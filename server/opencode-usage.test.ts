import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { PluginHookEvents } from "@getpaseo/plugin/server";
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
    async authFile(content: unknown) {
      await writeFile(join(dir, "auth.json"), typeof content === "string" ? content : JSON.stringify(content));
    },
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
        .run(id, integration, value === undefined ? null : JSON.stringify(value), active, created, created);
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
  data.credential("cred_other", "anthropic", { type: "key", key: "other-key" }, 1, 500);
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

test("reader: Go prefers the selected opencode Console key over opencode-go and auth.json when it serves Go", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  const consoleKey = "fixture-only-console-key";
  data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
  data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  await data.authFile({ "opencode-go": { type: "api", key: "fixture-only-file-key" } });
  const tokens: string[] = [];
  const read = createOpenCodeUsageReader({
    fetch: async (url, options) => {
      assert.equal(String(url), GO_URL);
      assert.equal(options?.redirect, "error");
      tokens.push((options?.headers as Record<string, string>).Authorization ?? "");
      return new Response(JSON.stringify(goBody()), { status: 200 });
    },
    log: () => {},
  });
  const check = await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage");
  assert.equal(check.status, "ready");
  assert.ok(check.identity);
  assert.deepEqual(tokens, [`Bearer ${consoleKey}`]);
});

test("reader: Go falls back from an opencode Console key to opencode-go only on 401 or 403, never on temporary failures", async (t) => {
  const consoleKey = "fixture-only-console-key";
  for (const rejectStatus of [401, 403] as const) {
    const data = await openCodeData(t);
    data.session(SESSION);
    data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
    data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
    const tokens: string[] = [];
    const read = createOpenCodeUsageReader({
      fetch: async (_url, options) => {
        const auth = (options?.headers as Record<string, string>).Authorization ?? "";
        tokens.push(auth);
        if (auth === `Bearer ${consoleKey}`) return new Response("no go", { status: rejectStatus });
        return new Response(JSON.stringify(goBody()), { status: 200 });
      },
      log: () => {},
    });
    const check = await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage");
    assert.equal(check.status, "ready", `status ${rejectStatus}`);
    assert.ok(check.identity, `status ${rejectStatus}`);
    assert.deepEqual(tokens, [`Bearer ${consoleKey}`, `Bearer ${GO_KEY}`], `status ${rejectStatus}`);
  }

  for (const failure of ["500", "network", "malformed"] as const) {
    const data = await openCodeData(t);
    data.session(SESSION);
    data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
    data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
    const tokens: string[] = [];
    const read = createOpenCodeUsageReader({
      fetch: async (_url, options) => {
        tokens.push((options?.headers as Record<string, string>).Authorization ?? "");
        if (failure === "network") throw new Error("network down");
        if (failure === "500") return new Response("outage", { status: 500 });
        return new Response(JSON.stringify({}), { status: 200 });
      },
      log: () => {},
    });
    const check = await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage");
    assert.equal(check.auth, "subscription", failure);
    assert.equal(check.status, "unknown", failure);
    assert.deepEqual(tokens, [`Bearer ${consoleKey}`], `must not fall back on ${failure}`);
    if (failure === "malformed") assert.ok(check.identity, "200 OK binds the Console key identity even if the body is malformed");
    else assert.equal(check.identity, undefined, "temporary failure before confirmation does not bind an unconfirmed key");
  }

  for (const fallbackFailure of ["503", "401", "network"] as const) {
    const data = await openCodeData(t);
    data.session(SESSION);
    data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
    data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
    const tokens: string[] = [];
    const logs: string[] = [];
    const read = createOpenCodeUsageReader({
      fetch: async (_url, options) => {
        const auth = (options?.headers as Record<string, string>).Authorization ?? "";
        tokens.push(auth);
        if (auth === `Bearer ${consoleKey}`) return new Response("no go", { status: 403 });
        if (fallbackFailure === "network") throw new Error("fallback timeout");
        return new Response("down", { status: Number(fallbackFailure) });
      },
      log: (line) => { logs.push(line); },
    });
    const check = await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage");
    assert.deepEqual(check, { auth: "subscription", status: "unknown" }, `failed fallback (${fallbackFailure}) must not return an unconfirmed identity`);
    assert.deepEqual(tokens, [`Bearer ${consoleKey}`, `Bearer ${GO_KEY}`], fallbackFailure);
    assert.ok(logs.some((line) => line.includes("usage_unavailable")), fallbackFailure);
  }
});

