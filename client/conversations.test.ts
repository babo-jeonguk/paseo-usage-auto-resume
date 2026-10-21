import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { PluginButton, PluginClientContext, PluginComposerPillContribution } from "@getpaseo/plugin/client";
import type { ScheduledJob } from "../shared/rpc";
import { installConversationControls } from "./conversations";
import { notifyScheduleChanged } from "./schedule-changes";

const job = (agentId: string, workspaceId: string | null = "workspace"): ScheduledJob => ({
  agentId, workspaceId, provider: "codex", title: null, projectName: null, workspaceName: null,
  resetAt: null, dueAt: new Date(Date.now() + 3_600_000).toISOString(), enabled: true, sending: false,
});

function fixture() {
  let jobs = [job("a"), job("b"), job("unplaced", null)];
  let read: () => Promise<{ jobs: ScheduledJob[] }> = async () => ({ jobs });
  const added: Array<PluginComposerPillContribution & { removed: boolean; updates: Partial<PluginButton>[] }> = [];
  const client = {
    rpc: () => read(),
    addComposerPill: (input: PluginComposerPillContribution) => {
      const item = { ...input, button: { ...input.button }, removed: false, updates: [] as Partial<PluginButton>[] };
      added.push(item);
      return {
        update: (patch: Partial<PluginButton>) => { item.updates.push(patch); Object.assign(item.button, patch); },
        remove: () => { item.removed = true; },
      };
    },
  } as unknown as PluginClientContext;
  const stop = installConversationControls(client, () => null);
  return { added, stop, setJobs: (next: ScheduledJob[]) => { jobs = next; }, setRead: (next: typeof read) => { read = next; } };
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
