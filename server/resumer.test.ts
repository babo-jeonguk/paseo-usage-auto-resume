import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { PaseoAgent } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginLifecycleEvents, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { CONTINUE_PROMPT, createResumer, type ResumerApi } from "./resumer";
import { createJobStore, type JobStore } from "./store";
import { createHistoryStore, type HistoryStore } from "./history";
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from "../shared/settings";
import { accountEmail } from "./usage";
import { createSubscriptionReader, unknownCheck, type SubscriptionCheck, type SubscriptionReader } from "./subscription";

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
let history: HistoryStore;
let clock: Date;
const savedCodexHome = process.env.CODEX_HOME;

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
  history = createHistoryStore({ path: join(dir, "history.json"), now: () => clock });
  clock = START;
  await signIn(join(dir, "claude"), ".claude.json", { oauthAccount: { emailAddress: MAIN_EMAIL } });
  await signIn(join(dir, "claude-sub"), ".claude.json", { oauthAccount: { emailAddress: SUB_EMAIL } });
  await signIn(join(dir, "codex"), "auth.json", { tokens: { id_token: jwt({ email: CODEX_EMAIL }), access_token: "opaque" } });
  process.env.CODEX_HOME = join(dir, "codex");
});

afterEach(async () => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  await rm(dir, { recursive: true, force: true });
});

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

/** Recorded results, oldest first, as "agent outcome/reason". */
async function recorded(): Promise<string[]> {
  return (await history.list()).reverse().map(({ agentId, outcome, reason }) => `${agentId} ${outcome}${reason ? `/${reason}` : ""}`);
}

interface FakeOptions {
  readSubscription?: SubscriptionReader;
  timelines?: Record<string, AgentTimelineItem[]>;
  backgroundAgents?: string[];
  /** A newer SDK can reject inclusive discovery against an older host. */
  backgroundUnsupported?: boolean;
  listError?: Error;
  usage?: Array<{ providerId: string; displayName: string; status?: string; windows: Array<Record<string, unknown>> }>;
  /** Runs while usage is being read, as a concurrent change would. */
  duringListUsage?: () => Promise<void>;
  claudeConfigDir?: string;
  claudeAliasEnv?: Record<string, string>;
  readSettings?: () => Promise<ProviderSettings | null>;
}

/** Daemon stand-in: agent snapshots by ID, recorded sends, and no way to create agents. */
function fakePaseo(agents: Map<string, Partial<PaseoAgent>>, options: FakeOptions = {}) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const listCalls: Array<{ filter?: { statuses?: string[]; includeBackground?: boolean } }> = [];
  let usageReads = 0;
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
      list: async (query: { filter?: { statuses?: string[]; includeBackground?: boolean } }) => {
        listCalls.push(query);
        if (options.listError) throw options.listError;
        if (query.filter?.includeBackground && options.backgroundUnsupported) {
          throw new Error("Update the host to use background workspaces.");
        }
        return {
          entries: [...agents]
            .filter(([agentId]) => query.filter?.includeBackground || !options.backgroundAgents?.includes(agentId))
            .map(([agentId, agent]) => ({ agent: snapshot(agentId, agent), project: null }))
            .filter((entry) => query.filter?.statuses?.includes(entry.agent.status) ?? true),
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        };
      },
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
            "codex-reserve": { extends: "codex" },
            "antigravity-fast": { extends: "antigravity" },
          },
        },
      }),
    },
    providers: {
      listUsage: async () => {
        usageReads += 1;
        await options.duringListUsage?.();
        return {
          requestId: "r",
          fetchedAt: clock.toISOString(),
          providers: (options.usage ?? []).map((entry) => ({
            status: "available",
            planLabel: null,
            ...entry,
          })),
        };
      },
    },
  } as unknown as ResumerApi;
  const readSubscription: SubscriptionReader = options.readSubscription ?? (async (_api, agent, source, _at, _launch, mode) => {
    if (source === "antigravity") return { auth: "subscription", status: "ready", identity: "fake-agy-account-model" };
    const email = await accountEmail((await api.config.get()).config, agent.provider, source);
    if (!email) return unknownCheck();
    const identity = `${source}:${email}`;
    if (mode === "identity") return { auth: "subscription", status: "unknown", identity };
    if (options.usage === undefined && !options.duringListUsage) return { auth: "subscription", status: "ready", identity };
    const result = await api.providers.listUsage();
    const entry = result.providers.find((e) => e.providerId === source && e.displayName.toLowerCase().endsWith(` (${email.toLowerCase()})`));
    if (!entry || entry.status !== "available" || !entry.windows.length) return { auth: "subscription", status: "unknown", identity };
    const windows = entry.windows.map((w) => ({ id: w.id, usedPct: w.usedPct ?? 100 - (w.remainingPct ?? 0), resetAt: w.resetsAt ?? null }));
    return { auth: "subscription", status: windows.some((w) => w.usedPct >= 100) ? "limited" : "ready", identity, windows };
  });
  return { api, sent, listCalls, readSubscription, usageReads: () => usageReads };
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
  const resumer = createResumer({ store, history, now: () => clock, readSettings: options?.readSettings, readSubscription: fake.readSubscription });
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

  await resumer.onTurnEnded(turnEnded("a1", "codex", { kind: "completed" }), api);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["a1 continued"], "clearing a sent continue adds nothing");
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

test("every provider built on Claude, Codex, or Antigravity resumes by default; other CLIs never do", async () => {
  const { api, sent, resumer } = await setup({
    s1: { provider: "claude-sub" }, m1: { provider: "claude-main" }, r1: { provider: "codex-reserve" }, o1: { provider: "opencode" },
  });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", { kind: "completed" }, claudeNotice(CLAUDE_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("s1", "claude-sub", { kind: "completed" }, claudeNotice(CLAUDE_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("r1", "codex-reserve", failed(CODEX_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("o1", "opencode", failed(CODEX_LIMIT)), api);

  assert.deepEqual((await store.list()).map((job) => job.agentId).sort(), ["m1", "r1", "s1"]);
  advance(24 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent.map((message) => message.agentId).sort(), ["m1", "r1", "s1"]);
});

