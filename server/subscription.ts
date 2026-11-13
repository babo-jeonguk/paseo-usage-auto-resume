import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { PaseoAgent, PaseoApi } from "./paseo-types";
import type { UsageSource } from "../shared/settings";
import { providerLaunch } from "./usage";
import { createClaudeCredentialReader, type ClaudeCredentialReader } from "./claude-credentials";
import { CLI_STOP_GRACE_MS, cliHome, runCli, spawnCli, stopProcessTree } from "./cli-launch";
import { agyFallback, createAgyUsageReader } from "./agy-usage";
import { createOpenCodeUsageReader } from "./opencode-usage";
import { isExhausted, type QuotaWindow } from "./quota";

const TIMEOUT = 15_000;
/** Subscription credentials for unattended runs; probes use their values, which are never saved. */
const AUTOMATION_TOKENS = ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN"] as const;
const AUTH_ENV = [
  "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "GEMINI_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GEMINI_BASE_URL", ...AUTOMATION_TOKENS,
] as const;
// Claude's cloud switches are not secret, and their exact value matters: `0` turns one off.
const SAFE_ENV = [
  "HOME", "USERPROFILE", "USER", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
];
/** Stands in for a credential whose value is unavailable; it cannot authenticate. */
const PLACEHOLDER = "<present>";
/** Codex auth methods that name an access token rather than a saved ChatGPT login. */
const ACCESS_TOKEN_METHODS = ["personalAccessToken", "agentIdentity"];

/** Non-secret store selectors and credential-presence flags survive a restart; never a credential value. */
export interface LaunchContext {
  env: Record<string, string>;
  authEnv: Record<string, boolean>;
  /** A one-way fingerprint of each automation token the session had, so a restart can recognize it. */
  fingerprints?: Record<string, string>;
}
/** Automation token values a session opened with, kept in memory only. */
export type LaunchTokens = Readonly<Record<string, string>>;
export interface SubscriptionCheck {
  auth: "subscription" | "api" | "unknown";
  status: "ready" | "limited" | "unknown";
  /** Account/organization and model scope, hashed; independent of rotating access tokens. */
  identity?: string;
  windows?: QuotaWindow[];
}
export type SubscriptionReader = (
  api: Pick<PaseoApi, "config">, agent: PaseoAgent, source: UsageSource, at: Date, launch?: LaunchContext,
  mode?: "identity" | "usage", tokens?: LaunchTokens,
) => Promise<SubscriptionCheck>;

export const subscriptionModel = (agent: PaseoAgent): string | undefined =>
  string(agent.runtimeInfo?.model) ?? string(agent.model);

export const unknownCheck = (): SubscriptionCheck => ({ auth: "unknown", status: "unknown" });
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const hash = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const instant = (value: unknown): string | null => {
  const time = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** A one-way digest of a credential value; equal values give equal fingerprints. */
export const fingerprint = (name: string, value: string): string => hash("usage-auto-resume/token", name, value);

export function captureLaunch(request: Pick<PluginSessionOpenRequest, "env">): LaunchContext {
  const tokens = captureTokens(request);
  return {
    env: Object.fromEntries(SAFE_ENV.flatMap((key) => request.env[key] === undefined ? [] : [[key, request.env[key]!]])),
    authEnv: Object.fromEntries(AUTH_ENV.flatMap((key) => request.env[key] === undefined ? [] : [[key, !!request.env[key]]])),
    ...Object.keys(tokens).length
      ? { fingerprints: Object.fromEntries(Object.entries(tokens).map(([key, value]) => [key, fingerprint(key, value)])) } : {},
  };
}

/** The automation token values a session opened with. Keep them in memory only. */
export function captureTokens(request: Pick<PluginSessionOpenRequest, "env">): Record<string, string> {
  return Object.fromEntries(AUTOMATION_TOKENS.flatMap((key) => request.env[key] ? [[key, request.env[key]!]] : []));
}

/**
 * Credential flags become placeholders that cannot authenticate. An automation token is restored
 * from memory, else from the daemon or provider environment, only when its value has the
 * fingerprint the session recorded; otherwise its route stays unverified.
 */
function applyLaunch(base: NodeJS.ProcessEnv, launch: LaunchContext | undefined, tokens: LaunchTokens | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...launch?.env };
  for (const [key, present] of Object.entries(launch?.authEnv ?? {})) {
    env[key] = present ? PLACEHOLDER : "";
    const expected = present ? launch?.fingerprints?.[key] : undefined;
    if (!expected) continue;
    const value = [tokens?.[key], base[key]].find((candidate) => candidate && fingerprint(key, candidate) === expected);
    if (value) env[key] = value;
  }
  return env;
}

