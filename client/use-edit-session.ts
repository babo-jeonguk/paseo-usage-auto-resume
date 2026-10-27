import { useEffect, useReducer } from "react";
import type { ScheduledJob } from "../shared/rpc";
import { editSession, synced } from "./edit-session";

/**
 * A surface's one editor, as the latest list allows it (see `synced`). Rendering uses that view
 * at once; the stored session catches up after.
 */
export function useEditSession(jobs: readonly ScheduledJob[] | undefined) {
  const [stored, dispatch] = useReducer(editSession, null);
  const session = jobs ? synced(stored, jobs) : stored;
  useEffect(() => {
    if (session !== stored && jobs) dispatch({ type: "sync", jobs });
  }, [session, stored, jobs]);
  return [session, dispatch] as const;
}
