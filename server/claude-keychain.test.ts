import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { PaseoAgent, PaseoApi } from "./paseo-types";
import { captureLaunch, createSubscriptionReader } from "./subscription";
import { createClaudeCredentialReader } from "./claude-credentials";
import { createResumer, CONTINUE_PROMPT, type ResumerApi } from "./resumer";
import { createJobStore } from "./store";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

const NOW = new Date("2026-10-20T00:00:00Z");
const authEnv = Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].map(key => [key, ""]));
const api = { config: { get: async () => ({ config: { providers: { claude: { env: authEnv } } } }) } } as unknown as Pick<PaseoApi, "config">;
/** An agent timeline whose latest turn ended with `notice`. */
const timelineOf = (notice: string) => ({ refetch: async () => ({ error: null, entries: [{ item: { type: "assistant_message", text: notice }, seqStart: 0 }] }) });
const agent = { id: "fixture-agent", provider: "claude", cwd: "/tmp", model: "claude-opus-4-6" } as PaseoAgent;

test("a macOS Claude subscription reaches account and usage verification", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    let credentialReads = 0;
    const options = {
      run: async () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
        subscriptionType: "max", orgId: "fixture-org", email: "fixture@example.invalid" }),
      readClaudeCredentials: async () => {
        credentialReads++;
        return { accessToken: "fixture-token", expiresAt: NOW.getTime() + 3_600_000 };
      },
      fetch: async (url: Parameters<typeof fetch>[0]) => Response.json(String(url).endsWith("/profile")
        ? { account: { uuid: "fixture-account", email: "fixture@example.invalid" }, organization: { uuid: "fixture-org" } }
        : { five_hour: { utilization: 10, resets_at: "2026-10-20T05:00:00Z" } }),
    };
    const result = await createSubscriptionReader(options)(api, agent, "claude", NOW);
    assert.equal(result.auth, "subscription");
    assert.equal(result.status, "ready");
    assert.ok(result.identity);
    assert.equal(credentialReads, 1);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("session storage overrides, including an empty value, persist without credential values", () => {
  const saved = captureLaunch({ env: { USER: "fixture-user", CLAUDE_CONFIG_DIR: "/tmp/team",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ACCESS_TOKEN: "fixture-secret" } });
  assert.deepEqual(saved.env, { USER: "fixture-user", CLAUDE_CONFIG_DIR: "/tmp/team", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" });
  assert.doesNotMatch(JSON.stringify(saved), /fixture-secret/);
});

for (const plan of ["pro", "max", "team"]) for (const window of ["five", "week"]) {
  test(`macOS ${plan}/${window}: selected Keychain → delayed verification → restart → one continue`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "claude-keychain-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    let clock = NOW.getTime();
    const reset = clock + (window === "five" ? 5 : 168) * 3_600_000;
    const due = reset + 120_000;
    const env = { ...authEnv, USER: "fixture-user", CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home };
    const service = `Claude Code-credentials-${createHash("sha256").update(home.normalize("NFC")).digest("hex").slice(0, 8)}`;
    const keychainRecord = JSON.stringify({ claudeAiOauth: { accessToken: "keychain-fixture-token", expiresAt: reset + 86_400_000 } });
    // A stale fallback file must not shadow the valid selected Keychain record.
    await writeFile(join(home, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"stale-file","expiresAt":1}}');
    let ready = false, reads = 0;
    const read = createSubscriptionReader({
      readClaudeCredentials: createClaudeCredentialReader({ platform: "darwin", runSecurity: async (args) => {
        assert.equal(args.at(-1), service);
        return keychainRecord;
      } }),
      run: async () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
        subscriptionType: plan, orgId: "fixture-org", email: "fixture@example.invalid" }),
      fetch: async (url, options) => {
        assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer keychain-fixture-token");
        if (String(url).endsWith("/profile")) return Response.json({ account: { uuid: "fixture-account", email: "fixture@example.invalid" }, organization: { uuid: "fixture-org" } });
        reads++;
        return Response.json({ [window === "five" ? "five_hour" : "seven_day"]: { utilization: ready ? 10 : 100, resets_at: new Date(reset).toISOString() } });
      },
    });
    const nativeAgent = { ...agent, model: plan === "pro" ? "claude-sonnet-4-6" : "claude-opus-4-6",
      status: "idle", lastUserMessageAt: null, pendingPermissions: [], activeTurn: null, attentionReason: null, archivedAt: null };
    const sent: string[] = [];
    const notice = `You've hit your limit. Resets at ${new Date(reset).toISOString()}`;
    const host = { config: { get: async () => ({ config: { providers: { claude: { env } } } }) },
      agents: { list: async () => ({ entries: [] }), ref: () => ({ refresh: async () => ({ agent: nativeAgent, project: null }),
        send: async (text: string) => { sent.push(text); }, timeline: timelineOf(notice) }) } } as unknown as ResumerApi;
    const store = createJobStore(join(home, "jobs.json"));
    const make = () => createResumer({ store: createJobStore(join(home, "jobs.json")), now: () => new Date(clock), readSubscription: read });
    const resumer = make();
    const event = { agent: { id: agent.id, provider: "claude", workspaceId: null, parentAgentId: null, cwd: "/tmp", title: null }, turnId: "fixture-turn",
      outcome: { kind: "completed" }, timeline: [] } as PluginLifecycleEvents["agent.turn_ended"];
    await resumer.onTurnEnded(event, host);
    assert.equal(reads, 0);
    assert.equal((await store.list())[0]?.dueAt, new Date(due).toISOString());
    assert.ok((await store.list())[0]?.identity);
    const restarted = make();
    clock = due;
    await restarted.attach(host);
    assert.deepEqual(sent, []);
    assert.equal((await store.list())[0]?.waiting, "usage");
    ready = true;
    clock += 15 * 60_000;
    await restarted.tick();
    await restarted.tick();
    assert.deepEqual(sent, [CONTINUE_PROMPT]);
    assert.doesNotMatch(await readFile(join(home, "jobs.json"), "utf8"), /keychain-fixture-token|stale-file/);
  });
}

