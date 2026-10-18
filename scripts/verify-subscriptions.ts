/** Opt-in, read-only checks of this host's configured providers. Never sends a model prompt. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cliFor } from "../server/providers";
import type { PaseoAgent, PaseoApi } from "../server/paseo-types";
import { createSubscriptionReader } from "../server/subscription";
import { providerLaunch } from "../server/usage";

async function main() {
  if (!process.argv.includes("--live")) {
    throw new Error("Pass --live to inspect local CLI authentication and contact read-only usage endpoints.");
  }
  const configFile = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "config.json");
  const saved = JSON.parse(await readFile(configFile, "utf8"));
  const providers = saved.agents?.providers ?? saved.providers ?? {};
  const api = { config: { get: async () => ({ config: { providers } }) } } as unknown as Pick<PaseoApi, "config">;
  const exec = promisify(execFile);
  const results: unknown[] = [];
  let verificationFailed = false;
  const selected = process.argv.find((arg) => arg.startsWith("--provider="))?.slice("--provider=".length);
  for (const provider of [...new Set(["codex", "claude", "antigravity", ...Object.keys(providers)])]) {
    if (selected && provider !== selected) continue;
    const source = cliFor((await api.config.get()).config, provider);
    if (!source) continue;
    const requests: Array<{ endpoint: string; status?: number; failed?: boolean }> = [];
    let nativeStatus: Record<string, unknown> | undefined;
    let observedPlan: string | undefined;
    let credentialState: string | undefined;
    if (source === "claude") {
      const env = { ...process.env, ...providerLaunch((await api.config.get()).config, provider).env };
      try {
        const path = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), ".credentials.json");
        const oauth = JSON.parse(await readFile(path, "utf8")).claudeAiOauth;
        credentialState = !oauth?.accessToken ? "missing-token" : typeof oauth.expiresAt !== "number" ? "missing-expiry"
          : oauth.expiresAt <= Date.now() ? "expired" : "unexpired";
      } catch { credentialState = "unreadable"; }
    }
    const read = createSubscriptionReader({
      run: async (command, args, options) => {
        const { stdout } = await exec(command, args, { ...options, timeout: 20_000, maxBuffer: 2_000_000 });
        const status = JSON.parse(stdout);
        // Deliberately omit email, organization identifiers, tokens and raw CLI output.
        nativeStatus = Object.fromEntries(["loggedIn", "authMethod", "apiProvider", "subscriptionType"].map((key) => [key, status[key] ?? null]));
        nativeStatus.hasOrgId = !!status.orgId;
        nativeStatus.hasEmail = !!status.email;
        return stdout;
      },
      fetch: async (url, options) => {
        const request: (typeof requests)[number] = { endpoint: String(url) };
        requests.push(request);
        try {
          const response = await fetch(url, options);
          request.status = response.status;
          if (source === "codex" && response.ok) {
            const data = await response.clone().json() as { plan_type?: unknown };
            if (typeof data.plan_type === "string" && /^[a-z_ -]{1,40}$/i.test(data.plan_type)) observedPlan = data.plan_type;
          }
          return response;
        } catch {
          request.failed = true;
          throw new Error("Read-only endpoint unavailable");
        }
      },
    });
    const model = source === "codex" ? "gpt-6-astra" : source === "claude" ? "claude-opus-4-6" : "gemini-pro";
    const check = await read(api, { id: "read-only-verification", provider, cwd: process.cwd(), model } as PaseoAgent, source, new Date());
    if (process.argv.includes("--expect-verified") && (!check.identity || check.auth !== "subscription" || check.status === "unknown")) verificationFailed = true;
    results.push({ provider, source, model, auth: check.auth, status: check.status,
      identityVerified: !!check.identity, windows: check.windows, nativeStatus, observedPlan, credentialState, requests,
      ...(source === "antigravity" ? { limitation: "Environment exclusion only; no account, plan, model availability or usage was verified." } : {}),
    });
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), modelTurns: 0, results }, null, 2));
  if (!results.length || verificationFailed) process.exitCode = 1;
}

main().catch(() => { console.error("Read-only verification failed; no credentials or raw errors are printed."); process.exitCode = 1; });
