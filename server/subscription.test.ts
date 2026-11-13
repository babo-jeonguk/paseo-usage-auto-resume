import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoAgent, PaseoApi } from "./paseo-types";
import { captureLaunch, captureTokens, claudeUsage, codexUsage, createSubscriptionReader } from "./subscription";

const at = new Date("2026-10-16T10:24:00Z");
const until = "2026-10-16T14:14:22Z";
const model = "gpt-6-astra";
const baseUsage = {
  account_id: "business-workspace",
  rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: 1792160062 } },
  credits: { has_credits: false },
  spend_control: { reached: false },
  rate_limit_reached_type: { type: "workspace_member_credits_depleted" },
};
const agent = (provider: string, selectedModel = model) => ({ id: "a", provider, cwd: "/tmp", model: selectedModel }) as PaseoAgent;
const api = (providers: Record<string, unknown> = {}) => ({ config: { get: async () => ({ config: { providers } }) } }) as unknown as Pick<PaseoApi, "config">;
const response = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));

test("a workspace out of credits waits for its used-up five-hour window, as the live Team response shows", () => {
  const check = codexUsage(baseUsage, "business-model", model);
  assert.equal(check.status, "limited");
  assert.deepEqual(check.windows, [{ id: "primary_window", usedPct: 100, resetAt: "2026-10-16T14:14:22.000Z" }]);
  const renewed = codexUsage({ ...baseUsage, rate_limit: { allowed: false, limit_reached: false, primary_window: { used_percent: 3, reset_at: 1792178062 } } }, "business-model", model);
  assert.equal(renewed.status, "ready", "credits alone never hold a continue");
});

test("the observed exact model availability supplies its own reset and recovery", () => {
  const blocked = codexUsage({ ...baseUsage, model_usage: { [model]: { available: false, available_at: until } } }, "business-model", model);
  assert.equal(blocked.status, "limited");
  assert.equal(blocked.windows?.[0]?.resetAt, "2026-10-16T14:14:22.000Z");
  const ready = codexUsage({ ...baseUsage, model_usage: { [model]: { available: true } } }, "business-model", model);
  assert.equal(ready.status, "ready");
  assert.equal(codexUsage({ ...baseUsage, model_usage: { "another-model": { available: true } } }, "business-model", model).status, "limited");
});

test("a spending cap never decides readiness, and missing windows never read as ready", () => {
  assert.equal(codexUsage({ ...baseUsage, spend_control: { reached: true }, model_usage: { [model]: { available: true } } }, "id", model).status, "ready");
  assert.equal(codexUsage({ rate_limit: { primary_window: null }, spend_control: null }, "id", model).status, "unknown");
  assert.equal(codexUsage({ rate_limit: { allowed: true, limit_reached: false } }, "id", model).status, "unknown");
});

test("stale exhausted windows are still limited even after their timestamp passes", () => {
  const check = codexUsage({ rate_limit: { limit_reached: true, primary_window: { used_percent: 100, reset_at: 1 } } }, "id", model);
  assert.equal(check.status, "limited");
});

test("Claude applies the selected model's weekly quota, not another model's", () => {
  const usage = { five_hour: { utilization: 10, resets_at: until }, seven_day: { utilization: 20 }, seven_day_opus: { utilization: 100 } };
  assert.equal(claudeUsage(usage, "id", "claude-sonnet-4-6").status, "ready");
  assert.equal(claudeUsage(usage, "id", "claude-opus-4-6").status, "limited");
  assert.equal(claudeUsage({ five_hour: null, seven_day: null }, "id", "sonnet").status, "unknown");
  assert.equal(claudeUsage({ ...usage, limits: [{ kind: "unknown-new-budget" }] }, "id", "sonnet").status, "unknown");
});

