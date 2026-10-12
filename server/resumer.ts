import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { detectLimitStop } from "./limit";
import type { ScheduledJob } from "../shared/rpc";
import type { JobStore, ResumeJob } from "./store";
import { usageResetAt } from "./usage";
import { DEFAULT_PROVIDER_SETTINGS, sourceForProvider, type ProviderSettings, type UsageSource } from "../shared/settings";

export const CONTINUE_PROMPT =
  "The provider usage limit should now be reset. Continue the unfinished work from the previous turn. " +
  "Review the latest conversation, workspace state, and subagent/task status before acting. " +
  "Use the provider's existing subagent resume or messaging tools to continue each unfinished subagent that stopped because of the usage limit, " +
  "using its existing agent ID/name and prior instructions. Tell it to continue from its saved progress. " +
  "Do not duplicate completed work or interrupt running subagents, and honor any user cancellation or pause. " +
  "If an existing subagent cannot be resumed, report that blocker instead of silently abandoning its unfinished task.";

const GRACE_MS = 2 * 60_000;
const UNKNOWN_RECHECK_MS = 15 * 60_000;
const MIN_DELAY_MS = 60_000;
/** Stops a limit that never renews from being retried forever (6 hours of rechecks). */
const MAX_ATTEMPTS = 24;
/** Startup scan looks at agents active this recently; older stops are left to the user. */
const SCAN_WINDOW_MS = 12 * 3_600_000;
const SCAN_TIMELINE_ITEMS = 20;

export type ResumerApi = Pick<PaseoApi, "agents" | "config" | "providers">;
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

function log(message: string): void {
  console.log(`[usage-auto-resume] ${message}`);
}

function minuteIso(date: Date): string {
  return new Date(Math.round(date.getTime() / 60_000) * 60_000).toISOString();
}

function dueFor(resetAt: Date | null, now: Date): string {
  if (!resetAt) return new Date(now.getTime() + UNKNOWN_RECHECK_MS).toISOString();
  return new Date(Math.max(resetAt.getTime() + GRACE_MS, now.getTime() + MIN_DELAY_MS)).toISOString();
}

/** Why a due job must not continue the agent, or null when it is safe to send. */
function skipReason(job: ResumeJob, agent: PaseoAgent | null): string | null {
  if (!agent) return "agent no longer exists";
  if (agent.archivedAt) return "agent is archived";
  if (agent.provider !== job.provider) return `provider changed to ${agent.provider}`;
  if ((agent.lastUserMessageAt ?? null) !== job.baseline) return "a newer message reached the agent";
  if (agent.activeTurn || (agent.status !== "idle" && agent.status !== "error")) {
    return `agent is ${agent.status}`;
  }
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") {
    return "agent is waiting for permission or input";
  }
  return null;
}

/**
 * Detects usage-limit stops, keeps one durable resume job per agent, and continues the same
 * agent once its limit resets. Paseo hands plugins an API only inside hooks and RPCs, so the
 * tick waits until a hook has attached it.
 */
