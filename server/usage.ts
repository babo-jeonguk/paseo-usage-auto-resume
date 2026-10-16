import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "./paseo-types";
import type { UsageSource } from "../shared/settings";

export type DaemonConfig = Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"];

/** The usage source that reports an agent's subscription, and the account the agent signs in as. */
interface Account {
  sourceId: string;
  email: string | null;
}

function providerEnv(config: DaemonConfig, provider: string): Record<string, unknown> {
  let env: Record<string, unknown> = {};
  const visited = new Set<string>();
  let id: string | undefined = provider;
  while (id) {
    if (visited.has(id)) throw new Error("Cyclic provider inheritance");
    visited.add(id);
    const entry = config.providers[id] as { extends?: string; env?: Record<string, unknown> } | undefined;
    // A provider overrides its ancestors, just as its CLI launch does.
    env = { ...entry?.env, ...env };
    id = entry?.extends;
  }
  return env;
}

/** Follow the same provider inheritance as the daemon; command is replaced, env is merged. */
export function providerLaunch(config: DaemonConfig, provider: string): { env: Record<string, string>; command?: string[] } {
  const env = Object.fromEntries(Object.entries(providerEnv(config, provider)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const visited = new Set<string>();
  let id: string | undefined = provider;
  while (id) {
    if (visited.has(id)) throw new Error("Cyclic provider inheritance");
    visited.add(id);
    const entry = config.providers[id] as { extends?: string; command?: string[] } | undefined;
    if (entry?.command) return { env, command: entry.command };
    id = entry?.extends;
  }
  return { env };
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

/** The account an agent of this provider runs under, read from the same home its CLI uses. */
async function accountIn(config: DaemonConfig, provider: string, source: Exclude<UsageSource, "antigravity">): Promise<Account> {
  const env = providerEnv(config, provider);
  if (source === "codex") {
    const codexHome = envValue(env, "CODEX_HOME") ?? join(homedir(), ".codex");
    return { sourceId: "codex", email: await codexEmail(codexHome) };
  }
  return { sourceId: "claude", email: await claudeEmail(envValue(env, "CLAUDE_CONFIG_DIR")) };
}

/** The email an agent of this provider signs in as, or null when it cannot be read. */
export async function accountEmail(
  config: DaemonConfig,
  provider: string,
  source: Exclude<UsageSource, "antigravity">,
): Promise<string | null> {
  return (await accountIn(config, provider, source)).email;
}
