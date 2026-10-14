import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";

// Reset-time parsing follows panrafal/paseo-plugins chat-resume (shared/usage.ts, MIT) and
// keefeere/paseo-continuity (server/classify.ts, MIT); detection is narrowed to limits that renew.

/** Phrases providers use when a subscription usage window or rate limit stopped the turn. */
const LIMIT_PATTERNS = [
  /you(?:'|’)?ve (?:hit|reached) your (?:usage |session |weekly |daily |5-hour |five-hour )?limit/i,
  /(?:usage|session|5-hour|five-hour|weekly|rate) limit (?:has been )?(?:reached|exceeded|hit)/i,
  /usage_limit_(?:reached|exceeded)/i,
  /rate_limit_(?:exceeded|error)/i,
  /quota (?:has been )?(?:reached|exceeded|exhausted)/i,
  /resource[_ ]exhausted/i,
  /too many requests/i,
];

/** Context overflow and billing stops never renew on a clock, so they are not usage limits. */
const NOT_A_LIMIT = [
  /context[ _-](?:length|window)/i,
  /(?:prompt|input) is too long/i,
  /maximum context/i,
  /too many (?:input )?tokens/i,
  /insufficient[_ ]quota|credit balance|billing/i,
];

/** Provider notices are short. Longer text that merely mentions a limit is ordinary output. */
const NOTICE_MAX_CHARS = 800;

/** Explicit renewable-limit codes; a generic HTTP 429 can also mean a billing stop. */
const LIMIT_CODES = new Set([
  "rate_limit", "rate_limit_exceeded", "rate_limit_error", "usage_limit_reached", "usage_limit_exceeded",
]);

export interface LimitStop {
  /** Reset instant stated by the provider, or null when the notice has none. */
  resetAt: Date | null;
}

export function isLimitNotice(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > NOTICE_MAX_CHARS) return false;
  if (NOT_A_LIMIT.some((pattern) => pattern.test(trimmed))) return false;
  return LIMIT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Items after the latest user message: the turn that just ended. */
function latestTurn(timeline: readonly AgentTimelineItem[]): readonly AgentTimelineItem[] {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.type === "user_message") return timeline.slice(index + 1);
  }
  return timeline;
}

/**
 * Only the final assistant message can be the closing notice. Join chunks when their
 * non-empty message IDs agree, never a separate answer and Claude's synthetic notice.
 * Without IDs there is no evidence that adjacent items belong to the same message.
 */
function closingAssistantText(turn: readonly AgentTimelineItem[]): string {
  const last = turn[turn.length - 1];
  if (last?.type !== "assistant_message") return "";
  let text = last.text;
  if (!last.messageId) return text;
  for (let index = turn.length - 2; index >= 0; index -= 1) {
    const item = turn[index];
    if (item?.type !== "assistant_message" || item.messageId !== last.messageId) break;
    text = item.text + text;
  }
  return text;
}

/** Texts that can carry a limit notice for this turn, most authoritative first. */
function notices(outcome: PluginTurnOutcome, timeline: readonly AgentTimelineItem[]): string[] {
  const texts: string[] = [];
  if (outcome.kind === "failed") texts.push(outcome.error.message);
  const turn = latestTurn(timeline);
  for (const item of turn) {
    if (item.type === "error") texts.push(item.message);
    else if (item.type === "notification" && item.level !== "info") texts.push(item.message);
  }
  texts.push(closingAssistantText(turn));
  return texts;
}

/** Detects a turn stopped by a usage/rate limit. Canceled turns and ordinary failures are null. */
export function detectLimitStop(
  outcome: PluginTurnOutcome,
  timeline: readonly AgentTimelineItem[],
  observedAt: Date,
): LimitStop | null {
  if (outcome.kind === "canceled") return null;
  if (outcome.kind === "failed" && LIMIT_CODES.has(outcome.error.code?.toLowerCase() ?? "")) {
    // Provider codes are more authoritative than wording or notice length. Billing and
    // context errors still take precedence over generic provider rate-limit classification.
    if (NOT_A_LIMIT.some((pattern) => pattern.test(outcome.error.message))) return null;
    return { resetAt: parseResetAt(outcome.error.message, observedAt) };
  }
  const matched = notices(outcome, timeline).filter(isLimitNotice);
  if (matched.length === 0) return null;
  for (const text of matched) {
    const resetAt = parseResetAt(text, observedAt);
    if (resetAt) return { resetAt };
  }
  return { resetAt: null };
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
};

