/** A continue waits this long past the reset, so the provider has renewed the window. */
export const GRACE_MS = 2 * 60_000;
export const MIN_DELAY_MS = 60_000;
/** A week plus an hour reaches past a weekly reset; a user-chosen time beyond it is a typo. */
export const MAX_AHEAD_MS = 7 * 24 * 3_600_000 + 3_600_000;

/**
 * The times a user may move a job to. Sending before the reset would only hit the limit
 * again, so the earliest is the reset plus grace, and never sooner than a minute from now.
 */
export function rescheduleWindow(resetAt: string | null, now: number): { earliest: number; latest: number } {
  const soonest = now + MIN_DELAY_MS;
  return {
    earliest: resetAt ? Math.max(soonest, Date.parse(resetAt) + GRACE_MS) : soonest,
    latest: now + MAX_AHEAD_MS,
  };
}
