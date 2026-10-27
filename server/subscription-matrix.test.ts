import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { PaseoAgent } from "./paseo-types";
import { CONTINUE_PROMPT, createResumer, type ResumerApi } from "./resumer";
import { createJobStore } from "./store";
import { pinOf } from "./test-pins";
import { captureLaunch, createSubscriptionReader } from "./subscription";
import { createClaudeCredentialReader } from "./claude-credentials";
import type { UsageSource } from "../shared/settings";

const START = "2026-10-18T00:00:00.000Z";
const SESSION = "2026-10-18T05:00:00.000Z";
const WEEK = "2026-10-23T00:00:00.000Z";
const DUE = "2026-10-23T00:02:00.000Z";
const epoch = (iso: string) => Date.parse(iso) / 1000;
const API_ROUTES = [
  ["codex", ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL"]],
  ["claude", ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]],
  ["antigravity", ["GEMINI_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GEMINI_BASE_URL"]],
] as const;
const cleanAuthEnv = Object.fromEntries(["OPENAI_API_KEY", ...API_ROUTES.flatMap(([, keys]) => [...keys])].map((key) => [key, ""]));

// Synthetic contract fixtures: plan labels exercise the absence of plan-name gating.
// They are NOT captures from paid accounts and do not prove live plan compatibility.
async function harness(t: TestContext, source: UsageSource, plan: string) {
  const dir = await mkdtemp(join(tmpdir(), "subscription-matrix-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "auth");
  await mkdir(home);
  const model = source === "codex" ? "gpt-6-astra" : "claude-opus-4-6";
  const provider = `${source}-${plan}`;
  const token = "fixture-only-access-token";
  const authPath = join(home, source === "codex" ? "auth.json" : ".credentials.json");
  const credentials = JSON.stringify(source === "codex"
    ? { auth_mode: "chatgpt", tokens: { access_token: token, account_id: "workspace-a" } }
    : { claudeAiOauth: { accessToken: token, expiresAt: Date.parse(WEEK) + 86_400_000 } });
  await writeFile(authPath, credentials);
  let clock = new Date(START);
  const state = { ready: false, outage: false, changed: false, nativeOrgId: true, fetches: 0, usageFetches: 0, accountType: "chatgpt" };
  const sent: Array<{ agentId: string; text: string }> = [];
  const agent = {
    id: "same-agent", provider, cwd: dir, model, status: "idle", updatedAt: START,
    lastUserMessageAt: START, activeTurn: null, pendingPermissions: [], attentionReason: null, archivedAt: null,
  } as unknown as PaseoAgent;
  const api = {
    config: { get: async () => ({ config: { providers: {
      [provider]: { extends: `${source}-base` },
      [`${source}-base`]: { extends: source, env: { ...cleanAuthEnv, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home } },
    } } }) },
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent, project: null }),
        send: async (text: string) => { sent.push({ agentId: id, text }); },
      }),
    },
  } as unknown as ResumerApi;
  const read = createSubscriptionReader({
    readClaudeCredentials: createClaudeCredentialReader({ platform: "linux" }),
    codex: async () => ({
      account: { account: { type: state.accountType, planType: plan } },
      config: { config: { model_provider: "openai" } },
    }),
    run: async (_command, args) => {
      assert.deepEqual(args, ["auth", "status", "--json"]);
      return JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
        subscriptionType: plan, email: "fixture@example.invalid", ...(state.nativeOrgId ? { orgId: state.changed ? "org-b" : "org-a" } : {}),
      });
    },
    fetch: async (url, options) => {
      state.fetches++;
      if (String(url).endsWith("/usage")) state.usageFetches++;
      assert.equal(options?.redirect, "error");
      assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
      if (state.outage) return new Response("unavailable", { status: 503 });
      const used = state.ready ? 0 : 100;
      const sessionUsed = clock.getTime() >= Date.parse(SESSION) ? 0 : used;
      let payload: unknown;
      if (source === "codex") {
        payload = { account_id: state.changed ? "workspace-b" : "workspace-a", plan_type: plan,
          rate_limit: {
            primary_window: { used_percent: sessionUsed, reset_at: epoch(SESSION) },
            secondary_window: { used_percent: used, reset_at: epoch(WEEK) },
          },
        };
      } else if (String(url).endsWith("/profile")) {
        payload = { account: { uuid: "account-a", email: "fixture@example.invalid" },
          organization: { uuid: state.changed ? "org-b" : "org-a" } };
      } else {
        payload = { five_hour: { utilization: sessionUsed, resets_at: SESSION },
          seven_day: { utilization: used, resets_at: WEEK },
          seven_day_sonnet: { utilization: 100, resets_at: WEEK },
        };
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const storePath = join(dir, "jobs.json");
  const store = createJobStore(storePath);
  const makeResumer = () => createResumer({ store: createJobStore(storePath), now: () => clock, readSubscription: read });
  const resumer = makeResumer();
  const event: PluginLifecycleEvents["agent.turn_ended"] = {
    agent: { id: agent.id, provider, workspaceId: null, parentAgentId: null, cwd: dir, title: null },
    turnId: "fixture-turn", outcome: { kind: "failed", error: { message: source === "antigravity"
      ? "Individual quota reached. Resets in 120h." : "Usage limit reached" } },
    timeline: [{ type: "user_message", text: "Continue the fixture task" }],
  };
  return { state, agent, api, store, resumer, makeResumer, sent, event, authPath, credentials,
    setTime: (value: string) => { clock = new Date(value); },
  };
}

for (const source of ["codex", "claude"] as const) {
  test(`${source}: a stated reset skips initial usage, then verifies weekly recovery before one continue`, async (t) => {
    const h = await harness(t, source, "stated-reset");
    h.event.outcome = { kind: "failed", error: { message: source === "codex"
      ? "Your workspace is out of credits. Try again in 5 hours."
      : "Usage limit reached. Try again in 5 hours." } };
    await h.resumer.attach(h.api);
    await h.resumer.onTurnEnded(h.event, h.api);
    const [job] = await h.store.list();
    assert.equal(job?.dueAt, "2026-10-18T05:02:00.000Z", "the notice wins over an unread weekly window");
    assert.equal(job?.waiting, undefined);
    assert.ok(job?.identity, "account/model binding does not require a usage fetch");
    assert.equal(h.state.usageFetches, 0);

    h.setTime(job.dueAt);
    await h.resumer.tick();
    assert.equal(h.state.usageFetches, 1);
    assert.deepEqual(h.sent, []);
    assert.equal((await h.store.list())[0]?.dueAt, DUE, "pre-send usage discovers the exhausted weekly window");

    const restarted = h.makeResumer();
    h.state.outage = true;
    h.setTime(DUE);
    await restarted.attach(h.api);
    assert.deepEqual(h.sent, [], "an unreadable account/usage never authorizes delivery");
    assert.equal((await h.store.list())[0]?.dueAt, "2026-10-23T00:17:00.000Z");
    h.state.outage = false;
    h.state.ready = true;
    h.setTime("2026-10-23T00:17:00.000Z");
    await restarted.tick();
    await restarted.tick();
    assert.deepEqual(h.sent, [{ agentId: h.agent.id, text: CONTINUE_PROMPT }]);
  });

  for (const changed of ["model", "account"] as const) test(`${source}: a stated-reset reservation cancels a changed ${changed} after restart`, async (t) => {
    const h = await harness(t, source, "stated-account");
    if (changed === "model") {
      h.state.accountType = "";
      h.state.nativeOrgId = false;
    }
    h.event.outcome = { kind: "failed", error: { message: "Usage limit reached. Try again in 5 hours." } };
    await h.resumer.onTurnEnded(h.event, h.api);
    assert.equal(h.state.usageFetches, 0);
    if (changed === "model") {
      assert.equal((await h.store.list())[0]?.identity, undefined, "model binding survives unavailable authentication");
      h.agent.model = "different-model";
    } else {
      h.state.changed = true;
      if (source === "codex") await writeFile(h.authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: {
        access_token: "fixture-only-access-token", account_id: "workspace-b",
      } }));
    }
    h.setTime("2026-10-18T05:02:00.000Z");
    await h.makeResumer().attach(h.api);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(await h.store.list(), []);
    if (changed === "model") assert.equal(h.state.usageFetches, 0, "a changed model is rejected before probing");
  });
}

