import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HistoryEntrySchema, type HistoryEntry } from "../shared/rpc";

/** Results older than this are dropped on every read and write. */
export const HISTORY_WINDOW_MS = 24 * 3_600_000;
/** The oldest results go first once there are more than this. */
export const HISTORY_MAX_ENTRIES = 200;

const FileSchema = z.object({ version: z.literal(1), entries: z.array(HistoryEntrySchema) });

export type HistoryRecord = Omit<HistoryEntry, "id" | "at">;

export function defaultHistoryPath(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugin-data", "usage-auto-resume", "history.json");
}

/**
 * How recent reservations ended, kept apart from jobs.json so a failed write here never
 * affects a resume. Entries are stored oldest first.
 */
export function createHistoryStore(options: { path?: string; now?: () => Date } = {}): {
  list(): Promise<HistoryEntry[]>;
  append(record: HistoryRecord): Promise<void>;
} {
  const path = options.path ?? defaultHistoryPath();
  const now = options.now ?? (() => new Date());
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };

  const recent = (entries: HistoryEntry[]) => {
    const since = now().getTime() - HISTORY_WINDOW_MS;
    return entries.filter((entry) => Date.parse(entry.at) >= since).slice(-HISTORY_MAX_ENTRIES);
  };

  async function read(): Promise<HistoryEntry[]> {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (parsed.success) return recent(parsed.data.entries);
      console.error("[usage-auto-resume] history file failed validation; starting empty");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[usage-auto-resume] could not read history file; starting empty", String(error));
      }
    }
    return [];
  }

  async function write(entries: HistoryEntry[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, entries }, null, 2), "utf8");
    await rename(temp, path);
  }

  return {
    /** Newest first. */
    list: () => serialize(async () => (await read()).reverse()),
    append: (record: HistoryRecord) =>
      serialize(async () => {
        const entry: HistoryEntry = { id: randomUUID(), at: now().toISOString(), ...record };
        await write(recent([...(await read()), entry]));
      }),
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