test("the current Claude limits array preserves global and applicable model quotas", () => {
  const usage = { limits: [
    { kind: "session", percent: 100, resets_at: until, scope: null, is_active: true },
    { kind: "weekly_all", percent: 91, resets_at: "2026-10-19T19:00:00Z", scope: null, is_active: false },
    { kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Sonnet" } } },
  ] };
  const opus = claudeUsage(usage, "id", "claude-opus-4-6");
  assert.equal(opus.status, "limited");
  assert.equal(opus.windows?.length, 2);
  assert.equal(claudeUsage({ limits: usage.limits.map((w) => ({ ...w, percent: 10 })) }, "id", "claude-opus-4-6").status, "ready");
});

test("persisted launch context contains only paths and presence flags, never keys or tokens", () => {
  const context = captureLaunch({ env: { CODEX_HOME: "/tmp/sub", OPENAI_API_KEY: "private-api-key", ANTHROPIC_AUTH_TOKEN: "private-token", OTHER_SECRET: "private-secret" } });
  assert.deepEqual(context.env, { CODEX_HOME: "/tmp/sub" });
  assert.deepEqual(context.authEnv, { OPENAI_API_KEY: true, ANTHROPIC_AUTH_TOKEN: true });
  assert.doesNotMatch(JSON.stringify(context), /private/);
  const tokens = captureLaunch({ env: { CLAUDE_CODE_OAUTH_TOKEN: "private-setup-token", CODEX_ACCESS_TOKEN: "private-access-token" } });
  assert.deepEqual(Object.keys(tokens.fingerprints ?? {}).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(tokens), /private/);
  assert.equal(captureLaunch({ env: { CLAUDE_CODE_OAUTH_TOKEN: "private-setup-token" } }).fingerprints?.CLAUDE_CODE_OAUTH_TOKEN,
    tokens.fingerprints?.CLAUDE_CODE_OAUTH_TOKEN, "the same token gives the same fingerprint");
});

test("custom wrappers and explicit API environments are never probed as subscriptions", async () => {
  let probes = 0;
  const read = createSubscriptionReader({ run: async () => { probes++; throw new Error("must not execute"); } });
  assert.equal((await read(api({ claude: { command: ["wrapper", "claude"] } }), agent("claude"), "claude", at, captureLaunch({ env: {} }))).auth, "unknown");
  const launch = captureLaunch({ env: { ANTHROPIC_AUTH_TOKEN: "gateway" } });
  assert.equal((await read(api(), agent("claude"), "claude", at, launch)).auth, "api");
  assert.equal(probes, 0);
});

test("Claude API keys and cloud switches are judged from auth status, which an unreadable report leaves unknown", async () => {
  let report: Record<string, unknown> | null = { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" };
  const envs: NodeJS.ProcessEnv[] = [];
  const read = createSubscriptionReader({
    run: async (_command, _args, options) => { envs.push(options.env); if (!report) throw new Error("unreadable"); return JSON.stringify(report); },
    fetch: async () => { throw new Error("an API route never reads subscription endpoints"); },
  });
  const launch = captureLaunch({ env: { ANTHROPIC_API_KEY: "key", CLAUDE_CODE_OAUTH_TOKEN: SETUP_TOKEN } });
  assert.equal((await read(api(), agent("claude"), "claude", at, launch)).auth, "api");
  report = { loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" };
  assert.equal((await read(api(), agent("claude"), "claude", at, captureLaunch({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }))).auth, "api");
  report = null;
  assert.deepEqual(await read(api(), agent("claude"), "claude", at, launch), { auth: "unknown", status: "unknown" });
  await read(api(), agent("claude"), "claude", at, captureLaunch({ env: { CLAUDE_CODE_USE_BEDROCK: "0" } }));
  assert.equal(envs.at(-1)?.CLAUDE_CODE_USE_BEDROCK, "0", "the CLI sees a switch's own value, so an off value stays off");
});

test("saved ChatGPT auth cannot override the resolved Codex API provider", async () => {
  let fetches = 0;
  const read = createSubscriptionReader({
    codex: async () => ({ account: { account: { type: "chatgpt" } }, config: { config: { model_provider: "custom-api" } }, authStatus: { authMethod: "chatgpt" } }),
    fetch: async () => { fetches++; throw new Error("must not fetch subscription"); },
  });
  assert.equal((await read(api(), agent("codex"), "codex", at, captureLaunch({ env: {} }))).auth, "api");
  assert.equal(fetches, 0);
});

test("read-only Codex status and usage bind workspace/model identity without refreshing auth", async () => {
  const home = await mkdtemp(join(tmpdir(), "resume-auth-"));
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-token", account_id: "business-workspace" } });
  await writeFile(join(home, "auth.json"), auth);
  try {
    let fetches = 0;
    let payload: Record<string, unknown> = { ...baseUsage, model_usage: { [model]: { available: false, available_at: until } } };
    const read = createSubscriptionReader({
      codex: async () => ({ account: { account: { type: "chatgpt" } }, config: { config: { model_provider: "openai" } }, authStatus: { authMethod: "chatgpt" } }),
      fetch: async (url, options) => {
        fetches++;
        assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
        assert.equal(options?.redirect, "error");
        return response(payload);
      },
    });
    const launch = captureLaunch({ env: { CODEX_HOME: home } });
    const bound = await read(api(), agent("codex"), "codex", at, launch, "identity");
    assert.equal(bound.auth, "subscription");
    assert.equal(bound.status, "unknown", "identity alone is not usage readiness");
    assert.ok(bound.identity);
    assert.equal(fetches, 0, "binding an account must not call the usage endpoint");
    const first = await read(api(), agent("codex"), "codex", at, launch);
    assert.equal(first.identity, bound.identity);
    assert.equal(first.status, "limited");
    payload = { ...baseUsage, model_usage: { [model]: { available: true } } };
    const recovered = await read(api(), agent("codex"), "codex", at, launch);
    assert.equal(recovered.status, "ready");
    assert.equal(first.identity, recovered.identity);
    assert.notEqual((await read(api(), agent("codex", "another-model"), "codex", at, launch)).identity, first.identity);
    payload = { ...payload, account_id: "different-workspace" };
    assert.equal((await read(api(), agent("codex"), "codex", at, launch)).auth, "unknown");
    assert.equal(await (await import("node:fs/promises")).readFile(join(home, "auth.json"), "utf8"), auth);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an uncaptured session is checked as the daemon and provider configuration launch it", async () => {
  const home = await mkdtemp(join(tmpdir(), "resume-auth-"));
  await writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-token", account_id: "business-workspace" } }));
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    const read = createSubscriptionReader({
      codex: async () => ({ account: { account: { type: "chatgpt" } }, config: { config: { model_provider: "openai" } }, authStatus: { authMethod: "chatgpt" } }),
      fetch: async () => response({ ...baseUsage, model_usage: { [model]: { available: false, available_at: until } } }),
    });
    const check = await read(api({ "codex-sub": { extends: "codex", env: { CODEX_HOME: home } } }), agent("codex-sub"), "codex", at);
    assert.equal(check.auth, "subscription");
    assert.equal(check.status, "limited");
    process.env.ANTHROPIC_API_KEY = "daemon-key";
    assert.equal((await read(api(), agent("claude"), "claude", at)).auth, "api");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    await rm(home, { recursive: true, force: true });
  }
});

test("Antigravity preserves its fallback when agy is unavailable, and its API routes stay excluded", async () => {
  const read = createSubscriptionReader({ run: async () => { throw new Error("agy unavailable"); } });
  assert.deepEqual(await read(api(), agent("antigravity", "gemini-pro"), "antigravity", at, captureLaunch({ env: {} })), { auth: "subscription", status: "ready" });
  assert.equal((await read(api(), agent("antigravity", "gemini-pro"), "antigravity", at, captureLaunch({ env: { GEMINI_API_KEY: "key" } }))).auth, "api");
});

test("Codex's login is read from the home it reports, before the inferred one", async () => {
  const reported = await mkdtemp(join(tmpdir(), "resume-auth-"));
  const inferred = await mkdtemp(join(tmpdir(), "resume-auth-"));
  await writeFile(join(reported, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-token", account_id: "business-workspace" } }));
  await writeFile(join(inferred, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "other-token", account_id: "other-workspace" } }));
  try {
    const tokens: string[] = [];
    const read = createSubscriptionReader({
      codex: async () => ({ account: { account: { type: "chatgpt" } }, config: { config: { model_provider: "openai" } }, home: reported, authStatus: { authMethod: "chatgpt" } }),
      fetch: async (_url, options) => {
        tokens.push((options?.headers as Record<string, string>).Authorization);
        return response({ ...baseUsage, model_usage: { [model]: { available: true } } });
      },
    });
    const check = await read(api(), agent("codex"), "codex", at, captureLaunch({ env: { CODEX_HOME: inferred } }));
    assert.equal(check.status, "ready");
    assert.deepEqual(tokens, ["Bearer test-token"]);
  } finally {
    await rm(reported, { recursive: true, force: true });
    await rm(inferred, { recursive: true, force: true });
  }
});

test("Claude credentials are looked up where the CLI reports its configuration", async () => {
  const seen: Array<string | undefined> = [];
  const read = createSubscriptionReader({
    run: async () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max",
      orgId: "org-a", email: "me@example.invalid", configDirectory: "C:\\Users\\me\\.claude" }),
    readClaudeCredentials: async (_env, configDirectory) => { seen.push(configDirectory); return null; },
  });
  assert.equal((await read(api(), agent("claude", "claude-sonnet-4-6"), "claude", at)).auth, "unknown");
  assert.deepEqual(seen, ["C:\\Users\\me\\.claude"]);
});

// Synthetic contract fixtures. The 403 body follows the measured shape of a real Team-plan
// setup token (docs/research/automation-subscription-tokens.md); no value here is a capture.
const SETUP_TOKEN = "sk-ant-oat01-fixture-setup-token";
const scopeDenied = { type: "error", error: { type: "permission_error", message: "OAuth token does not meet scope requirement",
  details: { error_code: "oauth_scope_insufficient" } } };
const setupStatus = JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", loginExpiresAt: null });

function setupTokenReader(answer: (url: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; authorization: string }> = [];
  const read = createSubscriptionReader({
    run: async () => setupStatus,
    readClaudeCredentials: async () => { throw new Error("a setup token never reads a saved login"); },
    fetch: async (url, options) => {
      calls.push({ url: String(url), authorization: (options?.headers as Record<string, string>).Authorization });
      return answer(String(url));
    },
  });
  return { read, calls };
}
const setupLaunch = (value = SETUP_TOKEN) => {
  const request = { env: { CLAUDE_CODE_OAUTH_TOKEN: value } };
  return { launch: captureLaunch(request), tokens: captureTokens(request) };
};

test("a Claude setup token whose scope cannot read the profile follows the notice, bound to that token", async () => {
  const { read, calls } = setupTokenReader(() => new Response(JSON.stringify(scopeDenied), { status: 403 }));
  const { launch, tokens } = setupLaunch();
  const check = await read(api(), agent("claude", "claude-opus-4-6"), "claude", at, launch, "usage", tokens);
  assert.equal(check.auth, "subscription");
  assert.equal(check.status, "ready");
  assert.equal(check.windows, undefined);
  assert.ok(check.identity);
  assert.deepEqual(calls, [{ url: "https://api.anthropic.com/api/oauth/profile", authorization: `Bearer ${SETUP_TOKEN}` }],
    "only the profile is requested, with the session's own token");
  const identity = await read(api(), agent("claude", "claude-opus-4-6"), "claude", at, launch, "identity", tokens);
  assert.equal(identity.identity, check.identity);
  const replaced = setupLaunch("sk-ant-oat01-fixture-replacement");
  assert.notEqual((await read(api(), agent("claude", "claude-opus-4-6"), "claude", at, replaced.launch, "usage", replaced.tokens)).identity, check.identity);
  assert.notEqual((await read(api(), agent("claude", "claude-sonnet-4-6"), "claude", at, launch, "usage", tokens)).identity, check.identity);
});

test("a Claude setup token that can read the profile is verified like a claude.ai login", async () => {
  const { read, calls } = setupTokenReader((url) => new Response(JSON.stringify(url.endsWith("/profile")
    ? { account: { uuid: "account-a", email: "someone@example.invalid" }, organization: { uuid: "org-a" } }
    : { five_hour: { utilization: 100, resets_at: until }, seven_day: { utilization: 10 } }), { status: 200 }));
  const { launch, tokens } = setupLaunch();
  const check = await read(api(), agent("claude", "claude-opus-4-6"), "claude", at, launch, "usage", tokens);
  assert.equal(check.auth, "subscription");
  assert.equal(check.status, "limited");
  assert.ok(check.identity);
  assert.deepEqual(calls.map((call) => call.url), ["https://api.anthropic.com/api/oauth/profile", "https://api.anthropic.com/api/oauth/usage"]);
});

for (const [label, answer] of [
  ["a revoked token (401)", () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error" } }), { status: 401 })],
  ["another 403", () => new Response(JSON.stringify({ type: "error", error: { type: "permission_error", details: { error_code: "account_disabled" } } }), { status: 403 })],
  ["a server error", () => new Response("unavailable", { status: 503 })],
  ["a network failure", () => { throw new TypeError("fetch failed"); }],
] as const) {
  test(`a Claude setup token with ${label} is unknown authentication`, async () => {
    const { read } = setupTokenReader(answer);
    const { launch, tokens } = setupLaunch();
    assert.deepEqual(await read(api(), agent("claude", "claude-opus-4-6"), "claude", at, launch, "usage", tokens), { auth: "unknown", status: "unknown" });
  });
}

test("a Claude setup token known only by its flag is unknown authentication, without a request", async () => {
  const { read, calls } = setupTokenReader(() => new Response(JSON.stringify(scopeDenied), { status: 403 }));
  const { launch } = setupLaunch();
  assert.deepEqual(await read(api(), agent("claude", "claude-opus-4-6"), "claude", at, launch), { auth: "unknown", status: "unknown" });
  const legacy = { env: {}, authEnv: { CLAUDE_CODE_OAUTH_TOKEN: true } };
  assert.deepEqual(await read(api(), agent("claude", "claude-opus-4-6"), "claude", at, legacy, "usage", { CLAUDE_CODE_OAUTH_TOKEN: SETUP_TOKEN }),
    { auth: "unknown", status: "unknown" }, "a saved flag without a fingerprint never accepts a token");
  assert.deepEqual(calls, []);
});

// Synthetic contract fixtures shaped after the Codex 0.167.0 app-server schema
// (docs/research/codex-access-token-usage.md); no real access token was available.
const ACCESS_TOKEN = "at-fixture-access-token";
const reset = (iso: string) => Date.parse(iso) / 1000;
const accountRead = (overrides: Record<string, unknown> = {}) => ({
  account: { type: "chatgpt", email: null, planType: "business" }, userId: "user-a",
  workspaceRouting: { chatgptAccountId: "workspace-a" }, requiresOpenaiAuth: true, ...overrides,
});
const rateLimits = (overrides: Record<string, unknown> = {}) => ({
  accountId: "workspace-a", ordinaryUsageAllowed: null,
  rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: reset(until) },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: reset("2026-10-20T00:00:00Z") },
    credits: { hasCredits: true, unlimited: false }, planType: "business", rateLimitReachedType: null },
  rateLimitsByLimitId: {},
  ...overrides,
});