/** Uses native status and read-only endpoints; never requests model turns or token refresh. */
export function createSubscriptionReader(deps: {
  run?: typeof runCli;
  now?: () => number;
  codex?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<CodexSnapshot>;
  fetch?: typeof fetch;
  readClaudeCredentials?: ClaudeCredentialReader;
} = {}): SubscriptionReader {
  const run = deps.run ?? runCli;
  const fetchApi = deps.fetch ?? fetch;
  const codex = deps.codex ?? codexSnapshot;
  const readClaudeCredentials = deps.readClaudeCredentials ?? createClaudeCredentialReader();
  const readAgyUsage = createAgyUsageReader({ run: deps.run, now: deps.now });
  const readOpenCodeUsage = createOpenCodeUsageReader({ fetch: deps.fetch });

  const json = async (url: string, headers: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const response = await fetchApi(url, { headers, signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error("Usage unavailable");
      return record(await response.json());
    } finally { clearTimeout(timer); }
  };

  /** A status and body for an endpoint whose refusal carries meaning. */
  const answer = async (url: string, headers: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const response = await fetchApi(url, { headers, signal: controller.signal, redirect: "error" });
      return { status: response.status, body: record(await response.json().catch(() => null)) };
    } finally { clearTimeout(timer); }
  };

  return async (api, agent, source, at, launch, mode = "usage", tokens) => {
    let verifiedIdentity: string | undefined;
    try {
      const { config } = await api.config.get();
      const runtime = providerLaunch(config, agent.provider);
      // A missed session-open hook (a session opened before this plugin loaded) leaves the daemon
      // and provider environment, as v1.2.0 used; only values other session-open hooks add are unseen.
      const env = applyLaunch({ ...process.env, ...runtime.env }, launch, tokens);
      // Status probes must not claim a running runtime proxy or inherit a parent Claude session.
      for (const key of Object.keys(env)) if (key.startsWith("RUNTIME_PROXY_") || ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION"].includes(key)) delete env[key];
      const apiCheck: SubscriptionCheck = { auth: "api", status: "unknown" };
      // OpenCode routes by its selected model and reads its own SQLite data; the API-key checks
      // below describe the other CLIs' environments, not this one.
      if (source === "opencode") {
        return await readOpenCodeUsage(
          { env },
          { id: agent.id, model: subscriptionModel(agent), sessionId: agent.runtimeInfo?.sessionId ?? null },
          at, mode,
        );
      }
      // Stated resets only request identity. agy has none; quota is read when planning without
      // a reset and before delivery. The quota reader turns its own failures into the existing
      // notice behavior; a route that cannot be classified waits for verification like any other.
      if (source === "antigravity") {
        if (env.GEMINI_API_KEY || env.AGY_ADC_AUTH || env.GOOGLE_GEMINI_BASE_URL) return apiCheck;
        if (mode === "identity") return agyFallback();
        return await readAgyUsage({ command: runtime.command, cwd: agent.cwd, env }, subscriptionModel(agent), agent.id);
      }
      const model = subscriptionModel(agent);
      const options = { cwd: agent.cwd, env };
      const command = runtime.command ?? [source];
      // A configured one-command launcher can answer the same native status protocol. Arbitrary
      // command arguments are ambiguous.
      if (command.length !== 1) return unknownCheck();
      const binary = command[0]!;

      if (source === "codex") {
        // Codex's app-server reports the credential it uses; only the base URL is invisible to it.
        if (env.OPENAI_BASE_URL) return apiCheck;
        if (env.CODEX_ACCESS_TOKEN === PLACEHOLDER) return unknownCheck();
        const snapshot = await codex(binary, [], options);
        const method = record(snapshot.authStatus).authMethod;
        if (method === "apikey") return apiCheck;
        if (method !== "chatgpt" && !ACCESS_TOKEN_METHODS.includes(method as string)) return unknownCheck();
        const accountRead = record(snapshot.account), account = record(accountRead.account);
        if (account.type !== "chatgpt") return account.type ? apiCheck : unknownCheck();
        const resolved = record(record(snapshot.config).config);
        if ((resolved.model_provider ?? "openai") !== "openai") return apiCheck;
        const provider = record(record(resolved.model_providers).openai);
        if (provider.env_key || provider.experimental_bearer_token || provider.auth || provider.base_url ||
          provider.requires_openai_auth === false) return apiCheck;
        if (method !== "chatgpt") {
          // An access token's quota is read by Codex itself, which attaches the credential.
          if (!account.planType || !model) return unknownCheck();
          return codexRateLimits(snapshot.rateLimits, accountRead, model);
        }
        // The home Codex reports is the one it read; older versions leave it to the same defaults.
        const home = string(snapshot.home) ?? (env.CODEX_HOME || join(cliHome(env), ".codex"));
        const auth = record(await readJson(join(home, "auth.json")));
        if (auth.auth_mode !== "chatgpt") return unknownCheck();
        const tokens = record(auth.tokens);
        const token = string(tokens.access_token), accountId = string(tokens.account_id);
        if (!token || !accountId || !model) return unknownCheck();
        // account/read must describe the same saved login used for this read-only fetch.
        const claims = jwt(record(tokens).id_token);
        if (string(claims.email) && string(account.email) && claims.email !== account.email) return unknownCheck();
        verifiedIdentity = hash(source, accountId, model);
        if (mode === "identity") return { auth: "subscription", status: "unknown", identity: verifiedIdentity };
        const usage = await json("https://chatgpt.com/backend-api/wham/usage", {
          Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, Accept: "application/json",
        });
        if (usage.account_id !== accountId) return unknownCheck();
        return codexUsage(usage, verifiedIdentity, model);
      }

      // auth status cannot tell a gateway token from a setup token, and omits the base URL.
      if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) return apiCheck;
      const status = record(JSON.parse(await run(binary, ["auth", "status", "--json"], { ...options, timeoutMs: TIMEOUT, maxBytes: 2_000_000 })));
      if (status.apiProvider === "firstParty" && status.authMethod === "oauth_token") {
        // A setup token outranks a saved login, so only its own value is ever checked.
        const token = env.CLAUDE_CODE_OAUTH_TOKEN;
        if (!token || token === PLACEHOLDER || !model) return unknownCheck();
        const headers = {
          Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json",
        };
        const profile = await answer("https://api.anthropic.com/api/oauth/profile", headers);
        if (profile.status === 403 && record(record(profile.body.error).details).error_code === "oauth_scope_insufficient") {
          // Valid, but scoped to model requests: follow the notice like Antigravity, bound to this token.
          return { auth: "subscription", status: "ready", identity: hash(source, fingerprint("CLAUDE_CODE_OAUTH_TOKEN", token), model) };
        }
        if (profile.status !== 200) return unknownCheck();
        const account = record(profile.body.account), organization = record(profile.body.organization);
        if (!account.uuid || !organization.uuid) return unknownCheck();
        verifiedIdentity = hash(source, account.uuid, organization.uuid, model);
        if (mode === "identity") return { auth: "subscription", status: "unknown", identity: verifiedIdentity };
        return claudeUsage(await json("https://api.anthropic.com/api/oauth/usage", headers), verifiedIdentity, model);
      }
      if (status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") {
        return status.loggedIn === true ? apiCheck : unknownCheck();
      }
      if (!status.subscriptionType || !status.orgId || !status.email || !model) return unknownCheck();
      const credentials = await readClaudeCredentials(env, string(status.configDirectory));
      if (!credentials?.accessToken || (credentials.expiresAt ?? 0) <= at.getTime()) return unknownCheck();
      const token = credentials.accessToken;
      const headers = {
        Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json",
      };
      const profile = await json("https://api.anthropic.com/api/oauth/profile", headers);
      const account = record(profile.account), organization = record(profile.organization);
      if (!account.uuid || account.email !== status.email || organization.uuid !== status.orgId) return unknownCheck();
      verifiedIdentity = hash(source, account.uuid, organization.uuid, model);
      if (mode === "identity") return { auth: "subscription", status: "unknown", identity: verifiedIdentity };
      const usage = await json("https://api.anthropic.com/api/oauth/usage", headers);
      return claudeUsage(usage, verifiedIdentity, model);
    } catch {
      // stderr and API bodies can contain credentials. Log neither.
      return verifiedIdentity ? { auth: "subscription", status: "unknown", identity: verifiedIdentity } : unknownCheck();
    }
  };
}

