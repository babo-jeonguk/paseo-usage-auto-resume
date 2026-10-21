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
  const added: Array<PluginComposerPillContribution & { removed: boolean }> = [];
  const client = {
    rpc: () => read(),
    addComposerPill: (input: PluginComposerPillContribution) => {
      const item = { ...input, button: { ...input.button }, removed: false };
      added.push(item);
      return {
        update: (patch: Partial<PluginButton>) => Object.assign(item.button, patch),
        remove: () => { item.removed = true; },
      };
    },
  } as unknown as PluginClientContext;
  const stop = installConversationControls(client, () => null);
  return { added, stop, setJobs: (next: ScheduledJob[]) => { jobs = next; }, setRead: (next: typeof read) => { read = next; } };
}

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
