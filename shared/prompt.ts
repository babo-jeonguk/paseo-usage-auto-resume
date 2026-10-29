/** The continue sent when the user has not written their own; Settings shows it as the starting text. */
export const DEFAULT_CONTINUE_PROMPT =
  "Continue the unfinished work from where it stopped. " +
  "Resume each subagent that stopped partway with its existing ID, and have it continue from its saved progress. " +
  "Don't redo finished work, interrupt anything still running, or restart what the user canceled. " +
  "If a subagent can't be resumed, say so.";

/** Longest note for one reservation. */
export const NOTE_MAX_CHARS = 2000;

const NOTE_HEADING = "Additional instructions from the user for this continue:";

/** The text sent to the agent: the custom or built-in prompt, then the reservation's note. */
export function continuePrompt(input: { custom: string | null; note?: string }): string {
  const body = input.custom ?? DEFAULT_CONTINUE_PROMPT;
  const note = input.note?.trim();
  return note ? `${body}\n\n${NOTE_HEADING}\n${note}` : body;
}
