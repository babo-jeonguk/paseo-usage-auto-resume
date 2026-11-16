import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { PluginButton, PluginClientContext, PluginComposerPillContribution } from "@getpaseo/plugin/client";
import type { ScheduledJob } from "../shared/rpc";
import { installConversationControls } from "./conversations";
import { notifyScheduleChanged } from "./schedule-changes";

const job = (agentId: string, workspaceId: string | null = "workspace"): ScheduledJob => ({
  id: `${agentId}-1`, agentId, workspaceId, provider: "codex", title: null, projectName: null, workspaceName: null,
  resetAt: null, dueAt: new Date(Date.now() + 3_600_000).toISOString(), enabled: true, sending: false, background: false,
});

type FakeSubscription = {
  onEvent(event: unknown): void;
  onClosed?: (closed: { error?: Error }) => void;
  released: boolean;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
};

function fixture() {
  let jobs = [job("a"), job("b"), job("unplaced", null)];
  let read: () => Promise<{ jobs: ScheduledJob[] }> = async () => ({ jobs });
  let reads = 0;
  const subscriptions: FakeSubscription[] = [];
  const added: Array<PluginComposerPillContribution & { removed: boolean; updates: Partial<PluginButton>[] }> = [];
  const client = {
    rpc: () => { reads += 1; return read(); },
    addComposerPill: (input: PluginComposerPillContribution) => {
      const item = { ...input, button: { ...input.button }, removed: false, updates: [] as Partial<PluginButton>[] };
      added.push(item);
      return {
        update: (patch: Partial<PluginButton>) => { item.updates.push(patch); Object.assign(item.button, patch); },
        remove: () => { item.removed = true; },
      };
    },
    subscribe: (
      _contract: unknown,
      _input: unknown,
      onEvent: (event: unknown) => void,
      options?: { onClosed?: (closed: { error?: Error }) => void },
    ) => {
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const item: FakeSubscription = { onEvent, onClosed: options?.onClosed, released: false, ready, resolveReady, rejectReady };
      subscriptions.push(item);
      return Object.assign(() => { item.released = true; }, {
        ready,
        release: async () => { item.released = true; },
      });
    },
  } as unknown as PluginClientContext;
  const stop = installConversationControls(client, () => null);
  return {
    added, subscriptions, stop, readCount: () => reads,
    setJobs: (next: ScheduledJob[]) => { jobs = next; },
    setRead: (next: typeof read) => { read = next; },
  };
}

test("unchanged polls do not update pills; displayed state changes and error recovery still do", async (t) => {
  t.mock.method(Date, "now", () => new Date(2026, 9, 21, 10).getTime());
  const f = fixture();
  const original = job("a");
  try {
    await setImmediate();
    f.setJobs([original]);
    for (let i = 0; i < 6; i++) { notifyScheduleChanged(); await setImmediate(); }
    const pill = f.added[0]!;
    assert.deepEqual(pill.updates, [], "stable reservations must not write to the host registry");
    f.setJobs([{ ...original, enabled: false }]);
    notifyScheduleChanged(); await setImmediate();
    assert.deepEqual(pill.updates, [{ label: "Resume off" }]);
    // Moving an off reservation does not change its displayed label.
    const moved = { ...original, dueAt: new Date(Date.parse(original.dueAt) + 600_000).toISOString() };
    f.setJobs([{ ...moved, enabled: false }]);
    notifyScheduleChanged(); await setImmediate();
    assert.equal(pill.updates.length, 1);
    f.setJobs([moved]);
    notifyScheduleChanged(); await setImmediate();
    assert.equal(pill.updates.length, 2);
    assert.equal(pill.button.label, "Resume 11:10");
    f.setRead(async () => { throw new Error("offline"); });
    for (let i = 0; i < 3; i++) { notifyScheduleChanged(); await setImmediate(); }
    assert.equal(pill.updates.length, 3, "repeated errors should update Unavailable only once");
    f.setRead(async () => ({ jobs: [moved] }));
    notifyScheduleChanged(); await setImmediate();
    assert.equal(pill.updates.length, 4);
    assert.equal(pill.button.label, "Resume 11:10", "recovery restores the current label");
    f.setRead(async () => ({ jobs: [{ ...moved, sending: true }] }));
    notifyScheduleChanged(); await setImmediate();
    assert.equal(pill.button.label, "Resuming…", "automatic execution still updates the pill");
  } finally { f.stop(); }
});

test("a calendar-day change refreshes the label even without a user action", async (t) => {
  let now = new Date(2026, 9, 21, 23, 59).getTime();
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  try {
    await setImmediate();
    assert.match(f.added[0]!.button.label!, /^Tmr /);
    now += 120_000;
    notifyScheduleChanged(); await setImmediate();
    assert.match(f.added[0]!.button.label!, /^Resume /);
    assert.equal(f.added[0]!.updates.length, 1);
    notifyScheduleChanged(); await setImmediate();
    assert.equal(f.added[0]!.updates.length, 1);
  } finally { f.stop(); }
});

