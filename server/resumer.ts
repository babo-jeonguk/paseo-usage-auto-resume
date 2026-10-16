import type { AgentTimelineItem, PaseoAgent, PaseoApi } from "./paseo-types";
import type { PluginLifecycleEvents, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { detectLimitStop } from "./limit";
import type { RescheduleResult, ScheduledJob } from "../shared/rpc";
import type { JobStore, ResumeJob } from "./store";
import { captureLaunch, createSubscriptionReader, unknownCheck, type LaunchContext, type SubscriptionCheck, type SubscriptionReader } from "./subscription";
import { GRACE_MS, MIN_DELAY_MS, rescheduleWindow } from "../shared/schedule";
import { DEFAULT_PROVIDER_SETTINGS, isProviderOn, type ProviderSettings, type UsageSource } from "../shared/settings";
import { cliFor } from "./providers";

export const CONTINUE_PROMPT =
  "The provider usage limit should now be reset. Continue the unfinished work from the previous turn. " +
  "Review the latest conversation, workspace state, and subagent/task status before acting. " +
  "Use the provider's existing subagent resume or messaging tools to continue each unfinished subagent that stopped because of the usage limit, " +
  "using its existing agent ID/name and prior instructions. Tell it to continue from its saved progress. " +
  "Do not duplicate completed work or interrupt running subagents, and honor any user cancellation or pause. " +
  "If an existing subagent cannot be resumed, report that blocker instead of silently abandoning its unfinished task.";

const UNKNOWN_RECHECK_MS = 15 * 60_000;
/**
 * Waits before each continue after a stop whose applicable windows were not used up, such as a
 * credits notice or a transient rate limit; the chain gives up after the last one.
 */
const RETRY_DELAYS_MS = [15, 30, 60].map((minutes) => minutes * 60_000);
/** Bounds actual automatic continues; read-only verification checks do not consume retries. */
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
  return date.toISOString();
}

function exhaustedReset(check: SubscriptionCheck, at: Date): Date | null {
  const times = (check.windows ?? []).filter((w) => w.usedPct >= 100).map((w) => w.resetAt ? Date.parse(w.resetAt) : NaN);
  // Every applicable exhausted window must have a known future reset.
  return times.length && times.every((time) => Number.isFinite(time) && time > at.getTime()) ? new Date(Math.max(...times)) : null;
}

/**
 * What a limit stop waits for. Only the 5-hour and weekly windows decide; credits and spending
 * notices are limit stops like any other. A stated reset still ahead is kept when the windows
 * do not show it, since a filtered or lagging window must not cut the wait short.
 */
type Plan =
  | { kind: "reset"; resetAt: Date }
  | { kind: "retry" }
  | { kind: "check"; waiting: "auth" | "usage" };

