/** The continue sent when the user has not written their own; Settings shows it as the starting text. */
export const DEFAULT_CONTINUE_PROMPT =
  "The provider usage limit should now be reset. Continue the unfinished work from the previous turn. " +
  "Review the latest conversation, workspace state, and subagent/task status before acting. " +
  "Use the provider's existing subagent resume or messaging tools to continue each unfinished subagent that stopped because of the usage limit, " +
  "using its existing agent ID/name and prior instructions. Tell it to continue from its saved progress. " +
  "Do not duplicate completed work or interrupt running subagents, and honor any user cancellation or pause. " +
  "If an existing subagent cannot be resumed, report that blocker instead of silently abandoning its unfinished task.";

/** Longest note for one reservation. */
export const NOTE_MAX_CHARS = 2000;

const NOTE_HEADING = "Additional instructions from the user for this continue:";

/** The text sent to the agent: the custom or built-in prompt, then the reservation's note. */
export function continuePrompt(input: { custom: string | null; note?: string }): string {
  const body = input.custom ?? DEFAULT_CONTINUE_PROMPT;
  const note = input.note?.trim();
  return note ? `${body}\n\n${NOTE_HEADING}\n${note}` : body;
}
