import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { PaseoAgent } from "./paseo-types";
import { CONTINUE_PROMPT, createResumer, type ResumerApi } from "./resumer";
import { createSubscriptionReader } from "./subscription";
import { createClaudeCredentialReader } from "./claude-credentials";
import { createHash } from "node:crypto";
import { createJobStore } from "./store";
import { pinOf } from "./test-pins";
import type { ProviderSettings, UsageSource } from "../shared/settings";
import { summaryLabels, waitingLabel } from "../client/format";

// Synthetic scenarios, not captures from paid accounts. Native status probes run real child
// processes speaking the CLI protocols; only HTTP and the Paseo transport are replaced.
const START = Date.parse("2026-10-20T01:00:00Z");
const MINUTE = 60_000;
const FIVE = START + 5 * 60 * MINUTE;
const WEEK = START + 7 * 24 * 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();
const profiles = [
  { source: "codex", plan: "plus", model: "gpt-6-sol" },
  { source: "codex", plan: "pro", model: "gpt-6-astra" },
  { source: "codex", plan: "business", model: "gpt-6-astra" },
  { source: "claude", plan: "pro", model: "claude-sonnet-4-6" },
  { source: "claude", plan: "max", model: "claude-opus-4-6" },
  { source: "claude", plan: "team", model: "claude-opus-4-6" },
  { source: "antigravity", plan: "unverified", model: "gemini-pro" },
] as const;
type Profile = { source: UsageSource; plan: string; model: string };

const nativeCli = String.raw`
const fs = require('node:fs');
const state = () => JSON.parse(fs.readFileSync(process.env.RESUME_SIM_STATE, 'utf8'));
const log = entry => fs.appendFileSync(process.env.RESUME_SIM_CALLS, JSON.stringify(entry) + '\n');
const args = process.argv.slice(2);
if (args.join(' ') === 'auth status --json') {
  const s = state(); log({command:'claude.auth.status'});
  process.stdout.write(JSON.stringify({loggedIn:!s.authFailure, authMethod:s.authFailure?null:s.api?'api_key':'claude.ai',
    apiProvider:s.api?'thirdParty':'firstParty', subscriptionType:s.plan,
    email:'fixture@example.invalid', orgId:s.authFailure?null:s.orgId, configDirectory:process.env.CLAUDE_CONFIG_DIR}));
} else if (args.join(' ') === 'app-server --stdio') {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const m = JSON.parse(line); if (m.id === undefined) return;
    const s = state(); log({command:m.method,params:m.params});
    let result;
    if (m.method === 'initialize') result = {};
    else if (m.method === 'account/read') result = {account:{type:s.authFailure?'':s.api?'apiKey':'chatgpt',
      email:'fixture@example.invalid',planType:s.plan}};
    else if (m.method === 'config/read') result = {config:{model_provider:'openai'}};
    else { process.exitCode = 42; return; }
    process.stdout.write(JSON.stringify({id:m.id,result}) + '\n');
  });
} else { process.exitCode = 42; }
`;

