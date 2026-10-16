import type { RescheduleResult, ScheduledJob } from "../shared/rpc";
import { rescheduleWindow } from "../shared/schedule";

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
  const title = on.length === 1 ? "1 agent will continue" : `${on.length} agents will continue`;
  const next = `Next at ${clockLabel(on[0]!.dueAt)}`;
  return { title, detail: [next, skippedLabel].filter(Boolean).join(" · ") };
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

export function refusalLabel(job: ScheduledJob, result: Extract<RescheduleResult, { changed: false }>): string {
  switch (result.reason) {
    case "too-early":
      return tooEarlyLabel(job, result.earliest ? Date.parse(result.earliest) : Date.now());
    case "too-late":
      return TOO_LATE;
    case "sending":
      return "This agent is continuing now.";
    case "changed":
      return "This schedule already ran or changed.";
  }
}

/** The one bulk button: turns everything off while anything not already sending is on. */
export function bulkAction(jobs: readonly ScheduledJob[]): { enabled: boolean; label: string; shortLabel: string } {
  const anyOn = jobs.some((job) => job.enabled && !job.sending);
  return anyOn
    ? { enabled: false, label: "Turn all off", shortLabel: "All off" }
    : { enabled: true, label: "Turn all on", shortLabel: "All on" };
}
