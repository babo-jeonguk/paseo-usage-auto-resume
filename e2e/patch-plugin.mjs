// Patches an installed copy of the plugin's index.server.ts for the e2e:
//  1. createResumer({ readSubscription }) is driven by a control file (the real reader treats an
//     ANTHROPIC_BASE_URL / GEMINI_API_KEY route as API billing by design),
//  2. log-only lines in agent.turn_ended reporting timeline length and the final outcome.
// Everything else is the real entry point.
export function patchEntry(source, controlFile) {
  if (source.includes('fixtureReader')) return source;
  let out = source.replace('import { createResumer } from "./server/resumer";', `import { createResumer } from "./server/resumer";
import { readFileSync } from "node:fs";
// E2E fixture: the account/usage check reads ${JSON.stringify(controlFile)}; everything else is the real entry.
const fixtureReader = async (_api: unknown, _agent: unknown, source: string) => {
  const f = JSON.parse(readFileSync(${JSON.stringify(controlFile)}, "utf8"));
  if (source === "antigravity") return { auth: "subscription", status: "ready" } as const;
  if (f.usage === "limited") return { auth: "subscription", status: "limited", identity: "fixture", windows: [{ id: "five_hour", usedPct: 100, resetAt: f.until ?? null }] } as const;
  if (f.usage === "auth") return { auth: "unknown", status: "unknown" } as const;
  return { auth: "subscription", status: "ready", identity: "fixture" } as const;
};`);
  out = out.replace('store: createJobStore(),', 'store: createJobStore(),\n    readSubscription: fixtureReader as never,');
  out = out.replace('server.on("agent.turn_ended", (event, { paseo }) => {',
    'server.on("agent.turn_ended", (event, { paseo }) => {\n      console.log("[usage-auto-resume] e2e-probe turn_ended agent=" + event.agent.id + " outcome=" + event.outcome.kind + " timeline.length=" + (Array.isArray((event as { timeline?: unknown[] }).timeline) ? (event as { timeline: unknown[] }).timeline.length : "absent"));');
  out = out.replace('void resumer.onTurnEnded(event, paseo).catch(report);',
    'console.log("[usage-auto-resume] e2e-outcome " + JSON.stringify({ agentId: event.agent.id, outcome: event.outcome }));\n      void resumer.onTurnEnded(event, paseo).catch(report);');
  if (!['readSubscription: fixtureReader', 'e2e-probe', 'e2e-outcome'].every((marker) => out.includes(marker))) throw new Error('entry patch failed');
  return out;
}
