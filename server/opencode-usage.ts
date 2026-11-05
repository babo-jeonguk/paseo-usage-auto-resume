import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isExhausted, type QuotaWindow } from "./quota";
import { unknownCheck, type SubscriptionCheck } from "./subscription";

const USAGE_TIMEOUT_MS = 15_000;
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const GO_CREDENTIAL = "SELECT id, value FROM credential WHERE integration_id = 'opencode-go' ORDER BY active DESC, time_created DESC, id DESC LIMIT 1";
const GO_WINDOWS = ["rolling", "weekly", "monthly"] as const;
const SESSION_HOST = "SELECT 1 FROM session_v2 WHERE id = ? LIMIT 1";
const SESSION_IDLE = "SELECT data FROM session_message WHERE session_id = ? AND type = 'idle' ORDER BY seq DESC LIMIT 1";
const BALANCE_TYPES = new Set(["provider.budget-limit", "provider.model-budget-limit", "provider.quota"]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
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

type Credential = { id: string; key: string } | { reason: "session_not_in_database" | "missing_credential" | "invalid_credential" };
type Idle = { data: unknown } | { reason: "session_not_in_database" };

/** Whether this database is the runtime that hosts the agent, not another server's. */
const hostsSession = (db: DatabaseSync, sessionId: string): boolean =>
  db.prepare(SESSION_HOST).get(sessionId) !== undefined;

/** The Go credential OpenCode would select: active rows first, then the newest legacy import. */
async function goCredential(env: NodeJS.ProcessEnv, sessionId: string): Promise<Credential | null> {
  return await readDatabase(env, (db) => {
    if (!hostsSession(db, sessionId)) return { reason: "session_not_in_database" as const };
    const row = db.prepare(GO_CREDENTIAL).get();
    if (!row) return { reason: "missing_credential" as const };
    let value: Record<string, unknown> = {};
    try { value = record(JSON.parse(String(row.value))); } catch { /* not JSON */ }
    const id = string(row.id), key = string(value.key);
    // Never fall back past OpenCode's selected row: anything but a key stays unverified.
    return id && value.type === "key" && key ? { id, key } : { reason: "invalid_credential" as const };
  });
}

/** Why usage gave no evidence; each is logged as is, never with output, keys or rows. */
type Unavailable = "missing_model" | "database_unavailable" | "session_not_in_database" | "missing_credential" | "invalid_credential" | "usage_unavailable" | "missing_session" | "no_free_limit_record";

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

  /** The Go usage answer, or null when the call failed or was not JSON. */
  async function goBody(key: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
    try {
      const response = await fetchApi(GO_USAGE_URL, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    } finally { clearTimeout(timer); }
  }

  return async (launch: OpenCodeLaunch, agent: OpenCodeAgent, at: Date, mode: "identity" | "usage"): Promise<SubscriptionCheck> => {
    const reason = (why: Unavailable) => log(`opencode usage unavailable for ${agent.id}: ${why}`);
    const unavailable = (why: Unavailable) => {
      reason(why);
      return unknownCheck();
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

    const credential = await goCredential(launch.env, sessionId);
    if (!credential) return unavailable("database_unavailable");
    if ("reason" in credential) return unavailable(credential.reason);
    // The key is hashed separately so identity changes when OpenCode replaces it, without keeping
    // the key itself in any result or log.
    const keyHash = createHash("sha256").update(credential.key).digest("hex");
    const identity = createHash("sha256").update(JSON.stringify(["opencode", "go", credential.id, keyHash, model])).digest("hex");
    if (mode === "identity") return { auth: "subscription", status: "unknown", identity };
    const check = goUsage(await goBody(credential.key), identity);
    if (check.status === "unknown") reason("usage_unavailable");
    return check;
  };
}
