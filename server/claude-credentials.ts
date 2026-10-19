import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt?: number;
}
export type ClaudeCredentialReader = (env: NodeJS.ProcessEnv) => Promise<ClaudeCredentials | null>;

const exec = promisify(execFile);
const SERVICE = "Claude Code-credentials";

function credentials(raw: string): ClaudeCredentials | null {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
    return { accessToken: oauth.accessToken, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined };
  } catch { return null; }
}

/**
 * Read the CLI's selected store without refreshing or writing credentials.
 * Storage contract: https://code.claude.com/docs/en/authentication#credential-management
 * Lookup reference: Paseo v0.12.0 plugins/claude-usage-source/server/usage.ts.
 * The secure-storage override and NFC suffix also match Claude Code 2.1.303's native selector.
 */
export function createClaudeCredentialReader(deps: {
  platform?: NodeJS.Platform;
  runSecurity?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  readFile?: (path: string) => Promise<string>;
} = {}): ClaudeCredentialReader {
  const platform = deps.platform ?? process.platform;
  const read = deps.readFile ?? ((path: string) => readFile(path, "utf8"));
  const runSecurity = deps.runSecurity ?? (async (args, env) =>
    (await exec("/usr/bin/security", args, { env, timeout: 2_000, maxBuffer: 1_048_576 })).stdout);

  return async (env) => {
    // An explicitly empty secure-storage override selects the default store, even with
    // CLAUDE_CONFIG_DIR set. Never probe another profile's Keychain item or fallback file.
    const directory = (env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR)?.normalize("NFC");
    if (platform === "darwin") {
      const service = SERVICE + (directory ? `-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}` : "");
      let username: string;
      try { username = env.USER || userInfo().username; } catch { username = "claude-code-user"; }
      const account = /^[a-zA-Z0-9._-]+$/.test(username) ? username : "claude-code-user";
      for (const selector of [["-a", account], []]) {
        try {
          const found = credentials(await runSecurity(["find-generic-password", ...selector, "-w", "-s", service], env));
          if (found) return found;
        } catch { /* Locked, denied or missing: try the same service's legacy lookup, then its file. */ }
      }
    }
    try { return credentials(await read(join(directory || join(env.HOME || homedir(), ".claude"), ".credentials.json"))); }
    catch { return null; }
  };
}
