import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledJob } from "../shared/rpc";
import { editorLocks, editSession, type EditEvent, type EditSession } from "./edit-session";

const DUE = "2026-10-06T05:02:00.000Z";
const job = (fields: Partial<ScheduledJob> = {}): ScheduledJob => ({
  agentId: "a", provider: "codex", title: "Task", projectName: null, workspaceName: null,
  resetAt: null, dueAt: DUE, enabled: true, sending: false, ...fields,
});
const run = (...events: EditEvent[]) => events.reduce<EditSession | null>(editSession, null);
const open = (kind: "time" | "note", fields: Partial<ScheduledJob> = {}): EditEvent => ({ type: "open", kind, job: job(fields) });
const kind = (state: EditSession | null) => state && `${state.agentId}:${state.kind}`;

test("extra instructions open with the saved note and the reservation's time", () => {
  const { opened, ...rest } = run(open("note", { note: "Rerun the tests" }))!;
  assert.equal(typeof opened, "object");
  assert.deepEqual(rest, {
    agentId: "a", kind: "note", pin: DUE, draft: "Rerun the tests", initial: "Rerun the tests", saving: false, problem: null,
  });
});

test("while extra instructions are open nothing else opens, in this row or another", () => {
  const writing = [open("note"), { type: "type", text: "draft" }] as EditEvent[];
  assert.equal(kind(run(...writing, open("time"))), "a:note");
  assert.equal(kind(run(...writing, open("time", { agentId: "b" }))), "a:note");
  assert.equal(kind(run(...writing, open("note", { agentId: "b" }))), "a:note");
  assert.equal(run(...writing, open("time", { agentId: "b" }))?.draft, "draft");
});

test("while a time is open no extra instructions open, but another time replaces it", () => {
  assert.equal(kind(run(open("time"), open("note"))), "a:time");
  assert.equal(kind(run(open("time"), open("note", { agentId: "b" }))), "a:time");
  assert.equal(kind(run(open("time"), open("time", { agentId: "b" }))), "b:time");
});

test("nothing opens on a reservation being sent", () => {
  assert.equal(run(open("note", { sending: true })), null);
  assert.equal(run(open("time", { sending: true })), null);
});

test("an editor whose reservation is gone closes, so a later one opens without it", () => {
  for (const editor of ["time", "note"] as const) {
    const gone = run(open(editor), { type: "sync", jobs: [job({ agentId: "b" })] });
    assert.equal(gone, null, editor);
    assert.deepEqual(editorLocks(gone), { time: false, note: false }, "the other rows are free again");
    assert.equal(editSession(gone, { type: "sync", jobs: [job({ dueAt: "2026-10-06T09:00:00.000Z" })] }), null);
  }
});

test("a time editor closes when its reservation moves or starts sending; extra instructions stay pinned", () => {
  const moved = [job({ dueAt: "2026-10-07T00:10:00.000Z" })];
  assert.equal(run(open("time"), { type: "sync", jobs: moved }), null);
  assert.equal(run(open("time"), { type: "sync", jobs: [job({ sending: true })] }), null);
  const note = run(open("note"), { type: "type", text: "keep me" }, { type: "sync", jobs: moved });
  assert.deepEqual([note?.draft, note?.pin], ["keep me", DUE], "the save stays pinned to the time shown when it opened");
  assert.equal(kind(run(open("note"), { type: "sync", jobs: [job({ sending: true })] })), "a:note");
});

test("Cancel and Escape wait for a save in flight", () => {
  const saving = [open("note"), { type: "save" }] as EditEvent[];
  assert.equal(kind(run(...saving, { type: "cancel" })), "a:note");
  assert.equal(kind(run(...saving, { type: "escape" })), "a:note");
  assert.equal(run(...saving, { type: "type", text: "late" })?.draft, "", "the text is locked while saving");
});

test("Escape closes only an untouched editor, ignoring spaces at either end", () => {
  assert.equal(run(open("note", { note: "x" }), { type: "escape" }), null);
  assert.equal(run(open("note", { note: "x" }), { type: "type", text: "  x " }, { type: "escape" }), null);
  assert.equal(kind(run(open("note", { note: "x" }), { type: "type", text: "xy" }, { type: "escape" })), "a:note");
  assert.equal(kind(run(open("time"), { type: "escape" })), "a:time", "the time editor handles its own keys");
});

test("a save's result reaches only the editor that made it", () => {
  const first = run(open("note"), { type: "save" })!;
  assert.equal(editSession(first, { type: "saved", opened: first.opened }), null);
  // The reservation was sent while saving, and the editor opened again on the agent's next one.
  const gone = editSession(first, { type: "sync", jobs: [] });
  const again = editSession(editSession(gone, open("note", { dueAt: "2026-10-06T10:02:00.000Z" })), { type: "save" });
  for (const late of [
    { type: "saved", opened: first.opened },
    { type: "refused", opened: first.opened, latest: DUE, problem: "x" },
    { type: "failed", opened: first.opened, problem: "x" },
  ] as EditEvent[]) {
    assert.equal(editSession(again, late), again, late.type);
  }
  const idle = run(open("note"))!;
  assert.equal(editSession(idle, { type: "saved", opened: idle.opened }), idle, "no save was in flight");
});

test("a refused save keeps the text and moves the pin to the latest reservation", () => {
  const saving = run(open("note"), { type: "type", text: "draft" }, { type: "save" })!;
  const refused = editSession(saving, { type: "refused", opened: saving.opened, latest: "2026-10-06T05:12:00.000Z", problem: "changed" });
  assert.deepEqual([refused?.draft, refused?.pin, refused?.saving, refused?.problem], ["draft", "2026-10-06T05:12:00.000Z", false, "changed"]);
  const failed = editSession(saving, { type: "failed", opened: saving.opened, problem: "retry" });
  assert.deepEqual([failed?.draft, failed?.pin, failed?.saving, failed?.problem], ["draft", DUE, false, "retry"]);
  assert.equal(editSession(failed, { type: "save" })?.problem, null, "a new save clears the last problem");
});

test("a time saved for a reservation closes only that reservation's time editor", () => {
  assert.equal(run(open("time"), { type: "moved", agentId: "a" }), null);
  assert.equal(kind(run(open("time"), { type: "moved", agentId: "b" })), "a:time", "another row's +10m leaves it open");
  assert.equal(kind(run(open("note"), { type: "moved", agentId: "a" })), "a:note");
});

test("an open editor's locks", () => {
  assert.deepEqual(editorLocks(null), { time: false, note: false });
  assert.deepEqual(editorLocks(run(open("time"))), { time: false, note: true });
  assert.deepEqual(editorLocks(run(open("note"))), { time: true, note: true });
});
