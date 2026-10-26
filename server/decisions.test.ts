import assert from "node:assert/strict";
import test from "node:test";
import { agentGate, countsFor, turnAction, type TurnEvent } from "./decisions";
import type { PaseoAgent } from "./paseo-types";
import type { ResumeJob } from "./store";

// One case per cell of the table in docs/behavior.md.

const BASELINE = "2026-10-06T02:00:00.000Z";
const LATER = "2026-10-06T03:00:00.000Z";

const job = (fields: Partial<ResumeJob> = {}): ResumeJob => ({
  agentId: "a1", provider: "codex", resetAt: null, dueAt: "2026-10-06T05:02:00.000Z", baseline: BASELINE,
  attempts: 0, retries: 0, state: "pending", enabled: true, ...fields,
});
const agent = (fields: Partial<PaseoAgent> = {}) => ({
  id: "a1", provider: "codex", status: "idle", lastUserMessageAt: BASELINE, pendingPermissions: [],
  attentionReason: null, archivedAt: null, activeTurn: null, ...fields,
}) as PaseoAgent;
const reason = (action: { cancel?: { reason: string } }) => action.cancel?.reason ?? null;

test("turn events: a new message cancels a pending reservation first, and a limit still plans its own", () => {
  const message = agent({ lastUserMessageAt: LATER });
  for (const event of ["started", "finished", "failed", "stopped"] as TurnEvent[]) {
    const action = turnAction(job(), message, event);
    assert.deepEqual([reason(action), action.plan], ["new_message", false], event);
  }
  assert.equal(reason(turnAction(job(), message, "limit")), "new_message");
  assert.equal(turnAction(job(), message, "limit").plan, true);
});

test("turn events without a new message: only a finished turn ends a pending reservation", () => {
  const idle = agent();
  assert.deepEqual(turnAction(job(), idle, "started"), { plan: false });
  assert.equal(reason(turnAction(job(), idle, "finished")), "turn_finished");
  assert.deepEqual(turnAction(job(), idle, "failed"), { plan: false }, "a failure without a limit is not progress");
  assert.deepEqual(turnAction(job(), idle, "stopped"), { plan: false });
  assert.deepEqual(turnAction(job(), idle, "limit"), { plan: true });
});

test("turn events: an agent that could not be read never cancels for a message", () => {
  assert.deepEqual(turnAction(job(), null, "started"), { plan: false });
  assert.equal(reason(turnAction(job(), null, "finished")), "turn_finished");
});

test("turn events: a sent record is cleared only by a finished turn, and a limit plans anew", () => {
  for (const state of ["sent", "sending"] as const) {
    const row = job({ state });
    assert.deepEqual(turnAction(row, null, "finished"), { clearSent: true }, state);
    for (const event of ["started", "failed", "stopped"] as TurnEvent[]) assert.deepEqual(turnAction(row, null, event), { plan: false });
    assert.deepEqual(turnAction(row, agent({ lastUserMessageAt: LATER }), "limit"), { plan: true }, "only a pending reservation is canceled");
  }
});

test("turn events: with no reservation, only a limit plans one", () => {
  for (const event of ["started", "finished", "failed", "stopped"] as TurnEvent[]) assert.deepEqual(turnAction(null, agent(), event), { plan: false });
  assert.deepEqual(turnAction(null, agent(), "limit"), { plan: true });
});

test("a message counts only when it is later than the baseline", () => {
  assert.equal(reason(turnAction(job(), agent({ lastUserMessageAt: "2026-10-06T01:00:00.000Z" }), "started")), null, "an older snapshot");
  assert.equal(reason(turnAction(job(), agent({ lastUserMessageAt: null }), "started")), null);
  assert.equal(reason(turnAction(job({ baseline: null }), agent(), "started")), "new_message");
});

test("due-time checks 3 to 8 run in the table's order", () => {
  const gate = (row: ResumeJob, snapshot: PaseoAgent | null, mode: "auto" | "manual" = "auto") => {
    const result = agentGate(row, snapshot, mode);
    return result && typeof result === "object" ? result.reason : result;
  };
  const off = job({ enabled: false });
  assert.equal(gate(off, null), "agent_missing");
  assert.equal(gate(off, agent({ archivedAt: LATER, status: "running" })), "archived", "3 comes before a turn");
  assert.equal(gate(off, agent({ provider: "claude" })), "provider_changed");
  assert.equal(gate(job({ model: "gpt-a" }), agent({ model: "gpt-b" } as Partial<PaseoAgent>)), "model_changed");
  assert.equal(gate(off, agent({ lastUserMessageAt: LATER, status: "running" })), "new_message", "4 comes before a turn");
  assert.equal(gate(off, agent({ status: "closed" })), "agent_busy");
  assert.equal(gate(off, agent({ status: "initializing" })), "agent_busy");
  assert.equal(gate(off, agent({ status: "running", attentionReason: "permission" })), "permission", "6 comes before a turn");
  assert.equal(gate(off, agent({ status: "running" })), "wait", "a reservation turned off waits for the turn too");
  assert.equal(gate(off, agent({ activeTurn: { turnId: "t", startedAt: null } })), "wait");
  assert.equal(gate(off, agent()), "skip");
  assert.equal(gate(off, agent({ status: "error" })), "skip");
  assert.equal(gate(job(), agent()), null);
});

test("Resume now never skips, and waits for a turn", () => {
  assert.equal(agentGate(job({ enabled: false }), agent(), "manual"), null);
  assert.equal(agentGate(job({ enabled: false }), agent({ status: "running" }), "manual"), "wait");
});

test("a pending reservation planned again keeps its counts and never gives up", () => {
  const pending = job({ attempts: 23, retries: 3 });
  assert.deepEqual(countsFor(pending, true), { kept: pending, attempts: 23, retries: 3, retryDelay: 2, gaveUp: null });
  assert.deepEqual(countsFor(pending, false), { kept: pending, attempts: 23, retries: 3, retryDelay: 2, gaveUp: null });
  assert.equal(countsFor(job({ retries: 0 }), true).retryDelay, 0);
});

test("a sent continue that stops again counts once, and gives up at the limits", () => {
  assert.deepEqual(countsFor(null, true), { kept: null, attempts: 0, retries: 1, retryDelay: 0, gaveUp: null });
  assert.deepEqual(countsFor(null, false), { kept: null, attempts: 0, retries: 0, retryDelay: 0, gaveUp: null });
  const sent = job({ state: "sent", attempts: 2, retries: 1 });
  assert.deepEqual(countsFor(sent, true), { kept: null, attempts: 3, retries: 2, retryDelay: 1, gaveUp: null });
  assert.deepEqual(countsFor(sent, false), { kept: null, attempts: 3, retries: 0, retryDelay: 0, gaveUp: null });
  assert.equal(countsFor(job({ state: "sent", attempts: 23 }), false).gaveUp?.reason, "attempts");
  assert.equal(countsFor(job({ state: "sent", retries: 3 }), true).gaveUp?.reason, "retries");
  assert.equal(countsFor(job({ state: "sent", retries: 3 }), false).gaveUp, null, "a reset plan starts the retries over");
});
