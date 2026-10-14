import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { detectLimitStop, parseResetAt } from "./limit";

const observedAt = new Date("2026-10-06T03:00:00.000Z");
const prompt: AgentTimelineItem = { type: "user_message", text: "Implement the feature" };
const failed = (message: string) => ({ kind: "failed" as const, error: { message } });
const completed = { kind: "completed" as const };

test("Codex usage-limit failure carries a relative reset", () => {
  const stop = detectLimitStop(
    failed("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 10 minutes."),
    [prompt],
    observedAt,
  );
  assert.deepEqual(stop, { resetAt: new Date("2026-10-06T05:10:00.000Z") });
});

test("Codex wall-clock reset is the next such local time", () => {
  // Verbatim Codex CLI rollout error.
  const stop = detectLimitStop(
    failed(
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:13 AM.",
    ),
    [prompt],
    observedAt,
  );
  const expected = new Date(observedAt);
  expected.setHours(4, 13, 0, 0);
  if (expected <= observedAt) expected.setDate(expected.getDate() + 1);
  assert.equal(stop?.resetAt?.toISOString(), expected.toISOString());
});

test("Codex weekly reset with an ordinal date", () => {
  const resetAt = parseResetAt("You've hit your usage limit. Try again at Oct 9th, 2026 4:13 AM.", observedAt)!;
  assert.equal(resetAt.getTime(), new Date(2026, 9, 9, 4, 13).getTime());
});

test("Claude reports its 5-hour limit as the closing assistant message", () => {
  const stop = detectLimitStop(
    completed,
    [prompt, { type: "assistant_message", text: "You've hit your limit · resets 3pm (Asia/Seoul)" }],
    observedAt,
  );
  // 12:00 KST observed → 15:00 KST the same day.
  assert.deepEqual(stop, { resetAt: new Date("2026-10-06T06:00:00.000Z") });
});

test("Claude's separate limit notice is detected after a long ordinary answer", () => {
  // The 2026-10-10 stop had an 834-character answer and a separate 58-character notice.
  const at = new Date("2026-10-10T05:24:04.274Z");
  const notice = "You've hit your session limit · resets 2:30pm (Asia/Seoul)";
  for (const withIds of [true, false]) {
    const timeline: AgentTimelineItem[] = [
      prompt,
      { type: "assistant_message", text: "Research is still running. ".padEnd(834, "."), ...(withIds ? { messageId: "answer" } : {}) },
      { type: "assistant_message", text: notice, ...(withIds ? { messageId: "limit" } : {}) },
    ];
    assert.deepEqual(detectLimitStop(completed, timeline, at), { resetAt: new Date("2026-10-10T05:30:00.000Z") });
  }
});

test("only chunks of the final message are joined, preserving a streamed reset time", () => {
  const timeline: AgentTimelineItem[] = [
    prompt,
    { type: "assistant_message", text: "Long ordinary answer. ".repeat(100), messageId: "answer" },
    { type: "assistant_message", text: "You've hit your session ", messageId: "limit" },
    { type: "assistant_message", text: "limit · resets 3", messageId: "limit" },
    { type: "assistant_message", text: "pm (Asia/Seoul)", messageId: "limit" },
  ];
  assert.deepEqual(detectLimitStop(completed, timeline, observedAt), { resetAt: new Date("2026-10-06T06:00:00.000Z") });
});

test("an earlier limit mention does not turn a subsequent normal message into a stop", () => {
  for (const withIds of [true, false]) {
    assert.equal(detectLimitStop(completed, [
      prompt,
      { type: "assistant_message", text: "You've hit your session limit · resets 3pm (Asia/Seoul)", ...(withIds ? { messageId: "quote" } : {}) },
      { type: "assistant_message", text: "That was the old error; the task is now complete.", ...(withIds ? { messageId: "done" } : {}) },
    ], observedAt), null);
  }
});

test("a long discussion stays excluded even when its last chunk mentions a limit", () => {
  assert.equal(detectLimitStop(completed, [
    prompt,
    { type: "assistant_message", text: "Parser implementation details. ".repeat(100), messageId: "essay" },
    { type: "assistant_message", text: "The example error says you've hit your session limit.", messageId: "essay" },
  ], observedAt), null);
});

