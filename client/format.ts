import type { ScheduledJob } from "../shared/rpc";

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

export function dayLabel(iso: string, now: number): string {
  const days = Math.round((startOfDay(Date.parse(iso)) - startOfDay(now)) / 86_400_000);
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
