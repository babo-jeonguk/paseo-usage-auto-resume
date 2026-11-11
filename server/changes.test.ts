import assert from "node:assert/strict";
import { test } from "node:test";
import { createChangeFeed, createChangeSubscriptions } from "./changes";

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

test("a change listener is released on abort and the rest on cleanup", () => {
  const feed = createChangeFeed();
  const subscriptions = createChangeSubscriptions(feed);
  const first: number[] = [], second: number[] = [];
  const one = new AbortController(), two = new AbortController();
  subscriptions.listen((revision) => first.push(revision), one.signal);
  subscriptions.listen((revision) => second.push(revision), two.signal);
  feed.notify();
  assert.deepEqual([first, second], [[1], [1]]);

  one.abort();
  one.abort();
  feed.notify();
  assert.deepEqual([first, second], [[1], [1, 2]], "the aborted subscription is released once");

  subscriptions.clear();
  feed.notify();
  assert.deepEqual([first, second], [[1], [1, 2]], "cleanup releases the remaining listener");
  // An abort after cleanup must not touch another subscription's listener.
  two.abort();
  feed.notify();
  assert.deepEqual(second, [1, 2]);
});
