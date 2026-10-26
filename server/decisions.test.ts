import assert from "node:assert/strict";
import test from "node:test";
import { agentGate, replan, turnAction, type Plan, type Stop, type TurnEvent } from "./decisions";
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
  assert.equal(gate(job(), agent({ archivedAt: LATER, lastUserMessageAt: LATER })), "archived", "3 before 4");
  assert.equal(gate(job(), agent({ lastUserMessageAt: LATER, status: "closed" })), "new_message", "4 before 5");
  assert.equal(gate(job(), agent({ status: "closed", attentionReason: "permission" })), "agent_busy", "5 before 6");
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

const AT = new Date("2026-10-06T03:00:00.000Z");
const RESET = new Date("2026-10-06T05:00:00.000Z");
const stop = (plan: Plan, fields: Partial<Stop> = {}): Stop => ({ agentId: "a1", provider: "codex", plan, at: AT, baseline: BASELINE, ...fields });
const reset = stop({ kind: "reset", resetAt: RESET });
const retry = stop({ kind: "retry" });
const written = (result: ReturnType<typeof replan>) => {
  assert.ok(result?.write, JSON.stringify(result));
  return result.write;
};
const ended = (result: ReturnType<typeof replan>) => result?.end?.reason ?? null;

test("a pending reservation planned again keeps the user's settings, its account and model, and counts nothing", () => {
  const pending = job({ attempts: 23, retries: 2, identity: "account-a", model: "gpt-a", enabled: false, note: "x", resetAt: "2026-10-06T04:00:00.000Z" });
  const next = written(replan(pending, { ...retry, identity: "account-a", model: "gpt-b" }));
  assert.deepEqual([next.attempts, next.retries, next.identity, next.model, next.enabled, next.note], [23, 2, "account-a", "gpt-a", false, "x"]);
  assert.equal(next.dueAt, "2026-10-06T03:30:00.000Z", "the retry step it was on: 30 minutes");
});

test("a pending reservation's time follows the new plan, except a later time the user chose", () => {
  assert.equal(written(replan(job({ dueAt: "2026-10-06T09:00:00.000Z" }), reset)).dueAt, "2026-10-06T05:02:00.000Z");
  const chosen = job({ dueAt: "2026-10-06T09:00:00.000Z", userChosenTime: true });
  assert.deepEqual([written(replan(chosen, reset)).dueAt, written(replan(chosen, reset)).userChosenTime], ["2026-10-06T09:00:00.000Z", true]);
  const earlier = job({ dueAt: "2026-10-06T04:00:00.000Z", userChosenTime: true });
  assert.deepEqual([written(replan(earlier, reset)).dueAt, written(replan(earlier, reset)).userChosenTime], ["2026-10-06T05:02:00.000Z", undefined]);
});

test("a pending reservation enters the retry sequence at its first step and leaves it on any other plan", () => {
  const next = written(replan(job({ retries: 0 }), retry));
  assert.deepEqual([next.retries, next.dueAt], [1, "2026-10-06T03:15:00.000Z"]);
  assert.equal(written(replan(job({ retries: 3 }), reset)).retries, 0);
  assert.equal(written(replan(job({ retries: 3 }), stop({ kind: "check", waiting: "usage" }))).retries, 0);
});

test("a pending reservation is checked against its account even when the plan is the same", () => {
  const bound = job({ identity: "account-a", resetAt: RESET.toISOString(), dueAt: "2026-10-06T05:02:00.000Z" });
  assert.equal(replan(bound, { ...reset, identity: "account-a" }), null, "nothing to change");
  assert.equal(replan(bound, reset), null, "an account that cannot be read keeps the bound one");
  assert.equal(ended(replan(bound, { ...reset, identity: "account-b" })), "account_changed");
  const unbound = job({ resetAt: RESET.toISOString(), dueAt: "2026-10-06T05:02:00.000Z" });
  assert.equal(written(replan(unbound, { ...reset, identity: "account-a" })).identity, "account-a", "an unbound one is bound");
});

test("a new message since a pending reservation was made cancels it inside the plan, and the stop gets its own", () => {
  const pending = job({ attempts: 3, retries: 2, note: "for the old request", enabled: false, userChosenTime: true, dueAt: "2026-10-06T09:00:00.000Z" });
  const result = replan(pending, { ...reset, baseline: LATER });
  assert.equal(ended(result), "new_message");
  const next = written(result);
  assert.deepEqual([next.attempts, next.retries, next.note, next.enabled, next.userChosenTime, next.dueAt, next.baseline],
    [0, 0, undefined, true, undefined, "2026-10-06T05:02:00.000Z", LATER]);
  assert.equal(ended(replan(pending, { ...reset, baseline: "2026-10-06T01:00:00.000Z" })), null, "an older snapshot is no new message");
});

test("a plan that changes any field is written, and one that changes none is not", () => {
  const stored = written(replan(null, reset));
  assert.equal(replan(stored, reset), null);
  assert.ok(replan(stored, { ...reset, provider: "codex-sub" })?.write, "even only the provider");
});

test("after a sent continue, or one being sent, a stop counts once, takes the new account, and gives up at the limits", () => {
  for (const state of ["sent", "sending"] as const) {
    const previous = job({ state, attempts: 2, retries: 1, identity: "account-a", note: "sent already", enabled: false });
    const next = written(replan(previous, { ...retry, identity: "account-b" }));
    assert.deepEqual([next.attempts, next.retries, next.dueAt, next.identity, next.note, next.enabled], [3, 2, "2026-10-06T03:30:00.000Z", "account-b", undefined, true], state);
  }
  assert.deepEqual([written(replan(null, retry)).attempts, written(replan(null, retry)).retries], [0, 1]);
  assert.equal(written(replan(job({ state: "sent", retries: 1 }), reset)).retries, 0, "a reset plan starts the retries over");
  assert.equal(ended(replan(job({ state: "sent", attempts: 23 }), reset)), "attempts");
  assert.equal(ended(replan(job({ state: "sent", retries: 3 }), retry)), "retries");
});
