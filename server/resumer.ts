import type { AgentTimelineItem, PaseoAgent, PaseoApi } from "./paseo-types";
import type { PluginLifecycleEvents, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { detectLimitStop } from "./limit";
import type { HistoryEntry, HistoryOutcome, HistoryReason, HistoryRow, RescheduleResult, ResumeNowResult, ScheduledJob, SetNoteResult, Waiting } from "../shared/rpc";
import type { HistoryStore } from "./history";
import type { JobStore, ResumeJob } from "./store";
import { captureLaunch, createSubscriptionReader, subscriptionModel, unknownCheck, type LaunchContext, type SubscriptionCheck, type SubscriptionReader } from "./subscription";
import { GRACE_MS, MAX_ATTEMPTS, MIN_DELAY_MS, RETRY_DELAYS_MS, rescheduleWindow } from "../shared/schedule";
import { DEFAULT_PROVIDER_SETTINGS, DEFAULT_RESUME_SETTINGS, isProviderOn, type ProviderSettings, type ResumeSettings, type UsageSource } from "../shared/settings";
import { cliFor } from "./providers";
import { continuePrompt, DEFAULT_CONTINUE_PROMPT } from "../shared/prompt";

/** Kept for callers that compare against the built-in prompt; sends go through `continuePrompt`. */
export const CONTINUE_PROMPT = DEFAULT_CONTINUE_PROMPT;

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

/** What the account says about sending now, before the notice's stated reset is considered. */
type UsageHold =
  | { kind: "ready" }
  | { kind: "used_up"; renews: Date | null }
  | { kind: "unverified"; waiting: Waiting };

function usageHold(check: SubscriptionCheck, at: Date): UsageHold {
  if (check.auth !== "subscription") return { kind: "unverified", waiting: "auth" };
  if (check.status === "limited") return { kind: "used_up", renews: exhaustedReset(check, at) };
  if (check.status !== "ready") return { kind: "unverified", waiting: "usage" };
  return { kind: "ready" };
}

/**
 * Without a reset in the notice, the applicable usage windows decide when to continue.
 * Credits and spending notices are limit stops like any other.
 */
type Plan =
  | { kind: "reset"; resetAt: Date }
  | { kind: "retry" }
  | { kind: "check"; waiting: Waiting };

function planFor(check: SubscriptionCheck, at: Date): Plan {
  const hold = usageHold(check, at);
  switch (hold.kind) {
    case "unverified":
      return { kind: "check", waiting: hold.waiting };
    case "used_up":
      return hold.renews ? { kind: "reset", resetAt: hold.renews } : { kind: "check", waiting: "usage" };
    case "ready":
      return { kind: "retry" };
  }
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
  /** Set when Resume now started the attempt. */
  trigger?: HistoryEntry["trigger"];
}

type Cancellation = Outcome & { outcome: "canceled"; reason: HistoryReason };

const canceled = (reason: HistoryReason, detail: string): Cancellation => ({ outcome: "canceled", reason, detail });
const providerOff = (provider: string) => canceled("provider_off", `automatic resume is turned off for ${provider}`);

/** The tick's attempt at a due job, or Resume now's on the user's request. */
type DeliverMode = "auto" | "manual";

/**
 * What one delivery attempt did. `skipped` (turned off at its time) and `postponed` (moved to
 * when its usage renews or can be checked again) belong to the tick alone.
 */
type Delivery = ResumeNowResult | { result: "skipped" } | { result: "postponed" };

/**
 * When a held continue can go: the used-up window's renewal, or a reset the notice stated, which
 * counts once the account is verified even while its usage is not. Null leaves only a check.
 */
function renewalFor(hold: UsageHold, stated: Date | null): Date | null {
  switch (hold.kind) {
    case "used_up":
      return hold.renews;
    case "unverified":
      return hold.waiting === "auth" ? null : stated;
    case "ready":
      return stated;
  }
}

/** What an attempt reports when the row is no longer the one it was given. */
const staleResult = (row: ResumeJob | null | undefined): ResumeNowResult =>
  row?.state === "sending" ? { result: "sending" } : { result: "changed" };

/** Why a due job must not continue the agent, or null when it is safe to send. */
function skipReason(job: ResumeJob, agent: PaseoAgent | null): Cancellation | null {
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
  /** What a continue says. Never holds a resume: anything unreadable sends the built-in prompt. */
  readResumeSettings?: () => Promise<ResumeSettings>;
  readSubscription?: SubscriptionReader;
}) {
  const { store } = options;
  const history: HistoryStore = options.history ?? { list: async () => [], append: async () => {} };
  const now = options.now ?? (() => new Date());
  const readSettings = options.readSettings ?? (async () => DEFAULT_PROVIDER_SETTINGS);
  const readResumeSettings = options.readResumeSettings ?? (async () => DEFAULT_RESUME_SETTINGS);
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
        // A new plan for a reservation still waiting keeps its note; one already sent is not sent twice.
        note: current?.state === "pending" ? current.note : undefined,
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
    await history.append({ agentId, provider, outcome: outcome.outcome, reason: outcome.reason, title: outcome.title ?? null, trigger: outcome.trigger })
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

  /**
   * A used-up window, or a stated reset still ahead, moves a due job to when it renews; unverified
   * auth or usage moves it to the next check. False when nothing holds it.
   */
  async function postpone(job: ResumeJob, check: SubscriptionCheck, at: Date): Promise<boolean> {
    const hold = usageHold(check, at);
    const stated = job.resetAt && Date.parse(job.resetAt) > at.getTime() ? new Date(job.resetAt) : null;
    const renewsAt = renewalFor(hold, stated);
    if (hold.kind === "ready" && !renewsAt) return false;
    await store.update(job.agentId, (current) => current && isSameJob(current, job) && current.enabled ? {
      ...current, resetAt: renewsAt ? minuteIso(renewsAt) : current.resetAt, dueAt: dueFor(renewsAt, at),
      waiting: renewsAt ? undefined : hold.kind === "unverified" ? hold.waiting : "usage",
      identity: current.identity ?? check.identity,
      retries: renewsAt ? 0 : current.retries,
    } : undefined);
    return true;
  }

  /**
   * One delivery attempt: every safety and usage check, then the claim and the send. Resume now
   * runs the same checks with three differences: it sends a reservation that is turned off,
   * ignores the reset the notice stated, and leaves the reservation as it was when the usage
   * holds it. Only the tick skips or postpones, so each mode gets its own result type.
   */
  function deliver(job: ResumeJob, api: ResumerApi, at: Date, mode: "auto"): Promise<Delivery>;
  function deliver(job: ResumeJob, api: ResumerApi, at: Date, mode: "manual"): Promise<ResumeNowResult>;
  async function deliver(job: ResumeJob, api: ResumerApi, at: Date, mode: DeliverMode): Promise<Delivery> {
    const manual = mode === "manual";
    // Its results say Resume now caused them; the tick's carry no trigger.
    const trigger = manual ? "manual" : undefined;
    const same = (current: ResumeJob) => isSameJob(current, job);
    const cancel = async (outcome: Cancellation): Promise<Delivery> =>
      await retire(job.agentId, same, { ...outcome, trigger }) ? { result: "canceled", reason: outcome.reason } : { result: "changed" };
    const settings = await readSettings();
    if (!settings) return { result: "unavailable" };
    if (!isProviderOn(job.provider, settings)) return cancel(providerOff(job.provider));
    const source = cliFor((await api.config.get()).config, job.provider);
    if (!source) return cancel(canceled("unsupported_cli", `${job.provider} no longer runs Claude, Codex, or Antigravity`));
    if (!job.enabled && !manual) {
      // Switching it back on just now keeps it; the next tick sends it.
      const removed = await retire(job.agentId, (current) => same(current) && !current.enabled, { outcome: "skipped", detail: "turned off in Auto Resume" });
      return removed ? { result: "skipped" } : { result: "changed" };
    }
    const agent = await loadAgent(api, job.agentId);
    const title = agent && titleOf(agent);
    const skip = skipReason(job, agent);
    if (skip) return cancel({ ...skip, title });
    const check = await inspect(api, agent!, source, at, launches.get(job.agentId) ?? job.launch);
    if (check.auth === "api") return cancel({ ...canceled("api_route", "authentication uses API billing"), title });
    if (job.identity && check.identity && job.identity !== check.identity) {
      return cancel({ ...canceled("account_changed", "account or model changed"), title });
    }
    if (manual) {
      // Only the account's own usage holds a continue the user asked for; the notice may be outdated.
      const hold = usageHold(check, at);
      if (hold.kind === "used_up") return { result: "used_up", until: hold.renews?.toISOString() ?? null };
      if (hold.kind === "unverified") return { result: "unverified", waiting: hold.waiting };
    } else if (await postpone(job, check, at)) {
      return { result: "postponed" };
    }
    // Claim before sending so a crash mid-send, or a tick and Resume now at once, never delivers
    // a second continue. The current row decides: the job may have been turned off while the
    // agent was being checked, which only stops the tick.
    const currentSettings = await readSettings();
    if (!currentSettings) return { result: "unavailable" };
    if (!isProviderOn(job.provider, currentSettings)) return cancel({ ...providerOff(job.provider), title });
    // Assigned inside the callback, which TypeScript does not follow. The returned row cannot
    // tell: a row another attempt already claimed comes back unchanged, also as `sending`.
    // The note is taken from the claimed row, not `job`: one saved while the agent was being
    // checked must go with it, and `isSameJob` ignores notes so that saving one never fails a claim.
    let claimed = false as boolean;
    let note: string | undefined;
    const latest = await store.update(job.agentId, (current) => {
      if (!current || !isSameJob(current, job) || (!manual && !current.enabled)) return undefined;
      claimed = true;
      note = current.note;
      return { ...current, identity: check.identity, waiting: undefined, state: "sending" };
    });
    if (!claimed) return staleResult(latest);
    // Read once claimed, so a prompt saved while the agent was being checked is the one sent. A
    // failure here must not leave the claim behind, so it falls back to the built-in prompt.
    const { continuePrompt: custom } = await readResumeSettings().catch(() => DEFAULT_RESUME_SETTINGS);
    try {
      await api.agents.ref(job.agentId).send(continuePrompt({ custom, note }));
    } catch (error) {
      await store.update(job.agentId, (current) => (current?.state === "sending" ? null : undefined));
      console.error(`[usage-auto-resume] could not continue ${job.agentId}`, String(error));
      await record(job.agentId, job.provider, { outcome: "send_failed", title, trigger });
      return { result: "send_failed" };
    }
    // The sent row stays until the agent's next turn ends, which clears it without a report. The
    // note went with the continue, so the user's text is not kept any longer.
    await store.update(job.agentId, (current) => (current?.state === "sending" ? { ...current, state: "sent", note: undefined } : undefined));
    log(`continued ${job.agentId}${manual ? " on request" : ""}`);
    await record(job.agentId, job.provider, { outcome: "continued", title, trigger });
    return { result: "sent" };
  }

  /** Sends the continue now if the agent and its usage allow it; `dueAt` pins the job the screen showed. */
  async function resumeNow(api: ResumerApi, agentId: string, dueAt: string): Promise<ResumeNowResult> {
    const job = (await store.list()).find((entry) => entry.agentId === agentId);
    if (job?.state !== "pending" || job.dueAt !== dueAt) return staleResult(job?.dueAt === dueAt ? job : null);
    log(`resume now requested for ${agentId}`);
    return deliver(job, api, now(), "manual");
  }

  /** Turning a provider off also retires the reservations it already has. */
  async function reconcileProviders(): Promise<void> {
    const settings = await readSettings();
    if (!settings) return;
    for (const job of await store.list()) {
      if (job.state !== "pending" || isProviderOn(job.provider, settings)) continue;
      await retire(job.agentId, (current) => isSameJob(current, job), providerOff(job.provider));
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
        await deliver(job, api, at, "auto").catch((error) =>
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
          note: job.note,
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
   * Saves or, when blank, removes the note sent with one pending job's continue. Its time and
   * switch stay as they are; `dueAt` pins the job the screen showed. The log never has the text.
   */
  async function setNote(agentId: string, dueAt: string, note: string): Promise<SetNoteResult> {
    const text = note.trim();
    let result: SetNoteResult = { changed: false, reason: "changed" };
    await store.update(agentId, (current) => {
      if (current?.state === "sending" && current.dueAt === dueAt) result = { changed: false, reason: "sending" };
      if (current?.state !== "pending" || current.dueAt !== dueAt) return undefined;
      result = { changed: true };
      log(`note ${text ? "updated" : "removed"} for ${agentId}`);
      return { ...current, note: text || undefined };
    });
    return result;
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
    setNote,
    resumeNow,
    reconcileProviders,
  };
}