test("reader: an opencode Console OAuth login on the default Console blocks fallback, while another Console's OAuth row is skipped", async (t) => {
  for (const metadata of [
    { orgID: "org_123" },
    { server: "https://opencode.ai/console", orgID: "org_123" },
    { server: "https://console.opencode.ai", orgID: "org_123" },
  ]) {
    const data = await openCodeData(t);
    data.session(SESSION);
    data.credential("cred_oauth", "opencode", { type: "oauth", access: "fixture-token", expires: 9_999_999_999_999, metadata }, 1, 200);
    data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
    await data.authFile({ "opencode-go": { type: "api", key: "fixture-only-file-key" } });
    const f = fakes();
    const read = createOpenCodeUsageReader(f);
    assert.deepEqual(await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage"), { auth: "unknown", status: "unknown" });
    assert.deepEqual(await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "identity"), { auth: "unknown", status: "unknown" });
    assert.equal(f.calls.fetches, 0);
  }

  const otherOauth = await openCodeData(t);
  otherOauth.session(SESSION);
  otherOauth.credential("cred_other_oauth", "opencode", { type: "oauth", access: "fixture-token", expires: 9_999_999_999_999, metadata: { server: "https://self-hosted.example/console" } }, 1, 200);
  otherOauth.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  const fOther = fakes();
  const check = await createOpenCodeUsageReader(fOther)(launchFor(otherOauth.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage");
  assert.equal(check.status, "ready", "OAuth for another Console server does not block an eligible opencode-go key");
  assert.equal(fOther.calls.fetches, 1);

  for (const invalidKey of ["   ", "\t\n", "bad\r\nkey", "foo bar", " sk-trimmed ", "foo\tbar", "foo\x00bar", "sk-한글"] as const) {
    const blankConsole = await openCodeData(t);
    blankConsole.session(SESSION);
    blankConsole.credential("cred_blank", "opencode", { type: "key", key: invalidKey }, 1, 200);
    blankConsole.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
    await blankConsole.authFile({ "opencode-go": { type: "api", key: GO_KEY } });
    const fBlank = fakes();
    const blankReader = createOpenCodeUsageReader(fBlank);
    assert.deepEqual(await blankReader(launchFor(blankConsole.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage"), { auth: "unknown", status: "unknown" }, JSON.stringify(invalidKey));
    assert.deepEqual(await blankReader(launchFor(blankConsole.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "identity"), { auth: "unknown", status: "unknown" }, JSON.stringify(invalidKey));
    assert.equal(fBlank.calls.fetches, 0, `invalid Bearer Console key (${JSON.stringify(invalidKey)}) must block fallback without sending a request`);
    assert.ok(fBlank.calls.logs.some((line) => line.includes("invalid_credential")), JSON.stringify(invalidKey));

    const blankGo = await openCodeData(t);
    blankGo.session(SESSION);
    blankGo.credential("cred_blank_go", "opencode-go", { type: "key", key: invalidKey }, 1, 100);
    await blankGo.authFile({ "opencode-go": { type: "api", key: GO_KEY } });
    const fBlankGo = fakes();
    assert.deepEqual(await createOpenCodeUsageReader(fBlankGo)(launchFor(blankGo.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage"), { auth: "unknown", status: "unknown" }, JSON.stringify(invalidKey));
    assert.equal(fBlankGo.calls.fetches, 0, `invalid Bearer Go DB key (${JSON.stringify(invalidKey)}) must neither fetch nor bypass to auth.json`);
    assert.ok(fBlankGo.calls.logs.some((line) => line.includes("invalid_credential")), JSON.stringify(invalidKey));

    const blankFile = await openCodeData(t);
    blankFile.session(SESSION);
    await blankFile.authFile({ "opencode-go": { type: "api", key: invalidKey } });
    const fBlankFile = fakes();
    assert.deepEqual(await createOpenCodeUsageReader(fBlankFile)(launchFor(blankFile.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage"), { auth: "unknown", status: "unknown" }, JSON.stringify(invalidKey));
    assert.equal(fBlankFile.calls.fetches, 0, `invalid Bearer auth.json key (${JSON.stringify(invalidKey)}) must not fetch`);
  }
});

test("reader: credentials for another Console server or empty/invalid metadata.server are rejected, while retired console.opencode.ai maps to opencode.ai", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  data.credential("cred_other_server", "opencode", { type: "key", key: "other-server-key", metadata: { server: "https://self-hosted.example/console" } }, 1, 300);
  data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY, metadata: { server: "https://console.opencode.ai" } }, 1, 100);
  const f = fakes();
  const read = createOpenCodeUsageReader(f);
  const check = await read(launchFor(data.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage");
  assert.equal(check.status, "ready");
  assert.equal(f.calls.fetches, 1);

  for (const invalidServer of ["https://console.opencode.ai/other", "", null, 123] as const) {
    const nonDefaultConsole = await openCodeData(t);
    nonDefaultConsole.session(SESSION);
    nonDefaultConsole.credential("cred_non_default", "opencode", { type: "key", key: "non-default-key", metadata: { server: invalidServer } }, 1, 300);
    nonDefaultConsole.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
    const fConsole = fakes();
    const consoleCheck = await createOpenCodeUsageReader(fConsole)(launchFor(nonDefaultConsole.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage");
    assert.equal(consoleCheck.status, "ready", `non-default Console server (${JSON.stringify(invalidServer)}) is skipped, not sent to opencode.ai`);
    assert.equal(fConsole.calls.fetches, 1);

    const nonDefaultGo = await openCodeData(t);
    nonDefaultGo.session(SESSION);
    nonDefaultGo.credential("cred_foreign_go", "opencode-go", { type: "key", key: "foreign-go-key", metadata: { server: invalidServer } }, 1, 100);
    await nonDefaultGo.authFile({ "opencode-go": { type: "api", key: GO_KEY } });
    const fGo = fakes();
    assert.deepEqual(await createOpenCodeUsageReader(fGo)(launchFor(nonDefaultGo.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage"), { auth: "unknown", status: "unknown" }, JSON.stringify(invalidServer));
    assert.equal(fGo.calls.fetches, 0, `non-default opencode-go DB row (${JSON.stringify(invalidServer)}) is neither sent to opencode.ai nor bypassed to auth.json`);
    assert.ok(fGo.calls.logs.some((line) => line.includes("invalid_credential")), JSON.stringify(invalidServer));
  }

  // auth.json entries must also validate metadata.server and map retired console.opencode.ai.
  for (const rejectedServer of ["https://self-hosted.example/console", "https://console.opencode.ai/other", "", null, 123] as const) {
    const foreignFile = await openCodeData(t);
    foreignFile.session(SESSION);
    await foreignFile.authFile({ "opencode-go": { type: "api", key: "foreign-file-key", metadata: { server: rejectedServer } } });
    const fFile = fakes();
    assert.deepEqual(await createOpenCodeUsageReader(fFile)(launchFor(foreignFile.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage"), { auth: "unknown", status: "unknown" }, JSON.stringify(rejectedServer));
    assert.equal(fFile.calls.fetches, 0, `auth.json key with server ${JSON.stringify(rejectedServer)} must never be sent to opencode.ai`);
  }

  for (const acceptedServer of ["https://opencode.ai/console", "https://console.opencode.ai"] as const) {
    const validFile = await openCodeData(t);
    validFile.session(SESSION);
    await validFile.authFile({ "opencode-go": { type: "api", key: GO_KEY, metadata: { server: acceptedServer } } });
    const fValidFile = fakes();
    const fileCheck = await createOpenCodeUsageReader(fValidFile)(launchFor(validFile.xdg), { id: "a", model: GO_MODEL, sessionId: SESSION }, at, "usage");
    assert.equal(fileCheck.status, "ready", acceptedServer);
    assert.equal(fValidFile.calls.fetches, 1, acceptedServer);
  }
});

test("reader: auth.json opencode-go key is used only when the local DB hosts the session and has no opencode-go row", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  await data.authFile({ "opencode-go": { type: "api", key: GO_KEY } });
  const f = fakes();
  const read = createOpenCodeUsageReader(f);
  const agent = { id: "a", model: GO_MODEL, sessionId: SESSION };
  const bound = await read(launchFor(data.xdg), agent, at, "identity");
  assert.equal(bound.auth, "subscription");
  assert.equal(bound.status, "unknown");
  assert.ok(bound.identity);
  assert.equal(f.calls.fetches, 0);

  const check = await read(launchFor(data.xdg), agent, at, "usage");
  assert.equal(check.status, "ready");
  assert.equal(check.identity, bound.identity);
  assert.equal(f.calls.fetches, 1);
  assert.doesNotMatch(JSON.stringify([bound, check, f.calls.logs]), new RegExp(GO_KEY));

  // Rotating the key in auth.json changes identity.
  await data.authFile({ "opencode-go": { type: "api", key: "fixture-only-rotated-file-key" } });
  const rotated = await read(launchFor(data.xdg), agent, at, "identity");
  assert.ok(rotated.identity);
  assert.notEqual(rotated.identity, bound.identity);

  // An opencode Console key that returns 403 falls back to auth.json when no DB opencode-go row exists.
  const consoleKey = "fixture-only-console-key";
  data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
  await data.authFile({ "opencode-go": { type: "api", key: GO_KEY } });
  const tokens: string[] = [];
  const withFallback = createOpenCodeUsageReader({
    fetch: async (_url, options) => {
      const auth = (options?.headers as Record<string, string>).Authorization ?? "";
      tokens.push(auth);
      return auth === `Bearer ${consoleKey}`
        ? new Response("no go", { status: 403 })
        : new Response(JSON.stringify(goBody()), { status: 200 });
    },
    log: () => {},
  });
  const fellBack = await withFallback(launchFor(data.xdg), agent, at, "usage");
  assert.equal(fellBack.status, "ready");
  assert.equal(fellBack.identity, bound.identity);
  assert.deepEqual(tokens, [`Bearer ${consoleKey}`, `Bearer ${GO_KEY}`]);

  // Once a DB opencode-go row exists (valid, invalid, or NULL value), auth.json is never used.
  const withInvalidGo = await openCodeData(t);
  withInvalidGo.session(SESSION);
  withInvalidGo.credential("cred_oauth_go", "opencode-go", { type: "oauth", access: "tok" }, 1, 100);
  await withInvalidGo.authFile({ "opencode-go": { type: "api", key: GO_KEY } });
  const fInvalid = fakes();
  assert.deepEqual(await createOpenCodeUsageReader(fInvalid)(launchFor(withInvalidGo.xdg), agent, at, "usage"), { auth: "unknown", status: "unknown" });
  assert.equal(fInvalid.calls.fetches, 0);
  assert.ok(fInvalid.calls.logs.some((line) => line.includes("invalid_credential")));

  const withNullGo = await openCodeData(t);
  withNullGo.session(SESSION);
  withNullGo.credential("cred_null_go", "opencode-go", undefined, 1, 100);
  await withNullGo.authFile({ "opencode-go": { type: "api", key: GO_KEY } });
  const fNull = fakes();
  assert.deepEqual(await createOpenCodeUsageReader(fNull)(launchFor(withNullGo.xdg), agent, at, "usage"), { auth: "unknown", status: "unknown" });
  assert.equal(fNull.calls.fetches, 0);
  assert.ok(fNull.calls.logs.some((line) => line.includes("invalid_credential")));

  // Without a matching session in the local DB, auth.json is never trusted.
  const unhosted = await openCodeData(t);
  await unhosted.authFile({ "opencode-go": { type: "api", key: GO_KEY } });
  const fUnhosted = fakes();
  assert.deepEqual(await createOpenCodeUsageReader(fUnhosted)(launchFor(unhosted.xdg), agent, at, "usage"), { auth: "unknown", status: "unknown" });
  assert.equal(fUnhosted.calls.fetches, 0);
});

test("reader: identity mode defers binding when both opencode and fallback keys exist, avoiding false account_changed on 403 fallback", async (t) => {
  const data = await openCodeData(t);
  data.session(SESSION);
  const consoleKey = "fixture-only-console-key";
  data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
  data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  let fetches = 0;
  const read = createOpenCodeUsageReader({
    fetch: async (_url, options) => {
      fetches++;
      const auth = (options?.headers as Record<string, string>).Authorization ?? "";
      return auth === `Bearer ${consoleKey}`
        ? new Response("no go", { status: 403 })
        : new Response(JSON.stringify(goBody()), { status: 200 });
    },
    log: () => {},
  });
  const agent = { id: "a", model: GO_MODEL, sessionId: SESSION };
  const initial = await read(launchFor(data.xdg), agent, at, "identity");
  assert.deepEqual(initial, { auth: "subscription", status: "unknown" });
  assert.equal(fetches, 0);

  const delivery = await read(launchFor(data.xdg), agent, at, "usage");
  assert.equal(delivery.status, "ready");
  assert.ok(delivery.identity);
  assert.equal(fetches, 2);
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

async function scenario(
  t: TestContext,
  model: string,
  message: string,
  start: string,
  customFetch?: (url: string, options?: RequestInit) => Promise<Response>,
) {
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
    workspaces: { ref: () => ({ refresh: async () => null }) },
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
  const fetchImpl = customFetch ?? ((url: string, options?: RequestInit) => f.fetch(url, options));
  const read = createSubscriptionReader({ run: f.run, fetch: (async (url: string, options?: RequestInit) => { state.fetches++; return fetchImpl(url, options); }) as typeof fetch });
  const storePath = join(dir, "jobs.json");
  const store = createJobStore(storePath);
  const resumer = createResumer({ store: createJobStore(storePath), now: () => clock, readSubscription: read });
  await resumer.attach(api);
  const event: PluginHookEvents["agent.turn.after"] = {
    agent: { id: agent.id, provider: "opencode", workspaceId: null, parentAgentId: null, cwd: dir, title: null, metadata: {}, background: false },
    turnId: "turn", outcome: { kind: "failed", error: { message } },
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

test("OpenCode Go synthetic: a failed fallback after Console 403 neither binds an unconfirmed identity nor cancels a Console-bound reservation", async (t) => {
  const consoleKey = "fixture-only-console-key";
  let consoleStatus = 403;
  let consoleBody: unknown = goBody();
  let goStatus = 503;
  const fetchPair = async (_url: string, options?: RequestInit) => {
    const auth = (options?.headers as Record<string, string>).Authorization ?? "";
    if (auth === `Bearer ${consoleKey}`) {
      return consoleStatus === 200 ? new Response(JSON.stringify(consoleBody), { status: 200 }) : new Response("no go", { status: consoleStatus });
    }
    return goStatus === 200 ? new Response(JSON.stringify(goBody()), { status: 200 }) : new Response("down", { status: goStatus });
  };

  // Case 1: Unbound reservation -> Console 403 + fallback 503 postpones without binding fallback identity,
  // so a later successful Console check continues instead of canceling as account_changed.
  const s1 = await scenario(t, GO_MODEL, GO_MESSAGE, "2026-11-02T13:00:00.000Z", fetchPair);
  s1.data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
  s1.data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  await s1.resumer.onTurnEnded(s1.event, s1.api);
  const [planned] = await s1.store.list();
  assert.ok(planned, "reservation scheduled for verification wait");
  assert.equal(planned.identity, undefined, "unconfirmed fallback must not bind identity on initial stop");

  s1.setTime(planned.dueAt);
  await s1.resumer.tick();
  const [postponedJob] = await s1.store.list();
  assert.ok(postponedJob, "reservation stays pending after failed fallback");
  assert.equal(postponedJob.identity, undefined, "failed fallback must not save identity during postponement");

  consoleStatus = 200;
  s1.setTime(postponedJob.dueAt);
  await s1.resumer.tick();
  assert.equal(s1.sent.length, 1, "subsequent Console success continues instead of canceling as account_changed");

  // Case 2: Console-bound reservation -> Console 403 + fallback 503 postpones instead of canceling immediately.
  consoleBody = goBody(goWindow("rate-limited", 100, "2026-11-02T17:00:00Z"));
  const s2 = await scenario(t, GO_MODEL, GO_MESSAGE, "2026-11-02T13:00:00.000Z", fetchPair);
  s2.data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
  s2.data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);
  consoleStatus = 200;
  await s2.resumer.onTurnEnded(s2.event, s2.api);
  const [bound] = await s2.store.list();
  assert.ok(bound?.identity, "initial Console 200 binds Console identity");

  consoleStatus = 403;
  s2.setTime(bound.dueAt);
  await s2.resumer.tick();
  const [stillPending] = await s2.store.list();
  assert.ok(stillPending, "Console-bound reservation must postpone, not cancel, when fallback fails");
  assert.equal(stillPending.identity, bound.identity);
  assert.equal(stillPending.state, "pending");
  consoleBody = goBody();
  consoleStatus = 200;
  s2.setTime(stillPending.dueAt);
  await s2.resumer.tick();
  assert.equal(s2.sent.length, 1);
});

test("OpenCode Go synthetic: a blocked Resume now binds the first confirmed identity so a later fallback key cancels as account_changed", async (t) => {
  const consoleKey = "fixture-only-console-key";
  let consoleStatus = 200;
  let consoleBody: unknown = goBody(goWindow("rate-limited", 100, "2026-11-02T17:00:00Z"));
  const s = await scenario(
    t,
    GO_MODEL,
    "Usage limit reached. Resets at 5:00 PM UTC.",
    "2026-11-02T13:00:00.000Z",
    async (_url, options) => {
      const auth = (options?.headers as Record<string, string>).Authorization ?? "";
      if (auth === `Bearer ${consoleKey}`) {
        return consoleStatus === 200 ? new Response(JSON.stringify(consoleBody), { status: 200 }) : new Response("no go", { status: consoleStatus });
      }
      return new Response(JSON.stringify(goBody()), { status: 200 });
    },
  );
  s.data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
  s.data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);

  // Stated reset uses identity mode, which defers binding when both Console and fallback keys exist.
  await s.resumer.onTurnEnded(s.event, s.api);
  const [planned] = await s.store.list();
  assert.ok(planned, "reservation scheduled from stated reset");
  assert.equal(planned.identity, undefined, "identity binding deferred when both keys exist");

  // First confirmed usage check happens on a blocked Resume now under the Console key.
  const blocked = await s.resumer.resumeNow(s.api, planned.agentId, { id: planned.id, dueAt: planned.dueAt });
  assert.deepEqual(blocked, { result: "used_up", until: "2026-11-02T17:00:00.000Z" });
  const [afterManual] = await s.store.list();
  assert.ok(afterManual?.identity, "blocked Resume now must bind the confirmed Console identity");
  assert.equal(afterManual.dueAt, planned.dueAt, "blocked Resume now keeps dueAt unchanged");
  assert.equal(afterManual.enabled, planned.enabled, "blocked Resume now keeps switch unchanged");

  // Later, if Console returns 403 and the fallback key answers ready, the reservation cancels instead of sending under the other key.
  consoleStatus = 403;
  s.setTime(afterManual.dueAt);
  await s.resumer.tick();
  assert.deepEqual(s.sent, [], "must not send under the fallback key after Console was bound");
  assert.deepEqual(await s.store.list(), [], "reservation canceled as account_changed");
});

test("OpenCode Go synthetic: a failed Console usage check never binds an unconfirmed identity even if the fallback is transiently absent", async (t) => {
  const consoleKey = "fixture-only-console-key";
  let consoleStatus = 503;
  const s = await scenario(
    t,
    GO_MODEL,
    "Usage limit reached. Resets at 5:00 PM UTC.",
    "2026-11-02T13:00:00.000Z",
    async (_url, options) => {
      const auth = (options?.headers as Record<string, string>).Authorization ?? "";
      if (auth === `Bearer ${consoleKey}`) {
        return new Response("no go", { status: consoleStatus });
      }
      return new Response(JSON.stringify(goBody()), { status: 200 });
    },
  );
  s.data.credential("cred_console", "opencode", { type: "key", key: consoleKey }, 1, 200);
  s.data.credential("cred_go", "opencode-go", { type: "key", key: GO_KEY }, 1, 100);

  // Starts unbound because both keys exist in identity mode.
  await s.resumer.onTurnEnded(s.event, s.api);
  const [planned] = await s.store.list();
  assert.ok(planned);
  assert.equal(planned.identity, undefined);

  // Go row becomes transiently unusable while Console returns 503 during a check.
  s.data.rekey("cred_go", { type: "oauth", access: "temporary-non-key" });
  const manual = await s.resumer.resumeNow(s.api, planned.agentId, { id: planned.id, dueAt: planned.dueAt });
  assert.deepEqual(manual, { result: "unverified", waiting: "usage" });
  const [afterManual] = await s.store.list();
  assert.equal(afterManual?.identity, undefined, "Console 503 must not bind an unconfirmed identity on Resume now");

  s.setTime(planned.dueAt);
  await s.resumer.tick();
  const [afterTick] = await s.store.list();
  assert.ok(afterTick);
  assert.equal(afterTick.identity, undefined, "Console 503 must not bind an unconfirmed identity on tick postponement");

  // Once the Go row is valid again, Console 403 + Go 200 confirms Go and continues instead of canceling as account_changed.
  s.data.rekey("cred_go", { type: "key", key: GO_KEY });
  consoleStatus = 403;
  s.setTime(afterTick.dueAt);
  await s.resumer.tick();
  assert.equal(s.sent.length, 1, "first confirmed usage check under fallback continues cleanly");
});
