import assert from "node:assert/strict";
import test from "node:test";
import { isSameJob, noted, pinned, postponed, replan, rescheduled, sent, switched, type Plan, type Stop } from "./reservation";
import type { ResumeJob } from "./store";

// The row transitions behind the table in docs/behavior.md.

const BASELINE = "2026-10-06T02:00:00.000Z";
const LATER = "2026-10-06T03:00:00.000Z";

const job = (fields: Partial<ResumeJob> = {}): ResumeJob => ({
  id: "r1", agentId: "a1", provider: "codex", resetAt: null, dueAt: "2026-10-06T05:02:00.000Z", baseline: BASELINE,
  attempts: 0, retries: 0, state: "pending", enabled: true, ...fields,
});
const AT = new Date("2026-10-06T03:00:00.000Z");
const RESET = new Date("2026-10-06T05:00:00.000Z");
const stop = (plan: Plan, fields: Partial<Stop> = {}): Stop => ({ id: "r2", agentId: "a1", provider: "codex", plan, at: AT, baseline: BASELINE, ...fields });
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

test("a pending reservation older than the stop's message, written after the event read it, is replaced", () => {
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

test("a reservation keeps its id when planned again, and a new one gets the stop's", () => {
  assert.equal(written(replan(job(), reset)).id, "r1");
  assert.equal(written(replan(null, reset)).id, "r2");
  assert.equal(written(replan(job({ state: "sent" }), reset)).id, "r2");
  assert.equal(written(replan(job(), { ...reset, baseline: LATER })).id, "r2", "a new message replaces it");
});

test("a pin matches the same reservation, at the same time when it names one, until it is being sent", () => {
  assert.equal(pinned(job(), { id: "r1", dueAt: "2026-10-06T05:02:00.000Z" }), "pending");
  assert.equal(pinned(job(), { id: "r1", dueAt: "2026-10-06T05:12:00.000Z" }), "changed", "moved");
  assert.equal(pinned(job(), { id: "r1" }), "pending", "a pin without a time follows the reservation");
  assert.equal(pinned(job(), { id: "r2" }), "changed", "replaced");
  assert.equal(pinned(null, { id: "r1" }), "changed");
  assert.equal(pinned(job({ state: "sending" }), { id: "r1" }), "sending");
  assert.equal(pinned(job({ state: "sent" }), { id: "r1" }), "changed");
});

test("an attempt's row is the same only with the same id and the fields it checked", () => {
  assert.ok(isSameJob(job({ note: "x", enabled: false }), job()), "the note and the switch don't count");
  assert.ok(!isSameJob(job({ id: "r2" }), job()));
  assert.ok(!isSameJob(job({ dueAt: "2026-10-06T06:00:00.000Z" }), job()));
});

test("each user change touches only its own fields", () => {
  const base = job({ note: "x", userChosenTime: true, enabled: false });
  assert.deepEqual(switched(base, true), { ...base, enabled: true });
  assert.deepEqual(noted(base, ""), { ...base, note: undefined });
  assert.deepEqual(rescheduled(job(), "2026-10-06T06:00:00.000Z"), { ...job(), dueAt: "2026-10-06T06:00:00.000Z", enabled: true, userChosenTime: true });
});

test("a postponement makes the time the plan's again, and a renewal starts the retries over", () => {
  const base = job({ userChosenTime: true, retries: 2, identity: undefined, note: "x" });
  const renewed = postponed(base, { renewsAt: RESET, identity: "account-a", at: AT });
  assert.deepEqual([renewed.dueAt, renewed.resetAt, renewed.retries, renewed.userChosenTime, renewed.identity, renewed.note, renewed.waiting],
    ["2026-10-06T05:02:00.000Z", RESET.toISOString(), 0, undefined, "account-a", "x", undefined]);
  const check = postponed(base, { renewsAt: null, waiting: "usage", at: AT });
  assert.deepEqual([check.dueAt, check.retries, check.waiting], ["2026-10-06T03:15:00.000Z", 2, "usage"]);
});

test("a sent continue keeps its id and drops what the user set for it", () => {
  const done = sent(job({ state: "sending", note: "x", userChosenTime: true }));
  assert.deepEqual([done.id, done.state, done.note, done.userChosenTime], ["r1", "sent", undefined, undefined]);
});
