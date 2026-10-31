import type { Waiting } from "../shared/rpc";
import { GRACE_MS, MAX_ATTEMPTS, MIN_DELAY_MS, RETRY_DELAYS_MS, overloadDue, type OverloadStep } from "../shared/schedule";
import { ACCOUNT_CHANGED, isLater, NEW_MESSAGE, type Outcome } from "./decisions";
import type { ResumeJob } from "./store";

// How a reservation's row changes. Each transition states which fields it keeps, sets or drops,
// so no writer builds a row by hand; the resumer decides which one applies and writes it.

/** What a user's change names: the reservation the screen showed, and, for a time-sensitive change, its time. */
export interface Pin {
  id: string;
  dueAt?: string;
}

/**
 * Whether a change pinned to a reservation still applies: it must be the same reservation, at the
 * same time when the pin has one, and not yet being sent.
 */
export function pinned(current: ResumeJob | null, pin: Pin): "pending" | "sending" | "changed" {
  if (!current || current.id !== pin.id || (pin.dueAt !== undefined && current.dueAt !== pin.dueAt)) return "changed";
  return current.state === "sent" ? "changed" : current.state;
}

/**
 * The row a due-time attempt checked, unchanged: a claim or a cancel made after the checks must
 * not act on a reservation moved, planned again or replaced meanwhile. The switch and the note
 * are left out, so turning one or saving the other never fails a claim.
 */
export const isSameJob = (left: ResumeJob | null, right: ResumeJob) =>
  left !== null && left.id === right.id && left.state === right.state && left.dueAt === right.dueAt &&
  left.resetAt === right.resetAt && left.identity === right.identity && left.model === right.model &&
  left.kind === right.kind && left.overloadStep === right.overloadStep && left.retries === right.retries && left.waiting === right.waiting && left.baseline === right.baseline;

const UNKNOWN_RECHECK_MS = 15 * 60_000;

/** When to act on a reset: two minutes after it, never sooner than a minute from now. Without one, check again. */
export function dueFor(resetAt: Date | null, now: Date): string {
  if (!resetAt) return new Date(now.getTime() + UNKNOWN_RECHECK_MS).toISOString();
  return new Date(Math.max(resetAt.getTime() + GRACE_MS, now.getTime() + MIN_DELAY_MS)).toISOString();
}

/**
 * When a stop's continue should go: a known reset, a retry while usage reads ready, or a check
 * when it cannot be verified.
 */
export type Plan =
  | { kind: "reset"; resetAt: Date }
  | { kind: "retry" }
  | { kind: "check"; waiting: Waiting };

/** A limit stop to plan a reservation for, with what was read about the agent and its account. */
export interface Stop {
  /** The id a reservation made for this stop gets; one planned again keeps its own. */
  id: string;
  agentId: string;
  provider: string;
  plan: Plan;
  at: Date;
  baseline: string | null;
  identity?: string;
  model?: string;
  launch?: ResumeJob["launch"];
}

/**
 * What a stop does to the stored row: `end` records how the reservation there ended, and `write`
 * is the row to store. With neither, the row is removed; null leaves it as it is.
 */
export type Replan = { write?: ResumeJob; end?: Outcome } | null;

/**
 * The table's "a turn stops at a limit", for the row the stop finds, decided inside the write.
 * - A message the user sent since a pending reservation was made cancels it, and the stop gets a
 *   reservation of its own. The turn event cancels it first; this covers a pending reservation
 *   another stop wrote after that event read the agent. A stop concerns the agent, so it plans
 *   against whatever row is stored when it writes.
 * - Otherwise a pending reservation is planned again. It keeps its switch, its extra instructions, its
 *   account and model, and a time the user chose that is later than the new plan. A stop under
 *   another account cancels it. Nothing is counted, since no continue was sent: a retry plan stays
 *   on its step of the retry sequence, and any other plan leaves the sequence.
 * - After a sent continue, or one being sent, the stop counts toward giving up.
 */
