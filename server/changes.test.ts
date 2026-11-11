import assert from "node:assert/strict";
import { test } from "node:test";
import { createChangeFeed } from "./changes";

test("a revision rises on every change and reaches every listener", () => {
  const feed = createChangeFeed();
  assert.equal(feed.revision(), 0);
  const seen: number[] = [];
  const stop = feed.subscribe((revision) => seen.push(revision));
  feed.notify();
  feed.notify();
  assert.equal(feed.revision(), 2);
  assert.deepEqual(seen, [1, 2]);
  stop();
  feed.notify();
  assert.equal(feed.revision(), 3, "the revision keeps rising without listeners");
  assert.deepEqual(seen, [1, 2], "a released listener is not called");
});

test("a listener that throws does not stop the others", () => {
  const feed = createChangeFeed();
  const seen: number[] = [];
  feed.subscribe(() => { throw new Error("boom"); });
  feed.subscribe((revision) => seen.push(revision));
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...line: unknown[]) => { errors.push(line); };
  try {
    feed.notify();
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, [1]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(String(errors[0]![0]), /change listener failed/);
});