async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
function jwt(value: unknown): Record<string, unknown> {
  try { return record(JSON.parse(Buffer.from(String(value).split(".")[1]!, "base64url").toString("utf8"))); }
  catch { return {}; }
}
function rolling(windows: QuotaWindow[], identity: string): SubscriptionCheck {
  if (!windows.length) return { auth: "subscription", status: "unknown", identity };
  return { auth: "subscription", status: windows.some(isExhausted) ? "limited" : "ready", identity, windows };
}

/**
 * Credits, spending controls and the reached-limit type only say whether usage could run past a
 * window. The exact model's availability, else the 5-hour and weekly windows, decide.
 */
export function codexUsage(usage: Record<string, unknown>, identity: string, model: string): SubscriptionCheck {
  const specific = record(record(usage.model_usage)[model]);
  if (specific.available === true) return { auth: "subscription", status: "ready", identity, windows: [] };
  if (specific.available === false) return {
    auth: "subscription", status: "limited", identity, windows: [{ id: `model:${model}`, usedPct: 100, resetAt: instant(specific.available_at) }],
  };
  const limit = record(usage.rate_limit);
  const windows = ["primary_window", "secondary_window"].flatMap((id) => {
    const value = record(limit[id]), used = number(value.used_percent);
    return used === undefined ? [] : [{ id, usedPct: used, resetAt: instant(value.reset_at) }];
  });
  return rolling(windows, identity);
}