function accessTokenReader(snapshot: () => Record<string, unknown>) {
  const envs: NodeJS.ProcessEnv[] = [];
  const read = createSubscriptionReader({
    codex: async (_command, _args, options) => {
      envs.push(options.env);
      return { account: accountRead(), config: { config: { model_provider: "openai" } }, authStatus: { authMethod: "personalAccessToken", authToken: null }, rateLimits: rateLimits(), ...snapshot() };
    },
    fetch: async () => { throw new Error("an access token is never sent by the plugin"); },
  });
  return { read, envs };
}
const accessLaunch = (value = ACCESS_TOKEN) => {
  const request = { env: { CODEX_ACCESS_TOKEN: value, CODEX_HOME: "/nonexistent/codex-home" } };
  return { launch: captureLaunch(request), tokens: captureTokens(request) };
};

test("a Codex access token is planned on the rate limits Codex reads for it, bound to its seat", async () => {
  let snapshot: Record<string, unknown> = {};
  const { read, envs } = accessTokenReader(() => snapshot);
  const { launch, tokens } = accessLaunch();
  const limited = await read(api(), agent("codex"), "codex", at, launch, "usage", tokens);
  assert.equal(limited.auth, "subscription");
  assert.equal(limited.status, "limited");
  assert.equal(limited.windows?.find((window) => window.usedPct === 100)?.resetAt, "2026-10-16T14:14:22.000Z");
  assert.ok(limited.identity);
  assert.equal(envs[0]?.CODEX_ACCESS_TOKEN, ACCESS_TOKEN, "Codex attaches the session's own token");
  assert.equal((await read(api(), agent("codex"), "codex", at, launch, "identity", tokens)).identity, limited.identity);

  const rotated = accessLaunch("at-fixture-rotated-token");
  assert.equal((await read(api(), agent("codex"), "codex", at, rotated.launch, "usage", rotated.tokens)).identity, limited.identity,
    "rotating the token for the same seat keeps the reservation");
  snapshot = { account: accountRead({ userId: "user-b" }) };
  assert.notEqual((await read(api(), agent("codex"), "codex", at, launch, "usage", tokens)).identity, limited.identity);
  snapshot = { authStatus: { authMethod: "agentIdentity", authToken: null }, account: accountRead({ workspaceRouting: null }) };
  assert.equal((await read(api(), agent("codex"), "codex", at, launch, "usage", tokens)).status, "limited", "a legacy agent identity is read the same way");
});