test("a provider turned off is not scheduled, even when another provider shares its account", async () => {
  const { api, sent, resumer } = await setup({ c1: { provider: "codex" }, r1: { provider: "codex-reserve" } }, {
    readSettings: async () => ({ disabledProviders: ["codex-reserve"] }),
  });
  await resumer.onTurnEnded(turnEnded("c1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("r1", "codex-reserve", failed(CODEX_LIMIT)), api);
  assert.deepEqual((await store.list()).map((job) => job.agentId), ["c1"]);
  advance(24 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent.map((message) => message.agentId), ["c1"]);
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
  await resumer.onTurnStarted("a1");
  assert.deepEqual(sent, []);
  assert.deepEqual(await recorded(), ["a1 canceled/turn_started"]);
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
  assert.deepEqual(await recorded(), ["a1 canceled/new_message"]);
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
  assert.deepEqual(await recorded(), ["a1 canceled/permission", "a1 canceled/permission", "a1 canceled/agent_busy"]);
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
  usage[0]!.windows[0]!.usedPct = 0;
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
  usage[0]!.windows[0]!.usedPct = 0;
  await resumer.tick();
  assert.equal(sent.length, 1);
});

test("the schedule survives a restart and runs once a hook supplies the API", async () => {
  const first = await setup({ a1: { provider: "codex" } });
  await first.resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), first.api);

  advance(5 * 60 * MINUTE);
  const restarted = createResumer({ store: createJobStore(join(dir, "jobs.json")), now: () => clock, readSubscription: first.readSubscription });
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
  assert.deepEqual(await recorded(), ["a1 continued", "a1 canceled/turn_finished"], "the second stop's reservation was still pending");
});

test("a turn that finishes on its own before the continue is recorded as canceled", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("a1", "codex", { kind: "completed" }), api);
  await resumer.onTurnEnded(turnEnded("a1", "codex", { kind: "completed" }), api);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["a1 canceled/turn_finished"]);
});

test("archiving an agent records its pending reservation, but not a continue already sent", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" }, a2: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("a2", "codex", failed(CODEX_LIMIT)), api);
  await store.update("a2", (job) => job && { ...job, state: "sent" });
  await resumer.forget("a1");
  await resumer.forget("a2");
  await resumer.forget("a3");
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["a1 canceled/archived"]);
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
    {
      timelines: { m1: claudeNotice(CLAUDE_LIMIT), s1: claudeNotice(CLAUDE_LIMIT) },
      readSettings: async () => ({ disabledProviders: ["claude-sub"] }),
    },
  );
  const jobs = await store.list();
  // s1's provider is turned off. o1 stopped 12h05m before the scan, i1 11h55m before: only the 12-hour window counts.
  assert.deepEqual(jobs.map((job) => job.agentId), ["m1", "i1"]);
  assert.equal(jobs[0]?.dueAt, "2026-10-06T06:02:00.000Z");
});

test("startup scan recovers unseen limit stops in background workspaces and sends to the existing agents", async () => {
  clock = new Date("2026-10-06T03:10:00.000Z");
  const updatedAt = "2026-10-06T03:05:00.000Z";
  const { sent, resumer } = await setup({
    c1: { provider: "codex", status: "error", lastError: CODEX_LIMIT, updatedAt },
    m1: { provider: "claude", status: "idle", updatedAt },
    off: { provider: "claude-sub", status: "error", lastError: CLAUDE_LIMIT, updatedAt },
  }, {
    backgroundAgents: ["c1", "m1", "off"],
    timelines: { m1: claudeNotice(CLAUDE_LIMIT) },
    readSettings: async () => ({ disabledProviders: ["claude-sub"] }),
  });
  assert.deepEqual((await store.list()).map((job) => job.agentId).sort(), ["c1", "m1"]);
  clock = new Date("2026-10-06T06:02:00.000Z");
  await resumer.tick();
  await resumer.tick();
  assert.deepEqual(sent.map((message) => message.agentId).sort(), ["c1", "m1"]);
  assert.ok(sent.every((message) => message.text === CONTINUE_PROMPT));
});

test("startup scan falls back to normal discovery when an older host rejects background discovery", async () => {
  const { listCalls } = await setup({
    c1: { provider: "codex", status: "error", lastError: CODEX_LIMIT },
  }, { backgroundUnsupported: true });
  assert.equal(listCalls.length, 2);
  assert.equal(listCalls[0]?.filter?.includeBackground, true);
  assert.equal(listCalls[1]?.filter?.includeBackground, undefined);
  assert.deepEqual((await store.list()).map((job) => job.agentId), ["c1"]);
});

test("startup scan does not hide unrelated discovery failures by retrying a narrower list", async () => {
  const { listCalls } = await setup({
    c1: { provider: "codex", status: "error", lastError: CODEX_LIMIT },
  }, { listError: new Error("Connection lost") });
  assert.equal(listCalls.length, 1);
  assert.deepEqual(await store.list(), []);
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
    retries: 0,
  }));
  await setup({ c1: { provider: "codex", status: "error", lastError: CODEX_LIMIT, updatedAt: "2026-10-06T03:05:00.000Z" } });
  const [job] = await store.list();
  assert.equal(job?.attempts, 3);
  assert.equal(job?.dueAt, "2026-10-06T03:20:00.000Z");
});

test("a job turned off is skipped at its time and leaves the list", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex", title: "Fix login", workspaceId: "background-workspace" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const [shown] = await resumer.listScheduled(api);
  assert.equal(shown?.title, "Fix login");
  assert.equal(shown?.workspaceId, "background-workspace", "composer placement follows the agent's workspace");
  assert.equal(shown?.enabled, true, "scheduled jobs start turned on");

  assert.equal(await resumer.setEnabled("a1", shown!.dueAt, false), true);
  assert.equal((await resumer.listScheduled(api))[0]?.enabled, false);

  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await resumer.listScheduled(api), []);
  assert.deepEqual(await recorded(), ["a1 skipped"]);
  const [row] = await resumer.listHistory(api);
  assert.equal(row?.title, "Fix login", "the live agent names a result recorded without a title");
  assert.equal(row?.workspaceId, "background-workspace");
});

