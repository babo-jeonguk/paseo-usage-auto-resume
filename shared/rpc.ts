import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ScheduledJobSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  /** Composer placement; optional for older server responses, null when unavailable. */
  workspaceId: z.string().nullable().optional(),
  title: z.string().nullable(),
  projectName: z.string().nullable(),
  workspaceName: z.string().nullable(),
  /** Reset instant the continue waits for; null while it is unknown and rechecked. */
  resetAt: z.string().nullable(),
  dueAt: z.string(),
  enabled: z.boolean(),
  /** The continue is being delivered right now. */
  sending: z.boolean(),
  /** This row's time is a status check, not a promised continue. */
  waiting: z.enum(["auth", "usage"]).optional(),
});

export type ScheduledJob = z.infer<typeof ScheduledJobSchema>;

export const listScheduledRpc = defineRpc({
  name: "auto-resume.list",
  input: z.object({}),
  output: z.object({ jobs: z.array(ScheduledJobSchema) }),
});

export const setEnabledRpc = defineRpc({
  name: "auto-resume.set-enabled",
  input: z.object({ agentId: z.string(), dueAt: z.string(), enabled: z.boolean() }),
  /** False when the job already ran, was canceled, or was rescheduled since it was shown. */
  output: z.object({ changed: z.boolean() }),
});

export const RescheduleResultSchema = z.discriminatedUnion("changed", [
  z.object({ changed: z.literal(true), dueAt: z.string() }),
  z.object({
    changed: z.literal(false),
    /**
     * `changed`: the job already ran, was canceled, or moved since it was shown.
     * `sending`: the continue is being delivered. `too-early`: before `earliest` (the limit
     * reset plus grace, or a minute from now). `too-late`: more than a week out.
     */
    reason: z.enum(["changed", "sending", "too-early", "too-late"]),
    earliest: z.string().optional(),
  }),
]);

export type RescheduleResult = z.infer<typeof RescheduleResultSchema>;

export const rescheduleRpc = defineRpc({
  name: "auto-resume.reschedule",
  /** `dueAt` is the time the screen showed; `newDueAt` replaces it. */
  input: z.object({ agentId: z.string(), dueAt: z.string(), newDueAt: z.iso.datetime() }),
  output: RescheduleResultSchema,
});

export const setAllEnabledRpc = defineRpc({
  name: "auto-resume.set-all-enabled",
  /** The rows the screen showed; jobs scheduled since, or being sent, are left alone. */
  input: z.object({ enabled: z.boolean(), jobs: z.array(z.object({ agentId: z.string(), dueAt: z.string() })) }),
  /** How many jobs flipped. */
  output: z.object({ changed: z.number().int().nonnegative() }),
});

/** How a reservation ended; only final results, never time changes or toggles. */
export const HistoryOutcomeSchema = z.enum([
  /** The continue prompt was sent. */
  "continued",
  /** Sending the continue threw. */
  "send_failed",
  /** The reservation was turned off when its time came. */
  "skipped",
  /** A safety check, agent activity or a setting removed it. */
  "canceled",
  /** The retry bound was reached. */
  "gave_up",
  /** A restart found it mid-send and dropped it. */
  "interrupted",
]);

export type HistoryOutcome = z.infer<typeof HistoryOutcomeSchema>;

export const HistoryReasonSchema = z.enum([
  // canceled
  "turn_started", "new_message", "turn_finished", "agent_missing", "archived",
  "provider_changed", "model_changed", "agent_busy", "permission",
  "account_changed", "api_route", "provider_off", "unsupported_cli",
  // gave_up
  "attempts", "retries",
]);

export type HistoryReason = z.infer<typeof HistoryReasonSchema>;

export const HistoryEntrySchema = z.object({
  id: z.string(),
  /** When the result was recorded. */
  at: z.string(),
  agentId: z.string(),
  provider: z.string(),
  outcome: HistoryOutcomeSchema,
  reason: HistoryReasonSchema.optional(),
  /** The log's wording, e.g. "provider changed to codex-sub"; the screen words it from `reason`. */
  detail: z.string().optional(),
  /** The conversation title when recorded, so a deleted agent still has a name. */
  title: z.string().nullable(),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const HistoryRowSchema = HistoryEntrySchema.extend({
  /** The live agent's workspace for opening it; null once the agent is gone. */
  workspaceId: z.string().nullable(),
});

export type HistoryRow = z.infer<typeof HistoryRowSchema>;

export const listHistoryRpc = defineRpc({
  name: "auto-resume.history",
  input: z.object({}),
  /** Newest first. */
  output: z.object({ entries: z.array(HistoryRowSchema) }),
});

export const DiscoveredProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  cli: z.enum(["claude", "codex", "antigravity"]),
  /** False when the provider is turned off in Paseo itself, so it starts no agents. */
  paseoEnabled: z.boolean(),
  /** Email the CLI signs in as; null for Antigravity or when it cannot be read. */
  account: z.string().nullable(),
});

export type DiscoveredProvider = z.infer<typeof DiscoveredProviderSchema>;

export const listProvidersRpc = defineRpc({
  name: "auto-resume.providers",
  input: z.object({}),
  output: z.object({ providers: z.array(DiscoveredProviderSchema) }),
});
