import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { UsageSource } from "../shared/settings";
import type { AgentTimelineItem } from "./paseo-types";
import { detectLimitStop } from "./limit";
import { detectOverloadStop } from "./overload";

const sources: UsageSource[] = ["codex", "claude", "antigravity"];
const dir = new URL("./fixtures/", import.meta.url);
const fixtures = readdirSync(dir).filter(name => /^overload-.*\.json$/.test(name)).map(name => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as {
  source: UsageSource; outcome: PluginTurnOutcome; timeline: AgentTimelineItem[];
});

test("every provider has a captured final result", () => {
  assert.deepEqual([...new Set(fixtures.map(f => f.source))].sort(), [...sources].sort());
});

test("real CLI final results match only their provider, including Claude's completed notice", () => {
  for (const f of fixtures) {
    // Limit detection runs first, so it must leave every captured overload alone.
    assert.equal(detectLimitStop(f.outcome, f.timeline, new Date()), null, `${f.source} as a limit`);
    for (const source of sources) assert.equal(detectOverloadStop(f.outcome, f.timeline, source), source === f.source, `${f.source} as ${source}`);
    assert.equal(detectOverloadStop({ kind: "canceled", reason: "user" }, f.timeline, f.source), false);
    if (f.outcome.kind === "failed") {
      assert.equal(detectOverloadStop(f.outcome, [{ type: "assistant_message", text: "Partial work finished" }], f.source), true);
      for (const suffix of [" billing_error", " context_length_exceeded", " authentication failed"]) {
        assert.equal(detectOverloadStop({ kind: "failed", error: { message: f.outcome.error.message + suffix } }, [], f.source), false);
      }
    }
  }
});

test("ordinary output, generic unavailable errors and other capacity products never match", () => {
  for (const text of ["The server was overloaded", "503 UNAVAILABLE", "500 overloaded_error", "502 Bad Gateway", "504 timeout", "stream was interrupted", "Policy-restricted capacity is unavailable. Please try again later.", "Flex capacity unavailable."]) {
    for (const source of sources) {
      assert.equal(detectOverloadStop({ kind: "failed", error: { message: text } }, [], source), false, text);
      assert.equal(detectOverloadStop({ kind: "completed" }, [{ type: "assistant_message", text }], source), false, text);
    }
  }
});

test("Claude matches its CLI's own overload classes and nothing that only mentions them", () => {
  const completed = { kind: "completed" } as const;
  const notice = (text: string) => detectOverloadStop(completed, [{ type: "assistant_message", text }], "claude");
  for (const text of [
    "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.",
    'API Error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  ]) assert.equal(notice(text), true, text);
  for (const text of [
    "API Error: 5290 Overloaded.",
    "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.",
    "Opus is experiencing high load, please use /model to switch to Sonnet",
    "The run hit API Error: 529 Overloaded earlier, and I retried.",
  ]) assert.equal(notice(text), false, text);
});

test("Claude reads only the short final synthetic notice and joins only chunks from one message", () => {
  const notice = "API Error: 529 Overloaded.";
  const assistant = (text: string, messageId?: string): AgentTimelineItem => ({ type: "assistant_message", text, messageId });
  const completed = { kind: "completed" } as const;
  assert.equal(detectOverloadStop(completed, [assistant(notice)], "claude"), true);
  for (const text of [`Earlier: ${notice}`, notice + "x".repeat(300), notice + " billing"]) {
    assert.equal(detectOverloadStop(completed, [assistant(text)], "claude"), false);
  }
  assert.equal(detectOverloadStop(completed, [assistant(notice), { type: "user_message", text: "Next task" }], "claude"), false);
  assert.equal(detectOverloadStop(completed, [assistant(notice), assistant("Done")], "claude"), false);
  assert.equal(detectOverloadStop(completed, [assistant("API Error: 529 ", "m"), assistant("Overloaded.", "m")], "claude"), true);
  assert.equal(detectOverloadStop(completed, [assistant("API Error: 529 ", "a"), assistant("Overloaded.", "b")], "claude"), false);
});
