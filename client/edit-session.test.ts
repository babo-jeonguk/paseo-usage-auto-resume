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
  assert.deepEqual(run(open("note", { note: "Rerun the tests" })), {
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
  const saving = [open("note"), { type: "save" }] as EditEvent[];
  assert.equal(run(...saving, { type: "saved", agentId: "a" }), null);
  // The reservation went while saving, and another editor opened before the result came back.
  const other = run(...saving, { type: "sync", jobs: [job({ agentId: "b" })] }, open("note", { agentId: "b" }));
  assert.equal(kind(other), "b:note");
  assert.equal(kind(editSession(other, { type: "saved", agentId: "a" })), "b:note");
  assert.equal(kind(editSession(other, { type: "failed", agentId: "a", problem: "x" })), "b:note");
  const otherSaving = editSession(other, { type: "save" });
  assert.equal(kind(editSession(otherSaving, { type: "saved", agentId: "a" })), "b:note", "even while it saves too");
  assert.equal(kind(run(open("note"), { type: "saved", agentId: "a" })), "a:note", "no save was in flight");
});

test("a refused save keeps the text and moves the pin to the latest reservation", () => {
  const refused = run(open("note"), { type: "type", text: "draft" }, { type: "save" },
    { type: "refused", agentId: "a", latest: "2026-10-06T05:12:00.000Z", problem: "changed" });
  assert.deepEqual([refused?.draft, refused?.pin, refused?.saving, refused?.problem], ["draft", "2026-10-06T05:12:00.000Z", false, "changed"]);
  const failed = run(open("note"), { type: "type", text: "draft" }, { type: "save" }, { type: "failed", agentId: "a", problem: "retry" });
  assert.deepEqual([failed?.draft, failed?.pin, failed?.saving, failed?.problem], ["draft", DUE, false, "retry"]);
  assert.equal(editSession(failed, { type: "save" })?.problem, null, "a new save clears the last problem");
});

test("a time saved closes only a time editor", () => {
  assert.equal(run(open("time"), { type: "moved" }), null);
  assert.equal(kind(run(open("note"), { type: "moved" })), "a:note");
});

test("an open editor's locks", () => {
  assert.deepEqual(editorLocks(null), { time: false, note: false });
  assert.deepEqual(editorLocks(run(open("time"))), { time: false, note: true });
  assert.deepEqual(editorLocks(run(open("note"))), { time: true, note: true });
});
