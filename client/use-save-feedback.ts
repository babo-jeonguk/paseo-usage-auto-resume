import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { saveFailure, type SaveFailure, type SaveTarget } from "./save-failure";

interface SaveState {
  saveError: string | null;
  reload(): Promise<void>;
}

/**
 * Feedback for the saves of one settings document. A failed save shows one toast, keeps a friendly
 * message beside the control that failed (by `key`) until the next successful save or reload, and
 * logs the raw error once; the raw error is never shown.
 */
export function useSaveFeedback(settings: SaveState) {
  const toast = useToast();
  const [failed, setFailed] = useState<{ target: SaveTarget; key: string; attempt: number } | null>(null);
  const attempts = useRef(0);
  const announced = useRef(0);
  // The settings hook can publish saveError a render after the save resolves.
  const failure: SaveFailure | null = failed && settings.saveError !== null ? saveFailure(settings.saveError, failed.target) : null;
  useEffect(() => {
    if (!failed || !failure || announced.current === failed.attempt) return;
    announced.current = failed.attempt;
    console.warn(`[usage-auto-resume] settings save failed: ${settings.saveError}`);
    toast.error(failure.message);
  });
  return {
    /** The friendly failure for the control saved under `key`, or null. */
    failureFor: (key: string): SaveFailure | null => (failed?.key === key ? failure : null),
    /** Runs one save; a failure is reported once, a success clears any earlier failure. */
    run: async (key: string, target: SaveTarget, save: () => Promise<boolean>): Promise<boolean> => {
      // The previous failure must not pick up this save's error text under the wrong control.
      setFailed(null);
      const ok = await save();
      setFailed(ok ? null : { target, key, attempt: ++attempts.current });
      return ok;
    },
    reload: async () => {
      await settings.reload();
      setFailed(null);
    },
  };
}

export type SaveFeedback = ReturnType<typeof useSaveFeedback>;
