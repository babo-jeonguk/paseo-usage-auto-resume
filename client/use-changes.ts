import { useSubscription } from "@getpaseo/plugin/client";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { changesSubscription } from "../shared/rpc";

/**
 * Refetches through the list RPCs when the daemon pushes a change, and once whenever the
 * subscription (re)connects or closes, so changes missed while it was down are fetched.
 */
export function useScheduleChanges(queryClient: QueryClient, queryKeys: readonly unknown[][]) {
  const invalidate = () => {
    for (const queryKey of queryKeys) void queryClient.invalidateQueries({ queryKey });
  };
  const state = useSubscription(changesSubscription, {}, invalidate);
  useEffect(() => {
    if (state.status === "live" || state.status === "closed" || state.status === "error") invalidate();
    // Only a state change matters; the keys are stable query keys of this surface.
  }, [state.status]);
  return state;
}
