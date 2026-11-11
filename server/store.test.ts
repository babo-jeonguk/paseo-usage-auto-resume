import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createJobStore } from "./store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usage-auto-resume-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const row = (agentId: string) => ({
  agentId,
  provider: "codex",
  resetAt: null,
  dueAt: "2026-10-06T05:02:00.000Z",
  baseline: null,
  attempts: 0,
  state: "pending" as const,
  enabled: true,
  retries: 0,
});

test("a write announces a change and a no-op update does not", async () => {
  let changes = 0;
  const store = createJobStore(join(dir, "jobs.json"), () => { changes += 1; });

  // Removing a row that is not there writes nothing.
  await store.update("a1", () => null);
  assert.equal(changes, 0);
  // Keeping the row as it is writes nothing either.
  await store.update("a1", () => undefined);
  assert.equal(changes, 0);

  await store.update("a1", () => row("a1"));
  assert.equal(changes, 1);
  await store.update("a1", () => undefined);
  assert.equal(changes, 1);

  await store.update("a1", () => null);
  assert.equal(changes, 2);
});