test("Codex's explicit usage permission decides when given; otherwise the stopped model's windows do", async () => {
  let snapshot: Record<string, unknown> = {};
  const { read } = accessTokenReader(() => snapshot);
  const { launch, tokens } = accessLaunch();
  const check = () => read(api(), agent("codex"), "codex", at, launch, "usage", tokens);
  snapshot = { rateLimits: rateLimits({ ordinaryUsageAllowed: true }) };
  assert.equal((await check()).status, "ready");
  snapshot = { rateLimits: rateLimits({ ordinaryUsageAllowed: false, rateLimits: { limitId: "codex", primary: { usedPercent: 20, resetsAt: reset(until) }, secondary: null } }) };
  assert.equal((await check()).status, "limited");
  snapshot = { rateLimits: rateLimits({ rateLimits: { limitId: "codex", primary: { usedPercent: 10, resetsAt: reset(until) }, secondary: null } }) };
  assert.equal((await check()).status, "ready");
  snapshot = { rateLimits: rateLimits({ rateLimitsByLimitId: { codex_astra: { limitId: "codex_astra", normalModelSlug: model,
    primary: { usedPercent: 100, resetsAt: reset("2026-10-17T00:00:00Z") }, secondary: null } } }) };
  const specific = await check();
  assert.equal(specific.status, "limited");
  assert.deepEqual(specific.windows?.map((window) => window.resetAt), ["2026-10-17T00:00:00.000Z"], "the stopped model's bucket wins");
  snapshot = { rateLimits: rateLimits({ ordinaryUsageAllowed: false, rateLimitsByLimitId: { codex_astra: { limitId: "codex_astra", normalModelSlug: model,
    primary: { usedPercent: 10, resetsAt: reset("2026-10-17T00:00:00Z") }, secondary: null } } }) };
  const refused = await check();
  assert.equal(refused.status, "limited");
  assert.ok(refused.windows?.some((window) => window.usedPct === 100 && window.resetAt === "2026-10-16T14:14:22.000Z"),
    "a refusal renews with whichever bucket is used up, even the shared one");
  snapshot = { rateLimits: rateLimits({ rateLimits: { limitId: "codex", primary: null, secondary: null, credits: { hasCredits: true } } }) };
  assert.equal((await check()).status, "unknown", "credits alone never mean ready");
});

