import type { ComponentType } from "react";
import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listScheduledRpc } from "../shared/rpc";
import { composerLabel } from "./format";
import { onScheduleChanged } from "./schedule-changes";

/** One directory poll per installation, including reservations in background workspaces. */
export function installConversationControls(client: PluginClientContext, Content: ComponentType<PluginButtonContentProps>) {
  const registrations = new Map<string, { workspaceId: string; button: PluginButtonRegistration }>();
  let stopped = false;
  let loading = false;
  let requested = false;

  async function refresh(invalidate = false) {
    if (stopped) return;
    if (loading) { requested ||= invalidate; return; }
    loading = true;
    try {
      const { jobs } = await client.rpc(listScheduledRpc, {});
      // A local mutation during the read makes that response stale.
      if (stopped || requested) return;
      const seen = new Set<string>();
      for (const job of jobs) {
        if (!job.workspaceId) continue;
        seen.add(job.agentId);
        let current = registrations.get(job.agentId);
        if (current && current.workspaceId !== job.workspaceId) {
          current.button.remove();
          registrations.delete(job.agentId);
          current = undefined;
        }
        const label = composerLabel(job, Date.now());
        if (current) current.button.update({ label });
        else registrations.set(job.agentId, {
          workspaceId: job.workspaceId,
          button: client.addComposerPill({
            id: `resume-${job.agentId}`,
            agentId: job.agentId,
            workspaceId: job.workspaceId,
            button: { title: "Auto Resume", label, icon: "AlarmClock", behavior: { kind: "popover", Content } },
          }),
        });
      }
      for (const [id, entry] of registrations) {
        if (seen.has(id)) continue;
        entry.button.remove();
        registrations.delete(id);
      }
    } catch {
      // Keep controls reachable for retry, but never present a stale time as current.
      if (!stopped) for (const entry of registrations.values()) entry.button.update({ label: "Unavailable" });
    } finally {
      loading = false;
      if (requested && !stopped) { requested = false; void refresh(); }
    }
  }

  const unsubscribeChanges = onScheduleChanged(() => void refresh(true));
  const timer = setInterval(() => void refresh(), 10_000);
  void refresh();
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribeChanges();
    for (const entry of registrations.values()) entry.button.remove();
    registrations.clear();
  };
}