for (const [source, plans] of [
  ["codex", ["plus", "pro", "team", "business", "enterprise", "edu"]],
  ["claude", ["pro", "max", "team", "enterprise"]],
] as const) for (const plan of plans) {
  test(`${source}/${plan} synthetic: auth → weekly reset → durable restart → fresh recovery → one continue`, async (t) => {
    const h = await harness(t, source, plan);
    await h.resumer.attach(h.api);
    await h.resumer.onTurnEnded(h.event, h.api);
    const [job] = await h.store.list();
    assert.equal(job?.resetAt, WEEK, "the later exhausted weekly window holds the five-hour reset");
    assert.equal(job?.dueAt, DUE);
    assert.ok(job?.identity);
    assert.equal(job?.waiting, undefined);
    assert.doesNotMatch(JSON.stringify(job), /fixture-only-access-token|fixture@example/);
    h.setTime("2026-10-18T05:02:00.000Z");
    await h.resumer.tick();
    assert.deepEqual(h.sent, []);
    const restarted = h.makeResumer();
    h.setTime(DUE);
    await restarted.recover();
    await restarted.attach(h.api);
    assert.deepEqual(h.sent, [], "a reset timestamp alone is not proof of recovery");
    assert.equal((await h.store.list())[0]?.waiting, "usage");
    h.state.outage = true;
    h.setTime("2026-10-23T00:17:00.000Z");
    await restarted.tick();
    assert.deepEqual(h.sent, [], "503 never authorizes a continue");
    h.state.outage = false;
    h.state.ready = true;
    h.setTime("2026-10-23T00:32:00.000Z");
    await restarted.tick();
    await restarted.tick();
    assert.deepEqual(h.sent, [{ agentId: "same-agent", text: CONTINUE_PROMPT }]);
    assert.equal((await h.store.list())[0]?.state, "sent");
    assert.equal(await readFile(h.authPath, "utf8"), h.credentials, "credentials are never rewritten");
  });
}

