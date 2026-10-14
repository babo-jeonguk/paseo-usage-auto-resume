import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { UsageSource } from "../shared/settings";

type UsageApi = Pick<PaseoApi, "config" | "providers">;
type UsageEntry = Awaited<ReturnType<PaseoApi["providers"]["listUsage"]>>["providers"][number];
type UsageWindow = UsageEntry["windows"][number];
type DaemonConfig = Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"];

/** The usage source that reports an agent's subscription, and the account the agent signs in as. */
interface Account {
  sourceId: string;
  email: string | null;
}

const FIVE_HOUR_WINDOW = /five_hour|5h|5-hour|five hour|session|primary/i;
const FIVE_HOURS_MS = 5 * 3_600_000;

function providerEnv(config: DaemonConfig, provider: string): Record<string, unknown> {
  let env: Record<string, unknown> = {};
  const visited = new Set<string>();
  let id: string | undefined = provider;
  while (id) {
    if (visited.has(id)) throw new Error("Cyclic provider inheritance");
    visited.add(id);
    const entry = config.providers[id] as { extends?: string; env?: Record<string, unknown> } | undefined;
    // The selected alias overrides its ancestors, just as its CLI launch does.
    env = { ...entry?.env, ...env };
    id = entry?.extends;
  }
  return env;
}

function envValue(env: Record<string, unknown>, key: string): string | null {
  const value = env[key] ?? process.env[key];
  return typeof value === "string" && value ? value : null;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function jwtClaims(token: unknown): unknown {
  const payload = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Claude Code records the signed-in account in `.claude.json`: in the config dir when set, else the home. */
async function claudeEmail(configDir: string | null): Promise<string | null> {
  const file = configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
  return text(field(field(await readJson(file), "oauthAccount"), "emailAddress"));
}

/** Reads only the email claims of the Codex login, in the order Paseo's Codex usage source labels it. */
async function codexEmail(codexHome: string): Promise<string | null> {
  const tokens = field(await readJson(join(codexHome, "auth.json")), "tokens");
  const access = jwtClaims(field(tokens, "access_token"));
  const id = jwtClaims(field(tokens, "id_token"));
  return (
    text(field(field(access, "https://api.openai.com/profile"), "email")) ??
    text(field(access, "email")) ??
    text(field(field(id, "https://api.openai.com/profile"), "email")) ??
    text(field(id, "email"))
  );
}

function extractEmailFromObject(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const direct =
    text(field(data, "email")) ??
    text(field(field(data, "user"), "email")) ??
    text(field(field(data, "account"), "email")) ??
    text(field(field(data, "oauthAccount"), "emailAddress"));
  if (direct) return direct;

  const tokens = field(data, "tokens") ?? field(data, "token") ?? data;
  const access = jwtClaims(field(tokens, "access_token") ?? field(data, "access_token"));
  const id = jwtClaims(field(tokens, "id_token") ?? field(data, "id_token"));

  return (
    text(field(id, "email")) ??
    text(field(access, "email")) ??
    text(field(field(access, "https://api.openai.com/profile"), "email")) ??
    text(field(field(id, "https://api.openai.com/profile"), "email"))
  );
}

/** Antigravity stores CLI configuration under `~/.gemini/antigravity-cli`, or a configured directory. */
async function antigravityEmail(configDir: string | null): Promise<string | null> {
  const fileNames = ["auth.json", "credentials.json", "settings.json", ".antigravity.json"];
  if (configDir) {
    if (configDir.endsWith(".json")) {
      const email = extractEmailFromObject(await readJson(configDir));
      if (email) return email;
    }
    for (const name of fileNames) {
      const email = extractEmailFromObject(await readJson(join(configDir, name)));
      if (email) return email;
    }
  }

  const defaultDirs = [
    join(homedir(), ".gemini", "antigravity-cli"),
    join(homedir(), ".antigravity"),
    join(homedir(), ".gemini"),
  ];

  for (const dir of defaultDirs) {
    for (const name of fileNames) {
      const email = extractEmailFromObject(await readJson(join(dir, name)));
      if (email) return email;
    }
  }

  return null;
}

/** The account an agent of this provider runs under, read from the same home its CLI uses. */
async function accountFor(paseo: UsageApi, provider: string, source: UsageSource): Promise<Account> {
  const { config } = await paseo.config.get();
  const env = providerEnv(config, provider);
  if (source === "codex") {
    const codexHome = envValue(env, "CODEX_HOME") ?? join(homedir(), ".codex");
    return { sourceId: "codex", email: await codexEmail(codexHome) };
  }
  if (source === "antigravity") {
    const configDir =
      envValue(env, "ANTIGRAVITY_CONFIG_DIR") ??
      envValue(env, "ANTIGRAVITY_HOME") ??
      envValue(env, "GEMINI_CONFIG_DIR");
    return { sourceId: "antigravity", email: await antigravityEmail(configDir) };
  }
  return { sourceId: "claude", email: await claudeEmail(envValue(env, "CLAUDE_CONFIG_DIR")) };
}

/**
 * Since Paseo 0.11 each usage source lists one entry per signed-in account, labeled
 * `<source> (<email>)`, including accounts other agents run under (Claude Sub's home, OpenCode's
 * ChatGPT login). Only the entry for the agent's own account describes its limit.
 */
function entryForAccount(entries: readonly UsageEntry[], account: Account): UsageEntry | null {
  if (!account.email) return null;
  const suffix = ` (${account.email.toLowerCase()})`;
  return (
    entries.find(
      (entry) => entry.providerId === account.sourceId && entry.displayName.toLowerCase().endsWith(suffix),
    ) ?? null
  );
}

function usedPercent(window: UsageWindow): number | null {
  if (typeof window.usedPct === "number") return window.usedPct;
  if (typeof window.remainingPct === "number") return 100 - window.remainingPct;
  return null;
}

/** Picks the window holding the agent back: an exhausted one, else its 5-hour/session window. */
export function resetFromWindows(windows: readonly UsageWindow[], now: Date): Date | null {
  const future = windows
    .map((window) => ({ window, resetAt: window.resetsAt ? new Date(window.resetsAt) : null }))
    .filter((entry): entry is { window: UsageWindow; resetAt: Date } =>
      entry.resetAt !== null && entry.resetAt.getTime() > now.getTime(),
    );
  const exhausted = future.filter((entry) => (usedPercent(entry.window) ?? 0) >= 100);
  if (exhausted.length > 0) {
    // Every exhausted window must renew before the agent can work again.
    return new Date(Math.max(...exhausted.map((entry) => entry.resetAt.getTime())));
  }
  const session = future.find(
    (entry) =>
      FIVE_HOUR_WINDOW.test(`${entry.window.id} ${entry.window.label}`) &&
      entry.resetAt.getTime() - now.getTime() <= FIVE_HOURS_MS,
  );
  return session?.resetAt ?? null;
}

/** Reset instant from the account's Paseo usage windows, or null when it cannot be known. */
export async function usageResetAt(paseo: UsageApi, provider: string, source: UsageSource, now: Date): Promise<Date | null> {
  try {
    const account = await accountFor(paseo, provider, source);
    if (!account?.email) return null;
    const { providers } = await paseo.providers.listUsage();
    const entry = entryForAccount(providers, account);
    if (!entry || entry.status !== "available") return null;
    return resetFromWindows(entry.windows, now);
  } catch (error) {
    console.error("[usage-auto-resume] could not read usage windows", String(error));
    return null;
  }
}
