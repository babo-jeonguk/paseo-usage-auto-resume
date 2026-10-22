// Runs the plugin's account check against a real installed CLI (`npm run test:native`).
// NATIVE_CLI selects claude or codex; NATIVE_CLI_HANDSHAKE_ONLY limits Codex to starting up, for
// releases that do not answer a fixture login. Logins are fixtures in a temporary home and HTTP
// is answered in-process, so no credential is used or sent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { PaseoAgent } from "./paseo-types";
import { CLI_STOP_GRACE_MS, cliLaunch, runCli, spawnCli, stopProcessTree } from "./cli-launch";
import { createSubscriptionReader } from "./subscription";

const tool = process.env.NATIVE_CLI as "claude" | "codex" | undefined;
const handshakeOnly = !!process.env.NATIVE_CLI_HANDSHAKE_ONLY;
const onWindows = process.platform === "win32";
const skip = tool ? false : "set NATIVE_CLI to claude or codex";
/** Token expiry far beyond any test run: 2100-01-01, in seconds. */
const FAR_FUTURE_SECONDS = 4_102_444_800;

// Only the fixture homes below may decide which login the CLI and the plugin see.
for (const key of Object.keys(process.env)) {
  if (/^(CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|CODEX_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_.*|ANTHROPIC_.*|OPENAI_.*|CODEX_API_KEY|CODEX_ACCESS_TOKEN|RUNTIME_PROXY_.*)$/.test(key)) delete process.env[key];
}

let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "native cli ")); });
after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); });

const jwt = (claims: Record<string, unknown>) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

async function signedIn(name: string): Promise<string> {
  const home = join(root, name);
  if (tool === "claude") {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: `token-${name}`, refreshToken: "fixture-refresh", expiresAt: FAR_FUTURE_SECONDS * 1000, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }));
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: {
      accountUuid: "account-a", emailAddress: "fixture@example.invalid", organizationUuid: "org-a", organizationRole: "admin", organizationName: "Fixture" } }));
  } else {
    await mkdir(join(home, ".codex"), { recursive: true });
    const auth = { "https://api.openai.com/auth": { chatgpt_account_id: "acct-a", chatgpt_plan_type: "plus" } };
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
      tokens: { id_token: jwt({ email: "fixture@example.invalid", exp: FAR_FUTURE_SECONDS, ...auth }), access_token: jwt({ exp: FAR_FUTURE_SECONDS, ...auth }), refresh_token: "fixture-refresh", account_id: "acct-a" } }));
  }
  return home;
}

const requests: Array<{ path: string; token: string }> = [];
const fixtureFetch = (async (url: string | URL, options?: RequestInit) => {
  const { pathname } = new URL(String(url));
  requests.push({ path: pathname, token: (options?.headers as Record<string, string>).Authorization });
  const resetAt = new Date(Date.now() + 3_600_000);
  if (pathname.endsWith("/oauth/profile")) return Response.json({ account: { uuid: "account-a", email: "fixture@example.invalid" }, organization: { uuid: "org-a" } });
  if (pathname.endsWith("/oauth/usage")) return Response.json({ five_hour: { utilization: 10, resets_at: resetAt.toISOString() }, seven_day: { utilization: 20, resets_at: resetAt.toISOString() } });
  if (pathname.endsWith("/wham/usage")) return Response.json({ account_id: "acct-a", plan_type: "plus",
    rate_limit: { primary_window: { used_percent: 10, reset_at: resetAt.getTime() / 1000 }, secondary_window: { used_percent: 20, reset_at: resetAt.getTime() / 1000 } } });
  return new Response("unexpected", { status: 500 });
}) as typeof fetch;

