import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { PaseoAgent } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginLifecycleEvents, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { CONTINUE_PROMPT, createResumer, type ResumerApi } from "./resumer";
import { createJobStore, type JobStore } from "./store";
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from "../shared/settings";

const START = new Date("2026-10-06T03:00:00.000Z");
const MINUTE = 60_000;
const CODEX_LIMIT = "You've hit your usage limit. Upgrade to Pro or try again in 2 hours.";
const CLAUDE_LIMIT = "You've hit your limit · resets 3pm (Asia/Seoul)";
const MAIN_EMAIL = "main@example.com";
const SUB_EMAIL = "sub@example.com";
const CODEX_EMAIL = "codex@example.com";
const ANTIGRAVITY_EMAIL = "antigravity@example.com";
const ANTIGRAVITY_LIMIT =
  'Cloud Code Assist API error (429): {"error":{"code":429,"message":"Individual quota reached. Resets in 2h.","status":"RESOURCE_EXHAUSTED"}}';

let dir: string;
let store: JobStore;
let clock: Date;
const savedCodexHome = process.env.CODEX_HOME;
const savedAntigravityConfigDir = process.env.ANTIGRAVITY_CONFIG_DIR;

const jwt = (claims: Record<string, unknown>) =>
  ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");

/** Writes the files each CLI keeps its signed-in account in, as the agents' homes. */
async function signIn(home: string, file: string, contents: unknown) {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, file), JSON.stringify(contents));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usage-auto-resume-"));
  store = createJobStore(join(dir, "jobs.json"));
  clock = START;
  await signIn(join(dir, "claude"), ".claude.json", { oauthAccount: { emailAddress: MAIN_EMAIL } });
  await signIn(join(dir, "claude-sub"), ".claude.json", { oauthAccount: { emailAddress: SUB_EMAIL } });
  await signIn(join(dir, "codex"), "auth.json", { tokens: { id_token: jwt({ email: CODEX_EMAIL }), access_token: "opaque" } });
  await signIn(join(dir, "antigravity"), "auth.json", { email: ANTIGRAVITY_EMAIL });
  process.env.CODEX_HOME = join(dir, "codex");
  process.env.ANTIGRAVITY_CONFIG_DIR = join(dir, "antigravity");
});

afterEach(async () => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  if (savedAntigravityConfigDir === undefined) delete process.env.ANTIGRAVITY_CONFIG_DIR;
  else process.env.ANTIGRAVITY_CONFIG_DIR = savedAntigravityConfigDir;
  await rm(dir, { recursive: true, force: true });
});

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

interface FakeOptions {
  timelines?: Record<string, AgentTimelineItem[]>;
  usage?: Array<{ providerId: string; displayName: string; windows: Array<Record<string, unknown>> }>;
  claudeConfigDir?: string;
  claudeAliasEnv?: Record<string, string>;
  antigravityConfigDir?: string;
  antigravityAliasEnv?: Record<string, string>;
  readSettings?: () => Promise<ProviderSettings | null>;
}