/**
 * An access token's quota as Codex's app-server reads it. The backend's own usage permission
 * decides when given; otherwise the stopped model's bucket, else the `codex` bucket, decides as
 * rolling windows do. The workspace and user name the seat; the token does not, so rotating it
 * keeps the reservation.
 */
export function codexRateLimits(response: unknown, accountRead: Record<string, unknown>, model: string): SubscriptionCheck {
  const limits = record(response);
  const accountId = string(limits.accountId), userId = string(accountRead.userId);
  const routed = string(record(accountRead.workspaceRouting).chatgptAccountId);
  if (!accountId || !userId || (routed && routed !== accountId)) return { auth: "subscription", status: "unknown" };
  const identity = hash("codex", accountId, userId, model);
  const buckets = Object.values(record(limits.rateLimitsByLimitId)).map(record);
  const bucket = buckets.find((entry) => entry.normalModelSlug === model) ?? record(limits.rateLimits);
  const windows = ["primary", "secondary"].flatMap((id) => {
    const value = record(bucket[id]), used = number(value.usedPercent);
    return used === undefined ? [] : [{ id: `${string(bucket.limitId) ?? "codex"}:${id}`, usedPct: used, resetAt: instant(value.resetsAt) }];
  });
  if (limits.ordinaryUsageAllowed === true) return { auth: "subscription", status: "ready", identity, windows };
  if (limits.ordinaryUsageAllowed === false) return { auth: "subscription", status: "limited", identity, windows };
  return rolling(windows, identity);
}

