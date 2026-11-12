import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_AHEAD_MS, overloadDue, OVERLOAD_DELAYS_MS, rescheduleWindow, wholeMinuteAtOrAfter } from "./schedule";

test("capacity jitter bounds each stage around its own failure time", () => {
  const at = new Date("2026-10-30T00:00:00.000Z");
  for (const step of [1, 2, 3] as const) {
    for (const random of [0, 0.5, 1]) {
      assert.equal(Date.parse(overloadDue(at, step, () => random)) - at.getTime(), Math.round(OVERLOAD_DELAYS_MS[step - 1]! * (0.8 + 0.4 * random)));
    }
  }
});

test("the reschedule window's earliest editable minute is the first whole minute at or after its earliest instant", () => {
  const now = Date.parse("2026-10-06T05:00:00.000Z");
  // A reset with seconds: reset + 2 minutes is 05:07:27, so the first minute a user can type is 05:08.
  assert.deepEqual(rescheduleWindow("2026-10-06T05:05:27.000Z", now), {
    earliest: Date.parse("2026-10-06T05:07:27.000Z"),
    earliestMinute: Date.parse("2026-10-06T05:08:00.000Z"),
    latest: now + MAX_AHEAD_MS,
  });
  // A whole-minute earliest is its own first editable minute.
  assert.equal(rescheduleWindow("2026-10-06T05:05:00.000Z", now).earliestMinute, Date.parse("2026-10-06T05:07:00.000Z"));
  // No known reset: one minute from now, rounded up.
  const later = Date.parse("2026-10-06T03:00:30.000Z");
  assert.deepEqual(rescheduleWindow(null, later), {
    earliest: Date.parse("2026-10-06T03:01:30.000Z"),
    earliestMinute: Date.parse("2026-10-06T03:02:00.000Z"),
    latest: Date.parse("2026-10-13T04:00:30.000Z"),
  });
  // A reset already past: one minute from now still wins.
  assert.equal(rescheduleWindow("2026-10-06T04:00:00.000Z", now).earliest, Date.parse("2026-10-06T05:01:00.000Z"));
});

test("whole minutes round up only when they carry seconds", () => {
  assert.equal(wholeMinuteAtOrAfter(Date.parse("2026-10-06T05:07:00.000Z")), Date.parse("2026-10-06T05:07:00.000Z"));
  assert.equal(wholeMinuteAtOrAfter(Date.parse("2026-10-06T05:07:00.001Z")), Date.parse("2026-10-06T05:08:00.000Z"));
  assert.equal(wholeMinuteAtOrAfter(Date.parse("2026-10-06T05:07:59.999Z")), Date.parse("2026-10-06T05:08:00.000Z"));
});