/** The plugin's real reader with process homes and provider config as given. */
async function check(homes: { HOME: string; USERPROFILE: string }, provider: Record<string, unknown> = {}) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, homes);
  requests.length = 0;
  try {
    const read = createSubscriptionReader({ fetch: fixtureFetch });
    const api = { config: { get: async () => ({ config: { providers: { [tool!]: provider } } }) } };
    const agent = { id: "native-agent", provider: tool, cwd: root, model: tool === "claude" ? "claude-sonnet-4-6" : "gpt-5.5" } as unknown as PaseoAgent;
    return await read(api as never, agent, tool!, new Date(), undefined, "usage");
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

/** The installed file that `where`/`which` finds first, skipping the extensionless npm script on Windows. */
function installed(): string {
  const found = execFileSync(onWindows ? "where.exe" : "which", [tool!], { encoding: "utf8" }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const path = onWindows ? found.find((entry) => /\.(exe|cmd)$/i.test(entry)) : found[0];
  assert.ok(path, `no installed ${tool}`);
  return path;
}

/** Running codex.exe processes with their parent and command line, for a leftover's diagnosis. */
function codexProcessList(): string[] {
  if (!onWindows) return [];
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | ForEach-Object { \"$($_.ProcessId) parent=$($_.ParentProcessId) $($_.CommandLine)\" }"], { encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean);
}

/** Waits briefly for the count to settle, since a terminated process can linger in the list. */
async function assertNoNewCodex(before: number): Promise<void> {
  for (let tries = 0; tries < 10 && codexProcessList().length > before; tries++) await new Promise((resolve) => setTimeout(resolve, 500));
  const left = codexProcessList();
  assert.equal(left.length, before, `no Codex server is left running:\n${left.join("\n")}`);
}

test("the plugin starts the installed CLI the way it is installed", { skip }, async () => {
  const options = { cwd: root, env: process.env };
  const version = await runCli(tool!, ["--version"], { ...options, timeoutMs: 60_000, maxBytes: 100_000 });
  assert.match(version, tool === "claude" ? /Claude Code/ : /codex/i);
  if (onWindows && /\.cmd$/i.test(installed())) assert.equal(cliLaunch(tool!, ["--version"], options).windowsVerbatimArguments, true, "an npm shim goes through cmd.exe");
});

test("Codex starts its app server through the launcher, reports its home and exits with its input", { skip: tool === "codex" ? false : "Codex only" }, async () => {
  const home = await signedIn("codex-handshake");
  const before = codexProcessList().length;
  const env = { ...process.env, CODEX_HOME: join(home, ".codex") };
  const child = spawnCli("codex", ["app-server", "--stdio"], { env, cwd: root });
  try {
    const reported = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no initialize response")), 30_000);
      let buffer = "";
      child.on("error", reject);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(end + 1)) {
          const frame = JSON.parse(buffer.slice(0, end));
          if (frame.id === 1) { clearTimeout(timer); resolve(frame.result?.codexHome); }
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "usage_auto_resume_status", version: "1.0" } } }) + "\n");
    });
    // Windows may spell the same directory with its short 8.3 name.
    assert.equal(realpathSync.native(String(reported)), realpathSync.native(join(home, ".codex")));
  } finally {
    child.stdin.end();
    await stopProcessTree(child, { graceMs: CLI_STOP_GRACE_MS });
  }
  await assertNoNewCodex(before);
});

test("a fixture login reaches a verified, ready subscription", { skip: skip || (handshakeOnly ? "this Codex does not answer a fixture login" : false) }, async () => {
  const home = await signedIn("signed-in");
  const provider = tool === "codex" ? { env: { CODEX_HOME: join(home, ".codex") } } : {};
  const before = codexProcessList().length;
  const result = await check({ HOME: home, USERPROFILE: home }, provider);
  await assertNoNewCodex(before);
  assert.equal(result.auth, "subscription");
  assert.equal(result.status, "ready");
  assert.deepEqual(requests.map((request) => request.path), tool === "claude" ? ["/api/oauth/profile", "/api/oauth/usage"] : ["/backend-api/wham/usage"]);
});

test("a Codex that never answers is given up on in time, leaving nothing running", { skip: tool === "codex" && handshakeOnly ? false : "unanswered Codex only" }, async () => {
  const home = await signedIn("unanswered");
  const before = codexProcessList().length;
  const started = Date.now();
  const result = await check({ HOME: home, USERPROFILE: home }, { env: { CODEX_HOME: join(home, ".codex") } });
  assert.equal(result.auth, "unknown");
  assert.ok(Date.now() - started < 30_000, "the status timeout applies");
  await assertNoNewCodex(before);
});

test("Windows: the login is found when HOME is not the user profile", { skip: tool === "claude" && onWindows ? false : "Claude on Windows only" }, async () => {
  const profile = await signedIn("profile");
  const elsewhere = await signedIn("elsewhere");
  const result = await check({ HOME: elsewhere, USERPROFILE: profile });
  assert.equal(result.status, "ready");
  assert.ok(requests.every((request) => request.token === "Bearer token-profile"), "the CLI's own login is used");
});

test("Windows: a configured shim path with spaces, parentheses and an ampersand still runs", { skip: tool === "claude" && onWindows ? false : "Claude on Windows only" }, async () => {
  const home = await signedIn("spaced");
  const directory = join(root, "Program Files (x86) & tools");
  await mkdir(directory, { recursive: true });
  const shim = join(directory, "claude.cmd");
  await writeFile(shim, `@"${installed()}" %*\r\n`);
  const result = await check({ HOME: home, USERPROFILE: home }, { command: [shim] });
  assert.equal(result.status, "ready");
});
