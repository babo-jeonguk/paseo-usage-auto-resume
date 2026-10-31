import assert from "node:assert/strict";
import { test } from "node:test";
import { overloadDue, OVERLOAD_DELAYS_MS } from "./schedule";

test("capacity jitter bounds each stage around its own failure time", () => {
  const at = new Date("2026-10-30T00:00:00.000Z");
  for (const step of [1, 2, 3] as const) {
    for (const random of [0, 0.5, 1]) {
      assert.equal(Date.parse(overloadDue(at, step, () => random)) - at.getTime(), Math.round(OVERLOAD_DELAYS_MS[step - 1]! * (0.8 + 0.4 * random)));
    }
  }
});
