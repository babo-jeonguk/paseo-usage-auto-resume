import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isExhausted, type QuotaWindow } from "./quota";
import { unknownCheck, type SubscriptionCheck } from "./subscription";

const USAGE_TIMEOUT_MS = 15_000;
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CONSOLE_CREDENTIAL = "SELECT id, value FROM credential WHERE integration_id = 'opencode' ORDER BY active DESC, time_created DESC, id DESC LIMIT 1";
const GO_CREDENTIAL = "SELECT id, value FROM credential WHERE integration_id = 'opencode-go' ORDER BY active DESC, time_created DESC, id DESC LIMIT 1";
const GO_WINDOWS = ["rolling", "weekly", "monthly"] as const;
const SESSION_HOST = "SELECT 1 FROM session_v2 WHERE id = ? LIMIT 1";
const SESSION_IDLE = "SELECT data FROM session_message WHERE session_id = ? AND type = 'idle' ORDER BY seq DESC LIMIT 1";
const BALANCE_TYPES = new Set(["provider.budget-limit", "provider.model-budget-limit", "provider.quota"]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** A credential id names its row; it only has to be present text. */
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
/** An HTTP Bearer key is visible US-ASCII: no spaces, tabs, controls or non-ASCII bytes. */
const bearerKey = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]+$/.test(value);
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A reset instant as normalized ISO, or null when the service's value is not a time. */
function instant(value: unknown): string | null {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** The billing route a model selects; both halves of `provider/model` must be present. */
export function openCodeRoute(model: string | undefined): "go" | "zen" | "other" | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  const provider = model.slice(0, slash);
  if (provider === "opencode-go") return "go";
  if (provider === "opencode") return "zen";
  return "other";
}

/** OpenCode keeps its SQLite database beside the other XDG data, or under the home by default. */
export function openCodeDataDir(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME
    ? join(env.XDG_DATA_HOME, "opencode")
    : join(env.HOME || homedir(), ".local", "share", "opencode");
}

/** The three Go windows, or no evidence when any of them is missing or malformed. */
export function goUsage(body: unknown, identity: string): SubscriptionCheck {
  const usage = record(record(body).usage);
  const windows: QuotaWindow[] = [];
  for (const id of GO_WINDOWS) {
    const window = record(usage[id]), status = window.status, percent = number(window.percent);
    const resetAt = instant(window.resetsAt);
    if ((status !== "ok" && status !== "rate-limited") || percent === undefined || resetAt === null) {
      return { auth: "subscription", status: "unknown", identity };
    }
    windows.push({
      id: `go:${id}`,
      usedPct: status === "rate-limited" ? 100 : Math.min(100, Math.max(0, percent)),
      resetAt,
    });
  }
  return { auth: "subscription", status: windows.some(isExhausted) ? "limited" : "ready", identity, windows };
}

/** A recorded free-limit failure supplies the reset; anything else is not free-limit evidence. */
export function freeUsage(idle: unknown, at: Date): SubscriptionCheck {
  const data = record(idle);
  if (data.outcome !== "failed" || !data.error || typeof data.error !== "object" || Array.isArray(data.error)) return unknownCheck();
  const error = record(data.error);
  if (typeof error.type === "string" && BALANCE_TYPES.has(error.type)) return { auth: "api", status: "unknown" };
  if (error.type !== "provider.free-limit") return unknownCheck();
  const created = number(record(data.time).created), delay = number(error.retryAfterMs);
  // Without a usable recorded delay, the bounded retry sequence decides when to check again.
  if (created === undefined || delay === undefined || delay <= 0) return { auth: "subscription", status: "ready" };
  const reset = created + delay;
  if (reset <= at.getTime()) return { auth: "subscription", status: "ready", windows: [] };
  return {
    auth: "subscription", status: "limited",
    windows: [{ id: "opencode:free", usedPct: 100, resetAt: new Date(reset).toISOString() }],
  };
}

/**
 * Opens the agent's OpenCode database read-only and runs one query. A missing file, a missing table
 * or any SQLite error gives null; the handle is closed even when the query fails.
 */