for (const source of ["codex", "claude", "antigravity"] as const) {
  for (const guard of ["new-message", "permission", "running", "archive", "provider-change", "switch-off", "delay"] as const) {
    test(`${source} synthetic: ${guard} prevents delivery at the original due time`, async (t) => {
      const h = await harness(t, source, "guard");
      await h.resumer.attach(h.api);
      await h.resumer.onTurnEnded(h.event, h.api);
      const [job] = await h.store.list();
      assert.ok(job);
      h.state.ready = true;
      if (guard === "new-message") h.agent.lastUserMessageAt = "2026-10-18T01:00:00.000Z";
      if (guard === "permission") h.agent.attentionReason = "permission";
      if (guard === "running") h.agent.status = "running";
      if (guard === "archive") h.agent.archivedAt = START;
      if (guard === "provider-change") h.agent.provider = "different-provider";
      if (guard === "switch-off") assert.equal(await h.resumer.setEnabled(h.agent.id, await pinOf(h.store, h.agent.id, job.dueAt), false), true);
      if (guard === "delay") assert.equal((await h.resumer.reschedule(h.agent.id, await pinOf(h.store, h.agent.id, job.dueAt), "2026-10-23T01:02:00.000Z")).changed, true);
      h.setTime(job.dueAt);
      await h.resumer.tick();
      assert.deepEqual(h.sent, []);
      if (guard === "delay") {
        h.setTime("2026-10-23T01:02:00.000Z");
        await h.resumer.tick();
        assert.equal(h.sent.length, 1);
      } else if (guard === "running") {
        // A turn the user did not start holds the continue until it ends.
        assert.deepEqual(await h.store.list(), [job]);
        h.agent.status = "idle";
        await h.resumer.tick();
        await h.resumer.tick();
        assert.equal(h.sent.length, 1);
      } else assert.deepEqual(await h.store.list(), []);
    });
  }
}