async function scenario(t: TestContext, profile: Profile, limit: "five" | "week") {
  const { source, plan, model } = profile;
  const dir = await mkdtemp(join(tmpdir(), "resume scenario "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "auth");
  await mkdir(home);
  const script = join(dir, "fixture-cli.cjs");
  await writeFile(script, `#!${process.execPath}\n${nativeCli}`, { mode: 0o700 });
  // Windows has no shebangs; there a .cmd shim starts the script, as npm installs a CLI.
  const cli = process.platform === "win32" ? join(dir, "fixture-cli.cmd") : script;
  if (cli !== script) await writeFile(cli, `@"${process.execPath}" "${script}" %*\r\n`);
  const stateFile = join(dir, "native-state.json"), callsFile = join(dir, "native-calls.jsonl");
  const credentialFile = join(home, source === "codex" ? "auth.json" : ".credentials.json");
  const state = { plan, accountId: "workspace-a", orgId: "org-a", api: false, authFailure: false,
    available: false, outage: false, holdWeekly: false, hidden: false, exactModel: false, sessionRenewed: false };
  const saveNative = () => writeFile(stateFile, JSON.stringify(state));
  const credentials = () => JSON.stringify(source === "codex"
    ? { auth_mode: "chatgpt", tokens: { access_token: "fixture-token", account_id: state.accountId } }
    : { claudeAiOauth: { accessToken: "fixture-token", expiresAt: WEEK + 86_400_000 } });
  const keychainRecord = credentials();
  const originalCredentials = source === "claude"
    ? JSON.stringify({ claudeAiOauth: { accessToken: "stale-fallback-token", expiresAt: 1 } }) : keychainRecord;
  await writeFile(credentialFile, originalCredentials);
  const keychainFile = join(dir, "keychain.json");
  await writeFile(keychainFile, keychainRecord);
  let keychainReads = 0;
  await saveNative();
  let clock = START;
  const reset = limit === "five" ? FIVE : WEEK;
  const provider = `${source}-${plan}`;
  const settings: ProviderSettings = { disabledProviders: [] };
  const sent: Array<{ id: string; text: string }> = [];
  const requests: string[] = [];
  const agent = { id: "original-agent", provider, cwd: dir, model, title: "Simulation",
    status: "idle", updatedAt: iso(START), lastUserMessageAt: iso(START), activeTurn: null,
    pendingPermissions: [], attentionReason: null, archivedAt: null, lastError: undefined } as unknown as PaseoAgent;
  const notice = source === "antigravity" ? `Cloud Code Assist API error (429): Individual quota reached. Resets in ${limit === "five" ? "5h" : "168h"}.`
    : source === "claude" && limit === "five" ? "You've hit your limit · resets 3pm (Asia/Seoul)"
    : `You've hit your ${limit === "week" ? "weekly " : "usage "}limit. Try again at ${iso(reset)}.`;
  let stopped = false;
  const timeline = () => [{ type: "user_message", text: "Continue the simulated task" },
    ...(stopped && source === "claude" ? [{ type: "assistant_message", text: notice }] : [])];
  const env = Object.fromEntries([
    "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "GEMINI_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GEMINI_BASE_URL",
  ].map(key => [key, ""]));
  const api = {
    config: { get: async () => ({ config: { providers: {
      [provider]: { extends: `${source}-base` },
      [`${source}-base`]: { extends: source, command: [cli], env: { ...env, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home,
        USER: "fixture-user", RESUME_SIM_STATE: stateFile, RESUME_SIM_CALLS: callsFile } },
    } } }) },
    agents: {
      list: async (query: { filter?: { includeBackground?: boolean } }) => ({ entries:
        state.hidden && !query.filter?.includeBackground ? [] : [{ agent, project: null }], pageInfo: { hasMore: false } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent, project: { projectName: "Simulation", workspaceName: "Isolated" } }),
        send: async (text: string) => { sent.push({ id, text }); },
        timeline: { refetch: async () => ({ entries: timeline().map((item, seqStart) => ({ item, seqStart })), error: null }) },
      }),
      create: () => { throw new Error("must never create a replacement agent"); },
    },
  } as unknown as ResumerApi;
  const readSubscription = createSubscriptionReader({
    readClaudeCredentials: createClaudeCredentialReader({ platform: "darwin", runSecurity: async (args) => {
      keychainReads++;
      const suffix = createHash("sha256").update(home.normalize("NFC")).digest("hex").slice(0, 8);
      assert.deepEqual(args, ["find-generic-password", "-a", "fixture-user", "-w", "-s", `Claude Code-credentials-${suffix}`]);
      return readFile(keychainFile, "utf8");
    } }),
    fetch: async (url, options) => {
    const address = String(url);
    assert.ok(["https://chatgpt.com/backend-api/wham/usage", "https://api.anthropic.com/api/oauth/profile",
      "https://api.anthropic.com/api/oauth/usage"].includes(address), "no unexpected network request");
    assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer fixture-token");
    assert.equal(options?.redirect, "error");
    requests.push(address);
    if (state.outage) return new Response("fixture outage", { status: 503 });
    if (address.endsWith("/profile")) return Response.json({ account: { uuid: "account-a", email: "fixture@example.invalid" }, organization: { uuid: state.orgId } });
    const primary = !state.available && !state.sessionRenewed && limit === "five" ? 100 : 10;
    const weekly = !state.available && (limit === "week" || state.holdWeekly) ? 100 : 20;
    if (source === "codex") {
      assert.equal((options?.headers as Record<string, string>)["ChatGPT-Account-Id"], state.accountId);
      return Response.json({ account_id: state.accountId, plan_type: plan, credits: { has_credits: false },
        rate_limit_reached_type: { type: plan === "business" ? "workspace_member_credits_depleted" : "usage_limit_reached" },
        rate_limit: { primary_window: { used_percent: primary, reset_at: FIVE / 1000 },
          secondary_window: { used_percent: weekly, reset_at: WEEK / 1000 } },
        ...(state.exactModel ? { model_usage: { [model]: { available: state.available, available_at: iso(reset) } } } : {}),
      });
    }
    const other = model.includes("opus") ? "sonnet" : "opus";
    return Response.json({ five_hour: { utilization: primary, resets_at: iso(FIVE) }, seven_day: { utilization: weekly, resets_at: iso(WEEK) },
      [`seven_day_${other}`]: { utilization: 100, resets_at: iso(WEEK) } });
  } });
  const storePath = join(dir, "jobs.json");
  const store = createJobStore(storePath);
  const make = () => createResumer({ store: createJobStore(storePath), now: () => new Date(clock), readSettings: async () => settings, readSubscription });
  const resumer = make();
  const event = (message: string): PluginLifecycleEvents["agent.turn_ended"] => ({
    agent: { id: agent.id, provider, cwd: dir, title: agent.title, workspaceId: null, parentAgentId: null },
    turnId: "fixture-turn", outcome: source === "claude" ? { kind: "completed" }
      : { kind: "failed", error: { message, ...(source === "antigravity" ? { code: "RESOURCE_EXHAUSTED" } : {}) } },
    timeline: [{ type: "user_message", text: "Continue the simulated task" }, { type: "assistant_message", text: message }],
  });
  const stop = async (message = notice) => {
    stopped = true;
    agent.status = source === "claude" ? "idle" : "error";
    agent.lastError = source === "claude" ? undefined : message;
    await resumer.onTurnEnded(event(message), api);
  };
  return { api, agent, state, settings, requests, sent, store, resumer, make, reset, notice, stop, saveNative,
    credentials, credentialFile, originalCredentials, callsFile, setTime: (value: number) => { clock = value; },
    usageReads: () => requests.filter(address => address.endsWith("/usage")).length, keychainReads: () => keychainReads,
    markStopped: () => { stopped = true; agent.status = source === "claude" ? "idle" : "error"; agent.lastError = source === "claude" ? undefined : notice; },
  };
}