/** Daemon stand-in: agent snapshots by ID, recorded sends, and no way to create agents. */
function fakePaseo(agents: Map<string, Partial<PaseoAgent>>, options: FakeOptions = {}) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const snapshot = (agentId: string, agent: Partial<PaseoAgent>) =>
    ({
      id: agentId,
      status: "idle",
      updatedAt: "2026-10-06T02:30:00.000Z",
      lastUserMessageAt: "2026-10-06T02:00:00.000Z",
      pendingPermissions: [],
      attentionReason: null,
      archivedAt: null,
      activeTurn: null,
      ...agent,
    }) as PaseoAgent;
  const api = {
    agents: {
      list: async (options: { filter?: { statuses?: string[] } }) => ({
        entries: [...agents]
          .map(([agentId, agent]) => ({ agent: snapshot(agentId, agent), project: null }))
          .filter((entry) => options.filter?.statuses?.includes(entry.agent.status) ?? true),
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      }),
      ref: (agentId: string) => ({
        refresh: async () => {
          const agent = agents.get(agentId);
          return agent ? { agent: snapshot(agentId, agent), project: null } : null;
        },
        send: async (text: string) => {
          sent.push({ agentId, text });
        },
        timeline: {
          refetch: async () => ({
            error: null,
            entries: (options.timelines?.[agentId] ?? []).map((item, seqStart) => ({ item, seqStart })),
          }),
        },
      }),
      create: () => {
        throw new Error("auto-resume must never create agents");
      },
    },
    config: {
      get: async () => ({
        requestId: "r",
        config: {
          providers: {
            "claude-main": {
              extends: "claude",
              env: options.claudeAliasEnv ?? { CLAUDE_CONFIG_DIR: options.claudeConfigDir ?? join(dir, "claude") },
            },
            "claude": {
              env: { CLAUDE_CONFIG_DIR: options.claudeConfigDir ?? join(dir, "claude") },
            },
            "claude-sub": { extends: "claude", env: { CLAUDE_CONFIG_DIR: join(dir, "claude-sub") } },
            "antigravity": {
              env: { ANTIGRAVITY_CONFIG_DIR: options.antigravityConfigDir ?? join(dir, "antigravity") },
            },
            "antigravity-main": {
              extends: "antigravity",
              env: options.antigravityAliasEnv ?? { ANTIGRAVITY_CONFIG_DIR: options.antigravityConfigDir ?? join(dir, "antigravity") },
            },
          },
        },
      }),
    },
    providers: {
      listUsage: async () => ({
        requestId: "r",
        fetchedAt: clock.toISOString(),
        providers: (options.usage ?? []).map((entry) => ({
          status: "available",
          planLabel: null,
          ...entry,
        })),
      }),
    },
  } as unknown as ResumerApi;
  return { api, sent };
}

function turnEnded(
  agentId: string,
  provider: string,
  outcome: PluginTurnOutcome,
  timeline: AgentTimelineItem[] = [{ type: "user_message", text: "Implement the feature" }],
): PluginLifecycleEvents["agent.turn_ended"] {
  return {
    agent: { id: agentId, workspaceId: "wks", parentAgentId: null, provider, cwd: "/repo", title: null },
    turnId: "turn-1",
    outcome,
    timeline,
  };
}

const failed = (message: string): PluginTurnOutcome => ({ kind: "failed", error: { message } });
const claudeNotice = (text: string): AgentTimelineItem[] => [
  { type: "user_message", text: "Implement the feature" },
  { type: "tool_call", callId: "c1", name: "Bash", status: "completed", detail: { type: "unknown" } } as unknown as AgentTimelineItem,
  { type: "assistant_message", text },
];

async function setup(agents: Record<string, Partial<PaseoAgent>>, options?: FakeOptions) {
  const map = new Map(Object.entries(agents));
  const fake = fakePaseo(map, options);
  const resumer = createResumer({ store, now: () => clock, readSettings: options?.readSettings });
  await resumer.attach(fake.api);
  return { ...fake, agents: map, resumer };
}

test("Codex 5h limit: schedules reset + 2 minutes and continues the same agent", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);

  const [job] = await store.list();
  assert.equal(job?.resetAt, "2026-10-06T05:00:00.000Z");
  assert.equal(job?.dueAt, "2026-10-06T05:02:00.000Z");

  advance(2 * 60 * MINUTE + MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, [], "not before reset + 2 minutes");

  advance(MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "a1", text: CONTINUE_PROMPT }]);
  assert.equal((await store.list())[0]?.state, "sent");

  await resumer.tick();
  assert.equal(sent.length, 1, "one continue per limit stop");
});

test("claude limit: continues after the reset in the notice", async () => {
  const { api, sent, resumer } = await setup({ m1: { provider: "claude" } });
  await resumer.onTurnEnded(turnEnded("m1", "claude", { kind: "completed" }, claudeNotice(CLAUDE_LIMIT)), api);

  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T06:02:00.000Z");
  clock = new Date("2026-10-06T06:02:00.000Z");
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "m1", text: CONTINUE_PROMPT }]);
});

