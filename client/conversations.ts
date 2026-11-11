import type { ComponentType } from "react";
import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext, PluginSubscriptionHandle } from "@getpaseo/plugin/client";
import { changesSubscription, listScheduledRpc } from "../shared/rpc";
import { composerLabel } from "./format";
import { onScheduleChanged } from "./schedule-changes";

/** One directory poll per installation, including reservations in background workspaces. */
export function installConversationControls(client: PluginClientContext, Content: ComponentType<PluginButtonContentProps>) {
  type Registration = { workspaceId: string; label: string; button: PluginButtonRegistration };
  const registrations = new Map<string, Registration>();
  let stopped = false;
  let loading = false;
  let requested = false;

  function updateLabel(entry: Registration, label: string) {
    if (entry.label === label) return;
    entry.button.update({ label });
    entry.label = label;
  }

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
        if (current) updateLabel(current, label);
        else registrations.set(job.agentId, {
          workspaceId: job.workspaceId,
          label,
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
      if (!stopped) for (const entry of registrations.values()) updateLabel(entry, "Unavailable");
    } finally {
      loading = false;
      if (requested && !stopped) { requested = false; void refresh(); }
    }
  }

  const unsubscribeChanges = onScheduleChanged(() => void refresh(true));
  // Pushed changes arrive as they happen; the interval only catches renamed or moved agents.
  const RETRY_DELAYS_MS = [5_000, 15_000, 60_000];
  let subscription: PluginSubscriptionHandle | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  function resubscribe() {
    if (stopped || retry) return;
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
    attempt += 1;
    retry = setTimeout(() => { retry = null; listen(); }, delay);
    (retry as { unref?: () => void }).unref?.();
  }

  function listen() {
    if (stopped) return;
    const next = client.subscribe(changesSubscription, {}, () => void refresh(true), {
      // The daemon closed it: a handler error or a plugin stop. Keep polling, then try again.
      onClosed: () => { void refresh(true); resubscribe(); },
    });
    subscription = next;
    next.ready.then(
      () => { attempt = 0; if (!stopped) void refresh(true); },
      () => resubscribe(),
    );
  }

  listen();
  const timer = setInterval(() => void refresh(), 120_000);
  void refresh();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (retry) clearTimeout(retry);
    void subscription?.release();
    unsubscribeChanges();
    for (const entry of registrations.values()) entry.button.remove();
    registrations.clear();
  };
}
