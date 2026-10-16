import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { PaseoAgent, PaseoApi } from "./paseo-types";
import type { UsageSource } from "../shared/settings";
import { providerLaunch } from "./usage";

const exec = promisify(execFile);
const TIMEOUT = 15_000;
const AUTH_ENV = [
  "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "GEMINI_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GEMINI_BASE_URL",
] as const;
const SAFE_ENV = ["HOME", "USERPROFILE", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];

/** Only paths and credential-presence flags survive a restart; never a credential value. */
export interface LaunchContext {
  env: Record<string, string>;
  authEnv: Record<string, boolean>;
}
export interface QuotaWindow { id: string; usedPct: number; resetAt: string | null }
export interface SubscriptionCheck {
  auth: "subscription" | "api" | "unknown";
  status: "ready" | "limited" | "credits" | "unknown";
  /** Account/organization and model scope, hashed; independent of rotating access tokens. */
  identity?: string;
  windows?: QuotaWindow[];
  reason?: string;
  /** Affirmative readiness for a previously credit-blocked request, not just a quota countdown. */
  creditRecovery?: boolean;
}
export type SubscriptionReader = (
  api: Pick<PaseoApi, "config">, agent: PaseoAgent, source: UsageSource, at: Date, launch?: LaunchContext,
) => Promise<SubscriptionCheck>;

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

export function captureLaunch(request: Pick<PluginSessionOpenRequest, "env">): LaunchContext {
  return {
    env: Object.fromEntries(SAFE_ENV.flatMap((key) => request.env[key] === undefined ? [] : [[key, request.env[key]!]])),
    authEnv: Object.fromEntries(AUTH_ENV.flatMap((key) => request.env[key] === undefined ? [] : [[key, !!request.env[key]]])),
  };
}