function planFor(check: SubscriptionCheck, stated: Date | null, at: Date): Plan {
  if (check.auth !== "subscription") return { kind: "check", waiting: "auth" };
  if (check.status === "limited") {
    const resetAt = exhaustedReset(check, at);
    return resetAt ? { kind: "reset", resetAt } : { kind: "check", waiting: "usage" };
  }
  if (check.status !== "ready") return { kind: "check", waiting: "usage" };
  return stated && stated.getTime() > at.getTime() ? { kind: "reset", resetAt: stated } : { kind: "retry" };
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
  readSubscription?: SubscriptionReader;
}) {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const readSettings = options.readSettings ?? (async () => DEFAULT_PROVIDER_SETTINGS);
  let paseo: ResumerApi | null = null;
  let ticking = false;
  const launches = new Map<string, LaunchContext>();
  const readSubscription = options.readSubscription ?? createSubscriptionReader();
  const inspect = async (api: ResumerApi, agent: PaseoAgent, source: UsageSource, at: Date, launch?: LaunchContext) => {
    try { return await readSubscription(api, agent, source, at, launch); }
    catch { return unknownCheck(); }
  };

  function rememberSession(request: PluginSessionOpenRequest): void {
    if (request.purpose === "interactive") launches.set(request.agentId, captureLaunch(request));
  }

  async function loadAgent(api: ResumerApi, agentId: string): Promise<PaseoAgent | null> {
    return (await api.agents.ref(agentId).refresh())?.agent ?? null;
  }

  /** The CLI behind a provider that is turned on, or null when its agents are not resumed. */
  async function resumableSource(api: ResumerApi, provider: string, settings: ProviderSettings): Promise<UsageSource | null> {
    if (!isProviderOn(provider, settings)) return null;
    return cliFor((await api.config.get()).config, provider);
  }

  async function onTurnEnded(event: TurnEnded, api: ResumerApi): Promise<void> {
    const { agent } = event;
    if (event.outcome.kind === "canceled") return;
    const settings = await readSettings();
    const source = settings && (await resumableSource(api, agent.provider, settings));
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
    const previous = (await store.list()).find((job) => job.agentId === agent.id);
    if (options.onlyIfNone && previous) return;
    const launch = launches.get(agent.id) ?? previous?.launch;
    const at = now();
    const check = await inspect(api, agent, source, at, launch);
    if (check.auth === "api") { await forget(agent.id); return; }
    const plan = planFor(check, stated, at);
    const settings = await readSettings();
    if (!settings || !isProviderOn(agent.provider, settings)) return;
    // A waiting check keeps the stated reset to show and to hold the continue until then.
    const resetAt = plan.kind === "reset" ? plan.resetAt : plan.kind === "check" ? stated : null;
    const key = resetAt ? minuteIso(resetAt) : null;
    const waiting = plan.kind === "check" ? plan.waiting : undefined;
    await store.update(agent.id, (current) => {
      if (options.onlyIfNone && current) return undefined;
      if (current?.state === "pending" && current.resetAt === key && current.waiting === waiting) return undefined;
      const attempts = current && current.state !== "pending" ? current.attempts + 1 : (current?.attempts ?? 0);
      if (attempts >= MAX_ATTEMPTS) {
        log(`gave up on ${agent.id} after ${attempts} automatic continues hit a limit again`);
        return null;
      }
      const retries = plan.kind === "retry" ? (current?.retries ?? 0) : 0;
      if (retries >= RETRY_DELAYS_MS.length) {
        log(`gave up on ${agent.id}: ${retries} continues stopped again while its usage windows were not used up`);
        return null;
      }
      const job: ResumeJob = {
        agentId: agent.id,
        provider: agent.provider,
        resetAt: key,
        dueAt: plan.kind === "retry" ? new Date(at.getTime() + RETRY_DELAYS_MS[retries]!).toISOString()
          : dueFor(plan.kind === "reset" ? plan.resetAt : null, at),
        baseline: agent.lastUserMessageAt ?? null,
        attempts,
        retries: plan.kind === "retry" ? retries + 1 : 0,
        state: "pending",
        enabled: true,
        waiting,
        identity: check.identity,
        launch,
      };
      log(`scheduled ${agent.id} (${agent.provider}) for ${job.dueAt}; ${plan.kind === "retry" ? `retry ${job.retries} of ${RETRY_DELAYS_MS.length}` : `reset ${key ?? "unknown"}`}`);
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
    const { config } = await api.config.get();
    const { entries } = await api.agents.list({
      filter: { statuses: ["idle", "error"] },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200 },
    });
    const since = now().getTime() - SCAN_WINDOW_MS;
    for (const { agent } of entries) {
      const source = isProviderOn(agent.provider, settings) ? cliFor(config, agent.provider) : null;
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
    launches.delete(agentId);
    await store.update(agentId, () => null);
  }

  const isSameJob = (left: ResumeJob | null, right: ResumeJob) =>
    left !== null && left.state === right.state && left.dueAt === right.dueAt && left.resetAt === right.resetAt &&
    left.identity === right.identity && left.retries === right.retries && left.waiting === right.waiting && left.baseline === right.baseline;

  async function fire(job: ResumeJob, api: ResumerApi, at: Date): Promise<void> {
    const settings = await readSettings();
    if (!settings) return;
    if (!isProviderOn(job.provider, settings)) {
      await forgetTurnedOff(job);
      return;
    }
    const source = cliFor((await api.config.get()).config, job.provider);
    if (!source) {
      log(`canceled ${job.agentId}: ${job.provider} no longer runs Claude, Codex, or Antigravity`);
      await store.update(job.agentId, (current) => (isSameJob(current, job) ? null : undefined));
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
    const check = await inspect(api, agent!, source, at, launches.get(job.agentId) ?? job.launch);
    if (check.auth === "api" || (job.identity && check.identity && job.identity !== check.identity)) {
      await store.update(job.agentId, (current) => isSameJob(current, job) ? null : undefined);
      log(`canceled ${job.agentId}: authentication, account or model changed`);
      return;
    }
    // A used-up window, or a stated reset still ahead, holds the continue until it renews.
    const held = check.auth !== "subscription" ? null
      : check.status === "limited" ? exhaustedReset(check, at)
      : job.resetAt && Date.parse(job.resetAt) > at.getTime() ? new Date(job.resetAt) : null;
    const ready = check.auth === "subscription" && check.status === "ready" && !!check.identity && !held;
    if (!ready) {
      await store.update(job.agentId, (current) => current && isSameJob(current, job) && current.enabled ? {
        ...current, resetAt: held ? minuteIso(held) : current.resetAt, dueAt: dueFor(held, at),
        waiting: held ? undefined : check.auth !== "subscription" ? "auth" : "usage",
        identity: current.identity ?? check.identity,
        retries: held ? 0 : current.retries,
      } : undefined);
      return;
    }
    // Claim before sending so a crash mid-send never delivers a second continue. The current
    // row decides: the job may have been turned off while the agent was being checked.
    const currentSettings = await readSettings();
    if (!currentSettings) return;
    if (!isProviderOn(job.provider, currentSettings)) {
      await forgetTurnedOff(job);
      return;
    }
    const claimed = await store.update(job.agentId, (current) =>
      current && isSameJob(current, job) && current.enabled ? { ...current, identity: check.identity, waiting: undefined, state: "sending" } : undefined,
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

  async function forgetTurnedOff(job: ResumeJob): Promise<void> {
    await store.update(job.agentId, (current) => (isSameJob(current, job) ? null : undefined));
    log(`canceled ${job.agentId}: automatic resume is turned off for ${job.provider}`);
  }

  /** Turning a provider off also retires the reservations it already has. */
  async function reconcileProviders(): Promise<void> {
    const settings = await readSettings();
    if (!settings) return;
    for (const job of await store.list()) {
      if (job.state === "pending" && !isProviderOn(job.provider, settings)) await forgetTurnedOff(job);
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
          waiting: job.waiting,
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

  /**
   * Turns the jobs the screen showed on or off and counts the ones that flipped. Jobs scheduled
   * after the screen loaded are not in `jobs`, and one being sent is no longer pending.
   */
  async function setAllEnabled(enabled: boolean, jobs: ReadonlyArray<{ agentId: string; dueAt: string }>): Promise<number> {
    let changed = 0;
    for (const { agentId, dueAt } of jobs) {
      await store.update(agentId, (current) => {
        if (current?.state !== "pending" || current.dueAt !== dueAt || current.enabled === enabled) return undefined;
        changed += 1;
        log(`${enabled ? "turned on" : "turned off"} ${agentId}`);
        return { ...current, enabled };
      });
    }
    return changed;
  }

  /**
   * Moves one pending job to `newDueAt` and turns it on, like changing an alarm's time;
   * `dueAt` pins the job the screen showed.
   */
  async function reschedule(agentId: string, dueAt: string, newDueAt: string): Promise<RescheduleResult> {
    let result: RescheduleResult = { changed: false, reason: "changed" };
    const at = now();
    const target = new Date(newDueAt);
    await store.update(agentId, (current) => {
      if (current?.state === "sending" && current.dueAt === dueAt) result = { changed: false, reason: "sending" };
      if (current?.state !== "pending" || current.dueAt !== dueAt) return undefined;
      const { earliest, latest } = rescheduleWindow(current.resetAt, at.getTime());
      if (target.getTime() < earliest) {
        result = { changed: false, reason: "too-early", earliest: new Date(earliest).toISOString() };
        return undefined;
      }
      if (target.getTime() > latest) {
        result = { changed: false, reason: "too-late" };
        return undefined;
      }
      const next = target.toISOString();
      result = { changed: true, dueAt: next };
      log(`rescheduled ${agentId} for ${next} (was ${current.dueAt}${current.enabled ? "" : "; turned on"})`);
      return { ...current, dueAt: next, enabled: true };
    });
    return result;
  }

  return {
    rememberSession,
    attach,
    onTurnEnded,
    onTurnStarted,
    forget,
    tick,
    recover,
    scan,
    listScheduled,
    setEnabled,
    setAllEnabled,
    reschedule,
    reconcileProviders,
  };
}