test("a job turned back on before its time still continues", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const dueAt = (await store.list())[0]!.dueAt;
  await resumer.setEnabled("a1", dueAt, false);
  await resumer.setEnabled("a1", dueAt, true);
  await resumer.setAllEnabled(false, [{ agentId: "a1", dueAt }]);
  await resumer.setAllEnabled(true, [{ agentId: "a1", dueAt }]);
  assert.deepEqual(await recorded(), [], "toggles are not results");
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(await recorded(), ["a1 continued"]);
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

/** This host resumes Claude only through Claude Main. */
const LOCAL_PROVIDERS: ProviderSettings = { disabledProviders: ["claude", "claude-sub"] };
const CLAUDE_MAIN_OFF: ProviderSettings = { disabledProviders: ["claude-main"] };

test("with only Claude Main on, only it resumes, using its own account windows", async () => {
  const usage = [
    { providerId: "claude", displayName: `Claude (${SUB_EMAIL})`, windows: [{ id: "five_hour", usedPct: 100, resetsAt: "2026-10-06T04:00:00.000Z" }] },
    { providerId: "claude", displayName: `Claude (${MAIN_EMAIL})`, windows: [{ id: "seven_day", usedPct: 100, resetsAt: "2026-10-09T00:00:00.000Z" }] },
  ];
  const { api, sent, resumer } = await setup({
    m1: { provider: "claude-main" }, c1: { provider: "claude" }, s1: { provider: "claude-sub" },
  }, {
    readSettings: async () => LOCAL_PROVIDERS,
    usage,
  });
  for (const [id, provider] of [["m1", "claude-main"], ["c1", "claude"], ["s1", "claude-sub"]]) {
    await resumer.onTurnEnded(turnEnded(id!, provider!, failed("Usage limit reached")), api);
  }
  const [job] = await store.list();
  assert.equal((await store.list()).length, 1);
  assert.equal(job?.agentId, "m1");
  assert.equal(job?.dueAt, "2026-10-09T00:02:00.000Z");
  advance(Date.parse(job!.dueAt) - clock.getTime());
  usage[1]!.windows[0]!.usedPct = 0;
  await resumer.tick();
  assert.deepEqual(sent.map((message) => message.agentId), ["m1"]);
});

test("startup recovery understands Claude Main's closing notice", async () => {
  await setup({ m1: { provider: "claude-main" } }, {
    readSettings: async () => LOCAL_PROVIDERS,
    timelines: { m1: claudeNotice(CLAUDE_LIMIT) },
  });
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T06:02:00.000Z");
});

test("turning a provider off cancels its pending reservations, including ones turned off in the list", async () => {
  let selection = DEFAULT_PROVIDER_SETTINGS;
  const { api, sent, resumer } = await setup(
    { m1: { provider: "claude-main" }, m2: { provider: "claude-main" }, c1: { provider: "codex" } },
    { readSettings: async () => selection },
  );
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("m2", "claude-main", failed(CLAUDE_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("c1", "codex", failed(CODEX_LIMIT)), api);
  const m2 = (await store.list()).find((job) => job.agentId === "m2")!;
  assert.equal(await resumer.setEnabled("m2", m2.dueAt, false), true);
  selection = CLAUDE_MAIN_OFF;
  await resumer.reconcileProviders();
  await resumer.reconcileProviders();
  assert.deepEqual((await store.list()).map((job) => job.agentId), ["c1"]);
  selection = DEFAULT_PROVIDER_SETTINGS;
  advance(24 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent.map((message) => message.agentId), ["c1"]);
  assert.deepEqual(await recorded(), ["m1 canceled/provider_off", "m2 canceled/provider_off", "c1 continued"]);
});

test("turning a provider back on restores nothing; its next limit stop is scheduled", async () => {
  let selection = CLAUDE_MAIN_OFF;
  const { api, resumer } = await setup({ m1: { provider: "claude-main" } }, { readSettings: async () => selection });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  assert.deepEqual(await store.list(), []);
  selection = DEFAULT_PROVIDER_SETTINGS;
  await resumer.reconcileProviders();
  assert.deepEqual(await store.list(), []);
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  assert.equal((await store.list())[0]?.agentId, "m1");
});

test("a reservation whose provider no longer runs a supported CLI is canceled at its time", async () => {
  const { api, sent, resumer } = await setup({ r1: { provider: "codex-reserve" } });
  await resumer.onTurnEnded(turnEnded("r1", "codex-reserve", failed(CODEX_LIMIT)), api);
  const config = api.config.get;
  api.config.get = async () => {
    const current = await config();
    return { ...current, config: { ...current.config, providers: { ...current.config.providers, "codex-reserve": { extends: "opencode" } } } } as Awaited<ReturnType<typeof config>>;
  };
  advance(24 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["r1 canceled/unsupported_cli"]);
});

test("saving with a provider turned off cancels its reservations", async () => {
  let selection = LOCAL_PROVIDERS;
  const { api, sent, resumer } = await setup({ m1: { provider: "claude-main" } }, { readSettings: async () => selection });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  selection = CLAUDE_MAIN_OFF;
  await resumer.reconcileProviders();
  assert.deepEqual(await store.list(), []);
  advance(24 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
});

test("delivery checks the latest settings even when a settings notification was missed", async () => {
  let selection = LOCAL_PROVIDERS;
  const { api, sent, resumer } = await setup({ m1: { provider: "claude-main" } }, { readSettings: async () => selection });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  selection = CLAUDE_MAIN_OFF;
  advance(3 * 60 * MINUTE + 2 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["m1 canceled/provider_off"]);
});

test("unreadable settings pause saved jobs and never fall back to the defaults", async () => {
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
  assert.deepEqual(await recorded(), []);
  selection = LOCAL_PROVIDERS;
  await resumer.tick();
  assert.deepEqual(sent.map((message) => message.agentId), ["m1"]);
});

test("the provider's switch is checked again if it changes while the due agent is loaded", async () => {
  let selection = LOCAL_PROVIDERS;
  const { api, sent, resumer } = await setup({ m1: { provider: "claude-main" } }, { readSettings: async () => selection });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed(CLAUDE_LIMIT)), api);
  const originalRef = api.agents.ref;
  api.agents.ref = (id) => {
    const handle = originalRef(id);
    return Object.assign(handle, {
      refresh: async () => {
        selection = CLAUDE_MAIN_OFF;
        return { agent: { id, provider: "claude-main", status: "idle", lastUserMessageAt: "2026-10-06T02:00:00.000Z", pendingPermissions: [] }, project: null };
      },
    });
  };
  advance(3 * 60 * MINUTE + 2 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await store.list(), []);
});

test("a provider built on Claude inherits its CLI home unless it overrides it", async () => {
  const { api, resumer } = await setup({ m1: { provider: "claude-main" } }, {
    readSettings: async () => LOCAL_PROVIDERS,
    claudeAliasEnv: {},
    usage: [{ providerId: "claude", displayName: `Claude (${MAIN_EMAIL})`, windows: [{ id: "five_hour", usedPct: 100, resetsAt: "2026-10-06T04:00:00.000Z" }] }],
  });
  await resumer.onTurnEnded(turnEnded("m1", "claude-main", failed("Usage limit reached")), api);
  assert.equal((await store.list())[0]?.resetAt, "2026-10-06T04:00:00.000Z");
});

test("a provider's own CLI home takes precedence over the base home", async () => {
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

test("Antigravity limit without a reset in the notice retries the continue in 15 minutes", async () => {
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
  assert.equal(job?.resetAt, null);
  assert.equal(job?.dueAt, "2026-10-06T03:15:00.000Z");
  assert.equal(job?.retries, 1);
});

test("Antigravity continues at the notice's reset even though agy reports no account", async () => {
  const readSubscription = createSubscriptionReader({ run: async () => { throw new Error("must not run agy"); } });
  const { api, sent, resumer } = await setup({ g1: { provider: "antigravity" } }, { readSubscription });
  await resumer.onTurnEnded(turnEnded("g1", "antigravity", failed(ANTIGRAVITY_LIMIT)), api);
  const [job] = await store.list();
  assert.equal(job?.dueAt, "2026-10-06T05:02:00.000Z");
  assert.equal(job?.waiting, undefined);
  clock = new Date("2026-10-06T05:02:00.000Z");
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "g1", text: CONTINUE_PROMPT }]);
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

test("an Antigravity provider can be turned off while another built on it resumes", async () => {
  const customSettings: ProviderSettings = { disabledProviders: ["antigravity"] };
  const { api, resumer } = await setup(
    {
      g1: { provider: "antigravity-fast" },
      g2: { provider: "antigravity" },
    },
    { readSettings: async () => customSettings },
  );
  await resumer.onTurnEnded(turnEnded("g1", "antigravity-fast", failed("Resource exhausted")), api);
  await resumer.onTurnEnded(turnEnded("g2", "antigravity", failed("Resource exhausted")), api);

  const jobs = await store.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.agentId, "g1");
  assert.equal(jobs[0]?.provider, "antigravity-fast");
});

test("a weekly window still used up at send time postpones the continue to its reset", async () => {
  const usage: FakeOptions["usage"] = [{
    providerId: "claude", displayName: `Claude (${MAIN_EMAIL})`,
    windows: [
      { id: "five_hour", label: "Session", usedPct: 10, resetsAt: "2026-10-06T08:00:00.000Z" },
      { id: "seven_day", label: "Weekly", usedPct: 90, resetsAt: "2026-10-09T00:00:00.000Z" },
    ],
  }];
  const { api, sent, resumer } = await setup({ m1: { provider: "claude" } }, { usage });
  await resumer.onTurnEnded(turnEnded("m1", "claude", { kind: "completed" }, claudeNotice(CLAUDE_LIMIT)), api);
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T06:02:00.000Z", "the notice decides the first time");
  usage[0]!.windows[1]!.usedPct = 100;

  clock = new Date("2026-10-06T06:02:00.000Z");
  await resumer.tick();
  assert.deepEqual(sent, []);
  const [job] = await store.list();
  assert.equal(job?.resetAt, "2026-10-09T00:00:00.000Z");
  assert.equal(job?.dueAt, "2026-10-09T00:02:00.000Z");
  assert.equal(job?.attempts, 0, "a postponement is not a retry");
  assert.equal(job?.enabled, true);
  assert.equal(job?.state, "pending");
  assert.deepEqual(await recorded(), [], "a postponement is not a result");

  usage[0]!.windows[1]!.usedPct = 0;
  clock = new Date("2026-10-09T00:02:00.000Z");
  await resumer.tick();
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "m1", text: CONTINUE_PROMPT }]);
});

