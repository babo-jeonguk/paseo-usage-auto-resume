import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { NOTE_MAX_CHARS } from "../shared/prompt";

const JobSchema = z.object({
  /**
   * Names one reservation for its whole life: kept when it is moved, switched, noted or planned
   * again, new when a reservation replaces it. Rows saved before it existed get one on reading.
   */
  id: z.string().optional(),
  agentId: z.string(),
  provider: z.string(),
  /** Reset instant (minute precision) the job waits for; null while it is unknown. */
  resetAt: z.string().nullable(),
  dueAt: z.string(),
  /** The agent's `lastUserMessageAt` when its limited turn ended; any later message cancels. */
  baseline: z.string().nullable(),
  /** Consecutive automatic continues that hit a limit again. */
  attempts: z.number().int().nonnegative(),
  state: z.enum(["pending", "sending", "sent"]),
  /** Unchecked in the Auto Resume screen: the due time passes without a continue. */
  enabled: z.boolean().default(true),
  /** Continues sent in a row while the agent's usage windows were not used up. */
  retries: z.number().int().nonnegative().default(0),
  // Earlier versions waited for "credits" recovery; those jobs now wait on their usage windows.
  waiting: z.enum(["auth", "usage"]).optional().catch((context) => context.value === "credits" ? "usage" : undefined),
  identity: z.string().optional(),
  /** Pin the selected model even when account verification is initially unavailable. */
  model: z.string().optional(),
  launch: z.object({ env: z.record(z.string(), z.string()), authEnv: z.record(z.string(), z.boolean()) }).optional(),
  /**
   * The user's extra instruction for this continue; sent once, then dropped. A damaged one is
   * dropped alone, so it never costs the file its reservations.
   */
  note: z.string().max(NOTE_MAX_CHARS).optional().catch(undefined),
  /** The user chose `dueAt`; a new plan for the reservation keeps it while it is later. */
  userChosenTime: z.literal(true).optional().catch(undefined),
});

export type ResumeJob = z.infer<typeof JobSchema>;

const FileSchema = z.object({ version: z.literal(1), jobs: z.array(JobSchema) });

export function defaultStorePath(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugin-data", "usage-auto-resume", "jobs.json");
}

/** One job per agent, persisted so a daemon or plugin restart keeps the schedule. */
export function createJobStore(path = defaultStorePath()) {
  // Hooks and the tick share one process; a promise chain serializes read-modify-write.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };

  async function read(): Promise<ResumeJob[]> {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      // Stable until the first write stores it: only a write can change `dueAt`.
      if (parsed.success) return parsed.data.jobs.map((job) => (job.id ? job : { ...job, id: `${job.agentId}@${job.dueAt}` }));
      console.error("[usage-auto-resume] job file failed validation; starting empty");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[usage-auto-resume] could not read job file; starting empty", String(error));
      }
    }
    return [];
  }

  async function write(jobs: ResumeJob[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, jobs }, null, 2), "utf8");
    await rename(temp, path);
  }

  return {
    list: () => serialize(read),
    /** Applies `change` to the agent's job: a job replaces it, null removes it, undefined keeps it. */
    update: (agentId: string, change: (current: ResumeJob | null) => ResumeJob | null | undefined) =>
      serialize(async () => {
        const jobs = await read();
        const index = jobs.findIndex((job) => job.agentId === agentId);
        const current = index === -1 ? null : jobs[index]!;
        const next = change(current);
        if (next === undefined || (next === null && current === null)) return next ?? current;
        const rest = jobs.filter((job) => job.agentId !== agentId);
        await write(next ? [...rest, next] : rest);
        return next;
      }),
  };
}

export type JobStore = ReturnType<typeof createJobStore>;