for (const profile of profiles.filter(profile => profile.source !== "antigravity")) {
  for (const failed of ["auth", "usage"] as const) test(`scenario ${profile.source}/${profile.plan}: untimed notice waits after ${failed} failure`, async (t) => {
    const h = await scenario(t, profile, "five");
    h.state.authFailure = failed === "auth";
    h.state.outage = failed === "usage";
    await h.saveNative();
    await h.resumer.attach(h.api);
    await h.stop("Usage limit reached");
    assert.equal((await h.store.list())[0]?.dueAt, iso(START + 15 * MINUTE));
    assert.ok((await h.store.list())[0]?.waiting);
    assert.deepEqual(h.sent, []);
    h.state.authFailure = false;
    h.state.outage = false;
    h.state.available = true;
    await h.saveNative();
    h.setTime(START + 15 * MINUTE);
    await h.resumer.tick();
    await h.resumer.tick();
    assert.equal(h.sent.length, 1);
  });

  test(`scenario ${profile.source}/${profile.plan}: API login creates no subscription reservation`, async (t) => {
    const h = await scenario(t, profile, "five");
    h.state.api = true;
    await h.saveNative();
    await h.stop();
    assert.deepEqual(await h.store.list(), []);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.sent, []);
  });

  test(`scenario ${profile.source}/${profile.plan}: account change cancels after restart despite the same email`, async (t) => {
    const h = await scenario(t, profile, "five");
    await h.stop();
    assert.ok((await h.store.list())[0]?.identity);
    h.state.accountId = "workspace-b";
    h.state.orgId = "org-b";
    h.state.available = true;
    await h.saveNative();
    await writeFile(h.credentialFile, h.credentials());
    h.setTime(h.reset + 2 * MINUTE);
    await h.make().attach(h.api);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(await h.store.list(), []);
  });

  test(`scenario ${profile.source}/${profile.plan}: a five-hour notice is postponed for an exhausted weekly window`, async (t) => {
    const h = await scenario(t, profile, "five");
    await h.resumer.attach(h.api);
    await h.stop();
    assert.equal(h.usageReads(), 0);
    h.state.sessionRenewed = true;
    h.state.holdWeekly = true;
    h.setTime(FIVE + 2 * MINUTE);
    await h.resumer.tick();
    assert.deepEqual(h.sent, []);
    assert.equal((await h.store.list())[0]?.dueAt, iso(WEEK + 2 * MINUTE));
    h.state.available = true;
    h.setTime(WEEK + 2 * MINUTE);
    await h.make().attach(h.api);
    assert.equal(h.sent.length, 1);
  });
}