test("a Codex 5-hour window still used up at send time postpones the continue to its reset", async () => {
  const usage: FakeOptions["usage"] = [{
    providerId: "codex", displayName: `Codex (${CODEX_EMAIL})`,
    windows: [{ id: "five_hour", label: "5-hour", usedPct: 100, resetsAt: "2026-10-06T07:30:00.000Z" }],
  }];
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } }, { usage });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);

  clock = new Date("2026-10-06T05:02:00.000Z");
  await resumer.tick();
  assert.deepEqual(sent, []);
  const [job] = await store.list();
  assert.equal(job?.resetAt, "2026-10-06T07:30:00.000Z");
  assert.equal(job?.dueAt, "2026-10-06T07:32:00.000Z");

  clock = new Date("2026-10-06T07:32:00.000Z");
  usage[0]!.windows[0]!.usedPct = 0;
  await resumer.tick();
  assert.equal(sent.length, 1, "the window has renewed by its own reset");
});

test("a 5-hour window that renews later but is not used up does not hold the continue", async () => {
  const usage = [{
    providerId: "codex", displayName: `Codex (${CODEX_EMAIL})`,
    windows: [{ id: "five_hour", label: "5-hour", usedPct: 99, resetsAt: "2026-10-06T09:00:00.000Z" }],
  }];
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } }, { usage });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  clock = new Date("2026-10-06T05:02:00.000Z");
  await resumer.tick();
  assert.equal(sent.length, 1);
});

