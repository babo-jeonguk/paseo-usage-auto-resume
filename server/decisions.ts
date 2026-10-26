import type { HistoryEntry, HistoryOutcome, HistoryReason, Waiting } from "../shared/rpc";
import { GRACE_MS, MAX_ATTEMPTS, MIN_DELAY_MS, RETRY_DELAYS_MS } from "../shared/schedule";
import type { PaseoAgent } from "./paseo-types";
import type { ResumeJob } from "./store";
import { subscriptionModel } from "./subscription";

// What happens to a reservation, as the table in docs/behavior.md states it. These functions only
// decide; the resumer reads the agent and the store, and writes what they return.

/** Why a reservation ended. The history keeps the codes; `detail` is only the log's wording. */
export interface Outcome {
  outcome: HistoryOutcome;
  reason?: HistoryReason;
  detail?: string;
  /** The conversation title when it is at hand, kept so a deleted agent still has a name. */
  title?: string | null;
  /** Set when Resume now started the attempt. */
  trigger?: HistoryEntry["trigger"];
}

export type Cancellation = Outcome & { outcome: "canceled"; reason: HistoryReason };

export const canceled = (reason: HistoryReason, detail: string): Cancellation => ({ outcome: "canceled", reason, detail });
export const NEW_MESSAGE = canceled("new_message", "a newer message reached the agent");
const TURN_FINISHED = canceled("turn_finished", "a turn finished before the scheduled continue");

/** A turn is in progress. */
export const inTurn = (agent: PaseoAgent) => !!agent.activeTurn || agent.status === "running";

/**
 * A message the user sent after the reservation was made. Only a later message counts: a snapshot
 * read before a message was recorded must not cancel the reservation that message's stop made.
 */
export const hasNewMessage = (agent: PaseoAgent, job: ResumeJob) =>
  agent.lastUserMessageAt != null && (job.baseline === null || Date.parse(agent.lastUserMessageAt) > Date.parse(job.baseline));

/** How a turn event reads in the table: a stop is `limit` only when a limit notice ended it. */
export type TurnEvent = "started" | "finished" | "failed" | "stopped" | "limit";

export interface TurnAction {
  /** Cancels the pending reservation with this reason. */
  cancel?: Cancellation;
  /** Removes a sent record without a report. */
  clearSent?: boolean;
  /** Plans a reservation for the stop just seen. */
  plan?: boolean;
}

/**
 * The table's turn events. Only a new message or a finished turn ends a pending reservation;
 * a turn the agent started on its own, failed or was stopped leaves it to the due time.
 */
export function turnAction(row: ResumeJob | null, agent: PaseoAgent | null, event: TurnEvent): TurnAction {
  const plan = event === "limit";
  if (row?.state === "pending") {
    if (agent && hasNewMessage(agent, row)) return { cancel: NEW_MESSAGE, plan };
    if (event === "finished") return { cancel: TURN_FINISHED };
    return { plan };
  }
  // A continue still being sent keeps its claim, which guards against sending it twice.
  if (row?.state === "sent" && event === "finished") return { clearSent: true };
  return { plan };
}

/** What the agent checks at the due time decide: cancel, wait for its turn, skip, or go on. */
export type Gate = Cancellation | "wait" | "skip" | null;

/**
 * Due-time checks 3 to 8, in the table's order. Resume now sends a reservation that is turned
 * off, so it never skips. A reservation turned off still waits for a turn, whose end decides it.
 */
export function agentGate(job: ResumeJob, agent: PaseoAgent | null, mode: "auto" | "manual"): Gate {
  if (!agent) return canceled("agent_missing", "agent no longer exists");
  if (agent.archivedAt) return canceled("archived", "agent is archived");
  if (agent.provider !== job.provider) return canceled("provider_changed", `provider changed to ${agent.provider}`);
  if (job.model !== undefined && subscriptionModel(agent) !== job.model) return canceled("model_changed", "model changed");
  if (hasNewMessage(agent, job)) return NEW_MESSAGE;
  if (!inTurn(agent) && agent.status !== "idle" && agent.status !== "error") {
    return canceled("agent_busy", `agent is ${agent.status}`);
  }
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") {
    return canceled("permission", "agent is waiting for permission or input");
  }
  if (inTurn(agent)) return "wait";
  if (!job.enabled && mode === "auto") return "skip";
  return null;
}

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
  agentId: string;
  provider: string;
  plan: Plan;
  at: Date;
  baseline: string | null;
  identity?: string;
  model?: string;
  launch?: ResumeJob["launch"];
}

/** A row to write, a reservation that ends with an outcome, or nothing to change. */
export type Replan = { write: ResumeJob } | { end: Outcome } | null;

/**
 * The table's "a turn stops at a limit", for the row the stop finds.
 * - A pending reservation is planned again. It keeps its switch, its extra instructions, its
 *   account and model, and a time the user chose that is later than the new plan. A stop under
 *   another account cancels it. Nothing is counted, since no continue was sent: a retry plan stays
 *   on its step of the retry sequence, and any other plan leaves the sequence.
 * - After a sent continue, or one being sent, the stop counts toward giving up.
 */
export function replan(current: ResumeJob | null, stop: Stop): Replan {
  const { plan, at } = stop;
  const retry = plan.kind === "retry";
  const kept = current?.state === "pending" ? current : null;
  let attempts: number, retries: number;
  if (kept) {
    if (kept.identity && stop.identity && kept.identity !== stop.identity) return { end: canceled("account_changed", "account changed") };
    attempts = kept.attempts;
    retries = retry ? Math.max(kept.retries, 1) : 0;
  } else {
    attempts = current ? current.attempts + 1 : 0;
    if (attempts >= MAX_ATTEMPTS) return { end: { outcome: "gave_up", reason: "attempts", detail: `${attempts} automatic continues hit a limit again` } };
    const done = retry ? (current?.retries ?? 0) : 0;
    if (done >= RETRY_DELAYS_MS.length) return { end: { outcome: "gave_up", reason: "retries", detail: `${done} continues stopped again while its usage windows were not used up` } };
    retries = retry ? done + 1 : 0;
  }
  const planned = retry ? new Date(at.getTime() + RETRY_DELAYS_MS[retries - 1]!).toISOString()
    : dueFor(plan.kind === "reset" ? plan.resetAt : null, at);
  const keepTime = !!kept?.userChosenTime && Date.parse(kept.dueAt) > Date.parse(planned);
  const job: ResumeJob = {
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
  return kept && sameRow(kept, job) ? null : { write: job };
}

const ROW_FIELDS = ["resetAt", "dueAt", "baseline", "retries", "waiting", "identity", "model", "launch", "userChosenTime"] as const;
const sameRow = (left: ResumeJob, right: ResumeJob) =>
  ROW_FIELDS.every((field) => JSON.stringify(left[field]) === JSON.stringify(right[field]));
