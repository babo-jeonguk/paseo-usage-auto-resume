import type { AgentTimelineItem } from "./paseo-types";

/**
 * Read the final provider message, ignoring rows appended by other plugins. Join only
 * chunks with the same non-empty message ID; provider activity still ends the message.
 */
export function closingAssistantText(timeline: readonly AgentTimelineItem[]): string {
  let index = timeline.length - 1;
  while (index >= 0 && timeline[index]?.type === "plugin") index--;
  const last = timeline[index];
  if (last?.type !== "assistant_message") return "";
  let text = last.text;
  if (!last.messageId) return text;
  for (index--; index >= 0; index--) {
    const item = timeline[index];
    if (item?.type === "plugin") continue;
    if (item?.type !== "assistant_message" || item.messageId !== last.messageId) break;
    text = item.text + text;
  }
  return text;
}