for (const failure of ["locked", "missing", "denied", "timeout", "malformed", "expired", "missing-expiry", "wrong-profile"]) {
  test(`macOS Keychain ${failure}: no usage request or automatic continue`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "claude-keychain-failure-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    let requests = 0;
    const read = createSubscriptionReader({
      readClaudeCredentials: createClaudeCredentialReader({ platform: "darwin", readFile: async () => { throw new Error("no same-profile fallback"); },
        runSecurity: async () => {
          if (["locked", "missing", "denied", "timeout"].includes(failure)) throw new Error(failure);
          if (failure === "malformed") return "not-json";
          return JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", ...(failure === "missing-expiry" ? {} : { expiresAt: failure === "expired" ? 1 : NOW.getTime() + 3_600_000 }) } });
        } }),
      run: async () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
        subscriptionType: "team", orgId: "fixture-org", email: "fixture@example.invalid" }),
      fetch: async (url) => {
        requests++;
        assert.ok(String(url).endsWith("/profile"), "must not fetch usage for a different profile");
        return Response.json({ account: { uuid: "other-account", email: "other@example.invalid" }, organization: { uuid: "other-org" } });
      },
    });
    const result = await read(api, agent, "claude", NOW);
    assert.equal(result.auth, "unknown");
    assert.equal(result.status, "unknown");
    assert.equal(requests, failure === "wrong-profile" ? 1 : 0);
    let clock = NOW.getTime();
    const sent: string[] = [];
    const nativeAgent = { ...agent, status: "idle", lastUserMessageAt: null, pendingPermissions: [], activeTurn: null, attentionReason: null, archivedAt: null };
    const host = { ...api, agents: { list: async () => ({ entries: [] }), ref: () => ({
      refresh: async () => ({ agent: nativeAgent, project: null }), send: async (text: string) => { sent.push(text); },
      timeline: timelineOf("You've hit your limit. Resets in 1 hour."),
    }) } } as unknown as ResumerApi;
    const store = createJobStore(join(home, "jobs.json"));
    const resumer = createResumer({ store, now: () => new Date(clock), readSubscription: read });
    await resumer.onTurnEnded({ agent: { id: agent.id, provider: "claude", workspaceId: null, parentAgentId: null, cwd: "/tmp", title: null }, turnId: "fixture-turn",
      outcome: { kind: "completed" }, timeline: [] }, host);
    clock += 62 * 60_000;
    await resumer.attach(host);
    assert.deepEqual(sent, []);
    assert.equal((await store.list())[0]?.waiting, "auth");
  });
}

test("macOS: a locked Keychain can use the matching profile's fallback file", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "claude-file-fallback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, ".credentials.json");
  const saved = JSON.stringify({ claudeAiOauth: { accessToken: "fallback-fixture", expiresAt: NOW.getTime() + 3_600_000 } });
  await writeFile(file, saved);
  const read = createSubscriptionReader({
    readClaudeCredentials: createClaudeCredentialReader({ platform: "darwin", runSecurity: async () => { throw new Error("locked"); } }),
    run: async () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
      subscriptionType: "team", orgId: "fixture-org", email: "fixture@example.invalid" }),
    fetch: async (url, options) => {
      assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer fallback-fixture");
      return Response.json(String(url).endsWith("/profile")
        ? { account: { uuid: "fixture-account", email: "fixture@example.invalid" }, organization: { uuid: "fixture-org" } }
        : { five_hour: { utilization: 10 } });
    },
  });
  const selected = { config: { get: async () => ({ config: { providers: { claude: {
    env: { ...authEnv, CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home },
  } } } }) } } as unknown as Pick<PaseoApi, "config">;
  assert.equal((await read(selected, agent, "claude", NOW)).status, "ready");
  assert.equal(await readFile(file, "utf8"), saved);
});
