import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ScheduledJobSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  title: z.string().nullable(),
  projectName: z.string().nullable(),
  workspaceName: z.string().nullable(),
  /** Reset instant the continue waits for; null while it is unknown and rechecked. */
  resetAt: z.string().nullable(),
  dueAt: z.string(),
  enabled: z.boolean(),
  /** The continue is being delivered right now. */
  sending: z.boolean(),
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