test("a long answer followed by a separate Claude limit notice schedules and resumes once", async () => {
  const { api, sent, resumer } = await setup({ m1: { provider: "claude" } });
  await resumer.onTurnEnded(turnEnded("m1", "claude", { kind: "completed" }, [
    { type: "user_message", text: "Continue the research" },
    { type: "assistant_message", text: "Research is still running. ".padEnd(834, "."), messageId: "answer" },
    { type: "assistant_message", text: CLAUDE_LIMIT, messageId: "limit" },
  ]), api);
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T06:02:00.000Z");
  clock = new Date("2026-10-06T06:02:00.000Z");
  await resumer.tick();
  await resumer.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /resume or messaging tools/i);
  assert.match(sent[0]!.text, /unfinished subagent.*usage limit/i);
  assert.match(sent[0]!.text, /existing.*(?:ID|name)/i);
  assert.match(sent[0]!.text, /completed work.*running subagents/i);
});

test("startup scan also detects a separate limit notice after a long Claude answer", async () => {
  await setup({ m1: { provider: "claude" } }, { timelines: { m1: [
    { type: "user_message", text: "Continue the research" },
    { type: "assistant_message", text: "Research is still running. ".padEnd(834, "."), messageId: "answer" },
    { type: "assistant_message", text: CLAUDE_LIMIT, messageId: "limit" },
  ] } });
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T06:02:00.000Z");
});

test("a structured limit code uses the existing usage-window fallback", async () => {
  const { api, resumer } = await setup({ m1: { provider: "claude" } }, { usage: [{
    providerId: "claude", displayName: `Claude (${MAIN_EMAIL})`,
    windows: [{ id: "five_hour", label: "Session", usedPct: 100, resetsAt: "2026-10-06T04:00:00.000Z" }],
  }] });
  await resumer.onTurnEnded(turnEnded("m1", "claude", {
    kind: "failed", error: { code: "rate_limit_exceeded", message: "Request rejected" },
  }), api);
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T04:02:00.000Z");
});

test("custom aliases are not automatically enabled by the public defaults", async () => {
  const { api, sent, resumer } = await setup({ s1: { provider: "claude-sub" }, m1: { provider: "claude-main" }, r1: { provider: "codex-reserve" } });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", { kind: "completed" }, claudeNotice(CLAUDE_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("s1", "claude-sub", { kind: "completed" }, claudeNotice(CLAUDE_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("s1", "claude-sub", failed("Claude AI usage limit reached|1791266400")), api);
  await resumer.onTurnEnded(turnEnded("r1", "codex-reserve", failed(CODEX_LIMIT)), api);

  assert.deepEqual(await store.list(), []);
  advance(24 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
});

test("the same failure is scheduled once", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } });
  const event = turnEnded("a1", "codex", failed(CODEX_LIMIT));
  await Promise.all([resumer.onTurnEnded(event, api), resumer.onTurnEnded(event, api)]);
  await resumer.onTurnEnded(event, api);

  const jobs = await store.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.dueAt, "2026-10-06T05:02:00.000Z");

  advance(3 * 60 * MINUTE);
  await Promise.all([resumer.tick(), resumer.tick()]);
  assert.equal(sent.length, 1);
});

test("a manual resume before the schedule cancels it", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);

  advance(30 * MINUTE);
  await resumer.onTurnStarted("a1");
  assert.deepEqual(await store.list(), []);

  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
});

test("a newer message seen only at fire time cancels the schedule", async () => {
  const { api, sent, resumer, agents } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);

  // The turn_started hook was missed (e.g. plugin reload); the snapshot still shows the message.
  agents.set("a1", { provider: "codex", lastUserMessageAt: "2026-10-06T04:00:00.000Z" });
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await store.list(), []);
});