test("composer controls follow only reserved agents, including off and waiting reservations", async () => {
  const f = fixture();
  try {
    await setImmediate();
    assert.deepEqual(f.added.map((item) => item.agentId), ["a", "b"]);
    f.setJobs([{ ...job("a"), enabled: false }, { ...job("b"), waiting: "usage" }]);
    notifyScheduleChanged();
    await setImmediate();
    assert.equal(f.added.length, 2, "updates keep the existing controls and popover");
    assert.equal(f.added[0]!.button.label, "Resume off");
    assert.match(f.added[1]!.button.label!, /Check /);
    f.setJobs([job("a", "moved-workspace")]);
    notifyScheduleChanged();
    await setImmediate();
    assert.equal(f.added[0]!.removed, true);
    assert.equal(f.added[1]!.removed, true);
    assert.equal(f.added[2]!.workspaceId, "moved-workspace");
    f.setJobs([]);
    notifyScheduleChanged();
    await setImmediate();
    assert.equal(f.added[2]!.removed, true, "sent or canceled reservations lose their pills");
  } finally { f.stop(); }
});

test("a read failure keeps retry controls without advertising a stale schedule", async () => {
  const f = fixture();
  try {
    await setImmediate();
    f.setRead(async () => { throw new Error("offline"); });
    notifyScheduleChanged();
    await setImmediate();
    assert.equal(f.added[0]!.removed, false);
    assert.equal(f.added[0]!.button.label, "Unavailable");
    f.setRead(async () => ({ jobs: [job("a")] }));
    notifyScheduleChanged();
    await setImmediate();
    assert.doesNotMatch(f.added[0]!.button.label!, /Unavailable/);
    assert.equal(f.added[1]!.removed, true);
  } finally { f.stop(); }
});

test("changes during a read discard the old result; unload removes controls and ignores late results", async () => {
  const f = fixture();
  try {
    await setImmediate();
    let resolve!: (result: { jobs: ScheduledJob[] }) => void;
    f.setRead(() => new Promise((done) => { resolve = done; }));
    notifyScheduleChanged();
    notifyScheduleChanged();
    f.setRead(async () => ({ jobs: [{ ...job("a"), enabled: false }] }));
    resolve({ jobs: [] });
    await setImmediate();
    assert.equal(f.added[0]!.removed, false, "a superseded empty response cannot remove an open control");
    assert.equal(f.added[0]!.button.label, "Resume off");
    f.setRead(() => new Promise((done) => { resolve = done; }));
    notifyScheduleChanged();
    f.stop();
    resolve({ jobs: [job("new")] });
    await setImmediate();
    assert.equal(f.added.length, 2);
    assert.ok(f.added.every((item) => item.removed));
    notifyScheduleChanged();
    await setImmediate();
    assert.equal(f.added.length, 2);
  } finally { f.stop(); }
});

test("a pushed change and every (re)connect ask for a fresh directory read", async () => {
  const f = fixture();
  try {
    await setImmediate();
    const afterLoad = f.readCount();
    f.subscriptions[0]!.onEvent({ revision: 1 });
    await setImmediate();
    assert.equal(f.readCount(), afterLoad + 1, "a pushed change refreshes");
    f.subscriptions[0]!.resolveReady();
    await setImmediate();
    assert.equal(f.readCount(), afterLoad + 2, "a resolved subscription refreshes as well");
    f.subscriptions[0]!.onEvent({ revision: 2 });
    f.subscriptions[0]!.onEvent({ revision: 3 });
    await setImmediate();
    assert.ok(f.readCount() >= afterLoad + 3, "each signal is applied");
  } finally { f.stop(); }
});

test("a closed subscription refreshes and resubscribes with backoff until cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await setImmediate();
    const afterLoad = f.readCount();
    assert.equal(f.subscriptions.length, 1);
    f.subscriptions[0]!.onClosed?.({ error: new Error("plugin stopped") });
    await setImmediate();
    assert.equal(f.readCount(), afterLoad + 1, "the closed subscription refreshes at once");
    t.mock.timers.tick(4_999);
    assert.equal(f.subscriptions.length, 1, "it does not resubscribe before 5 s");
    t.mock.timers.tick(1);
    assert.equal(f.subscriptions.length, 2, "it resubscribes after 5 s");
    f.subscriptions[1]!.onClosed?.({ error: Object.assign(new Error("plugin stopped"), { name: "DaemonConnectionError" }) });
    await setImmediate();
    t.mock.timers.tick(14_999);
    assert.equal(f.subscriptions.length, 2, "the next wait is 15 s");
    t.mock.timers.tick(1);
    assert.equal(f.subscriptions.length, 3);
  } finally { f.stop(); }
});

test("cleanup releases the change subscription", async () => {
  const f = fixture();
  await setImmediate();
  f.stop();
  assert.equal(f.subscriptions[0]!.released, true);
});

test("the fallback poll runs every two minutes", async (t) => {
  const intervals: Array<number | undefined> = [];
  t.mock.method(globalThis, "setInterval", (_fn: () => void, ms?: number) => {
    intervals.push(ms);
    return 0 as unknown as ReturnType<typeof setInterval>;
  });
  const f = fixture();
  try {
    await setImmediate();
    assert.deepEqual(intervals, [120_000]);
  } finally { f.stop(); }
});