for (const [label, snapshot] of [
  ["an RPC error", { rateLimits: undefined }],
  ["a missing accountId", { rateLimits: rateLimits({ accountId: null }) }],
  ["an accountId other than the routed workspace", { rateLimits: rateLimits({ accountId: "workspace-b" }) }],
  ["a missing userId", { account: accountRead({ userId: null }) }],
] as const) {
  test(`Codex access-token usage with ${label} is unknown`, async () => {
    const { read } = accessTokenReader(() => snapshot);
    const { launch, tokens } = accessLaunch();
    const check = await read(api(), agent("codex"), "codex", at, launch, "usage", tokens);
    assert.equal(check.status, "unknown");
    assert.notEqual(check.auth, "api");
  });
}

test("Codex's own auth status decides the route; CODEX_API_KEY, which its app-server ignores, does not", async () => {
  let authStatus: unknown = { authMethod: "apikey", authToken: null };
  let probes = 0;
  const read = createSubscriptionReader({
    codex: async () => { probes++; return { account: { account: { type: "chatgpt", planType: "plus" } }, config: { config: { model_provider: "openai" } }, authStatus }; },
    fetch: async () => { throw new Error("must not fetch"); },
  });
  const launch = captureLaunch({ env: { CODEX_API_KEY: "unused-by-app-server", CODEX_HOME: "/nonexistent/codex-home" } });
  assert.equal((await read(api(), agent("codex"), "codex", at, launch)).auth, "api");
  authStatus = { authMethod: null, authToken: null };
  assert.equal((await read(api(), agent("codex"), "codex", at, launch)).auth, "unknown");
  authStatus = undefined;
  assert.equal((await read(api(), agent("codex"), "codex", at, launch)).auth, "unknown");
  authStatus = { authMethod: "chatgpt", authToken: null };
  assert.equal((await read(api(), agent("codex"), "codex", at, launch)).auth, "unknown", "a ChatGPT login is read from its saved login, which is absent here");
  assert.equal(probes, 4);
  const flagOnly = captureLaunch({ env: { CODEX_ACCESS_TOKEN: ACCESS_TOKEN } });
  assert.deepEqual(await read(api(), agent("codex"), "codex", at, flagOnly), { auth: "unknown", status: "unknown" });
  assert.equal(probes, 4, "an unavailable token is not probed");
});

test("a session the plugin never saw is checked with the token its daemon and provider configuration launch it with", async () => {
  const { read, calls } = setupTokenReader(() => new Response(JSON.stringify(scopeDenied), { status: 403 }));
  const check = await read(api({ "claude-ci": { extends: "claude", env: { CLAUDE_CODE_OAUTH_TOKEN: SETUP_TOKEN } } }),
    agent("claude-ci", "claude-opus-4-6"), "claude", at);
  assert.equal(check.status, "ready");
  assert.equal(check.identity, (await read(api(), agent("claude", "claude-opus-4-6"), "claude", at, setupLaunch().launch, "usage", setupLaunch().tokens)).identity,
    "bound to that token, as a captured session with it would be");
  assert.equal(calls[0]?.authorization, `Bearer ${SETUP_TOKEN}`);
});