test("an agent waiting for permission or running is left alone", async () => {
  for (const state of [
    { pendingPermissions: [{ id: "p1" }] },
    { attentionReason: "permission" },
    { status: "running" },
  ] as Array<Partial<PaseoAgent>>) {
    const { api, sent, resumer, agents } = await setup({ a1: { provider: "codex" } });
    await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
    agents.set("a1", { provider: "codex", ...state });
    advance(3 * 60 * MINUTE);
    await resumer.tick();
    assert.deepEqual(sent, [], JSON.stringify(state));
    clock = START;
  }
});

test("context-limit and ordinary errors are not scheduled", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" }, m1: { provider: "claude" } });
  await resumer.onTurnEnded(
    turnEnded("a1", "codex", failed("Codex ran out of room in the model's context window. Start a new thread.")),
    api,
  );
  await resumer.onTurnEnded(turnEnded("m1", "claude", failed("prompt is too long: 212000 tokens > 200000 maximum")), api);
  await resumer.onTurnEnded(turnEnded("m1", "claude", failed("Claude run failed")), api);
  await resumer.onTurnEnded(turnEnded("a1", "codex", { kind: "canceled", reason: "interrupted" }), api);
  assert.deepEqual(await store.list(), []);
});

test("without a reset in the notice, the account's 5-hour usage window is used", async () => {
  const usage = [
    {
      providerId: "claude",
      displayName: `Claude (${MAIN_EMAIL})`,
      windows: [
        { id: "five_hour", label: "5-hour", usedPct: 100, resetsAt: "2026-10-06T04:30:12.345Z" },
        { id: "seven_day", label: "Weekly", usedPct: 40, resetsAt: "2026-10-09T00:00:00.000Z" },
      ],
    },
  ];
  const { api, sent, resumer } = await setup({ m1: { provider: "claude" } }, { usage });
  await resumer.onTurnEnded(turnEnded("m1", "claude", failed("Claude usage limit reached")), api);
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T04:32:12.345Z");

  clock = new Date("2026-10-06T04:32:12.345Z");
  await resumer.tick();
  assert.equal(sent.length, 1);
});

test("only the usage entry of the agent's own account is used", async () => {
  // Paseo lists every account it has seen; another agent's account may come first.
  const usage = [
    { providerId: "claude", displayName: `Claude (${SUB_EMAIL})`, windows: [{ id: "five_hour", label: "Session", usedPct: 100, resetsAt: "2026-10-06T04:00:00.000Z" }] },
    { providerId: "claude", displayName: `Claude (${MAIN_EMAIL.toUpperCase()})`, windows: [{ id: "five_hour", label: "Session", usedPct: 100, resetsAt: "2026-10-06T04:30:00.000Z" }] },
    { providerId: "codex", displayName: "Codex (opencode@example.com)", windows: [{ id: "five_hour", label: "5-hour", usedPct: 100, resetsAt: "2026-10-06T03:40:00.000Z" }] },
    { providerId: "codex", displayName: `Codex (${CODEX_EMAIL})`, windows: [{ id: "five_hour", label: "5-hour", usedPct: 100, resetsAt: "2026-10-06T04:50:00.000Z" }] },
  ];
  const { api, resumer } = await setup({ m1: { provider: "claude" }, a1: { provider: "codex" } }, { usage });
  await resumer.onTurnEnded(turnEnded("m1", "claude", failed("Claude usage limit reached")), api);
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed("Rate limit exceeded")), api);
  const jobs = Object.fromEntries((await store.list()).map((job) => [job.agentId, job.resetAt]));
  assert.deepEqual(jobs, { m1: "2026-10-06T04:30:00.000Z", a1: "2026-10-06T04:50:00.000Z" });
});

