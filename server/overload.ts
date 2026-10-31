import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { UsageSource } from "../shared/settings";
import type { AgentTimelineItem } from "./paseo-types";

const CODEX_CAPACITY = "Selected model is at capacity. Please try a different model.";
/**
 * Claude Code's own overload classes as it renders a final API error, `API Error: <detail>`: a 529
 * status, its give-up after repeated 529s, and an `overloaded_error` body that came without one.
 * Its model-specific high-load notice is a request to switch models and is not included.
 */
const CLAUDE_OVERLOAD = /^API Error: (?:529\b|Repeated 529 Overloaded errors\b|.*"type":"overloaded_error")/s;
const EXCLUDED = /context[ _-](?:length|window)|(?:prompt|input) is too long|maximum context|too many (?:input )?tokens|insufficient[_ ]quota|credit[_ ]balance|billing|payment|prepaid|prepay|insufficient (?:funds|credits)|authentication|unauthorized|invalid[_ ]api[_ ]key|permission[_ ]denied/i;

/** Claude alone reports its synthetic 529 notice as a completed turn. */
function closingNotice(timeline: readonly AgentTimelineItem[]): string {
  const last = timeline[timeline.length - 1];
  if (last?.type !== "assistant_message") return "";
  let text = last.text;
  if (last.messageId) {
    for (let index = timeline.length - 2; index >= 0; index--) {
      const item = timeline[index];
      if (item?.type !== "assistant_message" || item.messageId !== last.messageId) break;
      text = item.text + text;
    }
  }
  return text.trim();
}

/** Only final provider capacity failures; see the real-CLI, fake-API fixtures and docs/research/overload.md. */
export function detectOverloadStop(outcome: PluginTurnOutcome, timeline: readonly AgentTimelineItem[], source: UsageSource): boolean {
  if (outcome.kind === "canceled") return false;
  const code = outcome.kind === "failed" ? outcome.error.code ?? "" : "";
  const text = outcome.kind === "failed" ? outcome.error.message.trim() : source === "claude" ? closingNotice(timeline) : "";
  if ((!text && !code) || EXCLUDED.test(`${code} ${text}`)) return false;
  switch (source) {
    case "codex": return outcome.kind === "failed" && text === CODEX_CAPACITY;
    case "claude":
      if (outcome.kind === "failed" && code === "overloaded_error") return true;
      return text.length <= 300 && CLAUDE_OVERLOAD.test(text);
    case "antigravity":
      return outcome.kind === "failed" && (code === "MODEL_CAPACITY_EXHAUSTED" ||
        /^agent executor error: generating and executing: Error 503,/.test(text) && /\breason:MODEL_CAPACITY_EXHAUSTED\b/.test(text));
  }
}
