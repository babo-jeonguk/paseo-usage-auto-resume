import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createResumer } from "./server/resumer";
import { createJobStore } from "./server/store";
import { listScheduledRpc, setEnabledRpc } from "./shared/rpc";
import { providerSettings } from "./shared/settings";

const TICK_MS = 30_000;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(providerSettings);
  const resumer = createResumer({
    store: createJobStore(),
    readSettings: async () => {
      const current = await settings.read();
      if (current.status === "ready") return current.values;
      console.error("[usage-auto-resume] settings unreadable; automatic resumes are waiting", current.error);
      return null;
    },
  });
  const report = (error: unknown) => console.error("[usage-auto-resume] hook failed", String(error));
  void resumer.recover().catch(report);

  // Hooks return at once: detection reads the agent and usage, which must not hold up the daemon.
  const stops = [
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
  server.handle(setEnabledRpc, async ({ agentId, dueAt, enabled }, { paseo }) => {
    void resumer.attach(paseo);
    return { changed: await resumer.setEnabled(agentId, dueAt, enabled) };
  });
  const timer = setInterval(() => void resumer.tick().catch(report), TICK_MS);

  return () => {
    clearInterval(timer);
    for (const stop of stops) stop();
  };
}