async function readDatabase<T>(env: NodeJS.ProcessEnv, query: (db: DatabaseSync) => T): Promise<T | null> {
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(join(openCodeDataDir(env), "opencode.db"), { readOnly: true });
    return query(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

type Idle = { data: unknown } | { reason: "session_not_in_database" };
type CredentialRow = { id: unknown; value: unknown };
type GoSelection = { console?: CredentialRow; go?: CredentialRow };
type GoCandidate = { key: string; identity: string };

/** Whether this database is the runtime that hosts the agent, not another server's. */
const hostsSession = (db: DatabaseSync, sessionId: string): boolean =>
  db.prepare(SESSION_HOST).get(sessionId) !== undefined;

// Any returned row is present, even with a NULL or non-string value: auth.json must not replace it.
const rowOf = (value: unknown): CredentialRow | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const row = record(value);
  return { id: row.id, value: row.value };
};

/** The selected Console and opencode-go rows, read only from the database that hosts the session. */
async function selectCredentials(env: NodeJS.ProcessEnv, sessionId: string): Promise<GoSelection | { reason: "session_not_in_database" } | null> {
  return await readDatabase<GoSelection | { reason: "session_not_in_database" }>(env, (db) => {
    if (!hostsSession(db, sessionId)) return { reason: "session_not_in_database" };
    return { console: rowOf(db.prepare(CONSOLE_CREDENTIAL).get()), go: rowOf(db.prepare(GO_CREDENTIAL).get()) };
  });
}

/** Which Console a credential names: OpenCode's own, another valid HTTP server, or unreadable metadata. */
const consoleTarget = (value: Record<string, unknown>): "default" | "other" | "invalid" => {
  const metadata = value.metadata;
  if (metadata === undefined || metadata === null) return "default";
  if (typeof metadata !== "object" || Array.isArray(metadata)) return "invalid";
  const server = record(metadata).server;
  if (server === undefined) return "default";
  if (typeof server !== "string") return "invalid";
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "invalid";
  if (url.username || url.password || url.search || url.hash) return "invalid";
  const path = url.pathname.replace(/\/+$/, "");
  const isDefault =
    (url.origin === "https://opencode.ai" && path === "/console") ||
    (url.origin === "https://console.opencode.ai" && path === "");
  return isDefault ? "default" : "other";
};

const parseValue = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "string") return {};
  try { return record(JSON.parse(raw)); } catch { return {}; }
};

type UnusableCredential = { kind: "other_server" } | { kind: "oauth" } | { kind: "invalid" };
type CredentialClass = UnusableCredential | { kind: "candidate"; key: string };
type CredentialRowClass = UnusableCredential | { kind: "candidate"; key: string; id: string };

/** How one stored credential classifies as a Go key for OpenCode's own Console. */
const classifyCredential = (value: Record<string, unknown>, keyType: string): CredentialClass => {
  const target = consoleTarget(value);
  if (target === "other") return { kind: "other_server" };
  if (target === "invalid") return { kind: "invalid" };
  if (value.type === "oauth") return { kind: "oauth" };
  return value.type === keyType && bearerKey(value.key)
    ? { kind: "candidate", key: value.key }
    : { kind: "invalid" };
};

/** A database row names its credential with an id, then classifies like auth.json's entry. */
const classifyRow = (row: CredentialRow, keyType: string): CredentialRowClass => {
  const classified = classifyCredential(parseValue(row.value), keyType);
  if (classified.kind !== "candidate") return classified;
  return nonEmpty(row.id) ? { kind: "candidate", key: classified.key, id: row.id } : { kind: "invalid" };
};

const keyHash = (key: string): string => createHash("sha256").update(key).digest("hex");
const dbIdentity = (id: string, key: string, model: string): string =>
  createHash("sha256").update(JSON.stringify(["opencode", "go", id, keyHash(key), model])).digest("hex");
const fileIdentity = (key: string, model: string): string =>
  createHash("sha256").update(JSON.stringify(["opencode", "go", "file", "auth.json", keyHash(key), model])).digest("hex");

/** Why usage gave no evidence; each is logged as is, never with output, keys or rows. */
type Unavailable = "missing_model" | "database_unavailable" | "session_not_in_database" | "missing_credential" | "invalid_credential" | "oauth_credential" | "usage_unavailable" | "missing_session" | "no_free_limit_record";

/** How Paseo reaches OpenCode for the agent: the environment that selects its data. */
interface OpenCodeLaunch {
  env: NodeJS.ProcessEnv;
}

interface OpenCodeAgent {
  id: string;
  model: string | undefined;
  sessionId: string | null | undefined;
}

/**
 * Reads the usage that applies to an agent's model. Every failure, from a missing session to an
 * unreadable database, is logged with a fixed reason and waits for verification; nothing throws
 * and nothing is spawned.
 */
