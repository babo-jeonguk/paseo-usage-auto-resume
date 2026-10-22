import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createHistoryStore, HISTORY_MAX_ENTRIES, HISTORY_WINDOW_MS, type HistoryRecord } from "./history";

const HOUR = 3_600_000;

let dir: string;
let path: string;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usage-auto-resume-history-"));
  path = join(dir, "history.json");
  clock = new Date("2026-10-06T03:00:00.000Z");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (agentId: string, overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
  agentId,
  provider: "codex",
  outcome: "continued",
  title: null,
  ...overrides,
});

const open = () => createHistoryStore({ path, now: () => clock });

test("results are listed newest first with an ID and the time they were recorded", async () => {
  const history = open();
  await history.append(entry("a1"));
  clock = new Date(clock.getTime() + 60_000);
  await history.append(entry("a2", { outcome: "canceled", reason: "new_message", detail: "a newer message reached the agent", title: "Fix login" }));

  const [newest, oldest] = await history.list();
  assert.equal(newest?.agentId, "a2");
  assert.equal(newest?.at, "2026-10-06T03:01:00.000Z");
  assert.equal(newest?.reason, "new_message");
  assert.equal(newest?.title, "Fix login");
  assert.equal(oldest?.agentId, "a1");
  assert.notEqual(newest?.id, oldest?.id);
  assert.deepEqual((await open().list()).map((row) => row.agentId), ["a2", "a1"], "survives a restart");
});

test("results older than 24 hours are dropped", async () => {
  const history = open();
  await history.append(entry("old"));
  clock = new Date(clock.getTime() + 2 * HOUR);
  await history.append(entry("recent"));

  clock = new Date(Date.parse("2026-10-06T03:00:00.000Z") + HISTORY_WINDOW_MS);
  assert.deepEqual((await history.list()).map((row) => row.agentId), ["recent", "old"], "exactly 24 hours is kept");
  clock = new Date(clock.getTime() + 1);
  assert.deepEqual((await history.list()).map((row) => row.agentId), ["recent"]);

  await history.append(entry("new"));
  const saved = JSON.parse(await readFile(path, "utf8")) as { entries: Array<{ agentId: string }> };
  assert.deepEqual(saved.entries.map((row) => row.agentId), ["recent", "new"], "a write also drops expired results");
});

test("past the cap, the oldest results go first", async () => {
  const history = open();
  for (let index = 0; index < HISTORY_MAX_ENTRIES + 5; index += 1) {
    await history.append(entry(`a${index}`));
  }
  const rows = await history.list();
  assert.equal(rows.length, HISTORY_MAX_ENTRIES);
  assert.equal(rows[0]?.agentId, `a${HISTORY_MAX_ENTRIES + 4}`);
  assert.equal(rows.at(-1)?.agentId, "a5");
});

test("an unreadable or invalid file starts empty and is replaced by the next result", async () => {
  for (const contents of ["{ not json", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ agentId: "a1" }] })]) {
    await writeFile(path, contents);
    const history = open();
    assert.deepEqual(await history.list(), [], contents);
    await history.append(entry("a2"));
    assert.deepEqual((await history.list()).map((row) => row.agentId), ["a2"], contents);
  }
});

test("results appended at the same time are all kept", async () => {
  const history = open();
  await Promise.all(Array.from({ length: 20 }, (_, index) => history.append(entry(`a${index}`))));
  assert.equal((await history.list()).length, 20);
});
