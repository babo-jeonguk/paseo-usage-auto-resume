import type { DiscoveredProvider, HistoryEntry, HistoryOutcome, HistoryReason, RescheduleResult, ResumeNowResult, ScheduledJob } from "../shared/rpc";
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, rescheduleWindow } from "../shared/schedule";

const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  "claude-main": "Claude Main",
  antigravity: "Antigravity",
  "antigravity-main": "Antigravity Main",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** The CLI's own provider first, then the ones built on it by name. */
export function sortProviders(providers: readonly DiscoveredProvider[]): DiscoveredProvider[] {
  const rank = (provider: DiscoveredProvider) => (provider.id === provider.cli ? 0 : 1);
  return [...providers].sort((left, right) => rank(left) - rank(right) || left.label.localeCompare(right.label));
}

/** ID, the account it signs in as, and what is waiting on it, for a provider's switch. */
export function providerHint(provider: DiscoveredProvider, pending: number): string {
  return [
    provider.id,
    provider.account,
    pending ? `${pending} pending reservation${pending === 1 ? "" : "s"}` : null,
    provider.paseoEnabled ? null : "off in Paseo",
  ]
    .filter(Boolean)
    .join(" · ");
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 24-hour wall clock in the device's time zone, like an alarm list. */
export function clockLabel(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function relativeLabel(iso: string, now: number): string {
  const minutes = Math.ceil((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar days from today to `iso`; 0 is today. */
export function dayOffset(iso: string, now: number): number {
  return Math.round((startOfDay(Date.parse(iso)) - startOfDay(now)) / 86_400_000);
}

export function dayLabel(iso: string, now: number): string {
  const days = dayOffset(iso, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export interface DayGroup {
  label: string;
  jobs: ScheduledJob[];
}

/** Jobs are already sorted by due time; consecutive days become sections. */
export function groupByDay(jobs: readonly ScheduledJob[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const job of jobs) {
    const label = dayLabel(job.dueAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.jobs.push(job);
    else groups.push({ label, jobs: [job] });
  }
  return groups;
}

/** Headline and detail for the list, e.g. "2 agents will continue" / "Next at 18:53 · 1 skipped". */
export function summaryLabels(jobs: readonly ScheduledJob[]): { title: string; detail: string | null } {
  const on = jobs.filter((job) => job.enabled);
  const skipped = jobs.length - on.length;
  const skippedLabel = skipped > 0 ? `${skipped} skipped` : null;
  if (on.length === 0) return { title: "All turned off", detail: null };
  const scheduled = on.filter((job) => !job.waiting);
  const waiting = on.length - scheduled.length;
  const title = scheduled.length ? (scheduled.length === 1 ? "1 agent will continue" : `${scheduled.length} agents will continue`)
    : `${waiting} agent${waiting === 1 ? "" : "s"} waiting for verification`;
  const next = scheduled.length ? `Next at ${clockLabel(scheduled[0]!.dueAt)}` : `Next check at ${clockLabel(on[0]!.dueAt)}`;
  return { title, detail: [next, scheduled.length && waiting ? `${waiting} waiting` : null, skippedLabel].filter(Boolean).join(" · ") };
}

export function waitingLabel(job: ScheduledJob): string | null {
  switch (job.waiting) {
    case "auth": return "Waiting for account verification";
    case "usage": return "Waiting for usage verification";
    default: return null;
  }
}

const weekdayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short" });

/** Fits Paseo's narrow pill; the popover shows the full day and time. */
export function composerLabel(job: ScheduledJob, now: number): string {
  if (job.sending) return "Resuming…";
  if (!job.enabled) return "Resume off";
  const time = clockLabel(job.dueAt);
  if (job.waiting) return `Check ${time}`;
  const offset = dayOffset(job.dueAt, now);
  const day = offset === 1 ? "Tmr" : offset > 1 ? weekdayLabel(job.dueAt) : "Resume";
  return `${day} ${time}`;
}

/** Where the agent lives: "Project · workspace", without repeating a name. */
export function placeLabel(job: ScheduledJob): string | null {
  const parts = [job.projectName, job.workspaceName].filter((part): part is string => !!part);
  return [...new Set(parts)].join(" · ") || null;
}

export interface DayChoice {
  offset: number;
  label: string;
}

/** Today and Tomorrow, plus the job's own day when a weekly reset put it further out. */
export function dayChoices(dueAt: string, now: number): DayChoice[] {
  const choices = [
    { offset: 0, label: "Today" },
    { offset: 1, label: "Tomorrow" },
  ];
  const own = dayOffset(dueAt, now);
  return own > 1 ? [...choices, { offset: own, label: dayLabel(dueAt, now) }] : choices;
}

/** "07:30", "7:30" or "0730" on the day `offset` days from today, local time; null if unreadable. */
export function timeOnDay(text: string, offset: number, now: number): string | null {
  const match = /^\s*(\d{1,2}):?(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

const ceilMinute = (time: number) => Math.ceil(time / 60_000) * 60_000;

function tooEarlyLabel(job: ScheduledJob, earliest: number): string {
  const at = clockLabel(new Date(ceilMinute(earliest)).toISOString());
  return job.resetAt ? `Too early — the limit resets at ${clockLabel(job.resetAt)}. Earliest is ${at}.` : `Too early — earliest is ${at}.`;
}

const TOO_LATE = "Pick a time within 7 days.";

/** Why the server would refuse `dueAt`, checked before sending; null when it is allowed. */
export function rescheduleProblem(job: ScheduledJob, dueAt: string, now: number): string | null {
  const { earliest, latest } = rescheduleWindow(job.resetAt, now);
  const target = Date.parse(dueAt);
  if (target < earliest) return tooEarlyLabel(job, earliest);
  if (target > latest) return TOO_LATE;
  return null;
}

const SENDING = "This agent is continuing now.";
const CHANGED = "This schedule already ran or changed.";

export function refusalLabel(job: ScheduledJob, result: Extract<RescheduleResult, { changed: false }>): string {
  switch (result.reason) {
    case "too-early":
      return tooEarlyLabel(job, result.earliest ? Date.parse(result.earliest) : Date.now());
    case "too-late":
      return TOO_LATE;
    case "sending":
      return SENDING;
    case "changed":
      return CHANGED;
  }
}

/** Delays from the reservation's own time, not from now; the sidebar row offers only the first. */
export const DELAY_PRESETS = [
  { label: "+10m", spoken: "Delay 10 minutes", ms: 10 * 60_000 },
  { label: "+30m", spoken: "Delay 30 minutes", ms: 30 * 60_000 },
  { label: "+1h", spoken: "Delay 1 hour", ms: 60 * 60_000 },
] as const;

export interface DelayChoice {
  label: string;
  spoken: string;
  dueAt: string;
  /** Why the server would refuse it, or null when it can be offered. */
  problem: string | null;
}

export function delayChoices(job: ScheduledJob, now: number): DelayChoice[] {
  return DELAY_PRESETS.map(({ label, spoken, ms }) => {
    const dueAt = new Date(Date.parse(job.dueAt) + ms).toISOString();
    return { label, spoken, dueAt, problem: rescheduleProblem(job, dueAt, now) };
  });
}

const CANCEL_REASONS: Partial<Record<HistoryReason, string>> = {
  turn_started: "turn started",
  new_message: "a newer message",
  turn_finished: "turn finished",
  agent_missing: "agent not found",
  archived: "agent archived",
  provider_changed: "provider changed",
  model_changed: "model changed",
  agent_busy: "agent was busy",
  permission: "waiting for permission",
  account_changed: "account changed",
  api_route: "API billing route",
  provider_off: "provider turned off",
  unsupported_cli: "unsupported CLI",
};

/** One line for how a reservation ended, e.g. "Canceled · a newer message", naming Resume now when it started it. */
export function historyLabel(entry: Pick<HistoryEntry, "outcome" | "reason" | "trigger">): string {
  const label = outcomeLabel(entry);
  return entry.trigger === "manual" ? `${label} · Resume now` : label;
}

function outcomeLabel(entry: Pick<HistoryEntry, "outcome" | "reason">): string {
  switch (entry.outcome) {
    case "continued":
      return "Continued";
    case "send_failed":
      return "Couldn’t send the continue";
    case "skipped":
      return "Skipped · turned off";
    case "interrupted":
      return "Dropped · interrupted by a restart";
    case "gave_up":
      if (entry.reason === "attempts") return `Gave up · limit hit ${MAX_ATTEMPTS} times in a row`;
      if (entry.reason === "retries") return `Gave up · stopped again after ${RETRY_DELAYS_MS.length} retries`;
      return "Gave up";
    case "canceled": {
      const why = entry.reason && CANCEL_REASONS[entry.reason];
      return why ? `Canceled · ${why}` : "Canceled";
    }
  }
}

/** When Resume now got no result at all: the daemon may still have finished, and sent. */
export const RESUME_NOW_UNFINISHED = "Resume now didn’t finish. Refresh to see whether the continue was sent.";

/**
 * The toast's color: a block or a removed reservation warns, a result the user already has or a
 * stale screen informs, and only a send that failed or settings that could not be read are errors.
 */
export function resumeNowTone(result: ResumeNowResult): "success" | "info" | "warning" | "error" {
  switch (result.result) {
    case "sent":
      return "success";
    case "sending":
    case "changed":
      return "info";
    case "held":
    case "canceled":
      return "warning";
    case "send_failed":
    case "unavailable":
      return "error";
  }
}

/** The toast after Resume now. */
export function resumeNowLabel(result: ResumeNowResult, now: number): string {
  switch (result.result) {
    case "sent":
      return "Continue sent";
    case "held":
      if (result.waiting === "auth") return "Couldn’t verify the account. Check the CLI login.";
      if (result.waiting === "usage") return "Couldn’t verify usage. Try again shortly.";
      if (!result.until) return "Usage is still used up";
      return `Usage is still used up until ${dayOffset(result.until, now) === 0 ? "" : `${weekdayLabel(result.until)} `}${clockLabel(result.until)}`;
    case "canceled":
      return outcomeLabel({ outcome: "canceled", reason: result.reason });
    case "send_failed":
      return outcomeLabel({ outcome: "send_failed" });
    case "sending":
      return SENDING;
    case "changed":
      return CHANGED;
    case "unavailable":
      return "Auto Resume settings couldn’t be read.";
  }
}

const SUMMARY_WORDS: Array<[HistoryOutcome, string]> = [
  ["continued", "continued"],
  ["canceled", "canceled"],
  ["skipped", "skipped"],
  ["gave_up", "gave up"],
  ["send_failed", "failed"],
  ["interrupted", "dropped"],
];

/** Counts for the collapsed header, e.g. "2 continued · 1 canceled". */
export function historySummary(entries: ReadonlyArray<Pick<HistoryEntry, "outcome">>): string {
  return SUMMARY_WORDS.map(([outcome, word]) => {
    const count = entries.filter((entry) => entry.outcome === outcome).length;
    return count ? `${count} ${word}` : null;
  })
    .filter(Boolean)
    .join(" · ");
}

/** The date under every result's time, e.g. "Oct 22", since the list spans two days. */
export function historyDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The one bulk button: turns everything off while anything not already sending is on. */
export function bulkAction(jobs: readonly ScheduledJob[]): { enabled: boolean; label: string; shortLabel: string } {
  const anyOn = jobs.some((job) => job.enabled && !job.sending);
  return anyOn
    ? { enabled: false, label: "Turn all off", shortLabel: "All off" }
    : { enabled: true, label: "Turn all on", shortLabel: "All on" };
}