const UNIT = "(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smh])";

/** Extracts the renewal instant from a limit notice. */
export function parseResetAt(text: string, observedAt: Date): Date | null {
  return epochResetAt(text) ?? relativeResetAt(text, observedAt) ?? absoluteResetAt(text, observedAt);
}

/** Claude's legacy `Claude AI usage limit reached|1759300000`. */
function epochResetAt(text: string): Date | null {
  const epoch = /\|(\d{10,13})\b/.exec(text);
  if (!epoch) return null;
  const value = Number(epoch[1]);
  return new Date(value < 1e12 ? value * 1_000 : value);
}

function relativeResetAt(text: string, observedAt: Date): Date | null {
  const marker = /(?:try again|resets?|retry|available again|renews?)\s+(?:in|after)\s+/i.exec(text);
  if (!marker) return null;
  // Only the duration right after the marker ("2 hours 13 minutes", "6h53m44s"); later digits,
  // such as a request ID, are not part of it.
  const duration = new RegExp(`^(?:\\s*(?:,|and)?\\s*\\d+(?:\\.\\d+)?\\s*${UNIT}(?![a-z]))+`, "i").exec(
    text.slice(marker.index + marker[0].length),
  );
  if (!duration) return null;
  const units = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}`, "gi");
  let totalMs = 0;
  for (let match = units.exec(duration[0]); match; match = units.exec(duration[0])) {
    totalMs += Number(match[1]) * (UNIT_MS[match[2]!.toLowerCase()] ?? 0);
  }
  return totalMs > 0 ? new Date(observedAt.getTime() + totalMs) : null;
}

function absoluteResetAt(text: string, observedAt: Date): Date | null {
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})\b/i.exec(text);
  if (iso) {
    const parsed = new Date(iso[0]);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const clock = clockResetAt(text, observedAt);
  if (clock) return clock;
  // Codex weekly: "try again at Oct 9th, 2026 4:13 AM". Date.parse rejects ordinal suffixes.
  const dated = /(?:resets?|renews?|try again|available again)(?:\s+(?:at|on|after))?\s+([^\n.(]{4,80})/i.exec(text);
  if (dated) {
    const parsedMs = Date.parse(dated[1]!.trim().replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1"));
    if (!Number.isNaN(parsedMs) && parsedMs > observedAt.getTime()) return new Date(parsedMs);
  }
  return null;
}

/** "resets 3pm (Asia/Seoul)", "try again at 6:03 AM": the next such wall-clock time. */
function clockResetAt(text: string, observedAt: Date): Date | null {
  const clock =
    /(?:resets?|renews?|try again|available again)(?:\s+(?:at|after|until))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!clock) return null;
  let hour = Number(clock[1]) % 12;
  if (clock[3]!.toLowerCase() === "pm") hour += 12;
  const minute = Number(clock[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  const timeZone = clock[4]?.trim();
  if (timeZone && isValidTimeZone(timeZone)) return nextClockInTimeZone(observedAt, hour, minute, timeZone);
  const candidate = new Date(observedAt);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= observedAt.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function partsInTimeZone(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return parts;
}

function zonedDate(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMs = (date: Date) => {
    const parts = partsInTimeZone(date, timeZone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
  };
  const corrected = utcGuess - offsetMs(new Date(utcGuess));
  return new Date(utcGuess - offsetMs(new Date(corrected)));
}

function nextClockInTimeZone(observedAt: Date, hour: number, minute: number, timeZone: string): Date {
  const today = partsInTimeZone(observedAt, timeZone);
  const candidate = zonedDate(timeZone, today.year, today.month, today.day, hour, minute);
  if (candidate.getTime() > observedAt.getTime()) return candidate;
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1, 12));
  return zonedDate(
    timeZone,
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute,
  );
}