test("an account that cannot be identified falls back to the 15-minute recheck", async () => {
  const usage = [{ providerId: "claude", displayName: `Claude (${MAIN_EMAIL})`, windows: [{ id: "five_hour", label: "5-hour", usedPct: 100, resetsAt: "2026-10-06T04:30:00.000Z" }] }];
  const { api, resumer } = await setup({ m1: { provider: "claude" } }, { usage, claudeConfigDir: join(dir, "signed-out") });
  await resumer.onTurnEnded(turnEnded("m1", "claude", failed("Claude usage limit reached")), api);
  const [job] = await store.list();
  assert.equal(job?.resetAt, null);
  assert.equal(job?.dueAt, "2026-10-06T03:15:00.000Z", "unknown reset rechecks in 15 minutes");
});

test("an unknown reset rechecks in 15 minutes and follows a window that appeared", async () => {
  const usage: FakeOptions["usage"] = [];
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } }, { usage });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed("Rate limit exceeded")), api);
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T03:15:00.000Z");

  usage.push({ providerId: "codex", displayName: `Codex (${CODEX_EMAIL})`, windows: [{ id: "primary", label: "Session", usedPct: 100, resetsAt: "2026-10-06T05:00:00.000Z" }] });
  advance(15 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T05:02:00.000Z");

  clock = new Date("2026-10-06T05:02:00.000Z");
  await resumer.tick();
  assert.equal(sent.length, 1);
});

test("the schedule survives a restart and runs once a hook supplies the API", async () => {
  const first = await setup({ a1: { provider: "codex" } });
  await first.resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), first.api);

  advance(5 * 60 * MINUTE);
  const restarted = createResumer({ store: createJobStore(join(dir, "jobs.json")), now: () => clock });
  await restarted.recover();
  await restarted.tick();
  assert.deepEqual(first.sent, [], "no API before a hook");

  await restarted.attach(first.api);
  assert.deepEqual(first.sent, [{ agentId: "a1", text: CONTINUE_PROMPT }]);
});

test("a continue that hits the limit again is rescheduled, a normal turn clears the job", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.equal(sent.length, 1);

  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const [job] = await store.list();
  assert.equal(job?.state, "pending");
  assert.equal(job?.attempts, 1);

  await resumer.onTurnEnded(turnEnded("a1", "codex", { kind: "completed" }), api);
  assert.deepEqual(await store.list(), []);
});

test("startup scan schedules a Codex agent that hit its limit before the plugin ran", async () => {
  const updatedAt = "2026-10-06T07:06:29.999Z";
  clock = new Date("2026-10-06T07:10:00.000Z");
  const notice =
    "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:51 PM.";
  const { sent, resumer } = await setup({
    c1: { provider: "codex", status: "error", lastError: notice, updatedAt },
  });

  const expected = new Date(updatedAt);
  expected.setHours(18, 51, 0, 0);
  if (expected.getTime() <= Date.parse(updatedAt)) expected.setDate(expected.getDate() + 1);
  const [job] = await store.list();
  assert.equal(job?.resetAt, expected.toISOString());
  assert.equal(job?.dueAt, new Date(expected.getTime() + 2 * MINUTE).toISOString());

  clock = new Date(expected.getTime() + 2 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "c1", text: CONTINUE_PROMPT }]);
});

test("startup scan finds a Claude closing notice and ignores everything else", async () => {
  clock = new Date("2026-10-06T03:10:00.000Z");
  const recent = "2026-10-06T03:05:00.000Z";
  await setup(
    {
      m1: { provider: "claude", status: "idle", updatedAt: recent },
      s1: { provider: "claude-sub", status: "error", lastError: CODEX_LIMIT, updatedAt: recent },
      e1: { provider: "codex", status: "error", lastError: "Codex turn failed", updatedAt: recent },
      o1: { provider: "codex", status: "error", lastError: CODEX_LIMIT, updatedAt: "2026-10-05T15:05:00.000Z" },
      i1: { provider: "codex", status: "error", lastError: CODEX_LIMIT, updatedAt: "2026-10-05T15:15:00.000Z" },
      p1: { provider: "codex", status: "error", lastError: CODEX_LIMIT, updatedAt: recent, attentionReason: "permission" },
    },
    { timelines: { m1: claudeNotice(CLAUDE_LIMIT), s1: claudeNotice(CLAUDE_LIMIT) } },
  );
  const jobs = await store.list();
  // o1 stopped 12h05m before the scan, i1 11h55m before: only the 12-hour window counts.
  assert.deepEqual(jobs.map((job) => job.agentId), ["m1", "i1"]);
  assert.equal(jobs[0]?.dueAt, "2026-10-06T06:02:00.000Z");
});

