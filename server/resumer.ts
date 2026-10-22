import type { AgentTimelineItem, PaseoAgent, PaseoApi } from "./paseo-types";
import type { PluginLifecycleEvents, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { detectLimitStop } from "./limit";
import type { HistoryOutcome, HistoryReason, HistoryRow, RescheduleResult, ScheduledJob } from "../shared/rpc";
import type { HistoryStore } from "./history";
import type { JobStore, ResumeJob } from "./store";
import { captureLaunch, createSubscriptionReader, subscriptionModel, unknownCheck, type LaunchContext, type SubscriptionCheck, type SubscriptionReader } from "./subscription";
import { GRACE_MS, MAX_ATTEMPTS, MIN_DELAY_MS, RETRY_DELAYS_MS, rescheduleWindow } from "../shared/schedule";
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
/** Startup scan looks at agents active this recently; older stops are left to the user. */
const SCAN_WINDOW_MS = 12 * 3_600_000;
const SCAN_TIMELINE_ITEMS = 20;

export type ResumerApi = Pick<PaseoApi, "agents" | "config" | "providers">;
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

function log(message: string): void {
  console.log(`[usage-auto-resume] ${message}`);
}

const titleOf = (agent: Pick<PaseoAgent, "title">): string | null => agent.title?.trim() || null;

function minuteIso(date: Date): string {
  return date.toISOString();
}

function exhaustedReset(check: SubscriptionCheck, at: Date): Date | null {
  const times = (check.windows ?? []).filter((w) => w.usedPct >= 100).map((w) => w.resetAt ? Date.parse(w.resetAt) : NaN);
  // Every applicable exhausted window must have a known future reset.
  return times.length && times.every((time) => Number.isFinite(time) && time > at.getTime()) ? new Date(Math.max(...times)) : null;
}

/**
 * Without a reset in the notice, the applicable usage windows decide when to continue.
 * Credits and spending notices are limit stops like any other.
 */
type Plan =
  | { kind: "reset"; resetAt: Date }
  | { kind: "retry" }
  | { kind: "check"; waiting: "auth" | "usage" };

function planFor(check: SubscriptionCheck, at: Date): Plan {
  if (check.auth !== "subscription") return { kind: "check", waiting: "auth" };
  if (check.status === "limited") {
    const resetAt = exhaustedReset(check, at);
    return resetAt ? { kind: "reset", resetAt } : { kind: "check", waiting: "usage" };
  }
  if (check.status !== "ready") return { kind: "check", waiting: "usage" };
  return { kind: "retry" };
}

function dueFor(resetAt: Date | null, now: Date): string {
  if (!resetAt) return new Date(now.getTime() + UNKNOWN_RECHECK_MS).toISOString();
  return new Date(Math.max(resetAt.getTime() + GRACE_MS, now.getTime() + MIN_DELAY_MS)).toISOString();
}

/** Why a reservation ended. The history keeps the codes; `detail` is only the log's wording. */
interface Outcome {
  outcome: HistoryOutcome;
  reason?: HistoryReason;
  detail?: string;
  /** The conversation title when it is at hand, kept so a deleted agent still has a name. */
  title?: string | null;
}

const canceled = (reason: HistoryReason, detail: string): Outcome => ({ outcome: "canceled", reason, detail });

/** Why a due job must not continue the agent, or null when it is safe to send. */
function skipReason(job: ResumeJob, agent: PaseoAgent | null): Outcome | null {
  if (!agent) return canceled("agent_missing", "agent no longer exists");
  if (agent.archivedAt) return canceled("archived", "agent is archived");
  if (agent.provider !== job.provider) return canceled("provider_changed", `provider changed to ${agent.provider}`);
  if (job.model !== undefined && subscriptionModel(agent) !== job.model) return canceled("model_changed", "model changed");
  if ((agent.lastUserMessageAt ?? null) !== job.baseline) return canceled("new_message", "a newer message reached the agent");
  if (agent.activeTurn || (agent.status !== "idle" && agent.status !== "error")) {
    return canceled("agent_busy", `agent is ${agent.status}`);
  }
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") {
    return canceled("permission", "agent is waiting for permission or input");
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
  /** Where final results are recorded; without one nothing is kept. */
  history?: HistoryStore;
  now?: () => Date;
  /** Null means unreadable settings: wait instead of enabling the public defaults. */
  readSettings?: () => Promise<ProviderSettings | null>;
  readSubscription?: SubscriptionReader;
}) {
  const { store } = options;
  const history: HistoryStore = options.history ?? { list: async () => [], append: async () => {} };
  const now = options.now ?? (() => new Date());
  const readSettings = options.readSettings ?? (async () => DEFAULT_PROVIDER_SETTINGS);
  let paseo: ResumerApi | null = null;
  let ticking = false;
  const launches = new Map<string, LaunchContext>();
  const readSubscription = options.readSubscription ?? createSubscriptionReader();
  const inspect = async (api: ResumerApi, agent: PaseoAgent, source: UsageSource, at: Date, launch?: LaunchContext, mode?: "identity" | "usage") => {
    try { return await readSubscription(api, agent, source, at, launch, mode); }
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
      // A continue already sent is cleared without a second report.
      await retire(agent.id, (current) => current.state === "pending",
        canceled("turn_finished", "a turn finished before the scheduled continue"), { clearOthers: true });
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
    // A notice supplies the schedule; only bind identity here, leaving usage until delivery.
    const check = await inspect(api, agent, source, at, launch, stated ? "identity" : "usage");
    if (check.auth === "api") {
      // Only a reservation still waiting is canceled; a continue already sent was reported.
      launches.delete(agent.id);
      await retire(agent.id, (current) => current.state === "pending",
        { ...canceled("api_route", "authentication uses API billing"), title: titleOf(agent) }, { clearOthers: true });
      return;
    }
    const plan: Plan = stated ? { kind: "reset", resetAt: stated } : planFor(check, at);
    const settings = await readSettings();
    if (!settings || !isProviderOn(agent.provider, settings)) return;
    const resetAt = plan.kind === "reset" ? plan.resetAt : null;
    const key = resetAt ? minuteIso(resetAt) : null;
    const waiting = plan.kind === "check" ? plan.waiting : undefined;
    let gaveUp = null as Outcome | null;
    await store.update(agent.id, (current) => {
      if (options.onlyIfNone && current) return undefined;
      if (current?.state === "pending" && current.resetAt === key && current.waiting === waiting) return undefined;
      const attempts = current && current.state !== "pending" ? current.attempts + 1 : (current?.attempts ?? 0);
      if (attempts >= MAX_ATTEMPTS) {
        log(`gave up on ${agent.id} after ${attempts} automatic continues hit a limit again`);
        gaveUp = { outcome: "gave_up", reason: "attempts", detail: `${attempts} automatic continues hit a limit again` };
        return null;
      }
      const retries = plan.kind === "retry" ? (current?.retries ?? 0) : 0;
      if (retries >= RETRY_DELAYS_MS.length) {
        log(`gave up on ${agent.id}: ${retries} continues stopped again while its usage windows were not used up`);
        gaveUp = { outcome: "gave_up", reason: "retries", detail: `${retries} continues stopped again while its usage windows were not used up` };
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
        model: subscriptionModel(agent),
        launch,
      };
      log(`scheduled ${agent.id} (${agent.provider}) for ${job.dueAt}; ${plan.kind === "retry" ? `retry ${job.retries} of ${RETRY_DELAYS_MS.length}` : `reset ${key ?? "unknown"}`}`);
      return job;
    });
    // Recorded outside the update so the job file is never held waiting on the history file.
    if (gaveUp) await record(agent.id, agent.provider, { ...gaveUp, title: titleOf(agent) });
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
    // Visibility does not opt an agent out of recovery. Older host SDKs ignore this field.
    const filter = { statuses: ["idle", "error"] satisfies PaseoAgent["status"][], includeBackground: true };
    const query: NonNullable<Parameters<ResumerApi["agents"]["list"]>[0]> = {
      filter,
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200 },
    };
    const { entries } = await api.agents.list(query).catch((error: unknown) => {
      // A newer SDK connected to an older daemon explicitly rejects inclusive discovery.
      if (!(error instanceof Error) || error.message !== "Update the host to use background workspaces.") throw error;
      return api.agents.list({ ...query, filter: { statuses: filter.statuses } });
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

  /** Adds a final result to the history; a failed write is logged and never stops a resume. */
  async function record(agentId: string, provider: string, outcome: Outcome): Promise<void> {
    await history.append({ agentId, provider, outcome: outcome.outcome, reason: outcome.reason, title: outcome.title ?? null })
      .catch((error) => console.error("[usage-auto-resume] could not record history", String(error)));
  }

  /**
   * Removes the agent's job when `matches` accepts the current row, then logs and records why.
   * With `clearOthers`, a row `matches` rejects is removed in the same update without a report.
   * Returns whether a matching job was removed; one that changed meanwhile is left alone, or only
   * cleared, and nothing is recorded.
   */
  async function retire(agentId: string, matches: (current: ResumeJob) => boolean, outcome: Outcome, options: { clearOthers?: boolean } = {}): Promise<boolean> {
    // Assigned inside the callback, which TypeScript does not follow.
    let removed = null as ResumeJob | null;
    await store.update(agentId, (current) => {
      if (!current) return undefined;
      if (!matches(current)) return options.clearOthers ? null : undefined;
      removed = current;
      return null;
    });
    if (!removed) return false;
    log(outcome.outcome === "interrupted" ? `dropped interrupted continue for ${agentId}` : `${outcome.outcome} ${agentId}: ${outcome.detail}`);
    await record(agentId, removed.provider, outcome);
    return true;
  }

  /** A turn that starts while a job is pending was not started by this plugin. */
  async function onTurnStarted(agentId: string): Promise<void> {
    await retire(agentId, (job) => job.state === "pending", canceled("turn_started", "a turn started before the scheduled continue"));
  }

  /** An archived agent's reservation goes with it; a continue already sent is cleared quietly. */
  async function forget(agentId: string): Promise<void> {
    launches.delete(agentId);
    await retire(agentId, (job) => job.state === "pending", canceled("archived", "agent was archived"), { clearOthers: true });
  }

  const isSameJob = (left: ResumeJob | null, right: ResumeJob) =>
    left !== null && left.state === right.state && left.dueAt === right.dueAt && left.resetAt === right.resetAt &&
    left.identity === right.identity && left.model === right.model && left.retries === right.retries && left.waiting === right.waiting && left.baseline === right.baseline;

  async function fire(job: ResumeJob, api: ResumerApi, at: Date): Promise<void> {
    const settings = await readSettings();
    if (!settings) return;
    if (!isProviderOn(job.provider, settings)) {
      await forgetTurnedOff(job);
      return;
    }
    const source = cliFor((await api.config.get()).config, job.provider);
    const same = (current: ResumeJob) => isSameJob(current, job);
    if (!source) {
      await retire(job.agentId, same, canceled("unsupported_cli", `${job.provider} no longer runs Claude, Codex, or Antigravity`));
      return;
    }
    if (!job.enabled) {
      // Switching it back on just now keeps it; the next tick sends it.
      await retire(job.agentId, (current) => same(current) && !current.enabled, { outcome: "skipped", detail: "turned off in Auto Resume" });
      return;
    }
    const agent = await loadAgent(api, job.agentId);
    const title = agent && titleOf(agent);
    const skip = skipReason(job, agent);
    if (skip) {
      await retire(job.agentId, same, { ...skip, title });
      return;
    }
    const check = await inspect(api, agent!, source, at, launches.get(job.agentId) ?? job.launch);
    if (check.auth === "api") {
      await retire(job.agentId, same, { ...canceled("api_route", "authentication uses API billing"), title });
      return;
    }
    if (job.identity && check.identity && job.identity !== check.identity) {
      await retire(job.agentId, same, { ...canceled("account_changed", "account or model changed"), title });
      return;
    }
    // A used-up window, or a stated reset still ahead, holds the continue until it renews.
    const held = check.auth !== "subscription" ? null
      : check.status === "limited" ? exhaustedReset(check, at)
      : job.resetAt && Date.parse(job.resetAt) > at.getTime() ? new Date(job.resetAt) : null;
    const ready = check.auth === "subscription" && check.status === "ready" && !held;
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
      await forgetTurnedOff(job, title);
      return;
    }
    const claimed = await store.update(job.agentId, (current) =>
      current && isSameJob(current, job) && current.enabled ? { ...current, identity: check.identity, waiting: undefined, state: "sending" } : undefined,
    );
    if (claimed?.state !== "sending") return;
    try {
      await api.agents.ref(job.agentId).send(CONTINUE_PROMPT);
    } catch (error) {
      await store.update(job.agentId, (current) => (current?.state === "sending" ? null : undefined));
      console.error(`[usage-auto-resume] could not continue ${job.agentId}`, String(error));
      await record(job.agentId, job.provider, { outcome: "send_failed", title });
      return;
    }
    // The sent row stays until the agent's next turn ends, which clears it without a report.
    await store.update(job.agentId, (current) => (current?.state === "sending" ? { ...current, state: "sent" } : undefined));
    log(`continued ${job.agentId}`);
    await record(job.agentId, job.provider, { outcome: "continued", title });
  }

  async function forgetTurnedOff(job: ResumeJob, title?: string | null): Promise<void> {
    await retire(job.agentId, (current) => isSameJob(current, job), { ...canceled("provider_off", `automatic resume is turned off for ${job.provider}`), title });
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
      await retire(job.agentId, (current) => current.state === "sending", { outcome: "interrupted" });
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
          workspaceId: loaded?.agent.workspaceId ?? null,
          title: loaded ? titleOf(loaded.agent) : null,
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

  /** Recent results, newest first, named and placed by the live agent when it still exists. */
  async function listHistory(api: ResumerApi): Promise<HistoryRow[]> {
    const entries = await history.list();
    const ids = [...new Set(entries.map((entry) => entry.agentId))];
    const agents = new Map(await Promise.all(ids.map(async (id) => {
      const loaded = await api.agents.ref(id).refresh().catch(() => null);
      return [id, loaded?.agent ?? null] as const;
    })));
    return entries.map((entry) => {
      const agent = agents.get(entry.agentId);
      return {
        ...entry,
        title: (agent && titleOf(agent)) || entry.title,
        workspaceId: agent?.workspaceId ?? null,
        archived: !!agent?.archivedAt,
      };
    });
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
    listHistory,
    setEnabled,
    setAllEnabled,
    reschedule,
    reconcileProviders,
  };
}
