/** One usage window of an account or model, as a subscription check reads it. */
export interface QuotaWindow { id: string; usedPct: number; resetAt: string | null }

/** Whether a window is used up. Every provider's readiness and renewal use this one rule. */
export const isExhausted = (window: QuotaWindow): boolean => window.usedPct >= 100;
