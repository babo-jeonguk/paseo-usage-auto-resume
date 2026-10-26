import type { JobStore } from "./store";

/**
 * The pin a screen would send for an agent's stored reservation, at `dueAt` when a test pins a
 * time it showed earlier. An agent without one gets an id no reservation has.
 */
export async function pinOf(store: JobStore, agentId: string, dueAt?: string): Promise<{ id: string; dueAt: string }> {
  const job = (await store.list()).find((entry) => entry.agentId === agentId);
  return { id: job?.id ?? `${agentId}-none`, dueAt: dueAt ?? job?.dueAt ?? "" };
}
