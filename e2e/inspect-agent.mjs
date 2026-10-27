// node inspect-agent.mjs <cliDir> <home> <listen host:port> <agentId>  -> prints the agent's recent timeline
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [cliDir, home, target, agentId] = process.argv.slice(2);
const tools = createRequire(join(cliDir, 'package.json'));
const { DaemonClient } = await import(pathToFileURL(tools.resolve('@getpaseo/client/internal/daemon-client')));
const { readLocalCredentialForTarget } = await import(pathToFileURL(tools.resolve('@getpaseo/server/daemon-control')));
const { WebSocket } = tools('ws');
const c = new DaemonClient({ url: `ws://${target}/ws`, clientId: 'inspect', clientType: 'cli', appVersion: '0.13.2',
  localCredential: () => readLocalCredentialForTarget(home, target) ?? undefined,
  webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }), reconnect: { enabled: false }, connectTimeoutMs: 3000 });
await c.connect();
const t = await c.fetchAgentTimeline(agentId, { direction: 'tail', limit: 30 });
for (const e of (t.entries ?? [])) { const i = e.item ?? e; console.log(e.seq ?? '', i.type, JSON.stringify(i).slice(0, 260)); }
await c.close();