test("startup scan keeps a job that already exists", async () => {
  clock = new Date("2026-10-06T03:10:00.000Z");
  await store.update("c1", () => ({
    agentId: "c1",
    provider: "codex",
    resetAt: null,
    dueAt: "2026-10-06T03:20:00.000Z",
    baseline: null,
    attempts: 3,
    state: "pending",
    enabled: true,
  }));
  await setup({ c1: { provider: "codex", status: "error", lastError: CODEX_LIMIT, updatedAt: "2026-10-06T03:05:00.000Z" } });
  const [job] = await store.list();
  assert.equal(job?.attempts, 3);
  assert.equal(job?.dueAt, "2026-10-06T03:20:00.000Z");
});

test("a job turned off is skipped at its time and leaves the list", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex", title: "Fix login" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const [shown] = await resumer.listScheduled(api);
  assert.equal(shown?.title, "Fix login");
  assert.equal(shown?.enabled, true, "scheduled jobs start turned on");

  assert.equal(await resumer.setEnabled("a1", shown!.dueAt, false), true);
  assert.equal((await resumer.listScheduled(api))[0]?.enabled, false);

  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await resumer.listScheduled(api), []);
});

test("a job turned back on before its time still continues", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const dueAt = (await store.list())[0]!.dueAt;
  await resumer.setEnabled("a1", dueAt, false);
  await resumer.setEnabled("a1", dueAt, true);
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.equal(sent.length, 1);
});

test("a turned-off job is still canceled by a manual message", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.setEnabled("a1", (await store.list())[0]!.dueAt, false);
  await resumer.onTurnStarted("a1");
  assert.deepEqual(await resumer.listScheduled(api), []);
});

test("toggling a job that ran or changed reports no change", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const dueAt = (await store.list())[0]!.dueAt;
  assert.equal(await resumer.setEnabled("a1", "2026-10-06T09:00:00.000Z", false), false, "stale dueAt");
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.equal(await resumer.setEnabled("a1", dueAt, false), false, "already sent");
  assert.equal(await resumer.setEnabled("missing", dueAt, false), false);
});

test("jobs saved before the toggle existed load as turned on", async () => {
  const { writeFile } = await import("node:fs/promises");
  const legacy = { agentId: "a1", provider: "codex", resetAt: null, dueAt: "2026-10-06T03:15:00.000Z", baseline: null, attempts: 0, state: "pending" };
  await writeFile(join(dir, "jobs.json"), JSON.stringify({ version: 1, jobs: [legacy] }));
  assert.equal((await store.list())[0]?.enabled, true);
});

const LOCAL_PROVIDERS: ProviderSettings = {
  claudeProvider: "claude-main",
  codexProvider: "codex",
  antigravityProvider: "antigravity",
};

test("a local Claude Main selection resumes only that alias using its own account windows", async () => {
  const { api, sent, resumer } = await setup({
    m1: { provider: "claude-main" }, c1: { provider: "claude" }, s1: { provider: "claude-sub" },
  }, {
    readSettings: async () => LOCAL_PROVIDERS,
    usage: [
      { providerId: "claude", displayName: `Claude (${SUB_EMAIL})`, windows: [{ id: "five_hour", usedPct: 100, resetsAt: "2026-10-06T04:00:00.000Z" }] },
      { providerId: "claude", displayName: `Claude (${MAIN_EMAIL})`, windows: [{ id: "seven_day", usedPct: 100, resetsAt: "2026-10-09T00:00:00.000Z" }] },
    ],
  });
  for (const [id, provider] of [["m1", "claude-main"], ["c1", "claude"], ["s1", "claude-sub"]]) {
    await resumer.onTurnEnded(turnEnded(id!, provider!, failed("Usage limit reached")), api);
  }
  const [job] = await store.list();
  assert.equal((await store.list()).length, 1);
  assert.equal(job?.agentId, "m1");
  assert.equal(job?.dueAt, "2026-10-09T00:02:00.000Z");
  advance(Date.parse(job!.dueAt) - clock.getTime());
  await resumer.tick();
  assert.deepEqual(sent.map((message) => message.agentId), ["m1"]);
});

