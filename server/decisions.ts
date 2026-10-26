import type { HistoryEntry, HistoryOutcome, HistoryReason } from "../shared/rpc";
import { MAX_ATTEMPTS, RETRY_DELAYS_MS } from "../shared/schedule";
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

export interface CarryOver {
  /** The pending reservation planned again, whose user settings carry over. */
  kept: ResumeJob | null;
  attempts: number;
  retries: number;
  /** Index into the retry delays when the plan is a retry. */
  retryDelay: number;
  /** The account and model the reservation stays bound to. */
  identity?: string;
  model?: string;
  /** Set when the stop ends the reservation instead of planning it. */
  ended: Outcome | null;
}

/**
 * What a new plan takes over from the row it replaces.
 * - A pending reservation planned again stays bound to its account and model; another account
 *   cancels it, as at the due time. Only a retry plan keeps its retry count, as a postponement
 *   does, and nothing else counts: no continue was sent, so it never gives up.
 * - After a sent continue, the stop counts toward giving up.
 */
export function carryOver(current: ResumeJob | null, plan: { retry: boolean; identity?: string; model?: string }): CarryOver {
  const kept = current?.state === "pending" ? current : null;
  if (kept) {
    const changed = !!kept.identity && !!plan.identity && kept.identity !== plan.identity;
    const retries = plan.retry ? kept.retries : 0;
    return {
      kept, attempts: kept.attempts, retries, retryDelay: Math.max(retries - 1, 0),
      identity: kept.identity ?? plan.identity, model: kept.model ?? plan.model,
      ended: changed ? canceled("account_changed", "account or model changed") : null,
    };
  }
  const bound = { identity: plan.identity, model: plan.model };
  const attempts = current ? current.attempts + 1 : 0;
  if (attempts >= MAX_ATTEMPTS) {
    return { kept, attempts, retries: 0, retryDelay: 0, ...bound, ended: { outcome: "gave_up", reason: "attempts", detail: `${attempts} automatic continues hit a limit again` } };
  }
  const done = plan.retry ? (current?.retries ?? 0) : 0;
  if (done >= RETRY_DELAYS_MS.length) {
    return { kept, attempts, retries: done, retryDelay: 0, ...bound, ended: { outcome: "gave_up", reason: "retries", detail: `${done} continues stopped again while its usage windows were not used up` } };
  }
  return { kept, attempts, retries: plan.retry ? done + 1 : 0, retryDelay: done, ...bound, ended: null };
}