test("missing, unavailable and other-account usage hold the continue", async () => {
  const exhausted = [{ id: "five_hour", label: "5-hour", usedPct: 100, resetsAt: "2026-10-06T09:00:00.000Z" }];
  for (const [name, usage] of [
    ["no entries", []],
    ["unavailable", [{ providerId: "codex", displayName: `Codex (${CODEX_EMAIL})`, status: "unavailable", windows: exhausted }]],
    ["another account", [{ providerId: "codex", displayName: "Codex (opencode@example.com)", windows: exhausted }]],
  ] as Array<[string, FakeOptions["usage"]]>) {
    clock = START;
    const { api, sent, resumer } = await setup({ a1: { provider: "codex" } }, { usage });
    await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
    clock = new Date("2026-10-06T05:02:00.000Z");
    await resumer.tick();
    assert.equal(sent.length, 0, name);
    assert.equal((await store.list())[0]?.waiting, "usage");
    await store.update("a1", () => null);
  }
});

test("an Antigravity continue is sent without reading usage", async () => {
  const usage = [{
    providerId: "antigravity", displayName: `Antigravity (${ANTIGRAVITY_EMAIL})`,
    windows: [{ id: "gemini-5h", label: "Session", usedPct: 100, resetsAt: "2026-10-06T09:00:00.000Z" }],
  }];
  const { api, sent, resumer, usageReads } = await setup({ g1: { provider: "antigravity" } }, { usage });
  await resumer.onTurnEnded(turnEnded("g1", "antigravity", failed(ANTIGRAVITY_LIMIT)), api);
  clock = new Date("2026-10-06T05:02:00.000Z");
  await resumer.tick();
  assert.equal(sent.length, 1);
  assert.equal(usageReads(), 0);
});

test("a job turned off or replaced while usage is read is neither postponed nor sent", async () => {
  const usage = [{
    providerId: "codex", displayName: `Codex (${CODEX_EMAIL})`,
    windows: [{ id: "five_hour", label: "5-hour", usedPct: 10, resetsAt: "2026-10-06T07:30:00.000Z" }],
  }];
  const replacement = {
    agentId: "a1", provider: "codex", resetAt: "2026-10-06T08:00:00.000Z", dueAt: "2026-10-06T08:02:00.000Z",
    baseline: "2026-10-06T02:00:00.000Z", attempts: 0, state: "pending" as const, enabled: true, retries: 0,
  };
  for (const [name, change] of [
    ["turned off", async (resumer: ReturnType<typeof createResumer>) => {
      await resumer.setEnabled("a1", "2026-10-06T05:02:00.000Z", false);
    }],
    ["replaced", async () => {
      await store.update("a1", () => replacement);
    }],
  ] as Array<[string, (resumer: ReturnType<typeof createResumer>) => Promise<void>]>) {
    clock = START;
    let concurrent: (() => Promise<void>) | undefined;
    const { api, sent, resumer } = await setup({ a1: { provider: "codex" } }, {
      usage,
      duringListUsage: async () => {
        const run = concurrent;
        concurrent = undefined;
        await run?.();
      },
    });
    usage[0]!.windows[0]!.usedPct = 10;
    await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
    usage[0]!.windows[0]!.usedPct = 100;
    concurrent = () => change(resumer);
    clock = new Date("2026-10-06T05:02:00.000Z");
    await resumer.tick();
    assert.deepEqual(sent, [], name);
    const [job] = await store.list();
    assert.notEqual(job?.dueAt, "2026-10-06T07:32:00.000Z", name);
    assert.deepEqual(await recorded(), [], name);
    await store.update("a1", () => null);
  }
});

test("rescheduling moves only the due time and turns the job on", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.setEnabled("a1", "2026-10-06T05:02:00.000Z", false);
  const before = (await store.list())[0]!;

  const result = await resumer.reschedule("a1", "2026-10-06T05:02:00.000Z", "2026-10-06T07:00:00.000Z");

  assert.deepEqual(result, { changed: true, dueAt: "2026-10-06T07:00:00.000Z" });
  assert.deepEqual((await store.list())[0], { ...before, dueAt: "2026-10-06T07:00:00.000Z", enabled: true });
  assert.deepEqual(await recorded(), [], "a time change is not a result");
});

test("a rescheduled job continues once, at its new time", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.reschedule("a1", "2026-10-06T05:02:00.000Z", "2026-10-06T05:30:00.000Z");

  clock = new Date("2026-10-06T05:29:00.000Z");
  await resumer.tick();
  assert.deepEqual(sent, [], "not at the old time");

  clock = new Date("2026-10-06T05:30:00.000Z");
  await resumer.tick();
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "a1", text: CONTINUE_PROMPT }]);
});

test("rescheduling before the reset or more than a week out is refused with the reason", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const dueAt = "2026-10-06T05:02:00.000Z";

  assert.deepEqual(await resumer.reschedule("a1", dueAt, "2026-10-06T05:01:00.000Z"), {
    changed: false,
    reason: "too-early",
    earliest: "2026-10-06T05:02:00.000Z",
  });
  assert.deepEqual(await resumer.reschedule("a1", dueAt, "2026-10-13T04:01:00.000Z"), { changed: false, reason: "too-late" });
  assert.equal((await store.list())[0]?.dueAt, dueAt, "a refused time leaves the job alone");

  assert.equal((await resumer.reschedule("a1", dueAt, "2026-10-13T04:00:00.000Z")).changed, true, "7 days + 1 hour is allowed");
});