export function claudeUsage(usage: Record<string, unknown>, identity: string, model: string): SubscriptionCheck {
  const windows: QuotaWindow[] = [];
  for (const [key, value] of Object.entries(usage)) {
    if (key !== "five_hour" && key !== "seven_day" && !key.startsWith("seven_day_")) continue;
    if (key.startsWith("seven_day_") && !model.toLowerCase().includes(key.slice(10))) continue;
    const window = record(value), used = number(window.utilization);
    if (used !== undefined) windows.push({ id: key, usedPct: used, resetAt: instant(window.resets_at) });
  }
  if (Array.isArray(usage.limits)) for (const entry of usage.limits) {
    const limit = record(entry), scope = record(limit.scope);
    let id: string;
    if (limit.kind === "session" || limit.kind === "weekly_all") id = limit.kind === "session" ? "five_hour" : "seven_day";
    else if (limit.kind === "weekly_scoped") {
      const selected = record(scope.model), surface = record(scope.surface);
      const name = string(selected.display_name) ?? string(selected.id);
      const surfaceName = string(surface.display_name) ?? string(surface.id);
      if (surfaceName && !/^(claude[ _-]?)?code$/i.test(surfaceName)) continue;
      if (name && !model.toLowerCase().replace(/[^a-z0-9]/g, "").includes(name.toLowerCase().replace(/[^a-z0-9]/g, ""))) continue;
      if (!name && !surfaceName) return { auth: "subscription", status: "unknown", identity };
      id = name ? `seven_day_${name.toLowerCase()}` : "surface:claude-code";
    } else return { auth: "subscription", status: "unknown", identity };
    const usedPct = number(limit.percent);
    if (usedPct === undefined) return { auth: "subscription", status: "unknown", identity };
    const index = windows.findIndex((w) => w.id === id);
    const window = { id, usedPct, resetAt: instant(limit.resets_at) ?? (index >= 0 ? windows[index]!.resetAt : null) };
    if (index >= 0) windows[index] = window; else windows.push(window);
  }
  return rolling(windows, identity);
}

interface CodexSnapshot {
  account: unknown;
  config: unknown;
  /** `codexHome` from the initialize response, where this Codex keeps its login. */
  home?: unknown;
  /** `getAuthStatus` without tokens; undefined when Codex refused it. */
  authStatus?: unknown;
  /** `account/rateLimits/read`, asked only of an access token; undefined when refused. */
  rateLimits?: unknown;
}

/**
 * Read configuration, account and auth method without creating a thread or refreshing the login,
 * all in one app-server session; an access token also gets its rate limits there. Loading a
 * legacy agent-identity token registers an agent task, as the agent's own runs do.
 */
async function codexSnapshot(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawnCli(command, [...args, "app-server", "--stdio"], options);
  return await new Promise<CodexSnapshot>((resolve, reject) => {
    let buffer = "", bytes = 0, settled = false;
    const responses = new Map<number, unknown>();
    // Requests a Codex may refuse: their answer is read as missing, never as a failed probe.
    const optional = new Set([4, 5]);
    let wanted = [2, 3, 4];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); child.stdin.end();
      const snapshot = {
        account: responses.get(2), config: responses.get(3), home: record(responses.get(1)).codexHome,
        authStatus: responses.get(4), rateLimits: responses.get(5),
      };
      void stopProcessTree(child, { graceMs: CLI_STOP_GRACE_MS }).then(() => { if (error) reject(error); else resolve(snapshot); });
    };
    const timer = setTimeout(() => finish(new Error("Status timeout")), TIMEOUT);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", () => finish(new Error("Status unavailable")));
    child.stdin.on("error", () => finish(new Error("Status input closed")));
    child.on("exit", () => { if (!wanted.every((id) => responses.has(id))) finish(new Error("Status closed")); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2_000_000) { finish(new Error("Status too large")); return; }
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let frame: Record<string, unknown>;
        try { frame = record(JSON.parse(line)); } catch { continue; }
        if (typeof frame.id !== "number") continue;
        if (frame.error && !optional.has(frame.id)) { finish(new Error("Unsupported status")); return; }
        responses.set(frame.id, frame.error ? undefined : frame.result);
        if (frame.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
          send({ id: 3, method: "config/read", params: { cwd: options.cwd, includeLayers: false } });
          send({ id: 4, method: "getAuthStatus", params: { includeToken: false, refreshToken: false } });
        }
        if (frame.id === 4 && ACCESS_TOKEN_METHODS.includes(record(frame.result).authMethod as string)) {
          wanted = [...wanted, 5];
          send({ id: 5, method: "account/rateLimits/read" });
        }
        if (wanted.every((id) => responses.has(id))) { finish(); return; }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "usage_auto_resume_status", version: "1.0" } } });
  });
}
