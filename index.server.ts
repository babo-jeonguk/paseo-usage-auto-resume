import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHistoryStore } from "./server/history";
import { discoverProviders } from "./server/providers";
import { createResumer } from "./server/resumer";
import { createJobStore } from "./server/store";
import { listHistoryRpc, listProvidersRpc, listScheduledRpc, rescheduleRpc, resumeNowRpc, setAllEnabledRpc, setEnabledRpc, setNoteRpc } from "./shared/rpc";
import { providerSettings, resumeSettings } from "./shared/settings";

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
    // Unreadable values still send the built-in prompt; overload retries wait for them.
    readResumeSettings: async () => {
      const current = await promptSettings.read().catch((error: unknown) => ({ status: "invalid" as const, error: String(error) }));
      if (current.status === "ready") {
        resumeError = null;
        return current.values;
      }
      if (current.error !== resumeError) {
        console.error("[usage-auto-resume] resume settings unreadable; sending the built-in prompt, overload retries waiting", current.error);
      }
      resumeError = current.error;
      return null;
    },
  });
  const report = (error: unknown) => console.error("[usage-auto-resume] hook failed", String(error));
  void resumer.recover().catch(report);

  // Hooks return at once: detection reads the agent and usage, which must not hold up the daemon.
  const stops = [
    server.before("agent.session_open", ({ request }) => resumer.rememberSession(request)),
    settings.subscribe(() => void resumer.reconcileProviders().catch(report)),
    promptSettings.subscribe(() => void resumer.reconcileOverload().catch(report)),
    server.on("agent.turn_started", (event, { paseo }) => {
      void resumer.attach(paseo);
      void resumer.onTurnStarted(event.agent.id, paseo).catch(report);
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
  server.handle(setEnabledRpc, async ({ agentId, id, dueAt, enabled }, { paseo }) => {
    void resumer.attach(paseo);
    return { changed: await resumer.setEnabled(agentId, { id, dueAt }, enabled) };
  });
  server.handle(setAllEnabledRpc, async ({ enabled, jobs }, { paseo }) => {
    void resumer.attach(paseo);
    return { changed: await resumer.setAllEnabled(enabled, jobs) };
  });
  server.handle(rescheduleRpc, async ({ agentId, id, dueAt, newDueAt }, { paseo }) => {
    void resumer.attach(paseo);
    return resumer.reschedule(agentId, { id, dueAt }, newDueAt);
  });
  server.handle(setNoteRpc, async ({ agentId, id, note }, { paseo }) => {
    void resumer.attach(paseo);
    return resumer.setNote(agentId, { id }, note);
  });
  server.handle(resumeNowRpc, async ({ agentId, id, dueAt }, { paseo }) => {
    void resumer.attach(paseo);
    return resumer.resumeNow(paseo, agentId, { id, dueAt });
  });
  const timer = setInterval(() => void resumer.tick().catch(report), TICK_MS);

  return () => {
    clearInterval(timer);
    for (const stop of stops) stop();
  };
}