test("without a known reset, the earliest new time is a minute from now", async () => {
  const { resumer } = await setup({});
  await store.update("a1", () => ({
    agentId: "a1", provider: "codex", resetAt: null, dueAt: "2026-10-06T03:15:00.000Z",
    baseline: null, attempts: 0, state: "pending", enabled: true, retries: 0,
  }));

  assert.deepEqual(await resumer.reschedule("a1", "2026-10-06T03:15:00.000Z", "2026-10-06T03:00:30.000Z"), {
    changed: false,
    reason: "too-early",
    earliest: "2026-10-06T03:01:00.000Z",
  });
  assert.equal((await resumer.reschedule("a1", "2026-10-06T03:15:00.000Z", "2026-10-06T03:01:00.000Z")).changed, true);
});

test("rescheduling a job that moved, ran, or is being sent reports why nothing changed", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const shown = "2026-10-06T05:02:00.000Z";
  const plusTen = "2026-10-06T05:12:00.000Z";

  assert.equal((await resumer.reschedule("a1", shown, plusTen)).changed, true);
  assert.deepEqual(await resumer.reschedule("a1", shown, plusTen), { changed: false, reason: "changed" }, "a second +10m from the same screen");
  assert.deepEqual(await resumer.reschedule("missing", shown, plusTen), { changed: false, reason: "changed" });

  await store.update("a1", (job) => job && { ...job, state: "sending" });
  assert.deepEqual(await resumer.reschedule("a1", plusTen, "2026-10-06T05:22:00.000Z"), { changed: false, reason: "sending" });

  await store.update("a1", (job) => job && { ...job, state: "sent" });
  assert.deepEqual(await resumer.reschedule("a1", plusTen, "2026-10-06T05:22:00.000Z"), { changed: false, reason: "changed" });
});

test("after rescheduling, the toggle follows the new time", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.reschedule("a1", "2026-10-06T05:02:00.000Z", "2026-10-06T05:30:00.000Z");

  assert.equal(await resumer.setEnabled("a1", "2026-10-06T05:02:00.000Z", false), false, "old time");
  assert.equal(await resumer.setEnabled("a1", "2026-10-06T05:30:00.000Z", false), true);

  clock = new Date("2026-10-06T05:30:00.000Z");
  await resumer.tick();
  assert.deepEqual(sent, []);
});

test("turning all off or on changes only the pending jobs the screen showed", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" }, a2: { provider: "codex" }, a3: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("a2", "codex", failed(CODEX_LIMIT)), api);
  const shown = (await resumer.listScheduled(api)).map(({ agentId, dueAt }) => ({ agentId, dueAt }));
  await store.update("a2", (job) => job && { ...job, state: "sending" });
  await resumer.onTurnEnded(turnEnded("a3", "codex", failed(CODEX_LIMIT)), api);

  assert.equal(await resumer.setAllEnabled(false, shown), 1);
  const enabled = async () => Object.fromEntries((await store.list()).map((job) => [job.agentId, job.enabled]));
  assert.deepEqual(await enabled(), { a1: false, a2: true, a3: true }, "a sending job and one scheduled after the screen loaded stay on");

  assert.equal(await resumer.setAllEnabled(true, shown), 1);
  assert.deepEqual(await enabled(), { a1: true, a2: true, a3: true });
});

test("a usage lookup failure never authorizes an automatic continue", async () => {
  const { api, sent, resumer } = await setup({ a1: { provider: "codex" } }, {
    duringListUsage: async () => { throw new Error("usage service offline"); },
  });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.equal((await store.list())[0]?.state, "pending");
});

test("API auth never schedules even an explicit provider limit code", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" } }, {
    readSubscription: async () => ({ auth: "api", status: "unknown" }),
  });
  await resumer.onTurnEnded(turnEnded("a1", "codex", { kind: "failed", error: { code: "usage_limit_reached", message: CODEX_LIMIT } }), api);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), [], "nothing was reserved");
});

test("a reservation whose agent moves to API billing is recorded once, at a stop or at its time", async () => {
  let auth: SubscriptionCheck["auth"] = "subscription";
  const { api, resumer, sent } = await setup({ a1: { provider: "codex", title: "Fix login" }, a2: { provider: "codex" } }, {
    readSubscription: async () => auth === "api" ? { auth, status: "unknown" } : { auth, status: "ready", identity: "account-model" },
  });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("a2", "codex", failed(CODEX_LIMIT)), api);
  auth = "api";
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["a1 canceled/api_route", "a2 canceled/api_route"]);
  assert.equal((await history.list())[1]?.title, "Fix login", "a stop that loaded the agent keeps its title");
});

test("a stop whose windows are not used up retries after 15, 30 and 60 minutes, then gives up", async () => {
  const { api, resumer, sent } = await setup({ a1: { provider: "codex" } }, {
    readSubscription: async () => ({ auth: "subscription", status: "ready", identity: "account-model" }),
  });
  const stop = () => resumer.onTurnEnded(turnEnded("a1", "codex", failed("Your workspace is out of credits. Ask your workspace owner to refill in order to continue.")), api);
  await stop();
  for (const minutes of [15, 30, 60]) {
    const [job] = await store.list();
    assert.equal(job?.dueAt, new Date(clock.getTime() + minutes * MINUTE).toISOString());
    assert.equal(job?.waiting, undefined, "a retry is a planned continue, not a status check");
    advance(minutes * MINUTE);
    await resumer.tick();
    await stop();
  }
  assert.equal(sent.length, 3);
  assert.deepEqual(await store.list(), [], "a fourth stop with free windows gives up");
  assert.deepEqual(await recorded(), ["a1 continued", "a1 continued", "a1 continued", "a1 gave_up/retries"]);
});

test("the 24th automatic continue that hits a limit again gives up and is recorded", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" } });
  await store.update("a1", () => ({
    agentId: "a1", provider: "codex", resetAt: null, dueAt: "2026-10-06T02:50:00.000Z",
    baseline: "2026-10-06T02:00:00.000Z", attempts: 23, state: "sent", enabled: true, retries: 0,
  }));
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["a1 gave_up/attempts"]);
});

