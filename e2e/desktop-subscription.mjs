// Same file formats as the real-CLI integration checks. All login values are synthetic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLAUDE = 'claude-fixture@example.invalid';
const CODEX = 'codex-fixture@example.invalid';
const CLAUDE_TOKEN = 'fixture-claude-login';
const ACCOUNT = 'acct-e2e';
const EXPIRY = 4_102_444_800;
const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: 'plus' } };
const jwt = claims => ['e30', Buffer.from(JSON.stringify({ exp: EXPIRY, ...claims, ...auth })).toString('base64url'), 'sig'].join('.');
const CODEX_TOKEN = jwt({});
const PROFILE = 'https://api.anthropic.com/api/oauth/profile';
const CLAUDE_USAGE = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE = 'https://chatgpt.com/backend-api/wham/usage';

export async function prepareLogins(home) {
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: CLAUDE_TOKEN, refreshToken: 'fixture-refresh', expiresAt: EXPIRY * 1000,
    scopes: ['user:inference', 'user:profile'], subscriptionType: 'max',
  } }));
  await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: {
    accountUuid: 'account-a', emailAddress: CLAUDE, organizationUuid: 'org-a', organizationRole: 'admin', organizationName: 'Fixture',
  } }));
  // The probe uses the default built-in model provider and Codex's normal app-server handshake.
  await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
    tokens: { id_token: jwt({ email: CODEX }), access_token: CODEX_TOKEN, refresh_token: 'fixture-refresh', account_id: ACCOUNT },
  }));
  return { claude: CLAUDE, codex: CODEX };
}

export function patchDesktopEntry(source, control, log) {
  const anchor = '    store: createJobStore(undefined, notifyChange),';
  assert(source.includes(anchor) && !source.includes('const desktopReader'), 'Desktop subscription fixture cannot patch this plugin entry');
  return `import { createSubscriptionReader, type SubscriptionReader } from "./server/subscription";
import { appendFileSync, readFileSync } from "node:fs";

const readFixture = createSubscriptionReader({ fetch: async (input, options) => {
  const url = String(input);
  const token = new Headers(options?.headers).get("authorization");
  const fixture = JSON.parse(readFileSync(${JSON.stringify(control)}, "utf8"));
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url, token, usage: fixture.usage ?? "ready" }) + "\\n");
  const expectedTokens: Record<string, string> = ${JSON.stringify({
    [PROFILE]: `Bearer ${CLAUDE_TOKEN}`, [CLAUDE_USAGE]: `Bearer ${CLAUDE_TOKEN}`, [CODEX_USAGE]: `Bearer ${CODEX_TOKEN}`,
  })};
  if (!Object.hasOwn(expectedTokens, url)) throw new Error("Unexpected subscription fetch: " + url);
  if (token !== expectedTokens[url]) return new Response(null, { status: 401 });
  if (url === ${JSON.stringify(PROFILE)}) return Response.json({
    account: { uuid: "account-a", email: ${JSON.stringify(CLAUDE)} }, organization: { uuid: "org-a" },
  });
  if (fixture.usage === "auth") return new Response(null, { status: 503 });
  const reset = fixture.until ?? new Date(Date.now() + 3_600_000).toISOString();
  const percent = fixture.usage === "limited" ? 100 : 10;
  if (url === ${JSON.stringify(CLAUDE_USAGE)}) return Response.json({
    five_hour: { utilization: percent, resets_at: reset }, seven_day: { utilization: 20, resets_at: reset },
  });
  return Response.json({
    account_id: ${JSON.stringify(ACCOUNT)}, plan_type: "plus",
    rate_limit: { primary_window: { used_percent: percent, reset_at: Date.parse(reset) / 1000 },
      secondary_window: { used_percent: 20, reset_at: Date.parse(reset) / 1000 } },
  });
}});

const desktopReader: SubscriptionReader = (api, agent, provider, at, launch, mode, tokens) => {
  if (provider !== "claude") return readFixture(api, agent, provider, at, launch, mode, tokens);
  // The live Claude turn uses a loopback model address. The native auth check sees the same
  // provider and session with only that model routing override removed.
  const config = { ...api.config, get: async () => {
    const snapshot = await api.config.get();
    const providers = { ...snapshot.config.providers };
    const entry = providers[agent.provider];
    if (entry) {
      const env = { ...entry.env };
      delete env.ANTHROPIC_BASE_URL;
      providers[agent.provider] = { ...entry, env };
    }
    return { ...snapshot, config: { ...snapshot.config, providers } };
  }};
  const authEnv = { ...launch?.authEnv };
  delete authEnv.ANTHROPIC_BASE_URL;
  return readFixture({ config }, agent, provider, at, launch && { ...launch, authEnv }, mode, tokens);
};

${source.replace(anchor, `${anchor}\n    readSubscription: desktopReader,`)}`;
}

export function assertSubscriptionRequests(log, checks) {
  const expected = new Map([[PROFILE, CLAUDE_TOKEN], [CLAUDE_USAGE, CLAUDE_TOKEN], [CODEX_USAGE, CODEX_TOKEN]]);
  const requests = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const { url, token } of requests) {
    assert(expected.has(url), `Unexpected subscription endpoint ${url}`);
    assert.equal(token, `Bearer ${expected.get(url)}`, `Fixture login bearer did not reach ${url}`);
  }
  for (const [provider, usage] of checks) {
    const url = provider === 'codex' ? CODEX_USAGE : CLAUDE_USAGE;
    assert(requests.some(request => request.url === url && request.usage === usage), `Missing ${provider} ${usage} usage request`);
  }
  return requests.length;
}
