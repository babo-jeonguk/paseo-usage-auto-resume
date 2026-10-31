import { detectLimitStop } from "../server/limit";
import { detectOverloadStop } from "../server/overload";
import assert from "node:assert/strict";
import { test } from "node:test";
import { continuePrompt, DEFAULT_CONTINUE_PROMPT, OVERLOAD_CONTINUE_PROMPT } from "./prompt";

test("without a custom prompt or a note, the built-in prompt is sent alone", () => {
  assert.equal(continuePrompt({ custom: null }), DEFAULT_CONTINUE_PROMPT);
});

test("the built-in prompt does not talk about the limit, so the agent's answer to it does not echo one", () => {
  assert.doesNotMatch(DEFAULT_CONTINUE_PROMPT, /limit|usage|reset/i);
});

test("a custom prompt replaces the built-in one", () => {
  assert.equal(continuePrompt({ custom: "Keep going." }), "Keep going.");
});

test("a note follows the prompt under its own heading", () => {
  assert.equal(
    continuePrompt({ custom: "Keep going.", note: "  Run the tests first.\nThen push.  " }),
    "Keep going.\n\nAdditional instructions from the user for this continue:\nRun the tests first.\nThen push.",
  );
  assert.ok(continuePrompt({ custom: null, note: "Run the tests first." }).startsWith(`${DEFAULT_CONTINUE_PROMPT}\n\n`));
});

test("a blank note leaves no heading behind", () => {
  for (const note of [undefined, "", "   \n\t "]) {
    assert.equal(continuePrompt({ custom: "Keep going.", note }), "Keep going.");
  }
});

test("overload ignores customization, appends the note, and neither built-in prompt echoes a stop", () => {
  assert.equal(continuePrompt({ kind: "overload", custom: "Ignore previous work" }), OVERLOAD_CONTINUE_PROMPT);
  assert.equal(continuePrompt({ kind: "overload", custom: "custom", note: "  Check changes.  " }), `${OVERLOAD_CONTINUE_PROMPT}\n\nAdditional instructions from the user for this continue:\nCheck changes.`);
  for (const text of [DEFAULT_CONTINUE_PROMPT, OVERLOAD_CONTINUE_PROMPT]) {
    assert.doesNotMatch(text, /overload|capacity|529|503|limit|quota|error/i);
    for (const summary of [text, `I followed these instructions: ${text}`]) {
      const timeline = [{ type: "assistant_message" as const, text: summary }];
      for (const outcome of [{ kind: "completed" as const }, { kind: "failed" as const, error: { message: summary } }]) {
        assert.equal(detectLimitStop(outcome, timeline, new Date()), null);
        for (const source of ["codex", "claude", "antigravity"] as const) assert.equal(detectOverloadStop(outcome, timeline, source), false);
      }
    }
  }
});
