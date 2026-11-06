import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import {
  createOpenCodeUsageReader, freeUsage, goUsage, openCodeDataDir, openCodeRoute,
} from "./opencode-usage";
import { captureLaunch, createSubscriptionReader } from "./subscription";
import { createResumer, type ResumerApi } from "./resumer";
import { createJobStore } from "./store";
import type { PaseoAgent, PaseoApi } from "./paseo-types";
import { GRACE_MS } from "../shared/schedule";

const GO_URL = "https://opencode.ai/zen/go/v1/usage";
const GO_KEY = "fixture-only-go-key";
const FREE_MODEL = "opencode/deepseek-v4.1-flash-free";
const GO_MODEL = "opencode-go/deepseek-v4.1-flash";
const SESSION = "ses_fixture_session";
const VERSION = "opencode v2.2.5\n";
const FREE_MESSAGE = "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.";
const GO_MESSAGE = "OpenCode Go 5 hour usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.";

/** The idle record opencode v2.2.5 stored on 2026-11-02 for a free-limit failure (verbatim, no secrets). */
const LIVE_FREE_IDLE = {
  time: { created: 1793618299374 },
  outcome: "failed",
  error: {
    type: "provider.free-limit",
    message: FREE_MESSAGE,
    status: 429,
    response: { body: "{\"type\":\"error\",\"error\":{\"type\":\"FreeUsageLimitError\",\"message\":\"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go\"}}" },
    retryAfterMs: 48986000,
  },
};
/** created + retryAfterMs of the record above. */
const LIVE_FREE_RESET = "2026-11-03T00:54:45.374Z";

const goWindow = (status: "ok" | "rate-limited", percent: number, resetsAt: string) => ({ status, percent, resetsAt });
const goBody = (rolling = goWindow("ok", 10, "2026-11-06T05:00:00.000Z"), weekly = goWindow("ok", 20, "2026-11-09T00:00:00.000Z"),
  monthly = goWindow("ok", 30, "2026-12-01T00:00:00.000Z")) => ({ usage: { rolling, weekly, monthly } });

/** An OpenCode data directory with the two tables the reader uses, shaped like opencode v2.2.5's. */
async function openCodeData(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "opencode-usage-"));
  const dir = join(root, "opencode");
  await mkdir(dir);
  const db = new DatabaseSync(join(dir, "opencode.db"));
  // Close before removing: Windows cannot delete a database file that is still open.
  t.after(async () => {
    try { db.close(); } catch { /* closed */ }
    await rm(root, { recursive: true, force: true });
  });
  db.exec(`
    CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, label TEXT, value TEXT,
      connector_id TEXT NOT NULL DEFAULT '', method_id TEXT NOT NULL DEFAULT '', active INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'prj', slug TEXT NOT NULL DEFAULT 's',
      directory TEXT NOT NULL DEFAULT '/', version TEXT NOT NULL DEFAULT '2.2.5', time_created INTEGER NOT NULL DEFAULT 1, time_updated INTEGER NOT NULL DEFAULT 1);
  `);
  let rows = 0;
  return {
    xdg: root,
    /**
     * The OpenCode session this database hosts. `version` is what OpenCode recorded for it: the
     * creating runtime's, or a fork's parent's. It says nothing about the server writing it now.
     */
    session(id: string, version = "2.2.5") {
      db.prepare("INSERT INTO session_v2 (id, version) VALUES (?, ?)").run(id, version);
    },
    rekey(id: string, value: unknown) {
      db.prepare("UPDATE credential SET value = ? WHERE id = ?").run(JSON.stringify(value), id);
    },
    credential(id: string, integration: string, value: unknown, active: number | null, created: number) {
      db.prepare("INSERT INTO credential (id, integration_id, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, integration, JSON.stringify(value), active, created, created);
    },
    message(session: string, type: string, seq: number, data: unknown) {
      rows++;
      db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(`msg_${rows}`, session, type, seq, 1, 1, JSON.stringify(data));
    },
  };
}