test("explicit rate-limit failure codes work without matching provider wording", () => {
  for (const code of ["rate_limit", "rate_limit_exceeded", "rate_limit_error", "usage_limit_reached", "usage_limit_exceeded", "resource_exhausted", "quota_exceeded"]) {
    assert.deepEqual(detectLimitStop({ kind: "failed", error: { code, message: "Request rejected" } }, [prompt], observedAt), { resetAt: null });
  }
  assert.deepEqual(detectLimitStop({ kind: "failed", error: {
    code: "rate_limit_exceeded", message: `Diagnostic details. ${"detail ".repeat(150)} Retry in 2 hours.`,
  } }, [prompt], observedAt), { resetAt: new Date("2026-10-06T05:00:00.000Z") });
});

test("Antigravity Google quota refusal carries compact relative reset units", () => {
  const message =
    'Cloud Code Assist API error (429): {"error":{"code":429,"message":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 6h53m44s.","status":"RESOURCE_EXHAUSTED"}}';
  const stop = detectLimitStop(failed(message), [prompt], observedAt);
  const expectedMs = observedAt.getTime() + (6 * 3600 + 53 * 60 + 44) * 1000;
  assert.deepEqual(stop, { resetAt: new Date(expectedMs) });
});

test("generic failure codes and billing/context errors do not trigger code-based resumes", () => {
  for (const code of ["429", "error", "context_length_exceeded", "insufficient_quota"]) {
    assert.equal(detectLimitStop({ kind: "failed", error: { code, message: "Request rejected" } }, [prompt], observedAt), null);
  }
  for (const message of ["insufficient_quota: billing quota exhausted", "context_length_exceeded: prompt is too long"]) {
    assert.equal(detectLimitStop({ kind: "failed", error: { code: "rate_limit_exceeded", message } }, [prompt], observedAt), null);
  }
});

test("Claude legacy epoch notice", () => {
  const stop = detectLimitStop(failed("Claude AI usage limit reached|1791266400"), [prompt], observedAt);
  assert.deepEqual(stop, { resetAt: new Date(1791266400 * 1000) });
});

test("a limit notice without a time is detected with an unknown reset", () => {
  assert.deepEqual(detectLimitStop(failed("Rate limit exceeded"), [prompt], observedAt), { resetAt: null });
});

test("context-window overflow is not a usage limit", () => {
  for (const message of [
    "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    "prompt is too long: 212000 tokens > 200000 maximum",
    "context_length_exceeded: This model's maximum context length is 272000 tokens",
  ]) {
    assert.equal(detectLimitStop(failed(message), [prompt], observedAt), null, message);
  }
});

test("ordinary failures and normal turns are not usage limits", () => {
  assert.equal(detectLimitStop(failed("Claude run failed"), [prompt], observedAt), null);
  assert.equal(detectLimitStop(failed("Codex app-server session is closed"), [prompt], observedAt), null);
  assert.equal(
    detectLimitStop(completed, [prompt, { type: "assistant_message", text: "Done. All tests pass." }], observedAt),
    null,
  );
  assert.equal(
    detectLimitStop({ kind: "canceled", reason: "interrupted" }, [prompt], observedAt),
    null,
  );
});

test("discussion of limits is not a limit stop", () => {
  const essay = `I added handling for when "you've hit your usage limit" appears. ${"Details. ".repeat(120)}`;
  assert.equal(detectLimitStop(completed, [prompt, { type: "assistant_message", text: essay }], observedAt), null);
  // A notice quoted earlier in the turn is not the turn's closing output.
  assert.equal(
    detectLimitStop(
      completed,
      [
        prompt,
        { type: "assistant_message", text: "You've hit your limit · resets 3pm (Asia/Seoul)" },
        { type: "reasoning", text: "That was a quote from the log." },
        { type: "assistant_message", text: "Fixed the parser." },
      ],
      observedAt,
    ),
    null,
  );
  // Only the latest turn counts.
  assert.equal(
    detectLimitStop(
      completed,
      [
        { type: "user_message", text: "old" },
        { type: "assistant_message", text: "You've hit your limit · resets 3pm" },
        prompt,
        { type: "assistant_message", text: "Continuing." },
      ],
      observedAt,
    ),
    null,
  );
});
