import assert from "node:assert/strict";
import test from "node:test";
import { agentGate, turnAction, type TurnEvent } from "./decisions";
import type { PaseoAgent } from "./paseo-types";
import type { ResumeJob } from "./store";

// One case per cell of the table in docs/behavior.md.

const BASELINE = "2026-10-06T02:00:00.000Z";
const LATER = "2026-10-06T03:00:00.000Z";

const job = (fields: Partial<ResumeJob> = {}): ResumeJob => ({
  id: "r1", agentId: "a1", provider: "codex", resetAt: null, dueAt: "2026-10-06T05:02:00.000Z", baseline: BASELINE,
  attempts: 0, retries: 0, state: "pending", enabled: true, ...fields,
});
const agent = (fields: Partial<PaseoAgent> = {}) => ({
  id: "a1", provider: "codex", status: "idle", lastUserMessageAt: BASELINE, pendingPermissions: [],
  attentionReason: null, archivedAt: null, activeTurn: null, ...fields,
}) as PaseoAgent;
const reason = (action: { cancel?: { reason: string } }) => action.cancel?.reason ?? null;
/** The gate's cancel reason, or its wait/skip/go-on result. */
const gate = (row: ResumeJob, snapshot: PaseoAgent | null, mode: "auto" | "manual" = "auto") => {
  const result = agentGate(row, snapshot, mode);
  return result && typeof result === "object" ? result.reason : result;
};

test("turn events: a new message cancels a pending reservation first, and a limit still plans its own", () => {
  const message = agent({ lastUserMessageAt: LATER });
  for (const event of ["started", "finished", "failed", "stopped"] as TurnEvent[]) {
    const action = turnAction(job(), message, event);
    assert.deepEqual([reason(action), action.schedules], ["new_message", false], event);
  }
  assert.equal(reason(turnAction(job(), message, "limit")), "new_message");
  assert.equal(turnAction(job(), message, "limit").schedules, true);
});

test("turn events without a new message: only a finished turn ends a pending reservation", () => {
  const idle = agent();
  assert.deepEqual(turnAction(job(), idle, "started"), { schedules: false });
  assert.equal(reason(turnAction(job(), idle, "finished")), "turn_finished");
  assert.deepEqual(turnAction(job(), idle, "failed"), { schedules: false }, "a failure without a limit is not progress");
  assert.deepEqual(turnAction(job(), idle, "stopped"), { schedules: false });
  assert.deepEqual(turnAction(job(), idle, "limit"), { schedules: true });
});

test("turn events: an agent that could not be read never cancels for a message", () => {
  assert.deepEqual(turnAction(job(), null, "started"), { schedules: false });
  assert.equal(reason(turnAction(job(), null, "finished")), "turn_finished");
});

test("turn events: a sent record is cleared only by a finished turn, and a limit plans anew", () => {
  assert.deepEqual(turnAction(job({ state: "sending" }), null, "finished"), { schedules: false }, "a continue being sent keeps its claim");
  for (const state of ["sent", "sending"] as const) {
    const row = job({ state });
    if (state === "sent") assert.deepEqual(turnAction(row, null, "finished"), { clearSent: true });
    for (const event of ["started", "failed", "stopped"] as TurnEvent[]) assert.deepEqual(turnAction(row, null, event), { schedules: false });
    assert.deepEqual(turnAction(row, agent({ lastUserMessageAt: LATER }), "limit"), { schedules: true }, "only a pending reservation is canceled");
  }
});

test("turn events: with no reservation, only a limit plans one", () => {
  for (const event of ["started", "finished", "failed", "stopped"] as TurnEvent[]) assert.deepEqual(turnAction(null, agent(), event), { schedules: false });
  assert.deepEqual(turnAction(null, agent(), "limit"), { schedules: true });
});

test("a message counts only when it is later than the baseline", () => {
  assert.equal(reason(turnAction(job(), agent({ lastUserMessageAt: "2026-10-06T01:00:00.000Z" }), "started")), null, "an older snapshot");
  assert.equal(reason(turnAction(job(), agent({ lastUserMessageAt: null }), "started")), null);
  assert.equal(reason(turnAction(job({ baseline: null }), agent(), "started")), "new_message");
});

test("due-time checks 3 to 8 run in the table's order", () => {
  const off = job({ enabled: false });
  assert.equal(gate(off, null), "agent_missing");
  assert.equal(gate(off, agent({ archivedAt: LATER, status: "running" })), "archived", "3 comes before a turn");
  assert.equal(gate(off, agent({ provider: "claude" })), "provider_changed");
  assert.equal(gate(job({ model: "gpt-a" }), agent({ model: "gpt-b" } as Partial<PaseoAgent>)), "model_changed");
  assert.equal(gate(off, agent({ lastUserMessageAt: LATER, status: "running" })), "new_message", "4 comes before a turn");
  assert.equal(gate(off, agent({ status: "initializing" })), "agent_busy");
  assert.equal(gate(job(), agent({ archivedAt: LATER, lastUserMessageAt: LATER })), "archived", "3 before 4");
  assert.equal(gate(job(), agent({ lastUserMessageAt: LATER, status: "initializing" })), "new_message", "4 before 5");
  assert.equal(gate(job(), agent({ status: "initializing", attentionReason: "permission" })), "agent_busy", "5 before 6");
  assert.equal(gate(off, agent({ status: "running", attentionReason: "permission" })), "permission", "6 comes before a turn");
  assert.equal(gate(off, agent({ status: "running" })), "wait", "a reservation turned off waits for the turn too");
  assert.equal(gate(off, agent({ activeTurn: { turnId: "t", startedAt: null } })), "wait");
  assert.equal(gate(off, agent()), "skip");
  assert.equal(gate(off, agent({ status: "error" })), "skip");
  assert.equal(gate(job(), agent()), null);
});

test("a closed agent is resumed, not canceled: Paseo reopens its saved session on send", () => {
  assert.equal(gate(job(), agent({ status: "closed" })), null);
  assert.equal(gate(job({ enabled: false }), agent({ status: "closed" })), "skip");
  assert.equal(gate(job(), agent({ status: "closed" }), "manual"), null);
  assert.equal(gate(job(), agent({ status: "closed", archivedAt: LATER })), "archived");
  assert.equal(gate(job(), agent({ status: "closed", lastUserMessageAt: LATER })), "new_message");
  assert.equal(gate(job(), agent({ status: "closed", attentionReason: "permission" })), "permission");
});

test("Resume now never skips, and waits for a turn", () => {
  assert.equal(agentGate(job({ enabled: false }), agent(), "manual"), null);
  assert.equal(agentGate(job({ enabled: false }), agent({ status: "running" }), "manual"), "wait");
});