test("a used-up window after a retry waits for its reset and starts the retries over", async () => {
  let check: SubscriptionCheck = { auth: "subscription", status: "ready", identity: "account-model" };
  const { api, resumer, sent } = await setup({ a1: { provider: "codex" } }, { readSubscription: async () => check });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed("Rate limit exceeded")), api);
  advance(15 * MINUTE);
  await resumer.tick();
  check = { ...check, status: "limited", windows: [{ id: "primary_window", usedPct: 100, resetAt: "2026-10-06T06:00:00.000Z" }] };
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed("Rate limit exceeded")), api);
  const [job] = await store.list();
  assert.equal(job?.dueAt, "2026-10-06T06:02:00.000Z");
  assert.equal(job?.retries, 0);
  assert.equal(sent.length, 1);
});

test("a notice schedules its reset despite unknown auth, but cannot authorize delivery", async () => {
  const { api, resumer, sent } = await setup({ a1: { provider: "codex" } }, { readSubscription: async () => unknownCheck() });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  assert.equal((await store.list())[0]?.resetAt, "2026-10-06T05:00:00.000Z", "shown, not trusted");
  assert.equal((await store.list())[0]?.dueAt, "2026-10-06T05:02:00.000Z");
  assert.equal((await store.list())[0]?.waiting, undefined);
  advance(4 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.equal((await store.list())[0]?.attempts, 0, "status checks are not model retries");
});

test("a notice's reset stays evidence while auth is unknown, and continues once auth is verified ready", async () => {
  let check: SubscriptionCheck = unknownCheck();
  const { api, resumer, sent } = await setup({ a1: { provider: "codex" } }, { readSubscription: async () => check });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  advance(3 * 60 * MINUTE);
  check = { auth: "subscription", status: "ready", identity: "account-model" };
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "a1", text: CONTINUE_PROMPT }]);
});

test("a reservation saved by v1.2.0 continues after upgrading once its account is verified ready", async () => {
  const legacy = { agentId: "a1", provider: "codex", resetAt: "2026-10-06T02:50:00.000Z", dueAt: "2026-10-06T02:52:00.000Z", baseline: "2026-10-06T02:00:00.000Z", attempts: 0, state: "pending", enabled: true };
  await writeFile(join(dir, "jobs.json"), JSON.stringify({ version: 1, jobs: [legacy] }));
  const { resumer, sent } = await setup({ a1: { provider: "codex" } }, {
    readSubscription: async () => ({ auth: "subscription", status: "ready", identity: "account-model" }),
  });
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "a1", text: CONTINUE_PROMPT }]);
});

test("a credits notice waits for the used-up window to reset, not for credits", async () => {
  let check: SubscriptionCheck = { auth: "subscription", status: "limited", identity: "workspace-model", windows: [{ id: "primary_window", usedPct: 100, resetAt: "2026-10-06T04:00:00Z" }] };
  const { api, resumer, sent } = await setup({ a1: { provider: "codex" } }, { readSubscription: async () => check });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed("Your workspace is out of credits. Ask your workspace owner to refill in order to continue.")), api);
  const [job] = await store.list();
  assert.equal(job?.dueAt, "2026-10-06T04:02:00.000Z");
  assert.equal(job?.waiting, undefined);
  clock = new Date("2026-10-06T04:02:00Z");
  check = { ...check, status: "ready", windows: [{ id: "primary_window", usedPct: 0, resetAt: "2026-10-06T09:00:00Z" }] };
  await resumer.tick();
  assert.deepEqual(sent, [{ agentId: "a1", text: CONTINUE_PROMPT }]);
});

test("a job saved while waiting for credits loads as waiting for usage", async () => {
  const saved = { agentId: "a1", provider: "codex", resetAt: null, dueAt: "2026-10-06T03:15:00.000Z", baseline: null, attempts: 0, state: "pending", enabled: true, reason: "credits", waiting: "credits", renewable: false };
  await writeFile(join(dir, "jobs.json"), JSON.stringify({ version: 1, jobs: [saved] }));
  const [job] = await store.list();
  assert.equal(job?.waiting, "usage");
  assert.equal(job?.retries, 0);
});

test("changing workspace or model identity cancels a pending reservation", async () => {
  let identity = "original-workspace-model";
  const { api, resumer, sent } = await setup({ a1: { provider: "codex" } }, {
    readSubscription: async () => ({ auth: "subscription", status: "ready", identity }),
  });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  identity = "same-email-different-workspace-model";
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["a1 canceled/account_changed"]);
});

test("each safety check that stops a due continue is recorded with its own reason", async () => {
  for (const [reason, change] of [
    ["agent_missing", null],
    ["archived", { archivedAt: "2026-10-06T04:00:00.000Z" }],
    ["provider_changed", { provider: "codex-reserve" }],
    ["model_changed", { model: "gpt-b" }],
  ] as Array<[string, Partial<PaseoAgent> | null]>) {
    clock = START;
    const { api, resumer, sent, agents } = await setup({ a1: { provider: "codex", model: "gpt-a" } });
    await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
    if (change) agents.set("a1", { provider: "codex", model: "gpt-a", ...change });
    else agents.delete("a1");
    advance(3 * 60 * MINUTE);
    await resumer.tick();
    assert.deepEqual(sent, [], reason);
    assert.equal((await recorded()).at(-1), `a1 canceled/${reason}`);
  }
  assert.equal((await recorded()).length, 4);
});

test("a continue that cannot be sent is recorded as failed and leaves no job", async () => {
  const { api, resumer } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const originalRef = api.agents.ref;
  api.agents.ref = (id) => Object.assign(originalRef(id), { send: async () => { throw new Error("socket closed"); } });
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["a1 send_failed"]);
});

test("a restart drops a continue left mid-send and records it once", async () => {
  await store.update("a1", () => ({
    agentId: "a1", provider: "codex", resetAt: null, dueAt: "2026-10-06T02:50:00.000Z",
    baseline: null, attempts: 0, state: "sending", enabled: true, retries: 0,
  }));
  const resumer = createResumer({ store, history, now: () => clock });
  await resumer.recover();
  await resumer.recover();
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["a1 interrupted"]);
});