test("startup recovery understands the selected Claude alias's closing notice", async () => {
  await setup({ m1: { provider: "claude-main" } }, {
    readSettings: async () => LOCAL_PROVIDERS,
    timelines: { m1: claudeNotice(CLAUDE_LIMIT) },
  });
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T06:02:00.000Z");
});

test("saving a new provider selection cancels reservations for removed providers", async () => {
  let selection = LOCAL_PROVIDERS;
  const { api, sent, resumer } = await setup({ m1: { provider: "claude-main" } }, { readSettings: async () => selection });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  selection = DEFAULT_PROVIDER_SETTINGS;
  await resumer.reconcileProviders();
  assert.deepEqual(await store.list(), []);
  advance(24 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
});

test("delivery checks the latest selection even when a settings notification was missed", async () => {
  let selection = LOCAL_PROVIDERS;
  const { api, sent, resumer } = await setup({ m1: { provider: "claude-main" } }, { readSettings: async () => selection });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  selection = DEFAULT_PROVIDER_SETTINGS;
  advance(3 * 60 * MINUTE + 2 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await store.list(), []);
});

test("unreadable settings pause saved jobs and never fall back to different providers", async () => {
  let selection: ProviderSettings | null = LOCAL_PROVIDERS;
  const { api, sent, resumer } = await setup({ m1: { provider: "claude-main" }, c1: { provider: "claude" } }, { readSettings: async () => selection });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  selection = null;
  await resumer.onTurnEnded(turnEnded("c1", "claude", failed(CLAUDE_LIMIT)), api);
  await resumer.reconcileProviders();
  advance(3 * 60 * MINUTE + 2 * MINUTE);
  await resumer.tick();
  assert.equal(sent.length, 0);
  assert.equal((await store.list())[0]?.agentId, "m1");
  selection = LOCAL_PROVIDERS;
  await resumer.tick();
  assert.deepEqual(sent.map((message) => message.agentId), ["m1"]);
});

test("provider selection is checked again if it changes while the due agent is loaded", async () => {
  let selection = LOCAL_PROVIDERS;
  const { api, sent, resumer } = await setup({ m1: { provider: "claude-main" } }, { readSettings: async () => selection });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  const originalRef = api.agents.ref;
  api.agents.ref = (id) => {
    const handle = originalRef(id);
    return Object.assign(handle, {
      refresh: async () => {
        selection = DEFAULT_PROVIDER_SETTINGS;
        return { agent: { id, provider: "claude-main", status: "idle", lastUserMessageAt: "2026-10-06T02:00:00.000Z", pendingPermissions: [] }, project: null };
      },
    });
  };
  advance(3 * 60 * MINUTE + 2 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await store.list(), []);
});

test("the selected alias inherits the base CLI home unless it overrides it", async () => {
  const { api, resumer } = await setup({ m1: { provider: "claude-main" } }, {
    readSettings: async () => LOCAL_PROVIDERS,
    claudeAliasEnv: {},
    usage: [{ providerId: "claude", displayName: `Claude (${MAIN_EMAIL})`, windows: [{ id: "five_hour", usedPct: 100, resetsAt: "2026-10-06T04:00:00.000Z" }] }],
  });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed("Usage limit reached")), api);
  assert.equal((await store.list())[0]?.resetAt, "2026-10-06T04:00:00.000Z");
});