for (const limit of ["five", "week"] as const) test(`scenario codex/business/${limit}: untimed credit notice uses exact-model availability`, async (t) => {
  const h = await scenario(t, profiles[2], limit);
  h.state.exactModel = true;
  await h.resumer.attach(h.api);
  await h.stop("Your workspace is out of credits. Ask your workspace owner to refill in order to continue.");
  assert.equal(h.usageReads(), 1);
  assert.equal((await h.store.list())[0]?.dueAt, iso(h.reset + 2 * MINUTE));
  h.state.available = true;
  h.setTime(h.reset + 2 * MINUTE);
  await h.make().attach(h.api);
  assert.deepEqual(h.sent, [{ id: h.agent.id, text: CONTINUE_PROMPT }]);
});

test("scenario antigravity: an untimed limit retries after 15/30/60 minutes and stops", async (t) => {
  const h = await scenario(t, profiles[6], "five");
  await h.resumer.attach(h.api);
  let clock = START;
  for (const minutes of [15, 30, 60]) {
    await h.stop("Individual quota reached.");
    clock += minutes * MINUTE;
    assert.equal((await h.store.list())[0]?.dueAt, iso(clock));
    h.setTime(clock);
    await h.resumer.tick();
  }
  await h.stop("Individual quota reached.");
  assert.equal(h.sent.length, 3);
  assert.deepEqual(await h.store.list(), []);
  assert.equal(h.requests.length, 0);
});