for (const [source, keys] of API_ROUTES) for (const key of keys) {
  test(`${source} synthetic: ${key} excludes subscription resume before any probe`, async () => {
    const fail = async (): Promise<never> => { throw new Error("probe must not run"); };
    const read = createSubscriptionReader({ run: fail, codex: fail, fetch: fail });
    const api = { config: { get: async () => ({ config: { providers: {} } }) } } as unknown as ResumerApi;
    const check = await read(api, { provider: source, cwd: "/tmp" } as PaseoAgent, source, new Date(START), captureLaunch({ env: { [key]: "fixture" } }));
    assert.deepEqual(check, { auth: "api", status: "unknown" });
  });
}

test("Antigravity synthetic: the notice survives restart and delivers once without account or plan verification", async (t) => {
  const h = await harness(t, "antigravity", "unverified-plan");
  await h.resumer.attach(h.api);
  await h.resumer.onTurnEnded(h.event, h.api);
  const [job] = await h.store.list();
  assert.equal(job?.dueAt, DUE);
  assert.equal(job?.identity, undefined);
  h.setTime(DUE);
  const restarted = h.makeResumer();
  await restarted.attach(h.api);
  await restarted.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.state.fetches, 0);
});

test("Claude synthetic: a native status without orgId stays in auth verification", async (t) => {
  const h = await harness(t, "claude", "team");
  h.state.nativeOrgId = false;
  await h.resumer.onTurnEnded(h.event, h.api);
  assert.equal((await h.store.list())[0]?.waiting, "auth");
  assert.equal(h.state.fetches, 0);
});

test("Claude synthetic: an expired Pro token waits without refreshing credentials or calling usage", async (t) => {
  const h = await harness(t, "claude", "pro");
  const expired = JSON.stringify({ claudeAiOauth: { accessToken: "expired-fixture-token", expiresAt: Date.parse(START) - 1 } });
  await writeFile(h.authPath, expired);
  await h.resumer.attach(h.api);
  await h.resumer.onTurnEnded(h.event, h.api);
  assert.equal((await h.store.list())[0]?.waiting, "auth");
  h.setTime("2026-10-18T00:15:00.000Z");
  await h.resumer.tick();
  assert.deepEqual(h.sent, []);
  assert.equal(h.state.fetches, 0);
  assert.equal(await readFile(h.authPath, "utf8"), expired);
});

test("Codex synthetic: native account selection disambiguates OPENAI_API_KEY and removes a job on API login", async (t) => {
  const h = await harness(t, "codex", "plus");
  h.resumer.rememberSession({ agentId: h.agent.id, provider: h.agent.provider, cwd: h.agent.cwd,
    workspaceId: null, reason: "create", purpose: "interactive", env: { OPENAI_API_KEY: "unused-fixture-key" },
  });
  await h.resumer.onTurnEnded(h.event, h.api);
  assert.ok((await h.store.list())[0]?.identity, "native ChatGPT auth, rather than key presence, selects the subscription route");
  const fetches = h.state.fetches;
  h.state.accountType = "apiKey";
  await h.resumer.onTurnEnded(h.event, h.api);
  assert.deepEqual(await h.store.list(), []);
  assert.equal(h.state.fetches, fetches, "the API login must never fetch subscription usage");
});