/** Uses native status and read-only endpoints; never requests model turns or token refresh. */
export function createSubscriptionReader(deps: {
  run?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string>;
  codex?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ account: unknown; config: unknown }>;
  fetch?: typeof fetch;
} = {}): SubscriptionReader {
  const run = deps.run ?? (async (command, args, options) =>
    (await exec(command, args, { ...options, timeout: TIMEOUT, maxBuffer: 2_000_000 })).stdout);
  const fetchApi = deps.fetch ?? fetch;
  const codex = deps.codex ?? codexSnapshot;

  const json = async (url: string, headers: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const response = await fetchApi(url, { headers, signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error("Usage unavailable");
      return record(await response.json());
    } finally { clearTimeout(timer); }
  };

  return async (api, agent, source, at, launch) => {
    // A missed session-open hook means per-agent overrides are unknown. Preserve the job and wait.
    if (!launch) return unknownCheck();
    let verifiedIdentity: string | undefined;
    try {
      const { config } = await api.config.get();
      const runtime = providerLaunch(config, agent.provider);
      const env: NodeJS.ProcessEnv = { ...process.env, ...runtime.env, ...launch.env };
      for (const [key, present] of Object.entries(launch.authEnv)) env[key] = present ? "<present>" : "";
      // Status probes must not claim a running runtime proxy or inherit a parent Claude session.
      for (const key of Object.keys(env)) if (key.startsWith("RUNTIME_PROXY_") || ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION"].includes(key)) delete env[key];
      const model = string(agent.runtimeInfo?.model) ?? string(agent.model);
      const options = { cwd: agent.cwd, env };
      const command = runtime.command ?? [source === "antigravity" ? "agy" : source];
      // A configured one-command launcher can answer the same native status protocol. Arbitrary
      // command arguments are ambiguous; agy's print probes additionally require the native CLI.
      if (command.length !== 1 || source === "antigravity" && basename(command[0]!).replace(/\.exe$/i, "") !== "agy") return unknownCheck();
      const binary = command[0]!;
      const apiCheck: SubscriptionCheck = { auth: "api", status: "unknown" };

      if (source === "codex") {
        if (env.OPENAI_BASE_URL || env.CODEX_API_KEY || env.CODEX_ACCESS_TOKEN) return apiCheck;
        const snapshot = await codex(binary, [], options);
        const account = record(record(snapshot.account).account);
        if (account.type !== "chatgpt") return account.type ? apiCheck : unknownCheck();
        const resolved = record(record(snapshot.config).config);
        if ((resolved.model_provider ?? "openai") !== "openai") return apiCheck;
        const provider = record(record(resolved.model_providers).openai);
        if (provider.env_key || provider.experimental_bearer_token || provider.auth || provider.base_url ||
          provider.requires_openai_auth === false) return apiCheck;
        const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
        const auth = record(await readJson(join(home, "auth.json")));
        if (auth.auth_mode !== "chatgpt") return unknownCheck();
        const tokens = record(auth.tokens);
        const token = string(tokens.access_token), accountId = string(tokens.account_id);
        if (!token || !accountId || !model) return unknownCheck();
        // account/read must describe the same saved login used for this read-only fetch.
        const claims = jwt(record(tokens).id_token);
        if (string(claims.email) && string(account.email) && claims.email !== account.email) return unknownCheck();
        verifiedIdentity = hash(source, accountId, model);
        const usage = await json("https://chatgpt.com/backend-api/wham/usage", {
          Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, Accept: "application/json",
        });
        if (usage.account_id !== accountId) return unknownCheck();
        return codexUsage(usage, verifiedIdentity, model);
      }

      if (source === "claude") {
        if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL || env.CLAUDE_CODE_OAUTH_TOKEN ||
          [env.CLAUDE_CODE_USE_BEDROCK, env.CLAUDE_CODE_USE_VERTEX, env.CLAUDE_CODE_USE_FOUNDRY].some((v) => v && v !== "0" && v !== "false")) return apiCheck;
        const status = record(JSON.parse(await run(binary, ["auth", "status", "--json"], options)));
        if (status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") {
          return status.loggedIn === true ? apiCheck : unknownCheck();
        }
        if (!status.subscriptionType || !status.orgId || !status.email || !model || process.platform === "darwin") return unknownCheck();
        const home = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
        const credentials = record(record(await readJson(join(home, ".credentials.json"))).claudeAiOauth);
        const token = string(credentials.accessToken);
        if (!token || (number(credentials.expiresAt) ?? 0) <= at.getTime()) return unknownCheck();
        const headers = {
          Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json",
        };
        const profile = await json("https://api.anthropic.com/api/oauth/profile", headers);
        const account = record(profile.account), organization = record(profile.organization);
        if (!account.uuid || account.email !== status.email || organization.uuid !== status.orgId) return unknownCheck();
        verifiedIdentity = hash(source, account.uuid, organization.uuid, model);
        const usage = await json("https://api.anthropic.com/api/oauth/usage", headers);
        return claudeUsage(usage, verifiedIdentity, model);
      }

      if (env.GEMINI_API_KEY || env.AGY_ADC_AUTH || env.GOOGLE_GEMINI_BASE_URL) return apiCheck;
      if (!model) return unknownCheck();
      const version = /^(\d+)\.(\d+)\.(\d+)/.exec((await run(binary, ["--version"], options)).trim());
      if (!version || Number(version[1]) !== 1 || Number(version[2]) < 1 || (Number(version[2]) === 1 && Number(version[3]) < 15)) return unknownCheck();
      const configResult = commandData(await run(binary, ["-p", "/config", "--output-format", "json"], options), "config");
      const settings = record(configResult.config);
      if (settings.modelProvider !== "antigravity" && settings.modelProvider !== "") return unknownCheck();
      if (record(settings.userSettings).enableAdc || settings.enableAdc) return apiCheck;
      const data = commandData(await run(binary, ["-p", "/usage", "--output-format", "json"], options), "usage");
      // Quota groups are authoritative; never infer five hours from the countdown.
      const accountId = string(data.account_id) ?? string(settings.account);
      // Current agy versions may omit identity. A home directory is not an account identity.
      if (!accountId) return unknownCheck();
      return antigravityUsage(data, hash(source, accountId, model), model);
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
function commandData(output: string, name: string): Record<string, unknown> {
  const frame = record(JSON.parse(output)), command = record(frame.command);
  if (frame.status !== "SUCCESS" || frame.num_turns !== 0 || command.name !== name) throw new Error("Unsupported read-only response");
  return record(command.data);
}

function rolling(windows: QuotaWindow[], identity: string): SubscriptionCheck {
  if (!windows.length) return { auth: "subscription", status: "unknown", identity };
  return { auth: "subscription", status: windows.some((w) => w.usedPct >= 100) ? "limited" : "ready", identity, windows };
}

export function codexUsage(usage: Record<string, unknown>, identity: string, model: string): SubscriptionCheck {
  const base = { auth: "subscription" as const, identity };
  if (record(usage.spend_control).reached === true) return { ...base, status: "credits", reason: "Workspace spending limit" };
  const specific = record(record(usage.model_usage)[model]);
  const type = record(usage.rate_limit_reached_type).type;
  if (specific.available === true) return { ...base, status: "ready", windows: [], creditRecovery: record(usage.spend_control).reached === false };
  if (specific.available === false) return {
    ...base, status: "limited", windows: [{ id: `model:${model}`, usedPct: 100, resetAt: instant(specific.available_at) }],
  };
  if (typeof type === "string" && /workspace_.*(?:credits_depleted|usage_limit_reached)/.test(type)) {
    return { ...base, status: "credits", reason: "Workspace credits or spending limit" };
  }
  if (type != null && type !== "rate_limit_reached") return { ...base, status: "unknown" };
  const limit = record(usage.rate_limit);
  const windows = ["primary_window", "secondary_window"].flatMap((id) => {
    const value = record(limit[id]), used = number(value.used_percent);
    return used === undefined ? [] : [{ id, usedPct: used, resetAt: instant(value.reset_at) }];
  });
  if (limit.allowed === true && limit.limit_reached === false && windows.length && windows.every((w) => w.usedPct < 100)) return { ...base, status: "ready", windows };
  if (limit.limit_reached === true && windows.some((w) => w.usedPct >= 100)) return { ...base, status: "limited", windows };
  return { ...base, status: "unknown", windows };
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

export function antigravityUsage(data: Record<string, unknown>, identity: string, model: string): SubscriptionCheck {
  const groups = Array.isArray(data.groups) ? data.groups.map(record) : [];
  const name = /argon/i.test(model) ? "Gemini 4 Argon" : /gemini/i.test(model) ? "Gemini Models" : /claude|gpt/i.test(model) ? "Claude and GPT models" : null;
  const group = groups.find((g) => g.name === name);
  if (!group) return { auth: "subscription", status: "unknown", identity };
  const buckets = Array.isArray(group.buckets) ? group.buckets.map(record) : [];
  const windows = buckets.flatMap((b): QuotaWindow[] => {
    if (b.disabled === true) return [];
    const remaining = number(b.remaining_fraction);
    return remaining === undefined ? [] : [{ id: String(b.id), usedPct: 100 * (1 - remaining), resetAt: instant(b.reset_time) }];
  });
  return rolling(windows, identity);
}

/** Read configuration and account without creating a thread or refreshing the login. */
async function codexSnapshot(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(command, [...args, "app-server", "--stdio"], { ...options, stdio: ["pipe", "pipe", "ignore"] });
  return await new Promise<{ account: unknown; config: unknown }>((resolve, reject) => {
    let buffer = "", bytes = 0, settled = false;
    const responses = new Map<number, unknown>();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); child.kill();
      if (error) reject(error); else resolve({ account: responses.get(2), config: responses.get(3) });
    };
    const timer = setTimeout(() => finish(new Error("Status timeout")), TIMEOUT);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", () => finish(new Error("Status unavailable")));
    child.stdin.on("error", () => finish(new Error("Status input closed")));
    child.on("exit", () => { if (responses.size < 3) finish(new Error("Status closed")); });
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
        if (frame.error) { finish(new Error("Unsupported status")); return; }
        responses.set(frame.id, frame.result);
        if (frame.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
          send({ id: 3, method: "config/read", params: { cwd: options.cwd, includeLayers: false } });
        }
        if (responses.has(2) && responses.has(3)) { finish(); return; }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "usage_auto_resume_status", version: "1.0" } } });
  });
}