test("the selected alias's own CLI home takes precedence over the base home", async () => {
  const { api, resumer } = await setup({ m1: { provider: "claude-main" } }, {
    readSettings: async () => LOCAL_PROVIDERS,
    claudeAliasEnv: { CLAUDE_CONFIG_DIR: join(dir, "claude-sub") },
    usage: [
      { providerId: "claude", displayName: `Claude (${MAIN_EMAIL})`, windows: [{ id: "five_hour", usedPct: 100, resetsAt: "2026-10-06T04:00:00.000Z" }] },
      { providerId: "claude", displayName: `Claude (${SUB_EMAIL})`, windows: [{ id: "five_hour", usedPct: 100, resetsAt: "2026-10-06T04:30:00.000Z" }] },
    ],
  });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed("Usage limit reached")), api);
  assert.equal((await store.list())[0]?.resetAt, "2026-10-06T04:30:00.000Z");
});

test("Antigravity 5h limit: schedules reset + 2 minutes and continues the same agent", async () => {
  const { api, sent, resumer } = await setup({ g1: { provider: "antigravity" } });
  await resumer.onTurnEnded(turnEnded("g1", "antigravity", failed(ANTIGRAVITY_LIMIT)), api);
  const [job] = await store.list();
  assert.equal(job?.dueAt, "2026-10-06T05:02:00.000Z");
  assert.equal(job?.resetAt, "2026-10-06T05:00:00.000Z");

  advance(2 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);

  advance(2 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "g1", text: CONTINUE_PROMPT }]);
});

test("Antigravity limit without a reset in the notice uses the account's usage window", async () => {
  const usage = [
    {
      providerId: "antigravity",
      displayName: `Antigravity (${ANTIGRAVITY_EMAIL})`,
      windows: [{ id: "gemini-5h", label: "Session", usedPct: 100, resetsAt: "2026-10-06T04:30:00.000Z" }],
    },
  ];
  const { api, resumer } = await setup({ g1: { provider: "antigravity" } }, { usage });
  await resumer.onTurnEnded(turnEnded("g1", "antigravity", failed("RESOURCE_EXHAUSTED: Quota exceeded")), api);
  const [job] = await store.list();
  assert.equal(job?.resetAt, "2026-10-06T04:30:00.000Z");
  assert.equal(job?.dueAt, "2026-10-06T04:32:00.000Z");
});

test("startup scan schedules an Antigravity agent that hit its limit before the plugin ran", async () => {
  const { api, resumer } = await setup({
    g1: {
      provider: "antigravity",
      status: "error",
      lastError: ANTIGRAVITY_LIMIT,
      updatedAt: "2026-10-06T02:50:00.000Z",
    },
  });
  await resumer.attach(api);
  const [job] = await store.list();
  assert.equal(job?.agentId, "g1");
  assert.equal(job?.provider, "antigravity");
  assert.equal(job?.resetAt, "2026-10-06T04:50:00.000Z");
});

test("a custom Antigravity alias selection resumes only that alias", async () => {
  const customSettings: ProviderSettings = {
    claudeProvider: "claude",
    codexProvider: "codex",
    antigravityProvider: "antigravity-fast",
  };
  const { api, sent, resumer } = await setup(
    {
      g1: { provider: "antigravity-fast" },
      g2: { provider: "antigravity" },
    },
    {
      readSettings: async () => customSettings,
      antigravityAliasEnv: { ANTIGRAVITY_CONFIG_DIR: join(dir, "antigravity") },
      usage: [
        {
          providerId: "antigravity",
          displayName: `Antigravity (${ANTIGRAVITY_EMAIL})`,
          windows: [{ id: "gemini-5h", label: "Session", usedPct: 100, resetsAt: "2026-10-06T04:00:00.000Z" }],
        },
      ],
    },
  );
  await resumer.onTurnEnded(turnEnded("g1", "antigravity-fast", failed("Resource exhausted")), api);
  await resumer.onTurnEnded(turnEnded("g2", "antigravity", failed("Resource exhausted")), api);

  const jobs = await store.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.agentId, "g1");
  assert.equal(jobs[0]?.provider, "antigravity-fast");
});
