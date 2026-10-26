import type { ScheduledJob } from "../shared/rpc";

/** The two editors a reservation offers; each surface keeps at most one open. */
export type EditorKind = "time" | "note";

/**
 * The one editor a surface has open. It lives with the surface rather than in the editor, so a
 * row drawn again, as when its day group changes, keeps what was typed and what it was pinned to.
 */
export interface EditSession {
  /** This opening of the editor, so a save made in an earlier one never lands in it. */
  opened: object;
  agentId: string;
  kind: EditorKind;
  /** The reservation time the editor opened on. A note's save is pinned to it; a refusal moves it. */
  pin: string;
  /** The extra instructions as typed, and what the editor opened with. */
  draft: string;
  initial: string;
  /** A note's save is in flight: the editor stays open, and closes only on its result. */
  saving: boolean;
  problem: string | null;
}

export type EditEvent =
  | { type: "open"; kind: EditorKind; job: ScheduledJob }
  | { type: "type"; text: string }
  | { type: "save" }
  | { type: "saved"; opened: object }
  | { type: "refused"; opened: object; latest: string; problem: string }
  | { type: "failed"; opened: object; problem: string }
  | { type: "cancel" }
  | { type: "escape" }
  | { type: "moved" }
  | { type: "sync"; jobs: readonly ScheduledJob[] };

/**
 * One editor at a time. While extra instructions are open nothing else opens, so typed text is
 * never replaced; while a time is open no extra instructions open. A save's result applies only
 * to the editor that made it, and closing waits for it.
 */
export function editSession(state: EditSession | null, event: EditEvent): EditSession | null {
  switch (event.type) {
    case "open": {
      const { kind, job } = event;
      if (job.sending || (state && (kind === "note" || state.kind === "note"))) return state;
      const note = kind === "note" ? job.note ?? "" : "";
      return { opened: {}, agentId: job.agentId, kind, pin: job.dueAt, draft: note, initial: note, saving: false, problem: null };
    }
    case "type":
      return state?.kind === "note" && !state.saving ? { ...state, draft: event.text } : state;
    case "save":
      return state?.kind === "note" ? { ...state, saving: true, problem: null } : state;
    case "saved":
      return ownSave(state, event.opened) ? null : state;
    case "refused":
      return ownSave(state, event.opened) ? { ...state!, saving: false, pin: event.latest, problem: event.problem } : state;
    case "failed":
      return ownSave(state, event.opened) ? { ...state!, saving: false, problem: event.problem } : state;
    case "cancel":
      return state?.saving ? state : null;
    case "moved":
      // A time saved from the time editor closes it, even when it is the time already set.
      return state?.kind === "time" ? null : state;
    case "escape":
      // Only an untouched editor closes; typed text leaves through Cancel.
      return state?.kind === "note" && !state.saving && state.draft.trim() === state.initial ? null : state;
    case "sync":
      return synced(state, event.jobs);
  }
}

const ownSave = (state: EditSession | null, opened: object) => state?.kind === "note" && state.saving && state.opened === opened;

/**
 * The session as the latest list allows it. An editor whose reservation is gone closes, so a
 * later reservation never opens with one. A time editor also closes when its reservation moves
 * or starts sending; extra instructions stay, pinned to the time they opened on.
 */
export function synced(state: EditSession | null, jobs: readonly ScheduledJob[]): EditSession | null {
  if (!state) return state;
  const job = jobs.find((entry) => entry.agentId === state.agentId);
  if (!job) return null;
  if (state.kind === "time" && (job.dueAt !== state.pin || job.sending)) return null;
  return state;
}

/** What an open editor turns off: extra instructions stop everything else, a time stops notes. */
export function editorLocks(state: EditSession | null): { time: boolean; note: boolean } {
  return { time: state?.kind === "note", note: state !== null };
}