test("history keeps the title recorded at the time once the agent is gone, and prefers the live one", async () => {
  const { api, resumer, agents } = await setup({
    a1: { provider: "codex", title: "Fix login", workspaceId: "w1" },
    a2: { provider: "codex", title: "Old name", workspaceId: "w2" },
  });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("a2", "codex", failed(CODEX_LIMIT)), api);
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  agents.delete("a1");
  agents.set("a2", { provider: "codex", title: "  New name ", workspaceId: "w2" });
  const rows = await resumer.listHistory(api);
  assert.deepEqual(rows.map(({ agentId, title, workspaceId }) => ({ agentId, title, workspaceId })), [
    { agentId: "a2", title: "New name", workspaceId: "w2" },
    { agentId: "a1", title: "Fix login", workspaceId: null },
  ]);
});

test("history marks an archived agent so its conversation is not offered to open", async () => {
  const { api, resumer, agents } = await setup({
    a1: { provider: "codex", title: "Fix login", workspaceId: "w1" },
    a2: { provider: "codex", title: "Plan release", workspaceId: "w2" },
  });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  await resumer.onTurnEnded(turnEnded("a2", "codex", failed(CODEX_LIMIT)), api);
  agents.set("a1", { provider: "codex", title: "Fix login", workspaceId: "w1", archivedAt: "2026-10-06T03:30:00.000Z" });
  await resumer.forget("a1");
  await resumer.onTurnStarted("a2");
  const rows = await resumer.listHistory(api);
  assert.deepEqual(rows.map(({ agentId, workspaceId, archived }) => ({ agentId, workspaceId, archived })), [
    { agentId: "a2", workspaceId: "w2", archived: false },
    { agentId: "a1", workspaceId: "w1", archived: true },
  ]);
});

test("a history that cannot be written never stops a continue", async () => {
  const map = new Map(Object.entries({ a1: { provider: "codex" } as Partial<PaseoAgent> }));
  const fake = fakePaseo(map);
  const resumer = createResumer({
    store, now: () => clock, readSubscription: fake.readSubscription,
    history: { list: async () => [], append: async () => { throw new Error("disk full"); } },
  });
  await resumer.attach(fake.api);
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), fake.api);
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.equal(fake.sent.length, 1);
  assert.equal((await store.list())[0]?.state, "sent");
});

test("Business raw response goes through auth, exact-model reset, persisted restart and recovery once", async () => {
  const home = join(dir, "codex");
  await signIn(home, "auth.json", { auth_mode: "chatgpt", tokens: { access_token: "private-access-token", account_id: "business-workspace" } });
  let available = false;
  const readSubscription = createSubscriptionReader({
    codex: async () => ({ account: { account: { type: "chatgpt" } }, config: { config: { model_provider: "openai" } } }),
    fetch: async () => new Response(JSON.stringify({
      account_id: "business-workspace", rate_limit_reached_type: { type: "workspace_member_credits_depleted" },
      spend_control: { reached: false }, credits: { has_credits: false },
      rate_limit: { primary_window: { used_percent: 100, reset_at: 1792160062 } },
      model_usage: { "gpt-6-astra": { available, available_at: "2026-10-06T04:00:22Z", credits_would_enable: true } },
    })),
  });
  const { api, resumer, sent } = await setup({ a1: { provider: "codex", model: "gpt-6-astra" } }, { readSubscription });
  resumer.rememberSession({ agentId: "a1", workspaceId: null, provider: "codex", cwd: "/repo", reason: "create", purpose: "interactive", env: { CODEX_HOME: home } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed("Your workspace is out of credits. Ask your workspace owner to refill in order to continue.")), api);
  const [job] = await store.list();
  assert.equal(job?.resetAt, "2026-10-06T04:00:22.000Z");
  assert.equal(job?.dueAt, "2026-10-06T04:02:22.000Z");
  assert.doesNotMatch(JSON.stringify(job), /private-access-token/);
  const restarted = createResumer({ store, now: () => clock, readSubscription });
  clock = new Date("2026-10-06T04:02:22Z");
  await restarted.attach(api);
  assert.deepEqual(sent, [], "timestamp passing is not recovery");
  available = true;
  advance(15 * MINUTE);
  await restarted.tick();
  await restarted.tick();
  assert.equal(sent.length, 1);
});

test("a continue already sent is cleared without a report when the next stop runs on API billing", async () => {
  let auth: SubscriptionCheck["auth"] = "subscription";
  const { api, resumer, sent } = await setup({ a1: { provider: "codex" } }, {
    readSubscription: async () => auth === "api" ? { auth, status: "unknown" } : { auth, status: "ready", identity: "account-model" },
  });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  assert.equal(sent.length, 1);
  auth = "api";
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await recorded(), ["a1 continued"]);
});

test("a reservation switched back on while its skip is being decided is kept and sent", async () => {
  let duringSettings: (() => Promise<void>) | undefined;
  const { api, resumer, sent } = await setup({ a1: { provider: "codex" } }, {
    readSettings: async () => {
      const run = duringSettings;
      duringSettings = undefined;
      await run?.();
      return DEFAULT_PROVIDER_SETTINGS;
    },
  });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  const dueAt = (await store.list())[0]!.dueAt;
  await resumer.setEnabled("a1", dueAt, false);
  advance(3 * 60 * MINUTE);
  duringSettings = async () => { await resumer.setEnabled("a1", dueAt, true); };
  await resumer.tick();
  assert.deepEqual(await recorded(), [], "nothing was skipped");
  assert.equal((await store.list())[0]?.enabled, true);
  await resumer.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(await recorded(), ["a1 continued"]);
});

test("history keeps result codes, not the log's wording", async () => {
  const { api, resumer, agents } = await setup({ a1: { provider: "codex" } });
  await resumer.onTurnEnded(turnEnded("a1", "codex", failed(CODEX_LIMIT)), api);
  agents.set("a1", { provider: "codex", status: "running" });
  advance(3 * 60 * MINUTE);
  await resumer.tick();
  const saved = JSON.parse(await readFile(join(dir, "history.json"), "utf8")) as { entries: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(saved.entries[0]!).sort(), ["agentId", "at", "id", "outcome", "provider", "reason", "title"]);
  assert.equal(saved.entries[0]!.reason, "agent_busy");
});