function fakes(body: () => unknown = () => goBody(), status = 200) {
  const calls = { spawns: 0, fetches: 0, logs: [] as string[] };
  return {
    calls,
    // The OpenCode reader never runs a process: the session's runtime, not a local CLI, decides support.
    run: async (_command: string, _args: string[]) => {
      calls.spawns++;
      return VERSION;
    },
    fetch: async (url: string | URL | Request, options?: RequestInit) => {
      calls.fetches++;
      assert.equal(String(url), GO_URL);
      assert.equal(options?.redirect, "error");
      assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${GO_KEY}`);
      return new Response(JSON.stringify(body()), { status });
    },
    log: (message: string) => { calls.logs.push(message); },
  };
}

const at = new Date("2026-11-02T11:20:00.000Z");

test("the route follows the model's OpenCode provider ID", () => {
  assert.equal(openCodeRoute(GO_MODEL), "go");
  assert.equal(openCodeRoute(FREE_MODEL), "zen");
  assert.equal(openCodeRoute("opencode/big-pickle"), "zen");
  assert.equal(openCodeRoute("openrouter/minimax/minimax-m3:free"), "other");
  assert.equal(openCodeRoute("anthropic/claude-opus-5-5"), "other");
  for (const model of [undefined, "", "opencode-go", "opencode-go/", "/deepseek"]) assert.equal(openCodeRoute(model), null, String(model));
});

test("the data directory follows XDG_DATA_HOME, else HOME/.local/share", () => {
  assert.equal(openCodeDataDir({ XDG_DATA_HOME: "/data", HOME: "/home/u" }), join("/data", "opencode"));
  assert.equal(openCodeDataDir({ HOME: "/home/u" }), join("/home/u", ".local", "share", "opencode"));
  assert.equal(openCodeDataDir({ XDG_DATA_HOME: "", HOME: "/home/u" }), join("/home/u", ".local", "share", "opencode"));
});

test("Go usage maps the three windows; rate-limited or a full window is exhausted", () => {
  const ready = goUsage(goBody(), "go-id");
  assert.equal(ready.status, "ready");
  assert.equal(ready.auth, "subscription");
  assert.equal(ready.identity, "go-id");
  assert.deepEqual(ready.windows?.map((w) => w.id), ["go:rolling", "go:weekly", "go:monthly"]);
  assert.equal(ready.windows?.[0]?.usedPct, 10);
  assert.equal(ready.windows?.[0]?.resetAt, "2026-11-06T05:00:00.000Z");

  const limited = goUsage(goBody(goWindow("rate-limited", 63, "2026-11-02T15:00:00Z")), "go-id");
  assert.equal(limited.status, "limited", "the service's rate-limited status holds even below 100%");
  assert.equal(limited.windows?.[0]?.usedPct, 100);
  assert.equal(limited.windows?.[0]?.resetAt, "2026-11-02T15:00:00.000Z");

  assert.equal(goUsage(goBody(undefined, goWindow("ok", 100, "2026-11-09T00:00:00Z")), "go-id").status, "limited");
  assert.equal(goUsage(goBody(undefined, goWindow("ok", 140, "2026-11-09T00:00:00Z")), "go-id").windows?.[1]?.usedPct, 100);
});

test("a Go answer missing or malforming any window gives no evidence", () => {
  const broken: unknown[] = [
    null, "text", {}, { usage: null },
    { usage: { rolling: goWindow("ok", 1, "2026-11-06T05:00:00Z"), weekly: goWindow("ok", 1, "2026-11-09T00:00:00Z") } },
    goBody(goWindow("unknown" as "ok", 1, "2026-11-06T05:00:00Z")),
    goBody(goWindow("ok", Number.NaN, "2026-11-06T05:00:00Z")),
    goBody(goWindow("ok", 1, "not a time")),
  ];
  for (const body of broken) assert.deepEqual(goUsage(body, "go-id"), { auth: "subscription", status: "unknown", identity: "go-id" }, JSON.stringify(body));
});

test("the recorded free-limit failure supplies its own reset", () => {
  assert.deepEqual(freeUsage(LIVE_FREE_IDLE, at), {
    auth: "subscription", status: "limited", windows: [{ id: "opencode:free", usedPct: 100, resetAt: LIVE_FREE_RESET }],
  });
  assert.deepEqual(freeUsage(LIVE_FREE_IDLE, new Date(LIVE_FREE_RESET)), { auth: "subscription", status: "ready", windows: [] },
    "the reset reached is ready; re-reading never pushes it later");
});

test("a free-limit failure without a usable delay falls back to the bounded retries", () => {
  const fallback = { auth: "subscription", status: "ready" };
  for (const change of [
    (r: any) => { delete r.error.retryAfterMs; },
    (r: any) => { r.error.retryAfterMs = 0; },
    (r: any) => { r.error.retryAfterMs = -5; },
    (r: any) => { r.error.retryAfterMs = "48986000"; },
    (r: any) => { delete r.time; },
    (r: any) => { r.time.created = "yesterday"; },
  ]) {
    const record = structuredClone(LIVE_FREE_IDLE);
    change(record);
    assert.deepEqual(freeUsage(record, at), fallback);
  }
});

test("balance-billed failures are an API route; anything else gives no evidence", () => {
  for (const type of ["provider.budget-limit", "provider.model-budget-limit", "provider.quota"]) {
    assert.deepEqual(freeUsage({ ...LIVE_FREE_IDLE, error: { type, message: "x" } }, at), { auth: "api", status: "unknown" }, type);
  }
  for (const record of [
    null, "text", {}, { time: { created: 1 }, outcome: "succeeded" },
    { ...LIVE_FREE_IDLE, error: { type: "provider.rate-limit", message: "Too many requests", retryAfterMs: 10_000 } },
    { ...LIVE_FREE_IDLE, error: { type: "provider.go-limit", message: GO_MESSAGE, retryAfterMs: 10_000 } },
    { ...LIVE_FREE_IDLE, outcome: "succeeded" },
    { ...LIVE_FREE_IDLE, error: undefined },
  ]) {
    assert.deepEqual(freeUsage(record, at), { auth: "unknown", status: "unknown" }, JSON.stringify(record));
  }
});

const launchFor = (xdg: string) => ({ env: { HOME: "/nonexistent-home", XDG_DATA_HOME: xdg } });

test("reader: Go reads the selected credential's usage, binding a stable identity that never contains the key", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  let body: unknown = goBody(goWindow("rate-limited", 100, "2026-11-02T15:00:00Z"));
  const f = fakes(() => body);
  const read = createOpenCodeUsageReader(f);
  const agent = { id: "a", model: GO_MODEL, sessionId: SESSION };
  const limited = await read(launchFor(data.xdg), agent, at, "usage");
  assert.equal(limited.status, "limited");
  assert.ok(limited.identity);
  body = goBody();
  const ready = await read(launchFor(data.xdg), agent, at, "usage");
  assert.equal(ready.status, "ready");
  assert.equal(ready.identity, limited.identity);
  assert.notEqual((await read(launchFor(data.xdg), { ...agent, model: "opencode-go/glm-5.3-flash" }, at, "usage")).identity, limited.identity);
  assert.equal(f.calls.fetches, 3);
  assert.doesNotMatch(JSON.stringify([limited, ready, f.calls.logs]), new RegExp(GO_KEY));
});

test("reader: identity mode binds the Go credential without calling usage", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  const f = fakes();
  const read = createOpenCodeUsageReader(f);
  const agent = { id: "a", model: GO_MODEL, sessionId: SESSION };
  const bound = await read(launchFor(data.xdg), agent, at, "identity");
  assert.equal(bound.auth, "subscription");
  assert.equal(bound.status, "unknown");
  assert.equal(f.calls.fetches, 0);
  assert.equal(bound.identity, (await read(launchFor(data.xdg), agent, at, "usage")).identity);
});

test("reader: the Go credential is the one OpenCode selects: active first, then the newest", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  data.credential("cred_old", "opencode-go", { type: "key", key: "old-key" }, null, 100);
  data.credential("cred_other", "opencode", { type: "key", key: "other-key" }, 1, 500);
  data.credential("cred_new", "opencode-go", { type: "key", key: GO_KEY }, null, 300);
  const f = fakes();
  const read = createOpenCodeUsageReader(f);
  const agent = { id: "a", model: GO_MODEL, sessionId: SESSION };
  const newest = await read(launchFor(data.xdg), agent, at, "usage");
  assert.equal(newest.status, "ready", "the newest legacy-imported key is used, not only active = 1");
  data.credential("cred_active", "opencode-go", { type: "key", key: GO_KEY }, 1, 50);
  const active = await read(launchFor(data.xdg), agent, at, "usage");
  assert.equal(active.status, "ready");
  assert.notEqual(active.identity, newest.identity, "another selected credential is another identity");
});

test("reader: a selected Go credential that is not a key, or none, waits for verification", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  const f = fakes();
  const read = createOpenCodeUsageReader(f);
  const agent = { id: "a", model: GO_MODEL, sessionId: SESSION };
  assert.deepEqual(await read(launchFor(data.xdg), agent, at, "usage"), { auth: "unknown", status: "unknown" });
  data.credential("cred_oauth", "opencode-go", { type: "oauth", access: "token" }, 1, 100);
  data.credential("cred_key", "opencode-go", { type: "key", key: GO_KEY }, null, 200);
  assert.deepEqual(await read(launchFor(data.xdg), agent, at, "usage"), { auth: "unknown", status: "unknown" },
    "never falls back past the selected credential");
  assert.equal(f.calls.fetches, 0);
});

test("reader: a failed Go usage call keeps the identity and gives no evidence", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  for (const status of [401, 403, 500]) {
    const f = fakes(() => ({ error: "nope" }), status);
    const check = await createOpenCodeUsageReader(f)(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage");
    assert.equal(check.auth, "subscription");
    assert.equal(check.status, "unknown");
    assert.ok(check.identity);
  }
});

test("reader: free reads only the agent's own session, latest idle record by seq", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  data.message(SESSION, "user", 4, { text: "hi" });
  data.message(SESSION, "idle", 10, LIVE_FREE_IDLE);
  data.message(SESSION, "idle", 7, { time: { created: 1 }, outcome: "succeeded" });
  data.message("ses_other", "idle", 99, { time: { created: 1 }, outcome: "succeeded" });
  const f = fakes();
  const read = createOpenCodeUsageReader(f);
  const check = await read(launchFor(data.xdg), { id: "a", model: FREE_MODEL, sessionId: SESSION }, at, "usage");
  assert.deepEqual(check.windows, [{ id: "opencode:free", usedPct: 100, resetAt: LIVE_FREE_RESET }]);
  assert.equal(check.status, "limited");
  assert.equal(check.identity, undefined);
  assert.deepEqual(await read(launchFor(data.xdg), { id: "a", model: FREE_MODEL, sessionId: null }, at, "usage"), { auth: "unknown", status: "unknown" });
  assert.deepEqual(await read(launchFor(data.xdg), { id: "a", model: FREE_MODEL, sessionId: "ses_missing" }, at, "usage"), { auth: "unknown", status: "unknown" });
  assert.equal(f.calls.fetches, 0);
});

test("reader: other providers are an API route before any probe", async () => {
  const f = fakes();
  const read = createOpenCodeUsageReader(f);
  for (const model of ["openrouter/minimax/minimax-m3:free", "anthropic/claude-opus-5-5"]) {
    assert.deepEqual(await read(launchFor("/nonexistent"), { id: "a", model, sessionId: SESSION }, at, "usage"), { auth: "api", status: "unknown" });
  }
  assert.equal(f.calls.spawns, 0);
  assert.equal(f.calls.fetches, 0);
});

test("reader: records are judged by their own content, never by a recorded or local version, and nothing is spawned", async (t) => {
  // A session's recorded version is its creator's (or a fork's parent's), not the server writing
  // it now, and the local CLI may be another program entirely. Neither is evidence; the record is.
  for (const version of ["1.18.23", "2.1.4", "2.2.5", "0.0.0-dev-202611051200", "local", ""]) {
    const data = await openCodeData(t);
    data.session(SESSION, version);
    data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
    data.message(SESSION, "idle", 10, LIVE_FREE_IDLE);
    const f = { ...fakes(goBody), run: async () => { f.calls.spawns++; return "opencode v1.18.23"; } };
    const read = createOpenCodeUsageReader(f);
    assert.deepEqual((await read(launchFor(data.xdg), { id: "a", model: FREE_MODEL, sessionId: SESSION }, at, "usage")).windows,
      [{ id: "opencode:free", usedPct: 100, resetAt: LIVE_FREE_RESET }], version);
    assert.equal((await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage")).status, "ready", version);
    assert.equal(f.calls.fetches, 1, version);
    assert.equal(f.calls.spawns, 0, version);
  }
});

test("reader: records older OpenCode wrote without a dedicated free-limit type are never resumed as free", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION, "2.1.1");
  const read = createOpenCodeUsageReader(fakes());
  const agent = { id: "a", model: FREE_MODEL, sessionId: SESSION };
  // Before 2.1.2 a free limit was stored as a generic quota failure with no retry delay.
  data.message(SESSION, "idle", 10, { time: { created: 1 }, outcome: "failed",
    error: { type: "provider.quota", message: "Rate limit exceeded. Please try again later." } });
  assert.deepEqual(await read(launchFor(data.xdg), agent, at, "usage"), { auth: "api", status: "unknown" });
  // Before 2.0.27 a failed idle record carried no error at all.
  data.message(SESSION, "idle", 11, { time: { created: 2 }, outcome: "failed" });
  assert.deepEqual(await read(launchFor(data.xdg), agent, at, "usage"), { auth: "unknown", status: "unknown" });
});

test("reader: missing models and databases wait for verification", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  const unknown = { auth: "unknown", status: "unknown" };
  const f = fakes();
  const read = createOpenCodeUsageReader(f);
  const agent = { id: "a", model: GO_MODEL, sessionId: SESSION };
  assert.deepEqual(await read(launchFor(data.xdg), { ...agent, model: undefined }, at, "usage"), unknown);
  assert.deepEqual(await read(launchFor(join(data.xdg, "missing")), agent, at, "usage"), unknown, "no database");
  assert.deepEqual(await read(launchFor(join(data.xdg, "missing")), { ...agent, model: FREE_MODEL }, at, "usage"), unknown);
  assert.equal(f.calls.fetches, 0);
  assert.equal(f.calls.spawns, 0);
});

test("reader: a database that does not host the agent's session is not its runtime, so nothing in it is trusted", async (t) => {
  // For example Paseo reaching OpenCode on another host through PASEO_OPENCODE_SERVER_URL: the local
  // database has another credential and none of that server's sessions.
  const data = await openCodeData(t);
  data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  data.message("ses_remote", "idle", 10, LIVE_FREE_IDLE);
  const f = fakes();
  const read = createOpenCodeUsageReader(f);
  const unknown = { auth: "unknown", status: "unknown" };
  for (const mode of ["identity", "usage"] as const) {
    assert.deepEqual(await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: "ses_remote" }, at, mode), unknown, mode);
    assert.deepEqual(await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: null }, at, mode), unknown, mode);
    assert.deepEqual(await read(launchFor(data.xdg), { id: "a", model: FREE_MODEL, sessionId: "ses_remote" }, at, mode), unknown, mode);
  }
  assert.equal(f.calls.fetches, 0, "another runtime's account is never checked with this credential");
  assert.ok(f.calls.logs.length > 0);
  assert.ok(f.calls.logs.every((line) => !line.includes("ses_remote") && !line.includes(GO_KEY)), "logs carry fixed reasons only");
});

test("reader: replacing the key in the selected credential row is another identity", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  const read = createOpenCodeUsageReader(fakes());
  const agent = { id: "a", model: GO_MODEL, sessionId: SESSION };
  const before = await read(launchFor(data.xdg), agent, at, "identity");
  data.rekey("cred_go", { type: "key", key: "fixture-only-replaced-key" });
  const after = await read(launchFor(data.xdg), agent, at, "identity");
  assert.ok(before.identity && after.identity);
  assert.notEqual(after.identity, before.identity);
  assert.doesNotMatch(JSON.stringify([before, after]), /fixture-only/);
});

test("the subscription reader sends OpenCode agents to the OpenCode reader with the launch environment", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  data.message(SESSION, "idle", 10, LIVE_FREE_IDLE);
  const f = fakes();
  const read = createSubscriptionReader({ run: f.run, fetch: f.fetch as typeof fetch });
  const api = { config: { get: async () => ({ config: { providers: {} } }) } } as unknown as Pick<PaseoApi, "config">;
  const agent = { id: "a", provider: "opencode", cwd: "/tmp", model: FREE_MODEL,
    runtimeInfo: { provider: "opencode", sessionId: SESSION, model: FREE_MODEL } } as unknown as PaseoAgent;
  const check = await read(api, agent, "opencode", at, captureLaunch({ env: { XDG_DATA_HOME: data.xdg } }));
  assert.equal(check.status, "limited");
  assert.equal(check.windows?.[0]?.resetAt, LIVE_FREE_RESET);
});

// --- Resumer scenarios: synthetic fixtures, not captures of a Paseo-run limit. ---

async function scenario(t: TestContext, model: string, message: string, start: string) {
  const data = await openCodeData(t);
  data.session(SESSION);
  const dir = await mkdtemp(join(tmpdir(), "opencode-scenario-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = new Date(start);
  const sent: string[] = [];
  const state = { body: goBody() as unknown, fetches: 0 };
  const agent = {
    id: "oc-agent", provider: "opencode", cwd: dir, model, status: "idle", updatedAt: start, lastUserMessageAt: start,
    activeTurn: null, pendingPermissions: [], attentionReason: null, archivedAt: null,
    runtimeInfo: { provider: "opencode", sessionId: SESSION, model },
  } as unknown as PaseoAgent;
  const api = {
    config: { get: async () => ({ config: { providers: { opencode: { env: { XDG_DATA_HOME: data.xdg } } } } }) },
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
      ref: () => ({
        refresh: async () => ({ agent, project: null }),
        send: async (text: string) => { sent.push(text); },
        timeline: { refetch: async () => ({ error: null, entries: [
          { item: { type: "user_message", text: "Do the task" }, seqStart: 0 },
          { item: { type: "assistant_message", text: `[System Error] ${message}` }, seqStart: 1 },
        ] }) },
      }),
    },
  } as unknown as ResumerApi;
  const f = fakes(() => state.body);
  const read = createSubscriptionReader({ run: f.run, fetch: (async (url: string, options?: RequestInit) => { state.fetches++; return f.fetch(url, options); }) as typeof fetch });
  const storePath = join(dir, "jobs.json");
  const store = createJobStore(storePath);
  const resumer = createResumer({ store: createJobStore(storePath), now: () => clock, readSubscription: read });
  await resumer.attach(api);
  const event: PluginLifecycleEvents["agent.turn_ended"] = {
    agent: { id: agent.id, provider: "opencode", workspaceId: null, parentAgentId: null, cwd: dir, title: null },
    turnId: "turn", outcome: { kind: "failed", error: { message } }, timeline: [],
  };
  return { data, state, store, resumer, api, event, sent, setTime: (iso: string) => { clock = new Date(iso); } };
}

test("OpenCode free synthetic: a free limit waits for the recorded reset, then continues once without usage calls", async (t) => {
  const s = await scenario(t, FREE_MODEL, FREE_MESSAGE, "2026-11-02T11:18:20.000Z");
  s.data.message(SESSION, "idle", 10, LIVE_FREE_IDLE);
  await s.resumer.onTurnEnded(s.event, s.api);
  const [job] = await s.store.list();
  assert.equal(Date.parse(job!.dueAt), Date.parse(LIVE_FREE_RESET) + GRACE_MS);
  assert.equal(job!.identity, undefined);
  s.setTime("2026-11-03T00:50:00.000Z");
  await s.resumer.tick();
  assert.deepEqual(s.sent, []);
  s.setTime(job!.dueAt);
  await s.resumer.tick();
  assert.equal(s.sent.length, 1);
  assert.equal(s.state.fetches, 0);
});

test("OpenCode Go synthetic: a Go limit waits for the latest exhausted window, verifies recovery, then continues once", async (t) => {
  const s = await scenario(t, GO_MODEL, GO_MESSAGE, "2026-11-02T13:00:00.000Z");
  s.data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  s.state.body = goBody(goWindow("rate-limited", 100, "2026-11-02T17:00:00Z"), goWindow("rate-limited", 100, "2026-11-09T00:00:00Z"));
  await s.resumer.onTurnEnded(s.event, s.api);
  const [job] = await s.store.list();
  assert.equal(Date.parse(job!.dueAt), Date.parse("2026-11-09T00:00:00Z") + GRACE_MS);
  assert.ok(job!.identity);
  s.setTime(job!.dueAt);
  s.state.body = goBody(goWindow("ok", 0, "2026-11-09T05:00:00Z"), goWindow("ok", 0, "2026-11-16T00:00:00Z"));
  await s.resumer.tick();
  assert.equal(s.sent.length, 1);
});

test("OpenCode synthetic: a balance-billed Zen model is excluded like an API route", async (t) => {
  const s = await scenario(t, "opencode/some-paid-model", "Workspace usage limit reached. Model use is paused until the limit resets.", "2026-11-02T13:00:00.000Z");
  s.data.message(SESSION, "idle", 10, { time: { created: Date.parse("2026-11-02T12:59:59Z") }, outcome: "failed",
    error: { type: "provider.budget-limit", message: "Workspace usage limit reached. Model use is paused until the limit resets.", status: 429 } });
  await s.resumer.onTurnEnded(s.event, s.api);
  assert.deepEqual(await s.store.list(), []);
});
