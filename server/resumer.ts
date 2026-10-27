import type { AgentTimelineItem, PaseoAgent, PaseoApi } from "./paseo-types";
import type { PluginLifecycleEvents, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { ACCOUNT_CHANGED, agentGate, API_ROUTE, canceled, turnAction, turnEventOf, type Cancellation, type Gate, type Outcome, type TurnEvent } from "./decisions";
import { claimed, isSameJob, noted, pinned, postponed, replan, rescheduled, sent, switched, type Pin, type Plan } from "./reservation";
import { detectLimitStop } from "./limit";
import type { HistoryRow, RescheduleResult, ResumeNowResult, ScheduledJob, SetNoteResult, Waiting } from "../shared/rpc";
import type { HistoryStore } from "./history";
import type { JobStore, ResumeJob } from "./store";
import { captureLaunch, createSubscriptionReader, subscriptionModel, unknownCheck, type LaunchContext, type SubscriptionCheck, type SubscriptionReader } from "./subscription";
import { RETRY_DELAYS_MS, rescheduleWindow } from "../shared/schedule";
import { DEFAULT_PROVIDER_SETTINGS, DEFAULT_RESUME_SETTINGS, isProviderOn, type ProviderSettings, type ResumeSettings, type UsageSource } from "../shared/settings";
import { cliFor } from "./providers";
import { continuePrompt, DEFAULT_CONTINUE_PROMPT } from "../shared/prompt";

/** Kept for callers that compare against the built-in prompt; sends go through `continuePrompt`. */
export const CONTINUE_PROMPT = DEFAULT_CONTINUE_PROMPT;

/** Startup scan looks at agents active this recently; older stops are left to the user. */
const SCAN_WINDOW_MS = 12 * 3_600_000;
const TAIL_TIMELINE_ITEMS = 20;

export type ResumerApi = Pick<PaseoApi, "agents" | "config" | "providers">;
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

function log(message: string): void {
  console.log(`[usage-auto-resume] ${message}`);
}

const titleOf = (agent: Pick<PaseoAgent, "title">): string | null => agent.title?.trim() || null;

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
    const { outcome } = event;
    const observedAt = now();
    let stop = null;
    if (outcome.kind !== "canceled") {
      // The event's own timeline is deprecated and empty from Paseo 0.13, so it is never read.
      stop = detectLimitStop(outcome, await timelineTail(api, event.agent.id), observedAt);
    }
    const kind = turnEventOf(outcome.kind, !!stop);
    await onTurn(api, event.agent.id, kind, stop ? { resetAt: stop.resetAt, observedAt } : undefined);
  }

  function onTurnStarted(agentId: string, api: ResumerApi): Promise<void> {
    return onTurn(api, agentId, "started");
  }

  /**
   * Applies the table's turn events. The agent is read only when a new message could matter. A
   * cancel or a clear acts on the reservation the event read, by its id, wherever it has moved
   * meanwhile; a stop at a limit is planned by `replan` inside its own write.
   */
  async function onTurn(api: ResumerApi, agentId: string, event: TurnEvent, stop?: { resetAt: Date | null; observedAt: Date }): Promise<void> {
    const row = (await store.list()).find((job) => job.agentId === agentId) ?? null;
    // An agent that cannot be read only loses the message check; a finished turn still clears.
    const agent = row?.state === "pending" || event === "limit" ? await loadAgent(api, agentId).catch(() => null) : null;
    const action = turnAction(row, agent, event);
    // A reservation that replaced the one read is not this event's.
    const stillSeen = (current: ResumeJob | null, state: ResumeJob["state"]) => !!current && !!row && current.id === row.id && current.state === state;
    if (action.cancel) await retire(agentId, (current) => stillSeen(current, "pending"), action.cancel);
    // A continue already sent was reported when it went, so it is cleared quietly.
    if (action.clearSent) await store.update(agentId, (current) => (stillSeen(current, "sent") ? null : undefined));
    if (!action.schedules || !agent || !stop) return;
    const settings = await readSettings();
    const source = settings && (await resumableSource(api, agent.provider, settings));
    if (source) await schedule(api, agent, source, stop.resetAt, stop.observedAt, { onlyIfNone: false });
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
    // A missed stop is planned unless a reservation is still waiting or being sent; after a sent
    // continue it counts as one more.
    const waits = (row: ResumeJob | null | undefined) => !!row && row.state !== "sent";
    if (options.onlyIfNone && waits(previous)) return;
    const launch = launches.get(agent.id) ?? previous?.launch;
    const at = now();
    // A notice supplies the schedule; only bind identity here, leaving usage until delivery.
    const check = await inspect(api, agent, source, at, launch, stated ? "identity" : "usage");
    if (check.auth === "api") {
      // Only a reservation still waiting is canceled; a continue already sent was reported.
      launches.delete(agent.id);
      await retire(agent.id, (current) => current.state === "pending",
        { ...API_ROUTE, title: titleOf(agent) }, { clearOthers: true });
      return;
    }
    const plan: Plan = stated ? { kind: "reset", resetAt: stated } : planFor(check, at);
    const settings = await readSettings();
    if (!settings || !isProviderOn(agent.provider, settings)) return;
    const stop = {
      id: randomUUID(),
      agentId: agent.id, provider: agent.provider, plan, at, baseline: agent.lastUserMessageAt ?? null,
      identity: check.identity, model: subscriptionModel(agent), launch,
    };
    let ended = null as Outcome | null;
    await store.update(agent.id, (current) => {
      if (options.onlyIfNone && waits(current)) return undefined;
      const next = replan(current, stop);
      if (!next) return undefined;
      if (next.end) {
        log(`${next.end.outcome} ${agent.id}: ${next.end.detail}`);
        ended = next.end;
      }
      const job = next.write;
      if (!job) return null;
      log(`scheduled ${agent.id} (${agent.provider}) for ${job.dueAt}; ${plan.kind === "retry" ? `retry ${job.retries} of ${RETRY_DELAYS_MS.length}` : `reset ${job.resetAt ?? "unknown"}`}`);
      return job;
    });
    // Recorded outside the update so the job file is never held waiting on the history file.
    if (ended) await record(agent.id, agent.provider, { ...ended, title: titleOf(agent) });
  }

  /** The agent's latest timeline items, oldest first; none, and a log line, when they cannot be read. */
  async function timelineTail(api: ResumerApi, agentId: string): Promise<AgentTimelineItem[]> {
    let page;
    try {
      page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: TAIL_TIMELINE_ITEMS });
    } catch (error) {
      page = { error: String(error), entries: [] };
    }
    if (page.error) {
      console.error(`[usage-auto-resume] could not read the timeline of ${agentId}`, page.error);
      return [];
    }
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
   * With `clearOthers`, a sent record `matches` rejects is removed in the same update without a
   * report; a continue still being sent keeps its claim.
   * Returns whether a matching job was removed; one that changed meanwhile is left alone, or only
   * cleared, and nothing is recorded.
   */
  async function retire(agentId: string, matches: (current: ResumeJob) => boolean, outcome: Outcome, options: { clearOthers?: boolean } = {}): Promise<boolean> {
    // Assigned inside the callback, which TypeScript does not follow.
    let removed = null as ResumeJob | null;
    await store.update(agentId, (current) => {
      if (!current) return undefined;
      if (!matches(current)) return options.clearOthers && current.state === "sent" ? null : undefined;
      removed = current;
      return null;
    });
    if (!removed) return false;
    log(outcome.outcome === "interrupted" ? `dropped interrupted continue for ${agentId}` : `${outcome.outcome} ${agentId}: ${outcome.detail}`);
    await record(agentId, removed.provider, outcome);
    return true;
  }

  /** An archived agent's reservation goes with it; a continue already sent is cleared quietly. */
  async function forget(agentId: string): Promise<void> {
    launches.delete(agentId);
    await retire(agentId, (job) => job.state === "pending", canceled("archived", "agent was archived"), { clearOthers: true });
  }

  /**
   * A used-up window, or a stated reset still ahead, moves a due job to when it renews; unverified
   * auth or usage moves it to the next check. False when nothing holds it.
   */
  async function postpone(job: ResumeJob, check: SubscriptionCheck, at: Date): Promise<boolean> {
    const hold = usageHold(check, at);
    const stated = job.resetAt && Date.parse(job.resetAt) > at.getTime() ? new Date(job.resetAt) : null;
    const renewsAt = renewalFor(hold, stated);
    if (hold.kind === "ready" && !renewsAt) return false;
    const waiting = hold.kind === "unverified" ? hold.waiting : "usage";
    await store.update(job.agentId, (current) => current && isSameJob(current, job) && current.enabled
      ? postponed(current, { renewsAt, waiting, identity: check.identity, at }) : undefined);
    return true;
  }

  /**
   * One delivery attempt: the due-time checks of the table in docs/behavior.md, then the claim
   * and the send. Resume now differs where the table says. Only the tick skips or postpones, so
   * each mode gets its own result type.
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
    const gated = async (gate: Exclude<Gate, null>, title: string | null): Promise<Delivery> => {
      // A turn holds the continue without reading usage; the tick tries again after it.
      if (gate === "wait") return { result: "busy" };
      if (gate !== "skip") return cancel({ ...gate, title });
      // Switching it back on just now keeps it; the next tick sends it.
      const removed = await retire(job.agentId, (current) => same(current) && !current.enabled, { outcome: "skipped", detail: "turned off in Auto Resume" });
      return removed ? { result: "skipped" } : { result: "changed" };
    };
    const agent = await loadAgent(api, job.agentId);
    const title = agent && titleOf(agent);
    const gate = agentGate(job, agent, mode);
    if (gate) return gated(gate, title);
    const check = await inspect(api, agent!, source, at, launches.get(job.agentId) ?? job.launch);
    if (check.auth === "api") return cancel({ ...API_ROUTE, title });
    if (job.identity && check.identity && job.identity !== check.identity) {
      return cancel({ ...ACCOUNT_CHANGED, title });
    }
    if (manual) {
      // Only the account's own usage holds a continue the user asked for; the notice may be outdated.
      const hold = usageHold(check, at);
      if (hold.kind === "used_up") return { result: "used_up", until: hold.renews?.toISOString() ?? null };
      if (hold.kind === "unverified") return { result: "unverified", waiting: hold.waiting };
    } else if (await postpone(job, check, at)) {
      return { result: "postponed" };
    }
    // The usage lookup takes seconds, and Paseo's send unarchives an agent, clears its permission
    // requests and replaces a running turn, so the agent is checked again just before the claim.
    const latestAgent = await loadAgent(api, job.agentId);
    const latestGate = agentGate(job, latestAgent, mode);
    if (latestGate) return gated(latestGate, (latestAgent && titleOf(latestAgent)) ?? title);
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
    let won = false as boolean;
    let note: string | undefined;
    const latest = await store.update(job.agentId, (current) => {
      if (!current || !isSameJob(current, job) || (!manual && !current.enabled)) return undefined;
      won = true;
      note = current.note;
      return claimed(current, check.identity);
    });
    if (!won) return staleResult(latest);
    // Read once claimed, so a prompt saved while the agent was being checked is the one sent. A
    // failure here must not leave the claim behind, so it falls back to the built-in prompt.
    const { continuePrompt: custom } = await readResumeSettings().catch(() => DEFAULT_RESUME_SETTINGS);
    try {
      // A turn that starts after the last check is steered, not replaced, where the provider can.
      await api.agents.ref(job.agentId).send(continuePrompt({ custom, note }), { activeTurnBehavior: "steer" });
    } catch (error) {
      await store.update(job.agentId, (current) => (current?.state === "sending" && current.id === job.id ? null : undefined));
      console.error(`[usage-auto-resume] could not continue ${job.agentId}`, String(error));
      await record(job.agentId, job.provider, { outcome: "send_failed", title, trigger });
      return { result: "send_failed" };
    }
    // The sent row stays until the agent's next turn ends, which clears it without a report. The
    // note went with the continue, so the user's text is not kept any longer.
    await store.update(job.agentId, (current) => (current?.state === "sending" && current.id === job.id ? sent(current) : undefined));
    log(`continued ${job.agentId}${manual ? " on request" : ""}`);
    await record(job.agentId, job.provider, { outcome: "continued", title, trigger });
    return { result: "sent" };
  }

  /** Sends the continue now if the agent and its usage allow it, for the reservation and time the screen showed. */
  async function resumeNow(api: ResumerApi, agentId: string, pin: Required<Pin>): Promise<ResumeNowResult> {
    const job = (await store.list()).find((entry) => entry.agentId === agentId) ?? null;
    const state = pinned(job, pin);
    if (!job || state !== "pending") return { result: state === "pending" ? "changed" : state };
    log(`resume now requested for ${agentId}`);
    return deliver(job, api, now(), "manual");
  }

  /**
   * Turning a provider off also retires the reservations it already has: it concerns the agent,
   * so whatever pending reservation is stored when the write happens goes, moved or not.
   */
  async function reconcileProviders(): Promise<void> {
    const settings = await readSettings();
    if (!settings) return;
    for (const job of await store.list()) {
      if (job.state !== "pending" || isProviderOn(job.provider, settings)) continue;
      await retire(job.agentId, (current) => current.state === "pending" && !isProviderOn(current.provider, settings), providerOff(job.provider));
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
          id: job.id,
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

  /** Turns one pending job on or off, for the reservation and time the screen showed. */
  async function setEnabled(agentId: string, pin: Required<Pin>, enabled: boolean): Promise<boolean> {
    let changed = false;
    await store.update(agentId, (current) => {
      if (pinned(current, pin) !== "pending") return undefined;
      changed = true;
      log(`${enabled ? "turned on" : "turned off"} ${agentId}`);
      return switched(current!, enabled);
    });
    return changed;
  }

  /**
   * Turns the jobs the screen showed on or off and counts the ones that flipped. Jobs scheduled
   * after the screen loaded are not in `jobs`, and one being sent is no longer pending.
   */
  async function setAllEnabled(enabled: boolean, jobs: ReadonlyArray<{ agentId: string } & Required<Pin>>): Promise<number> {
    let changed = 0;
    for (const { agentId, ...pin } of jobs) {
      await store.update(agentId, (current) => {
        if (pinned(current, pin) !== "pending" || current!.enabled === enabled) return undefined;
        changed += 1;
        log(`${enabled ? "turned on" : "turned off"} ${agentId}`);
        return switched(current!, enabled);
      });
    }
    return changed;
  }

  /**
   * Saves or, when blank, removes the note sent with one pending job's continue. Its time and
   * switch stay as they are. The note is for the reservation, not its time, so the pin is the
   * reservation alone: one moved since the screen showed it still takes it. The log never has the text.
   */
  async function setNote(agentId: string, pin: { id: string }, note: string): Promise<SetNoteResult> {
    const text = note.trim();
    let result: SetNoteResult = { changed: false, reason: "changed" };
    await store.update(agentId, (current) => {
      const state = pinned(current, { id: pin.id });
      if (state !== "pending") {
        result = { changed: false, reason: state };
        return undefined;
      }
      result = { changed: true };
      log(`note ${text ? "updated" : "removed"} for ${agentId}`);
      return noted(current!, text);
    });
    return result;
  }

  /**
   * Moves one pending job to `newDueAt` and turns it on, like changing an alarm's time, for the
   * reservation and time the screen showed.
   */
  async function reschedule(agentId: string, pin: Required<Pin>, newDueAt: string): Promise<RescheduleResult> {
    let result: RescheduleResult = { changed: false, reason: "changed" };
    const at = now();
    const target = new Date(newDueAt);
    await store.update(agentId, (current) => {
      const state = pinned(current, pin);
      if (state !== "pending") {
        result = { changed: false, reason: state };
        return undefined;
      }
      if (!current) return undefined;
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
      return rescheduled(current, next);
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