for (const profile of profiles) for (const limit of ["five", "week"] as const) {
  test(`scenario ${profile.source}/${profile.plan}/${limit}: notice → durable schedule → verified recovery → one continue`, async (t) => {
    const h = await scenario(t, profile, limit);
    await h.resumer.attach(h.api);
    await h.stop();
    const [job] = await h.store.list();
    assert.equal(job?.dueAt, iso(h.reset + 2 * MINUTE));
    assert.equal(h.usageReads(), 0, "no initial quota lookup when notice supplies time");
    if (profile.source === "claude") assert.ok(h.keychainReads() > 0, "Claude scenarios exercise the macOS credential reader");
    const rows = await h.resumer.listScheduled(h.api);
    assert.equal(rows[0]?.title, "Simulation");
    assert.equal(rows[0]?.waiting, undefined);
    assert.equal(summaryLabels(rows).title, "1 agent will continue");
    h.setTime(h.reset + 2 * MINUTE - 1);
    await h.resumer.tick();
    assert.deepEqual(h.sent, []);
    const restarted = h.make();
    await restarted.recover();
    h.setTime(h.reset + 2 * MINUTE);
    await restarted.attach(h.api);
    if (profile.source !== "antigravity") {
      assert.deepEqual(h.sent, [], "passing the timestamp cannot override stale exhausted quota");
      assert.equal((await h.store.list())[0]?.waiting, "usage");
      const waiting = await restarted.listScheduled(h.api);
      assert.equal(waitingLabel(waiting[0]!), "Waiting for usage verification");
      assert.equal(summaryLabels(waiting).title, "1 agent waiting for verification");
      h.state.outage = true;
      h.setTime(h.reset + 17 * MINUTE);
      await restarted.tick();
      assert.deepEqual(h.sent, [], "503 cannot authorize a continue");
      h.state.outage = false;
      h.state.available = true;
      h.setTime(h.reset + 32 * MINUTE);
    }
    await restarted.tick();
    await restarted.tick();
    assert.deepEqual(h.sent, [{ id: h.agent.id, text: CONTINUE_PROMPT }]);
    assert.equal((await h.store.list())[0]?.state, "sent");
    assert.deepEqual(await restarted.listScheduled(h.api), []);
    assert.equal(await readFile(h.credentialFile, "utf8"), h.originalCredentials);
    assert.doesNotMatch(JSON.stringify(await h.store.list()), /fixture-token|fixture@example/);
    if (profile.source === "antigravity") {
      assert.equal(h.requests.length, 0);
      await assert.rejects(readFile(h.callsFile), { code: "ENOENT" });
    } else {
      const calls = (await readFile(h.callsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.ok(calls.length > 0);
      if (profile.source === "codex") for (const call of calls.filter(c => c.command === "account/read")) assert.equal(call.params.refreshToken, false);
    }
  });
}

for (const profile of profiles) {
  for (const action of ["new-message", "running", "permission", "archive", "provider", "model", "provider-off", "resume-off"] as const) {
    test(`scenario ${profile.source}/${profile.plan}: ${action} prevents a scheduled continue`, async (t) => {
      const h = await scenario(t, profile, "five");
      await h.resumer.attach(h.api);
      await h.stop();
      const [job] = await h.store.list();
      assert.ok(job);
      if (action === "new-message") h.agent.lastUserMessageAt = iso(START + MINUTE);
      if (action === "running") h.agent.status = "running";
      if (action === "permission") h.agent.attentionReason = "permission";
      if (action === "archive") h.agent.archivedAt = iso(START);
      if (action === "provider") h.agent.provider = "different-provider";
      if (action === "model") h.agent.model = "different-model";
      if (action === "provider-off") h.settings.disabledProviders.push(h.agent.provider);
      if (action === "resume-off") assert.equal(await h.resumer.setEnabled(h.agent.id, await pinOf(h.store, h.agent.id, job.dueAt), false), true);
      h.state.available = true;
      h.setTime(h.reset + 2 * MINUTE);
      await h.resumer.tick();
      assert.deepEqual(h.sent, []);
      // A running turn the user did not start holds the continue instead of canceling it.
      assert.deepEqual(await h.store.list(), action === "running" ? [job] : []);
      assert.equal(h.usageReads(), 0, "agent/settings checks prevent unnecessary quota calls");
    });
  }

  test(`scenario ${profile.source}/${profile.plan}: switches and +10m editing survive restart`, async (t) => {
    const h = await scenario(t, profile, "week");
    await h.resumer.attach(h.api);
    await h.stop();
    const shown = await h.resumer.listScheduled(h.api);
    assert.equal(await h.resumer.setAllEnabled(false, shown), 1);
    assert.equal((await h.store.list())[0]?.enabled, false);
    assert.equal(await h.resumer.setAllEnabled(true, shown), 1);
    assert.equal(await h.resumer.setEnabled(h.agent.id, await pinOf(h.store, h.agent.id, shown[0]!.dueAt), false), true);
    assert.equal((await h.resumer.reschedule(h.agent.id, await pinOf(h.store, h.agent.id, shown[0]!.dueAt), iso(h.reset + MINUTE))).changed, false);
    const delayed = iso(h.reset + 12 * MINUTE);
    assert.equal((await h.resumer.reschedule(h.agent.id, await pinOf(h.store, h.agent.id, shown[0]!.dueAt), delayed)).changed, true);
    assert.equal((await h.store.list())[0]?.enabled, true, "editing re-enables the reservation");
    const restarted = h.make();
    h.state.available = true;
    h.setTime(h.reset + 2 * MINUTE);
    await restarted.attach(h.api);
    assert.deepEqual(h.sent, []);
    h.setTime(Date.parse(delayed));
    await restarted.tick();
    await restarted.tick();
    assert.equal(h.sent.length, 1);
  });

  test(`scenario ${profile.source}/${profile.plan}: recovers an unseen hidden-workspace stop`, async (t) => {
    const h = await scenario(t, profile, "five");
    h.state.hidden = true;
    h.markStopped();
    await h.make().attach(h.api);
    assert.equal((await h.store.list())[0]?.dueAt, iso(h.reset + 2 * MINUTE));
    assert.equal(h.usageReads(), 0);
  });
}