export function replan(current: ResumeJob | null, stop: Stop): Replan {
  const { plan, at } = stop;
  const retry = plan.kind === "retry";
  const pending = current?.state === "pending" ? current : null;
  const superseded = !!pending && isLater(stop.baseline, pending.baseline);
  const kept = superseded ? null : pending;
  const previous = superseded ? null : current;
  let attempts: number, retries: number;
  if (kept) {
    if (kept.identity && stop.identity && kept.identity !== stop.identity) return { end: ACCOUNT_CHANGED };
    attempts = kept.attempts;
    retries = retry ? Math.max(kept.retries, 1) : 0;
  } else {
    attempts = previous ? previous.attempts + 1 : 0;
    if (attempts >= MAX_ATTEMPTS) return { end: { outcome: "gave_up", reason: "attempts", detail: `${attempts} automatic continues stopped again` } };
    const done = retry ? (previous?.retries ?? 0) : 0;
    if (done >= RETRY_DELAYS_MS.length) return { end: { outcome: "gave_up", reason: "retries", detail: `${done} continues stopped again while its usage windows were not used up` } };
    retries = retry ? done + 1 : 0;
  }
  const planned = retry ? new Date(at.getTime() + RETRY_DELAYS_MS[retries - 1]!).toISOString()
    : dueFor(plan.kind === "reset" ? plan.resetAt : null, at);
  const keepTime = !!kept?.userChosenTime && Date.parse(kept.dueAt) > Date.parse(planned);
  const job: ResumeJob = {
    id: kept?.id ?? stop.id,
    agentId: stop.agentId,
    provider: stop.provider,
    resetAt: plan.kind === "reset" ? plan.resetAt.toISOString() : null,
    dueAt: keepTime ? kept!.dueAt : planned,
    baseline: stop.baseline,
    attempts,
    retries,
    state: "pending",
    enabled: kept?.enabled ?? true,
    waiting: plan.kind === "check" ? plan.waiting : undefined,
    identity: kept?.identity ?? stop.identity,
    model: kept ? kept.model ?? stop.model : stop.model,
    launch: stop.launch,
    note: kept?.note,
    userChosenTime: keepTime || undefined,
  };
  if (kept && !kept.kind && unchanged(kept, job)) return null;
  return { write: job, end: superseded ? NEW_MESSAGE : undefined };
}

/** Every field the plan sets is what is stored already. */
const unchanged = (stored: ResumeJob, job: ResumeJob) =>
  (Object.keys(job) as Array<keyof ResumeJob>).every((field) => JSON.stringify(stored[field]) === JSON.stringify(job[field]));

/**
 * A due reservation that usage holds, moved to when it renews or can be checked again. The time
 * is no longer the user's; a renewal starts the retry sequence over.
 */
export function postponed(current: ResumeJob, hold: { renewsAt: Date | null; waiting?: Waiting; identity?: string; at: Date; usedUp?: boolean }): ResumeJob {
  return {
    ...current,
    ...(hold.usedUp && current.kind === "overload" ? { kind: undefined, overloadStep: undefined } : {}),
    resetAt: hold.renewsAt ? hold.renewsAt.toISOString() : current.resetAt,
    dueAt: dueFor(hold.renewsAt, hold.at),
    waiting: hold.renewsAt ? undefined : hold.waiting,
    identity: current.identity ?? hold.identity,
    retries: hold.renewsAt || hold.usedUp && current.kind === "overload" ? 0 : current.retries,
    userChosenTime: undefined,
  };
}

/** The user's own time, which turns the reservation on and survives a new plan while it is later. */
export const rescheduled = (current: ResumeJob, dueAt: string): ResumeJob => ({ ...current, dueAt, enabled: true, userChosenTime: true });

/** The switch alone. */
export const switched = (current: ResumeJob, enabled: boolean): ResumeJob => ({ ...current, enabled });

/** The extra instructions alone; blank removes them. */
export const noted = (current: ResumeJob, note: string): ResumeJob => ({ ...current, note: note || undefined });

/** Claimed for sending: a crash from here on drops it rather than sending twice. */
export const claimed = (current: ResumeJob, identity?: string): ResumeJob => ({ ...current, identity, waiting: undefined, state: "sending" });

/** Sent: the record stays until a turn finishes; what the user set for this continue is gone with it. */
export const sent = (current: ResumeJob): ResumeJob => ({ ...current, state: "sent", note: undefined, userChosenTime: undefined });

/** A final capacity failure: pending jobs win, otherwise reserve the next bounded stage, which neither advances nor restarts the limit retry sequence. */
export function replanOverload(current: ResumeJob | null, stop: Omit<Stop, "plan">, random: () => number): Replan {
  const superseded = current?.state === "pending" && isLater(stop.baseline, current.baseline);
  if (current?.state === "pending" && !superseded) return null;
  const previous = superseded ? null : current;
  const attempts = previous ? previous.attempts + 1 : 0;
  if (attempts >= MAX_ATTEMPTS) return { end: { outcome: "gave_up", reason: "attempts", detail: "automatic continue bound reached" } };
  const done = previous?.kind === "overload" ? previous.overloadStep ?? 3 : 0;
  if (done >= 3) return { end: { outcome: "gave_up", reason: "overload_retries", detail: "three retries ended in another capacity failure" } };
  const overloadStep = (done + 1) as OverloadStep;
  return {
    end: superseded ? NEW_MESSAGE : undefined,
    write: {
      id: stop.id, agentId: stop.agentId, provider: stop.provider,
      kind: "overload", overloadStep, attempts, retries: previous?.retries ?? 0,
      dueAt: overloadDue(stop.at, overloadStep, random), resetAt: null,
      baseline: stop.baseline, identity: stop.identity, model: stop.model, launch: stop.launch,
      state: "pending", enabled: true,
    },
  };
}