export function createOpenCodeUsageReader(deps: {
  fetch?: typeof fetch;
  log?: (message: string) => void;
} = {}) {
  const fetchApi = deps.fetch ?? fetch;
  const log = deps.log ?? ((message: string) => console.warn(`[usage-auto-resume] ${message}`));

  /** The Go usage answer with its outcome, or null when the call itself failed. */
  async function goAnswer(key: string): Promise<{ ok: boolean; status: number; body?: unknown } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
    try {
      const response = await fetchApi(GO_USAGE_URL, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, status: response.status };
      try {
        return { ok: true, status: response.status, body: await response.json() };
      } catch {
        // A successful response whose body is not JSON still confirms the credential; it just has no windows.
        return { ok: true, status: response.status };
      }
    } catch {
      return null;
    } finally { clearTimeout(timer); }
  }

  /** The opencode-go entry saved by `opencode auth login`, read only as a last resort. */
  async function readAuthEntry(env: NodeJS.ProcessEnv): Promise<Record<string, unknown> | undefined> {
    try {
      const auth = record(JSON.parse(await readFile(join(openCodeDataDir(env), "auth.json"), "utf8")));
      const entry = auth["opencode-go"];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      return record(entry);
    } catch {
      return undefined;
    }
  }

  return async (launch: OpenCodeLaunch, agent: OpenCodeAgent, at: Date, mode: "identity" | "usage"): Promise<SubscriptionCheck> => {
    const reason = (why: Unavailable) => log(`opencode usage unavailable for ${agent.id}: ${why}`);
    const unavailable = (why: Unavailable) => {
      reason(why);
      return unknownCheck();
    };
    /** The check a confirmed Go answer gives; a body that names no windows is no evidence. */
    const parseGoResult = (body: unknown, identity: string): SubscriptionCheck => {
      const check = goUsage(body, identity);
      if (check.status === "unknown") reason("usage_unavailable");
      return check;
    };
    // The model decides the billing route: another provider is never a subscription.
    const model = agent.model;
    const route = openCodeRoute(model);
    if (!route || !model) return unavailable("missing_model");
    if (route === "other") return { auth: "api", status: "unknown" };

    // The database is trusted only when it hosts the agent's own session. This covers a server on
    // another host, reached through PASEO_OPENCODE_SERVER_URL, without copying Paseo's selection.
    const sessionId = agent.sessionId;
    if (!sessionId) return unavailable("missing_session");

    if (route === "zen") {
      // A found row whose data is not JSON is passed as null, like a session with no idle record.
      const idle = await readDatabase<Idle>(launch.env, (db) => {
        if (!hostsSession(db, sessionId)) return { reason: "session_not_in_database" };
        const row = db.prepare(SESSION_IDLE).get(sessionId);
        if (!row) return { data: null };
        try { return { data: JSON.parse(String(row.data)) as unknown }; }
        catch { return { data: null }; }
      });
      if (!idle) return unavailable("database_unavailable");
      if ("reason" in idle) return unavailable(idle.reason);
      // The free route is local, so identity and usage modes read the same record and never fetch.
      const check = freeUsage(idle.data, at);
      if (check.auth === "unknown" && check.status === "unknown") reason("no_free_limit_record");
      return check;
    }

    const selection = await selectCredentials(launch.env, sessionId);
    if (!selection) return unavailable("database_unavailable");
    if ("reason" in selection) return unavailable(selection.reason);

    // The Console credential is OpenCode's first choice; a different Console server is not ours.
    // Selecting one that cannot serve Go stops here rather than falling back to another account.
    let consoleCandidate: GoCandidate | undefined;
    if (selection.console) {
      const classified = classifyRow(selection.console, "key");
      if (classified.kind === "oauth") return unavailable("oauth_credential");
      if (classified.kind === "invalid") return unavailable("invalid_credential");
      if (classified.kind === "candidate") {
        consoleCandidate = { key: classified.key, identity: dbIdentity(classified.id, classified.key, model) };
      }
    }

    // A present opencode-go row is authoritative: auth.json is only read when the table has none.
    let goCandidate: GoCandidate | undefined;
    if (selection.go) {
      const classified = classifyRow(selection.go, "key");
      if (classified.kind === "candidate") {
        goCandidate = { key: classified.key, identity: dbIdentity(classified.id, classified.key, model) };
      }
    } else {
      const entry = await readAuthEntry(launch.env);
      if (entry) {
        const classified = classifyCredential(entry, "api");
        if (classified.kind === "candidate") {
          goCandidate = { key: classified.key, identity: fileIdentity(classified.key, model) };
        }
      }
    }

    // Two possible keys bind only on the one a confirmed usage check used; none means no evidence.
    if (mode === "identity") {
      if (consoleCandidate && goCandidate) return { auth: "subscription", status: "unknown" };
      const single = consoleCandidate ?? goCandidate;
      if (!single) return unavailable(selection.go ? "invalid_credential" : "missing_credential");
      return { auth: "subscription", status: "unknown", identity: single.identity };
    }
    // The Console key is checked first; only a rejected one falls back to the opencode-go key.
    if (consoleCandidate) {
      const answer = await goAnswer(consoleCandidate.key);
      if (answer?.ok) return parseGoResult(answer.body, consoleCandidate.identity);
      if (goCandidate && answer && (answer.status === 401 || answer.status === 403)) {
        const retry = await goAnswer(goCandidate.key);
        if (retry?.ok) return parseGoResult(retry.body, goCandidate.identity);
      }
      // A temporary failure, or a rejected Console key with a failed fallback, never binds a Console key.
      reason("usage_unavailable");
      return { auth: "subscription", status: "unknown" };
    }
    // A dedicated opencode-go key answers alone; its own failure still belongs to it.
    if (goCandidate) {
      const answer = await goAnswer(goCandidate.key);
      return parseGoResult(answer?.ok ? answer.body : null, goCandidate.identity);
    }
    return unavailable(selection.go ? "invalid_credential" : "missing_credential");
  };
}