export function createResumer(options: {
  store: JobStore;
  now?: () => Date;
  /** Null means unreadable settings: wait instead of enabling the public defaults. */
  readSettings?: () => Promise<ProviderSettings | null>;
}) {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const readSettings = options.readSettings ?? (async () => DEFAULT_PROVIDER_SETTINGS);
  let paseo: ResumerApi | null = null;
  let ticking = false;

  async function loadAgent(api: ResumerApi, agentId: string): Promise<PaseoAgent | null> {
    return (await api.agents.ref(agentId).refresh())?.agent ?? null;
  }

  async function onTurnEnded(event: TurnEnded, api: ResumerApi): Promise<void> {
    const { agent } = event;
    if (event.outcome.kind === "canceled") return;
    const settings = await readSettings();
    const source = settings && sourceForProvider(agent.provider, settings);
    if (!source) return;
    const observedAt = now();
    const stop = detectLimitStop(event.outcome, event.timeline, observedAt);
    if (!stop) {
      // The agent finished a turn on its own terms; nothing is waiting and retries start over.
      await store.update(agent.id, () => null);
      return;
    }
    const snapshot = await loadAgent(api, agent.id);
    if (!snapshot) return;
    await schedule(api, snapshot, source, stop.resetAt, observedAt, { onlyIfNone: false });
  }

  async function schedule(
    api: ResumerApi,
    agent: PaseoAgent,
    source: UsageSource,
    stated: Date | null,
    observedAt: Date,
    options: { onlyIfNone: boolean },
  ): Promise<void> {
    const resetAt = stated ?? (await usageResetAt(api, agent.provider, source, observedAt));
    const settings = await readSettings();
    if (!settings || sourceForProvider(agent.provider, settings) !== source) return;
    const key = resetAt ? minuteIso(resetAt) : null;
    await store.update(agent.id, (current) => {
      if (options.onlyIfNone && current) return undefined;
      if (current?.state === "pending" && current.resetAt === key) return undefined;
      const attempts = current && current.state !== "pending" ? current.attempts + 1 : (current?.attempts ?? 0);
      if (attempts >= MAX_ATTEMPTS) {
        log(`gave up on ${agent.id} after ${attempts} automatic continues hit a limit again`);
        return null;
      }
      const job: ResumeJob = {
        agentId: agent.id,
        provider: agent.provider,
        resetAt: key,
        dueAt: dueFor(resetAt, now()),
        baseline: agent.lastUserMessageAt ?? null,
        attempts,
        state: "pending",
        enabled: true,
      };
      log(`scheduled ${agent.id} (${agent.provider}) for ${job.dueAt}; reset ${key ?? "unknown"}`);
      return job;
    });
  }

  async function timelineTail(api: ResumerApi, agentId: string): Promise<AgentTimelineItem[]> {
    const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: SCAN_TIMELINE_ITEMS });
    if (page.error) return [];
    return [...page.entries].sort((left, right) => left.seqStart - right.seqStart).map((entry) => entry.item);
  }

  /**
   * Finds agents that a limit stopped while this plugin was not running (before install, or
   * during a reload), whose turn_ended was therefore never seen. Codex failures leave the
   * agent in `error` with the notice as `lastError`; Claude ends idle with a closing notice.
   */
  async function scan(api: ResumerApi): Promise<void> {
    const settings = await readSettings();
    if (!settings) return;
    const { entries } = await api.agents.list({
      filter: { statuses: ["idle", "error"] },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200 },
    });
    const since = now().getTime() - SCAN_WINDOW_MS;
    for (const { agent } of entries) {
      const source = sourceForProvider(agent.provider, settings);
      if (!source || agent.archivedAt) continue;
      if (Date.parse(agent.updatedAt) < since) continue;
      if (agent.activeTurn || agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") continue;
      const observedAt = new Date(agent.updatedAt);
      let stop = null;
      if (agent.status === "error" && agent.lastError) {
        stop = detectLimitStop({ kind: "failed", error: { message: agent.lastError } }, [], observedAt);
      } else if (source === "claude") {
        stop = detectLimitStop({ kind: "completed" }, await timelineTail(api, agent.id), observedAt);
      }
      if (stop) await schedule(api, agent, source, stop.resetAt, observedAt, { onlyIfNone: true });
    }
  }

  /** A turn that starts while a job is pending was not started by this plugin. */
  async function onTurnStarted(agentId: string): Promise<void> {
    await store.update(agentId, (job) => {
      if (job?.state !== "pending") return undefined;
      log(`canceled ${agentId}: a turn started before the scheduled continue`);
      return null;
    });
  }

  async function forget(agentId: string): Promise<void> {
    await store.update(agentId, () => null);
  }

  const isSameJob = (left: ResumeJob | null, right: ResumeJob) =>
    left !== null && left.state === right.state && left.dueAt === right.dueAt && left.resetAt === right.resetAt;

  async function fire(job: ResumeJob, api: ResumerApi, at: Date): Promise<void> {
    const settings = await readSettings();
    if (!settings) return;
    const source = sourceForProvider(job.provider, settings);
    if (!source) {
      await forgetIfUnselected(job);
      return;
    }
    if (!job.enabled) {
      log(`skipped ${job.agentId}: turned off in Auto Resume`);
      await store.update(job.agentId, (current) => (isSameJob(current, job) ? null : undefined));
      return;
    }
    const agent = await loadAgent(api, job.agentId);
    const reason = skipReason(job, agent);
    if (reason) {
      log(`canceled ${job.agentId}: ${reason}`);
      await store.update(job.agentId, (current) => (isSameJob(current, job) ? null : undefined));
      return;
    }
    if (job.resetAt === null) {
      const resetAt = await usageResetAt(api, job.provider, source, at);
      if (resetAt) {
        await store.update(job.agentId, (current) =>
          current && isSameJob(current, job)
            ? { ...current, resetAt: minuteIso(resetAt), dueAt: dueFor(resetAt, at) }
            : undefined,
        );
        log(`rescheduled ${job.agentId} for its usage reset at ${minuteIso(resetAt)}`);
        return;
      }
    }
    // Claim before sending so a crash mid-send never delivers a second continue. The current
    // row decides: the job may have been turned off while the agent was being checked.
    const currentSettings = await readSettings();
    if (!currentSettings) return;
    if (sourceForProvider(job.provider, currentSettings) !== source) {
      await forgetIfUnselected(job);
      return;
    }
    const claimed = await store.update(job.agentId, (current) =>
      current && isSameJob(current, job) && current.enabled ? { ...current, state: "sending" } : undefined,
    );
    if (claimed?.state !== "sending") return;
    try {
      await api.agents.ref(job.agentId).send(CONTINUE_PROMPT);
      await store.update(job.agentId, (current) => (current?.state === "sending" ? { ...current, state: "sent" } : undefined));
      log(`continued ${job.agentId}`);
    } catch (error) {
      await store.update(job.agentId, (current) => (current?.state === "sending" ? null : undefined));
      console.error(`[usage-auto-resume] could not continue ${job.agentId}`, String(error));
    }
  }

  async function forgetIfUnselected(job: ResumeJob): Promise<void> {
    await store.update(job.agentId, (current) => (isSameJob(current, job) ? null : undefined));
    log(`canceled ${job.agentId}: provider is no longer selected`);
  }

  /** Settings changes also retire reservations created under an earlier selection. */
  async function reconcileProviders(): Promise<void> {
    const settings = await readSettings();
    if (!settings) return;
    for (const job of await store.list()) {
      if (job.state === "pending" && !sourceForProvider(job.provider, settings)) await forgetIfUnselected(job);
    }
  }

  async function tick(): Promise<void> {
    const api = paseo;
    if (!api || ticking) return;
    ticking = true;
    try {
      const at = now();
      for (const job of await store.list()) {
        if (job.state !== "pending" || Date.parse(job.dueAt) > at.getTime()) continue;
        await fire(job, api, at).catch((error) =>
          console.error(`[usage-auto-resume] resume check failed for ${job.agentId}`, String(error)),
        );
      }
    } finally {
      ticking = false;
    }
  }

  /** Called from every hook; the first one after a start scans for missed stops and runs due jobs. */
  function attach(api: ResumerApi): Promise<void> {
    const first = paseo === null;
    paseo = api;
    if (!first) return Promise.resolve();
    return reconcileProviders().then(() => scan(api))
      .catch((error) => console.error("[usage-auto-resume] startup scan failed", String(error)))
      .then(tick);
  }

  /** A job left mid-send by a crash may already have been delivered, so it is dropped. */
  async function recover(): Promise<void> {
    for (const job of await store.list()) {
      if (job.state !== "sending") continue;
      await store.update(job.agentId, (current) => (current?.state === "sending" ? null : undefined));
      log(`dropped interrupted continue for ${job.agentId}`);
    }
  }

  /** Jobs still ahead, with the agent's title and project for display. */
  async function listScheduled(api: ResumerApi): Promise<ScheduledJob[]> {
    const jobs = (await store.list()).filter((job) => job.state === "pending" || job.state === "sending");
    const rows = await Promise.all(
      jobs.map(async (job): Promise<ScheduledJob> => {
        const loaded = await api.agents
          .ref(job.agentId)
          .refresh()
          .catch(() => null);
        return {
          agentId: job.agentId,
          provider: job.provider,
          title: loaded?.agent.title?.trim() || null,
          projectName: loaded?.project?.projectName ?? null,
          workspaceName: loaded?.project?.workspaceName ?? null,
          resetAt: job.resetAt,
          dueAt: job.dueAt,
          enabled: job.enabled,
          sending: job.state === "sending",
        };
      }),
    );
    return rows.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  }

  /** Turns one pending job on or off; `dueAt` pins the job the screen showed. */
  async function setEnabled(agentId: string, dueAt: string, enabled: boolean): Promise<boolean> {
    let changed = false;
    await store.update(agentId, (current) => {
      if (current?.state !== "pending" || current.dueAt !== dueAt) return undefined;
      changed = true;
      log(`${enabled ? "turned on" : "turned off"} ${agentId}`);
      return { ...current, enabled };
    });
    return changed;
  }

  return { attach, onTurnEnded, onTurnStarted, forget, tick, recover, scan, listScheduled, setEnabled, reconcileProviders };
}
