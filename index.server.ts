import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHistoryStore } from "./server/history";
import { discoverProviders } from "./server/providers";
import { createResumer } from "./server/resumer";
import { createJobStore } from "./server/store";
import { listHistoryRpc, listProvidersRpc, listScheduledRpc, rescheduleRpc, resumeNowRpc, setAllEnabledRpc, setEnabledRpc, setNoteRpc } from "./shared/rpc";
import { DEFAULT_RESUME_SETTINGS, providerSettings, resumeSettings } from "./shared/settings";

const TICK_MS = 30_000;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(providerSettings);
  const promptSettings = server.registerSettings(resumeSettings);
  // The tick reads these on every send; the same failure is reported once, not every time.
  let resumeError: string | null = null;
  const resumer = createResumer({
    store: createJobStore(),
    history: createHistoryStore(),
    readSettings: async () => {
      const current = await settings.read();
      if (current.status === "ready") return current.values;
      console.error("[usage-auto-resume] settings unreadable; automatic resumes are waiting", current.error);
      return null;
    },
    // Unlike the provider switches, unreadable values here never hold a resume: the built-in
    // prompt is a safe thing to send.
    readResumeSettings: async () => {
      const current = await promptSettings.read().catch((error: unknown) => ({ status: "invalid" as const, error: String(error) }));
      if (current.status === "ready") {
        resumeError = null;
        return current.values;
      }
      if (current.error !== resumeError) {
        console.error("[usage-auto-resume] continue prompt settings unreadable; sending the built-in prompt", current.error);
      }
      resumeError = current.error;
      return DEFAULT_RESUME_SETTINGS;
    },
  });
  const report = (error: unknown) => console.error("[usage-auto-resume] hook failed", String(error));
  void resumer.recover().catch(report);

  // Hooks return at once: detection reads the agent and usage, which must not hold up the daemon.
  const stops = [
    server.before("agent.session_open", ({ request }) => resumer.rememberSession(request)),
    settings.subscribe(() => void resumer.reconcileProviders().catch(report)),
    server.on("agent.turn_started", (event, { paseo }) => {
      void resumer.attach(paseo);
      void resumer.onTurnStarted(event.agent.id).catch(report);
    }),
    server.on("agent.turn_ended", (event, { paseo }) => {
      void resumer.attach(paseo);
      void resumer.onTurnEnded(event, paseo).catch(report);
    }),
    server.on("agent.archived", (event, { paseo }) => {
      void resumer.attach(paseo);
      void resumer.forget(event.agent.id).catch(report);
    }),
    server.on("agent.permission_requested", (_event, { paseo }) => void resumer.attach(paseo)),
    server.on("agent.created", (_event, { paseo }) => void resumer.attach(paseo)),
    server.on("agent.closed", (_event, { paseo }) => void resumer.attach(paseo)),
  ];
  // Opening the screen also hands over the API, so a restart never waits on agent activity alone.
  server.handle(listScheduledRpc, async (_input, { paseo }) => {
    void resumer.attach(paseo);
    return { jobs: await resumer.listScheduled(paseo) };
  });
  server.handle(listHistoryRpc, async (_input, { paseo }) => {
    void resumer.attach(paseo);
    return { entries: await resumer.listHistory(paseo) };
  });
  server.handle(listProvidersRpc, async (_input, { paseo }) => {
    void resumer.attach(paseo);
    return { providers: await discoverProviders(paseo) };
  });
  server.handle(setEnabledRpc, async ({ agentId, dueAt, enabled }, { paseo }) => {
    void resumer.attach(paseo);
    return { changed: await resumer.setEnabled(agentId, dueAt, enabled) };
  });
  server.handle(setAllEnabledRpc, async ({ enabled, jobs }, { paseo }) => {
    void resumer.attach(paseo);
    return { changed: await resumer.setAllEnabled(enabled, jobs) };
  });
  server.handle(rescheduleRpc, async ({ agentId, dueAt, newDueAt }, { paseo }) => {
    void resumer.attach(paseo);
    return resumer.reschedule(agentId, dueAt, newDueAt);
  });
  server.handle(setNoteRpc, async ({ agentId, dueAt, note }, { paseo }) => {
    void resumer.attach(paseo);
    return resumer.setNote(agentId, dueAt, note);
  });
  server.handle(resumeNowRpc, async ({ agentId, dueAt }, { paseo }) => {
    void resumer.attach(paseo);
    return resumer.resumeNow(paseo, agentId, dueAt);
  });
  const timer = setInterval(() => void resumer.tick().catch(report), TICK_MS);

  return () => {
    clearInterval(timer);
    for (const stop of stops) stop();
  };
}
