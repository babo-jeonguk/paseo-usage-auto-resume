import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cliBin, connectToDaemon, daemonErrors, DEFAULT_MARK, freePort, installPlugin, patchInstalled,
  paseoCommand, PLUGIN, providerEnvironment, readJson, replace, revisionOf, runHome, startModels, startProxy, waitFor } from './core.mjs';

export const nativeDefaults = { to: 'main', out: 'e2e/out-native', path: '' };

export async function nativeFixture(ctx, args) {
  const { root, artifacts, report, dispose } = ctx;
  const dirs = await runHome(root, args.path);
  const { home, work, env } = dirs;
  const cli = resolve(args.cli), version = (await readJson(join(cli, 'package.json'))).version;
  report.paseo = version;
  const models = await startModels(root);
  dispose(() => models.close());
  artifacts['model.jsonl'] = models.log;
  const proxyLog = join(root, 'providers-proxy.log');
  const proxy = await startProxy(proxyLog);
  dispose(() => proxy.close());
  artifacts['providers-proxy.log'] = proxyLog;
  const usageFile = join(root, 'usage.json');
  await writeFile(usageFile, '{}');
  const port = await freePort(), target = `127.0.0.1:${port}`;
  const environment = { ...env, PASEO_HOME: home, PASEO_LISTEN: target, PASEO_RELAY_ENABLED: 'false' };
  const paseo = paseoCommand(() => cliBin(cli), home, environment);
  let client, workspace;
  dispose(() => client?.close());
  const rpc = (method, input = {}) => client.invokePluginRpc(PLUGIN, method, input);
  const jobsFile = join(home, 'plugin-data', PLUGIN, 'jobs.json');
  const jobs = async () => (await rpc('auto-resume.list')).jobs;
  const job = async id => (await jobs()).find(row => row.agentId === id);
  return {
    ...dirs, cli, version, environment, paseo, target, port, models, proxy, usageFile, jobsFile, rpc, jobs,
    get client() { return client; },
    claudeEnv: providerEnvironment(models.url, proxy.env),
    async configure(providers) {
      await writeFile(join(home, 'config.json'), JSON.stringify({
        version: 1, daemon: { listen: target, relay: { enabled: false }, mcp: { enabled: false }, usage: { enabled: false } }, pluginsEnabled: true,
        features: { webUi: { enabled: false }, dictation: { enabled: false }, voiceMode: { enabled: false } },
        agents: { providers, resumeOnStartup: false },
      }));
    },
    async attach(alive) {
      await client?.close();
      client = await connectToDaemon(cli, version, home, target, alive);
    },
    async install(patch) {
      report.revision = revisionOf(await installPlugin(paseo, args.source, args.to, environment));
      await patchInstalled({ paseo, client, patch });
      workspace = (await client.createWorkspace({ source: { kind: 'directory', path: work }, title: 'Usage Auto Resume E2E' })).workspace;
    },
    agent(title, provider = 'claude', model) {
      return client.createAgent({ title, provider, model, cwd: work, workspaceId: workspace.id });
    },
    async limit(agent, resetInSec = 5400) {
      await models.set('claude', { mode: 'limit', resetInSec });
      try {
        await client.sendAgentMessage(agent.id, `Work on ${agent.title}.`);
        const job = await waitFor(async () => (await jobs()).find(row => row.agentId === agent.id), `reservation for ${agent.title}`, 90_000, 100);
        assert(models.requests().some(request => request.api === 'claude' && request.mode === 'limit' && request.last.includes(agent.title)),
          'No fake model limit reached the Claude turn');
        return { job, observedAt: performance.now() };
      } finally { await models.set('claude', { mode: 'text' }); }
    },
    job,
    waitJob: (agent, matches, what) => waitFor(async () => matches(await job(agent.id)), what, 20_000, 250),
    history: async () => (await rpc('auto-resume.history')).entries,
    setUsage: (usage, until) => replace(usageFile, JSON.stringify({ usage, until })),
    continues: (mark = DEFAULT_MARK) =>
      models.requests().filter(request => request.api === 'claude' && request.counted && request.last.includes(mark)),
  };
}

export async function assertDaemonLogs(report, path, expectedDaemonError = () => false) {
  report.daemonLogErrors = daemonErrors(await readFile(path, 'utf8'));
  assert.deepEqual(report.daemonLogErrors.plugin, [], 'Unexpected plugin errors');
  assert.deepEqual(report.daemonLogErrors.daemon.filter(entry => !expectedDaemonError(entry)), [], 'Unexpected daemon errors');
}

export async function editSavedJobs(fixture, edit) {
  const state = await readJson(fixture.jobsFile);
  await replace(fixture.jobsFile, JSON.stringify({ ...state, jobs: edit(state.jobs) }));
}

export function localClock(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function tomorrowAtNoon() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
}
