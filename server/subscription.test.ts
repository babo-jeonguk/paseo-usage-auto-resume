import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoAgent, PaseoApi } from "./paseo-types";
import { captureLaunch, claudeUsage, codexUsage, createSubscriptionReader } from "./subscription";

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
});

test("custom wrappers and explicit API environments are never probed as subscriptions", async () => {
  let probes = 0;
  const read = createSubscriptionReader({ run: async () => { probes++; throw new Error("must not execute"); } });
  assert.equal((await read(api({ claude: { command: ["wrapper", "claude"] } }), agent("claude"), "claude", at, captureLaunch({ env: {} }))).auth, "unknown");
  const launch = captureLaunch({ env: { ANTHROPIC_API_KEY: "key" } });
  assert.equal((await read(api(), agent("claude"), "claude", at, launch)).auth, "api");
  assert.equal(probes, 0);
});

test("saved ChatGPT auth cannot override the resolved Codex API provider", async () => {
  let fetches = 0;
  const read = createSubscriptionReader({
    codex: async () => ({ account: { account: { type: "chatgpt" } }, config: { config: { model_provider: "custom-api" } } }),
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
      codex: async () => ({ account: { account: { type: "chatgpt" } }, config: { config: { model_provider: "openai" } } }),
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
      codex: async () => ({ account: { account: { type: "chatgpt" } }, config: { config: { model_provider: "openai" } } }),
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

test("Antigravity follows the notice without probing agy, and its API routes stay excluded", async () => {
  const read = createSubscriptionReader({ run: async () => { throw new Error("must not run agy"); } });
  assert.deepEqual(await read(api(), agent("antigravity", "gemini-pro"), "antigravity", at, captureLaunch({ env: {} })), { auth: "subscription", status: "ready" });
  assert.equal((await read(api(), agent("antigravity", "gemini-pro"), "antigravity", at, captureLaunch({ env: { GEMINI_API_KEY: "key" } }))).auth, "api");
});
