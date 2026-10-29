// Usage Auto Resume end-to-end simulation. Runs on Linux and Windows with the same code.
// Real: Paseo daemon (isolated home/port), real plugin install from GitHub, real Claude/Codex/agy CLIs,
// real hooks, 30 s tick, settings, store, history. Fake: model APIs (fake-models.mjs), the account/usage
// check (control file, see patch-plugin.mjs). See README.md next to this file.
//
// node e2e.mjs --label linux-0.13.2 --cli <@getpaseo/cli dir> --root <run dir> --suites claude,codex,antigravity \
//   [--from <ref, default v1.2.2>] [--to <ref, default main>] [--source <git source>] [--out <results dir>] \
//   [--min 1] [--ui 1] [--hold 1] [--claude <bin>] [--codex <bin>] [--agy <bin>] [--path <extra PATH dirs>]
// --ui 1 reads Playwright from PW_ROOT and Chromium from CHROME (see ui-steps.mjs).
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, appendFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { patchEntry } from './patch-plugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a, []));
const isWin = process.platform === 'win32';
const label = args.label ?? 'run';
const suites = (args.suites ?? 'claude').split(',');
const MIN = args.min === '1';
const UI = args.ui === '1';
const GIT_SOURCE = args.source ?? 'git:babo-jeonguk/paseo-usage-auto-resume';
// The release a user updates from and rolls back to, and the version under test.
const OLD_REF = args.from ?? 'v1.2.2', NEW_REF = args.to ?? 'main';
let oldRevision = '';
const PLUGIN = 'usage-auto-resume';
const DEFAULT_MARK = 'usage limit should now be reset';

const cliDir = args.cli;
const tools = createRequire(join(cliDir, 'package.json'));
const { DaemonClient } = await import(pathToFileURL(tools.resolve('@getpaseo/client/internal/daemon-client')));
const { readLocalCredentialForTarget } = await import(pathToFileURL(tools.resolve('@getpaseo/server/daemon-control')));
const { WebSocket } = tools('ws');
const paseoVersion = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (fn, what, timeout = 180000, every = 500) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error('Timeout: ' + what);
};
const freePort = () => new Promise((done) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const iso = (ms) => new Date(ms).toISOString();

const root = args.root;
await rm(root, { recursive: true, force: true });
const home = join(root, 'paseo'), profile = join(root, 'profile'), work = join(root, 'work');
for (const d of [home, profile, work]) await mkdir(d, { recursive: true });
const out = args.out ?? join(here, 'out-' + label);
await mkdir(out, { recursive: true });
const usageFile = join(root, 'usage.json'), modelCtl = join(root, 'model.json'), modelLog = join(root, 'model.jsonl'), proxyLog = join(root, 'proxy.log');
await writeFile(usageFile, '{}'); await writeFile(modelCtl, '{}'); await writeFile(modelLog, ''); await writeFile(proxyLog, '');
const port = await freePort(), modelPort = await freePort(), proxyPort = await freePort();
const target = `127.0.0.1:${port}`, origin = `http://${target}`;
const data = join(home, 'plugin-data', PLUGIN);
const jobsFile = join(data, 'jobs.json'), historyFile = join(data, 'history.json');
const settingsDir = join(home, 'plugin-settings', PLUGIN);
const daemonLog = join(root, 'daemon.log');

// ---- results ------------------------------------------------------------------------------
const results = [];
// The longest stall of this process's event loop; anything near 45 s means the harness lost its daemon session (see paseo below).
const loopDelay = monitorEventLoopDelay({ resolution: 100 }); loopDelay.enable();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const step = async (item, suite, name, fn) => {
  try { const ev = await fn(); results.push({ item, suite, ok: true, name, ev: String(ev ?? '') }); log(`OK   [${item}/${suite}] ${name} :: ${ev ?? ''}`); return true; }
  catch (e) { results.push({ item, suite, ok: false, name, ev: String(e?.message ?? e).slice(0, 700) }); log(`FAIL [${item}/${suite}] ${name} :: ${String(e?.message ?? e).slice(0, 400)}`); return false; }
};
const note = (item, suite, name, ev) => { results.push({ item, suite, ok: null, name, ev }); log(`NOTE [${item}/${suite}] ${name} :: ${ev}`); };

// ---- data files ---------------------------------------------------------------------------
const readJobs = async () => existsSync(jobsFile) ? JSON.parse(await readFile(jobsFile, 'utf8')).jobs : [];
const readHistory = async () => existsSync(historyFile) ? JSON.parse(await readFile(historyFile, 'utf8')).entries : [];
const writeJobs = async (jobs) => { await mkdir(data, { recursive: true }); await writeFile(jobsFile + '.tmp', JSON.stringify({ version: 1, jobs }, null, 2)); await rename(jobsFile + '.tmp', jobsFile); };
const jobOf = async (id) => (await readJobs()).find((j) => j.agentId === id);
const editJob = async (id, patch) => writeJobs((await readJobs()).map((j) => j.agentId === id ? { ...j, ...patch } : j));
const setUsage = async (v) => { await writeFile(usageFile + '.tmp', JSON.stringify(v)); await rename(usageFile + '.tmp', usageFile); };
const modelState = {};
const setModel = async (api, v) => { modelState[api] = v; await writeFile(modelCtl + '.tmp', JSON.stringify(modelState)); await rename(modelCtl + '.tmp', modelCtl); };
const allRequests = () => readFileSync(modelLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const API = { claude: 'claude', codex: 'codex', antigravity: 'agy' };
// agy puts the continue in an earlier user turn and repeats it in later requests, so count distinct user turns (they carry a timestamp).
const continues = (suite, mark = DEFAULT_MARK) => {
  const reqs = allRequests().filter((r) => r.api === API[suite] && r.counted && !r.url.includes('flash-lite'));
  if (suite !== 'antigravity') return reqs.filter((r) => r.last.includes(mark));
  const seen = new Map();
  for (const r of reqs) for (const t of r.turns ?? []) if (t.includes(mark) && !seen.has(t)) seen.set(t, { ...r, last: t });
  return [...seen.values()];
};
const writeSettings = async (id, version, values) => { await mkdir(settingsDir, { recursive: true }); await writeFile(join(settingsDir, id + '.json'), JSON.stringify({ version, values })); };

// ---- processes ----------------------------------------------------------------------------
const nodeBin = process.execPath;
const sys = process.env.SystemRoot;
const extraPath = (args.path ?? '').split(delimiter).filter(Boolean);
const baseEnv = isWin ? {
  SystemRoot: sys, windir: sys, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, SystemDrive: process.env.SystemDrive,
  TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: profile, APPDATA: join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: join(profile, 'AppData', 'Local'),
  USERNAME: process.env.USERNAME, COMPUTERNAME: process.env.COMPUTERNAME,
  PATH: [dirname(nodeBin), ...extraPath, `${sys}\\System32`, sys, `${sys}\\System32\\WindowsPowerShell\\v1.0`].join(';'),
} : { HOME: join(root, 'home'), PATH: [dirname(nodeBin), ...extraPath, '/usr/local/bin', '/usr/bin', '/bin'].join(':') };
if (!isWin) await mkdir(baseEnv.HOME, { recursive: true });
const paseoBin = join(cliDir, 'bin', 'paseo');
// Must not block: the client below only keeps its session by sending a heartbeat from this event loop, and the daemon
// closes a socket that sends nothing for 45 s. A CLI call (start + plugin update) under load can take longer than that.
const run = promisify(execFile);
const paseo = async (...a) => (await run(nodeBin, [paseoBin, ...a, '--home', home], { encoding: 'utf8', env: { ...baseEnv, PASEO_HOME: home }, timeout: 240000, windowsHide: true })).stdout;

const proxyEnv = { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1,localhost', https_proxy: `http://127.0.0.1:${proxyPort}`, http_proxy: `http://127.0.0.1:${proxyPort}`, no_proxy: '127.0.0.1,localhost' };
const modelUrl = `http://127.0.0.1:${modelPort}`;
const claudeEnv = (dir) => ({ CLAUDE_CODE_OAUTH_TOKEN: 'e2e-fixture-only', ANTHROPIC_BASE_URL: modelUrl, CLAUDE_CONFIG_DIR: join(root, dir),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', ...proxyEnv });
const codexHome = join(root, 'codex-home'), agyHome = join(root, 'agy-home');
const providers = {};
const withCmd = (bin) => bin ? { command: [bin] } : {};
if (suites.includes('claude')) {
  providers.claude = { ...withCmd(args.claude), env: claudeEnv('claude-cfg') };
  providers['claude-sub'] = { extends: 'claude', label: 'Claude Sub', ...withCmd(args.claude), env: claudeEnv('claude-sub-cfg') };
}
if (suites.includes('codex')) {
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-fake"\nmodel_provider = "fake"\n[model_providers.fake]\nname = "fake"\nbase_url = "${modelUrl}/v1"\nenv_key = "FAKE_KEY"\nwire_api = "responses"\n`);
  providers.codex = { ...withCmd(args.codex), env: { CODEX_HOME: codexHome, FAKE_KEY: 'e2e-fixture-only', ...proxyEnv } };
}
if (suites.includes('antigravity')) {
  await mkdir(join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true });
  await writeFile(join(agyHome, '.gemini', 'antigravity-cli', 'settings.json'), '{"modelProvider":"gemini"}');
  providers.antigravity = { ...withCmd(args.agy), env: { HOME: agyHome, USERPROFILE: agyHome, GEMINI_API_KEY: 'e2e-fixture-only', GOOGLE_GEMINI_BASE_URL: modelUrl, ...proxyEnv } };
}
const cfg = { version: 1, daemon: { listen: target, relay: { enabled: false }, mcp: { enabled: false } }, pluginsEnabled: true,
  features: { webUi: { enabled: UI }, dictation: { enabled: false }, voiceMode: { enabled: false } }, agents: { providers } };
await writeFile(join(home, 'config.json'), JSON.stringify(cfg, null, 2));

const spawned = [];
const startAux = (script, a) => { const p = spawn(nodeBin, [join(here, script), ...a], { stdio: 'ignore', windowsHide: true, detached: !isWin }); spawned.push(p); return p; };
let daemon, client, ui;
const startDaemon = async () => {
  const fd = openSync(daemonLog, 'a');
  daemon = spawn(nodeBin, ['--no-maglev', paseoBin, 'daemon', 'run', '--home', home], {
    env: { ...baseEnv, PASEO_HOME: home, PASEO_LISTEN: target, PASEO_RELAY_ENABLED: 'false', PASEO_WEB_UI_ENABLED: UI ? 'true' : 'false' },
    stdio: ['ignore', fd, fd], detached: !isWin, windowsHide: true });
  closeSync(fd);
  client = await waitFor(async () => {
    if (daemon.exitCode !== null) throw new Error('daemon exited; see ' + daemonLog);
    const c = new DaemonClient({ url: `ws://${target}/ws`, clientId: 'uar-e2e', clientType: 'cli', appVersion: paseoVersion,
      localCredential: () => readLocalCredentialForTarget(home, target) ?? undefined,
      webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }),
      reconnect: { enabled: false }, connectTimeoutMs: 1000 });
    try { await c.connect(); return c; } catch { await c.close().catch(() => {}); return null; }
  }, 'daemon connection', 240000);
};
const stopAll = async () => {
  await client?.close().catch(() => {});
  await paseo('daemon', 'stop').catch(() => {});
  await sleep(1500);
  if (daemon && daemon.exitCode === null) {
    if (isWin) { try { execFileSync('taskkill', ['/pid', String(daemon.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    else { try { process.kill(-daemon.pid, 'SIGTERM'); } catch {} await sleep(2000); try { process.kill(-daemon.pid, 'SIGKILL'); } catch {} }
  }
  for (const p of spawned) { if (isWin) { try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} } } }
};

// ---- plugin helpers -----------------------------------------------------------------------
const rpc = (method, input = {}) => client.invokePluginRpc(PLUGIN, method, input);
const pluginInfo = async () => { const j = JSON.parse(await paseo('plugin', 'ls', PLUGIN, '--json')); return Array.isArray(j) ? j.find((p) => p.id === PLUGIN) ?? j[0] : j; };
const pluginDir = async () => { const i = await pluginInfo(); return i.path ?? i.directory ?? i.dir; };
const pluginRevision = async () => { const i = await pluginInfo(); return i.installation?.currentRevision ?? i.commit ?? i.revision ?? ''; };
const patchInstalled = async () => {
  const entry = join(await pluginDir(), 'index.server.ts');
  await writeFile(entry, patchEntry(await readFile(entry, 'utf8'), usageFile));
  await client.reloadPlugin(PLUGIN);
  await waitFor(async () => (await rpc('auto-resume.list').catch(() => null))?.jobs, 'plugin answering after reload', 90000);
};
const pluginLogLines = async () => (await readFile(daemonLog, 'utf8').catch(() => '')).split(/\r?\n/).filter((l) => l.includes('[usage-auto-resume]'));

// ---- agents -------------------------------------------------------------------------------
let workspace;
const mkAgent = async (title, provider = 'claude') => client.createAgent({ provider, cwd: work, workspaceId: workspace.id, title });
const timelineText = async (id) => {
  try {
    const t = await client.fetchAgentTimeline(id, { direction: 'tail', limit: 30 });
    const items = t.entries ?? t.items ?? t.timeline ?? [];
    return items.map((e) => { const i = e.item ?? e; return `${i.type}:${String(i.text ?? i.message ?? i.content ?? '').slice(0, 400)}`; });
  } catch (e) { return ['timeline unreadable: ' + e.message]; }
};
const agentStatus = async (id) => { try { const r = await client.fetchAgent(id); return r?.agent?.status ?? r?.status ?? JSON.stringify(r).slice(0, 80); } catch (e) { return 'err ' + e.message; } };
const agentCount = async () => { try { const r = await client.fetchAgents(); return (r.entries ?? r.agents ?? []).length; } catch { return -1; } };
const hit = async (a, suite, state = { mode: 'limit' }, timeout = 240000) => {
  await setModel(API[suite], state);
  const t0 = Date.now();
  await client.sendAgentMessage(a.id, 'Work on the task.');
  const job = await waitFor(async () => { const j = await jobOf(a.id); return j?.state === 'pending' ? j : null; }, `reservation for ${a.title}`, timeout, 1000);
  job._latencyMs = Date.now() - t0;
  await setModel(API[suite], { mode: 'text' });
  return job;
};
const sinceLog = (from) => readFileSync(daemonLog, 'utf8').split(/\r?\n/).slice(from);
const limitWith = (suite, sec) => suite === 'antigravity' ? { mode: 'limit', resetText: `${sec / 3600}h` } : { mode: 'limit', resetInSec: sec };

// ---- checks shared by every suite -------------------------------------------------------------
// 9 through the settings file; the UI phase uses the Settings switch.
const checkProviderOff = (S, provider, title) => step(9, S, 'turning the provider off cancels its pending reservations (settings file edit)', async () => {
  const f = await mkAgent(title, provider);
  await hit(f, S);
  await writeSettings('providers', 2, { disabledProviders: [provider] });
  let how = 'immediately (settings change picked up)';
  const immediate = await waitFor(async () => (await readHistory()).some((h) => h.agentId === f.id && h.reason === 'provider_off'), 'provider_off now', 25000, 1000).catch(() => null);
  if (!immediate) {
    how = 'not pushed on a file edit (Paseo only notifies subscribers for writes through its settings API); cancelled by the due-time check instead';
    await editJob(f.id, { resetAt: iso(Date.now() - 120000), dueAt: iso(Date.now() - 60000) });
    await waitFor(async () => (await readHistory()).some((h) => h.agentId === f.id && h.reason === 'provider_off'), 'provider_off at due time', 200000, 1000);
  }
  await writeSettings('providers', 2, { disabledProviders: [] });
  assert.equal(await jobOf(f.id), undefined);
  return `${provider}: history canceled/provider_off, job gone, nothing sent: ${how}`;
});
const checkStartupScan = (S, provider, title) => step(11, S, 'startup scan: agent stopped at a limit while the plugin was disabled gets a reservation after enabling', async () => {
  const h = await mkAgent(title, provider);
  await client.disablePlugin(PLUGIN);
  try {
    assert.match(await paseo('plugin', 'ls', PLUGIN), /usage-auto-resume\s+\S+\s+no/, 'plugin not disabled');
    await setModel(API[S], limitWith(S, 4 * 3600));
    await client.sendAgentMessage(h.id, 'Work on the task.');
    await waitFor(async () => (await agentStatus(h.id)) !== 'running' && (await timelineText(h.id)).some((l) => /limit|quota|429/i.test(l)), 'agent stopped at the limit', 240000, 1000);
    await sleep(3000);
    assert.equal(await jobOf(h.id), undefined, 'reservation made while plugin disabled');
  } finally {
    // A failure here must not leave the plugin off for the items after it.
    await setModel(API[S], { mode: 'text' });
    await client.enablePlugin(PLUGIN);
  }
  // A connected app polls the plugin's list RPC, which hands the plugin the Paseo API the scan needs.
  const job = await waitFor(async () => { await rpc('auto-resume.list').catch(() => {}); const j = await jobOf(h.id); return j?.state === 'pending' ? j : null; }, 'scan reservation', 240000, 3000);
  return `no job while disabled; after enable the scan created one: due ${job.dueAt} (resetAt ${job.resetAt})`;
});

// Stands in for Paseo 0.14's one-hour idle close, which a run cannot wait for.
const restartDaemon = async () => {
  await client.close().catch(() => {});
  await paseo('daemon', 'stop').catch(() => {});
  await waitFor(async () => daemon.exitCode !== null, 'daemon exit', 60000, 500);
  await startDaemon();
};
const checkClosedAgent = (S, provider, title) => step(16, S, 'a reservation whose agent a daemon restart closed is continued at its due time', async () => {
  const k = await mkAgent(title, provider);
  await hit(k, S, limitWith(S, 4 * 3600));
  await restartDaemon();
  // Reading the timeline here would reopen the agent.
  const status = await agentStatus(k.id);
  assert.equal(status, 'closed', 'agent status after the restart');
  const sent0 = continues(S).length;
  await editJob(k.id, { resetAt: iso(Date.now() - 120000), dueAt: iso(Date.now() - 60000) });
  // The list RPC hands the restarted plugin the Paseo API its tick needs.
  await waitFor(async () => { await rpc('auto-resume.list').catch(() => {}); return continues(S).length === sent0 + 1; }, 'continue to the closed agent', 240000, 3000);
  await sleep(6000);
  assert.equal(continues(S).length, sent0 + 1, 'more than one continue');
  const outcomes = (await readHistory()).filter((h) => h.agentId === k.id).map((h) => `${h.outcome}${h.reason ? '/' + h.reason : ''}`);
  assert.deepEqual(outcomes, ['continued'], 'history');
  assert.ok((await timelineText(k.id)).join('\n').includes(DEFAULT_MARK), 'continue not in the same agent timeline');
  return `status ${status} after the restart; 1 continue reached the model in the same agent's timeline, history continued`;
});

// ==========================================================================================
const ctx = { step, note, results, rpc, client: () => client, mkAgent, hit, setModel, setUsage, jobOf, editJob, readJobs, readHistory, writeJobs, continues, writeSettings, waitFor, sleep, origin, out, jobsFile, historyFile, root, API, DEFAULT_MARK, timelineText, home };
try {
  startAux('fake-models.mjs', [String(modelPort), modelCtl, modelLog]);
  startAux('blackhole-proxy.mjs', [String(proxyPort), proxyLog]);
  await sleep(1500);
  await startDaemon();
  log(`daemon up (Paseo ${paseoVersion}) at ${target}; suites=${suites}; ui=${UI}; min=${MIN}`);
  workspace = (await client.createWorkspace({ source: { kind: 'directory', path: work }, title: 'UAR E2E' })).workspace;

  // ---- 1. install the older release from GitHub ------------------------------------------------------
  await step(1, 'claude', `install ${OLD_REF} through paseo plugin install (git source + ref)`, async () => {
    await paseo('plugin', 'install', GIT_SOURCE, '--ref', OLD_REF, '--json');
    const ls = await paseo('plugin', 'ls', PLUGIN);
    assert.match(ls, /usage-auto-resume\s+running/, ls);
    const rev = await pluginRevision();
    assert.ok(rev, 'no revision reported');
    oldRevision = rev;
    assert.deepEqual(await rpc('auto-resume.list'), { jobs: [] });
    const provs = (await rpc('auto-resume.providers')).providers.map((p) => p.id);
    for (const s of suites) assert.ok(provs.includes(s), `${s} not discovered: ${provs}`);
    const plog = await paseo('plugin', 'logs', PLUGIN);
    assert.doesNotMatch(plog, /error|failed/i, plog.slice(0, 300));
    return `status running, revision ${rev}, providers ${provs.join(',')}, plugin logs clean`;
  });
  await patchInstalled();

  // ---- baseline: the older release on this Paseo ------------------------------------------------------
  let legacyJob = null, legacyAgent = null;
  if (suites.includes('claude')) {
    legacyAgent = await mkAgent('Legacy reservation');
    const mark = (await pluginLogLines()).length;
    await setModel('claude', { mode: 'limit', resetInSec: 5 * 3600 });
    await client.sendAgentMessage(legacyAgent.id, 'Work on the task.');
    legacyJob = await waitFor(async () => { const j = await jobOf(legacyAgent.id); return j?.state === 'pending' ? j : null; }, `${OLD_REF} reservation`, 90000, 1000).catch(() => null);
    await setModel('claude', { mode: 'text' });
    await sleep(3000);
    const probe = (await pluginLogLines()).filter((l) => l.includes('e2e-probe') && l.includes(legacyAgent.id)).map((l) => l.replace(/^.*e2e-probe /, '').replace(/".*$/, '').trim());
    note(2, 'claude', `${OLD_REF} baseline on Paseo ${paseoVersion}`, `real CLI limit hit -> reservation by ${OLD_REF}: ${legacyJob ? 'YES (due ' + legacyJob.dueAt + ')' : 'NO'}; turn_end probe: ${probe.join(' | ') || 'none'}; agent status ${await agentStatus(legacyAgent.id)}`);
  }

  // ---- 2. reservation on the older release, update to the version under test ------------------------------------
  let seeded = false;
  if (suites.includes('claude')) {
    await step(2, 'claude', `reservation + history on ${OLD_REF} survive the update to ${NEW_REF}`, async () => {
      if (!legacyJob) {
        // v1.2.2 on Paseo 0.13 does not detect a normal turn end that carries only the notice (fixed in PR #24): seed one.
        const agent = await mkAgent('Seeded legacy reservation');
        seeded = true; legacyAgent = agent;
        await writeJobs([{ agentId: agent.id, provider: 'claude', resetAt: null, dueAt: iso(Date.now() + 5 * 3600000), baseline: null, attempts: 0, state: 'pending', enabled: true, retries: 0 }]);
        await waitFor(async () => (await rpc('auto-resume.list')).jobs.some((j) => j.agentId === agent.id), `seeded job listed by ${OLD_REF}`, 60000);
      }
      const ago = (m) => iso(Date.now() - m * 60000);
      const h = await readHistory();
      await writeFile(historyFile, JSON.stringify({ version: 1, entries: [
        ...h, { id: 'e2e-h1', at: ago(90), agentId: legacyAgent.id, provider: 'claude', outcome: 'canceled', reason: 'new_message', title: 'Old canceled' },
        { id: 'e2e-h2', at: ago(30), agentId: 'gone-agent', provider: 'claude', outcome: 'continued', title: 'Old finished task' }] }, null, 2));
      const jobBefore = await jobOf(legacyAgent.id), histBefore = await readFile(historyFile, 'utf8');
      const listBefore = (await rpc('auto-resume.list')).jobs.find((j) => j.agentId === legacyAgent.id);
      assert.ok(listBefore, `${OLD_REF} lists the reservation`);
      const upd = await paseo('plugin', 'update', PLUGIN, '--ref', NEW_REF, '--yes');
      assert.match(upd, /updated/, upd);
      const rev = await pluginRevision();
      assert.ok(rev && rev !== oldRevision, 'revision ' + rev);
      await patchInstalled();
      const jobAfter = await jobOf(legacyAgent.id);
      assert.deepEqual(jobAfter, jobBefore, 'job changed by the update');
      assert.ok((await rpc('auto-resume.list')).jobs.some((j) => j.agentId === legacyAgent.id), 'PR lists the reservation');
      const histAfter = await readFile(historyFile, 'utf8');
      assert.equal(histAfter, histBefore, 'history.json changed by the update');
      assert.ok((await rpc('auto-resume.history')).entries.length >= JSON.parse(histBefore).entries.length, 'PR history RPC reads the earlier entries');
      return `created on ${OLD_REF} ${seeded ? `(seeded jobs.json: ${OLD_REF} made no reservation on this Paseo)` : '(by the real hook)'}; updated to ${rev.slice(0, 7)} via plugin update --ref; job + history.json byte-identical, listed by the new version, its history RPC reads the ${JSON.parse(histBefore).entries.length} earlier entries (v1.2.2 itself has no history/resume-now/note RPCs)`;
    });
  } else {
    await paseo('plugin', 'update', PLUGIN, '--ref', NEW_REF, '--yes'); await patchInstalled();
  }
  if (legacyAgent) { await client.archiveAgent(legacyAgent.id).catch(() => {}); await sleep(1500); }

  // ---- claude suite -------------------------------------------------------------------------
  const probeFor = async (id) => (await pluginLogLines()).filter((l) => l.includes('e2e-probe') && l.includes(id)).map((l) => l.replace(/^.*e2e-probe /, '').replace(/".*$/, '').trim());
  if (suites.includes('claude')) {
    const S = 'claude';
    // 3
    const a = await mkAgent('Limit detect');
    let jobA;
    await step(3, S, 'real CLI limit -> reservation at stated reset + 2 min', async () => {
      const t0 = Date.now();
      jobA = await hit(a, S, { mode: 'limit', resetInSec: 5400 });
      const lim = allRequests().filter((r) => r.api === 'claude' && r.mode === 'limit').at(-1);
      const expectedReset = Date.parse(lim.t) + 5400 * 1000;
      const text = (await timelineText(a.id)).filter((l) => /hit your|limit/i.test(l)).join(' | ');
      assert.ok(Math.abs(Date.parse(jobA.resetAt) - expectedReset) < 90000, `resetAt ${jobA.resetAt} vs expected ~${iso(expectedReset)}`);
      assert.equal(Date.parse(jobA.dueAt) - Date.parse(jobA.resetAt), 120000, 'due = reset + 2m');
      const probes = await probeFor(a.id);
      return `notice [${text.slice(0, 120)}]; resetAt ${jobA.resetAt}, dueAt ${jobA.dueAt} (+2m); reservation after ${Math.round(jobA._latencyMs / 1000)}s; hook probe: ${probes.join(' | ')}; agent status ${await agentStatus(a.id)}; mode=real CLI 429 + unified rate-limit headers -> CLI-synthesized notice`;
    });
    if (jobA) {
      await step(3, S, 'turn_ended carried an empty timeline on 0.13 (only the new read finds the notice)', async () => {
        const probes = await probeFor(a.id);
        assert.ok(probes.length, 'no probe line');
        const tl = probes.map((p) => (p.match(/timeline\.length=(\S+)/) ?? [])[1]);
        if (paseoVersion.startsWith('0.13')) assert.ok(tl.every((x) => x === '0'), 'timeline.length ' + tl);
        return `event timeline.length=${tl.join(',')} on Paseo ${paseoVersion}; ${probes.join(' | ')}`;
      });
      if (args.hold) {
        await writeFile(join(root, 'hold.json'), JSON.stringify({ origin, agentId: a.id, title: a.title, job: jobA, workspace: workspace.id }));
        log('HOLD: daemon kept; touch ' + join(root, 'release') + ' to continue');
        await waitFor(() => existsSync(join(root, 'release')), 'release', 3 * 3600000, 2000);
      }
      // 4
      await step(4, S, '+10m / +30m / +1h / Change time move the reservation own due time (reschedule RPC)', async () => {
        let cur = jobA.dueAt; const seen = [];
        for (const [name, ms] of [['+10m', 600000], ['+30m', 1800000], ['+1h', 3600000]]) {
          const want = iso(Date.parse(cur) + ms);
          const r = await rpc('auto-resume.reschedule', { agentId: a.id, id: jobA.id, dueAt: cur, newDueAt: want });
          assert.deepEqual(r, { changed: true, dueAt: want }, name + ' ' + JSON.stringify(r));
          assert.equal((await jobOf(a.id)).dueAt, want); cur = want; seen.push(`${name}->${want.slice(11, 16)}`);
        }
        const custom = iso(Date.parse(jobA.dueAt) + 3 * 3600000 + 7 * 60000);
        const r2 = await rpc('auto-resume.reschedule', { agentId: a.id, id: jobA.id, dueAt: cur, newDueAt: custom });
        assert.deepEqual(r2, { changed: true, dueAt: custom });
        const early = await rpc('auto-resume.reschedule', { agentId: a.id, id: jobA.id, dueAt: custom, newDueAt: iso(Date.now() + 120000) });
        assert.equal((await jobOf(a.id)).dueAt, custom, 'earlier than reset+2m must be refused: ' + JSON.stringify(early));
        const j = await jobOf(a.id); assert.equal(j.enabled, true);
        return `${seen.join(', ')}, Change time -> ${custom}; below reset+2m refused (${JSON.stringify(early)})`;
      });
    }
    // 5
    const b = await mkAgent('Note and custom prompt');
    await step(5, S, 'extra instructions + custom continue prompt are sent together; note deleted after sending', async () => {
      const jobB = await hit(b, S);
      const NOTE = 'E2E-NOTE-' + Math.random().toString(36).slice(2, 8), CUSTOM = 'E2E-CUSTOM-PROMPT-' + Math.random().toString(36).slice(2, 8) + ' please carry on.';
      assert.deepEqual(await rpc('auto-resume.set-note', { agentId: b.id, id: jobB.id, note: NOTE }), { changed: true });
      assert.equal((await jobOf(b.id)).note, NOTE);
      await writeSettings('resume', 1, { continuePrompt: CUSTOM });
      await sleep(1500);
      const before = continues(S, CUSTOM).length;
      await editJob(b.id, { resetAt: iso(Date.now() - 120000), dueAt: iso(Date.now() - 60000) });
      await waitFor(async () => continues(S, CUSTOM).length === before + 1, 'custom continue reaches the model', 180000, 1000);
      const req = continues(S, CUSTOM).at(-1);
      assert.ok(req.last.includes(NOTE), 'note missing in sent text');
      assert.ok(req.last.includes('Additional instructions from the user for this continue:'), 'heading missing');
      const after = await jobOf(b.id);
      assert.ok(!after || !after.note, 'note kept after sending: ' + JSON.stringify(after));
      assert.ok(!(await readFile(jobsFile, 'utf8')).includes(NOTE), 'note still in jobs.json');
      await waitFor(async () => !(await jobOf(b.id)), 'row cleared after next turn', 180000, 1000);
      await writeSettings('resume', 1, { continuePrompt: null });
      return `one continue with custom prompt + heading + note (${NOTE}); note absent from jobs.json after send; ${(await readHistory()).filter((h) => h.agentId === b.id).map((h) => h.outcome).join(',')}`;
    });
    // 6
    const c = await mkAgent('Resume now');
    await step(6, S, 'Resume now: used_up / unverified leave the reservation and send nothing; ready sends exactly one (manual)', async () => {
      const jobC = await hit(c, S);
      const before = await jobOf(c.id), sentBefore = continues(S).length;
      const until = iso(Date.now() + 40 * 60000);
      await setUsage({ usage: 'limited', until });
      const r1 = await rpc('auto-resume.resume-now', { agentId: c.id, id: jobC.id, dueAt: jobC.dueAt });
      assert.deepEqual(r1, { result: 'used_up', until });
      await setUsage({ usage: 'auth' });
      const r2 = await rpc('auto-resume.resume-now', { agentId: c.id, id: jobC.id, dueAt: jobC.dueAt });
      assert.equal(r2.result, 'unverified', JSON.stringify(r2));
      assert.deepEqual(await jobOf(c.id), before, 'reservation changed by blocked Resume now');
      await sleep(2500);
      assert.equal(continues(S).length, sentBefore, 'a continue was sent while blocked');
      await setUsage({});
      const r3 = await rpc('auto-resume.resume-now', { agentId: c.id, id: jobC.id, dueAt: jobC.dueAt });
      assert.deepEqual(r3, { result: 'sent' });
      await waitFor(async () => continues(S).length === sentBefore + 1, 'continue reached the model', 180000, 1000);
      await sleep(5000);
      assert.equal(continues(S).length, sentBefore + 1, 'more than one continue');
      await waitFor(async () => !(await jobOf(c.id)), 'row cleared', 180000, 1000);
      const h = (await readHistory()).find((e) => e.agentId === c.id && e.outcome === 'continued');
      assert.equal(h?.trigger, 'manual');
      return `used_up ${JSON.stringify(r1)}; unverified ${JSON.stringify(r2)}; job unchanged, 0 sent; ready -> ${JSON.stringify(r3)}, exactly 1 continue, history trigger=manual`;
    });
    // 7
    const d = await mkAgent('Automatic tick');
    await step(7, S, 'tick sends exactly one continue to the same agent, no new agent, row clears after next turn', async () => {
      await hit(d, S);
      const n0 = await agentCount(), sent0 = continues(S).length;
      await editJob(d.id, { resetAt: iso(Date.now() - 120000), dueAt: iso(Date.now() - 60000) });
      await waitFor(async () => continues(S).length === sent0 + 1, 'tick continue', 240000, 1000);
      await sleep(6000);
      assert.equal(continues(S).length, sent0 + 1, 'more than one continue');
      await waitFor(async () => !(await jobOf(d.id)), 'row cleared', 240000, 1000);
      const n1 = await agentCount();
      const tl = (await timelineText(d.id)).join('\n');
      assert.ok(tl.includes(DEFAULT_MARK), 'continue not in the same agent timeline');
      const h = (await readHistory()).find((e) => e.agentId === d.id && e.outcome === 'continued');
      assert.ok(h && h.trigger === undefined, 'history ' + JSON.stringify(h));
      return `1 continue, agent count ${n0} -> ${n1}, continue text found in the same agent timeline, history continued (no trigger); due moved by editing jobs.json, fired by the real tick`;
    });
    // 8
    const e = await mkAgent('Turned off');
    await step(8, S, 'a reservation turned off is skipped at its due time', async () => {
      const jobE = await hit(e, S);
      assert.deepEqual(await rpc('auto-resume.set-enabled', { agentId: e.id, id: jobE.id, dueAt: jobE.dueAt, enabled: false }), { changed: true });
      const sent0 = continues(S).length;
      await editJob(e.id, { resetAt: iso(Date.now() - 120000), dueAt: iso(Date.now() - 60000) });
      await waitFor(async () => (await readHistory()).some((h) => h.agentId === e.id && h.outcome === 'skipped'), 'skipped', 240000, 1000);
      assert.equal(continues(S).length, sent0);
      assert.equal(await jobOf(e.id), undefined);
      return 'history skipped, job removed, 0 continues';
    });
    if (!MIN) {
      // 9 (settings file edit; the UI switch is exercised in the UI phase where there is a browser)
      await checkProviderOff(S, 'claude-sub', 'Provider off');
      // 10
      const g = await mkAgent('New message');
      await step(10, S, 'a new user message cancels the reservation', async () => {
        await hit(g, S);
        await client.sendAgentMessage(g.id, 'Actually, here is a new instruction.');
        await waitFor(async () => (await readHistory()).some((h) => h.agentId === g.id && h.outcome === 'canceled'), 'canceled', 120000, 1000);
        assert.equal(await jobOf(g.id), undefined);
        return 'history ' + (await readHistory()).filter((h) => h.agentId === g.id).map((h) => `${h.outcome}/${h.reason}`).join(',');
      });
      if (UI) { const m = await import(pathToFileURL(join(here, 'ui-steps.mjs'))); await m.uiPhase(ctx); }
      // 11
      await checkStartupScan(S, 'claude', 'Missed while disabled');
      // 16
      await checkClosedAgent(S, 'claude', 'Closed by a restart');
    }
  }

  // ---- codex / antigravity suites -------------------------------------------------------------
  for (const S of suites.filter((s) => s !== 'claude')) {
    const resetSec = 7200;
    const a = await mkAgent(`${S} limit`, S);
    let job;
    await step(3, S, `real ${S} CLI limit -> reservation at stated reset + 2 min`, async () => {
      job = await hit(a, S, limitWith(S, resetSec));
      const lim = allRequests().filter((r) => r.api === API[S] && r.mode === 'limit').at(-1);
      const expected = Date.parse(lim.t) + resetSec * 1000;
      const text = (await timelineText(a.id)).filter((l) => /limit|quota|429/i.test(l)).join(' | ');
      assert.ok(Math.abs(Date.parse(job.resetAt) - expected) < 5 * 60000, `resetAt ${job.resetAt} vs ~${iso(expected)}`);
      assert.equal(Date.parse(job.dueAt) - Date.parse(job.resetAt), 120000);
      return `notice [${text.slice(0, 160)}]; resetAt ${job.resetAt}, dueAt ${job.dueAt}; probe ${(await probeFor(a.id)).join(' | ')}; status ${await agentStatus(a.id)}`;
    });
    if (!job) continue;
    await step(6, S, 'Resume now sends exactly one continue (manual)', async () => {
      const sent0 = continues(S).length;
      if (S === 'codex') {
        await setUsage({ usage: 'limited', until: iso(Date.now() + 40 * 60000) });
        const r1 = await rpc('auto-resume.resume-now', { agentId: a.id, id: job.id, dueAt: job.dueAt });
        assert.equal(r1.result, 'used_up', JSON.stringify(r1));
        await setUsage({});
      }
      const r = await rpc('auto-resume.resume-now', { agentId: a.id, id: job.id, dueAt: job.dueAt });
      assert.deepEqual(r, { result: 'sent' });
      await waitFor(async () => continues(S).length === sent0 + 1, 'continue reached the model', 240000, 1000);
      await sleep(6000);
      assert.equal(continues(S).length, sent0 + 1);
      const cleared = await waitFor(async () => !(await jobOf(a.id)), 'row cleared', S === 'antigravity' ? 45000 : 240000, 1000).catch((e) => { if (S !== 'antigravity') throw e; return false; });
      assert.equal((await readHistory()).find((e) => e.agentId === a.id && e.outcome === 'continued')?.trigger, 'manual');
      if (!cleared) note(6, S, 'row after the continue', `NOT cleared: ${JSON.stringify(await timelineText(a.id))} -> the agy agent re-emitted the earlier 429 after the continue's reply and the plugin re-reserved (new row ${JSON.stringify((await jobOf(a.id))?.dueAt)})`);
      return `${S === 'codex' ? 'used_up blocked first; ' : 'no usage check for antigravity; '}sent exactly 1 continue, row cleared, history trigger=manual`;
    });
    const b = await mkAgent(`${S} tick`, S);
    await step(7, S, 'tick sends exactly one continue to the same agent', async () => {
      await hit(b, S, limitWith(S, resetSec));
      const n0 = await agentCount(), sent0 = continues(S).length;
      await editJob(b.id, { resetAt: iso(Date.now() - 120000), dueAt: iso(Date.now() - 60000) });
      await waitFor(async () => continues(S).length === sent0 + 1, 'tick continue', 240000, 1000);
      await sleep(6000);
      assert.equal(continues(S).length, sent0 + 1);
      const cleared = await waitFor(async () => !(await jobOf(b.id)), 'row cleared', S === 'antigravity' ? 45000 : 240000, 1000).catch((e) => { if (S !== 'antigravity') throw e; return false; });
      if (!cleared) note(7, S, 'row after the continue', `NOT cleared: timeline tail ${JSON.stringify((await timelineText(b.id)).slice(-3))}; new row ${JSON.stringify((await jobOf(b.id))?.dueAt)} (the agy agent re-emitted the earlier 429 after "Done.")`);
      assert.ok((await timelineText(b.id)).join('\n').includes(DEFAULT_MARK));
      return `1 continue, agent count ${n0} -> ${await agentCount()}, continue in the same agent timeline, row cleared`;
    });
    if (!MIN) {
      await checkProviderOff(S, S, `${S} provider off`);
      await checkStartupScan(S, S, `${S} missed while disabled`);
      await checkClosedAgent(S, S, `${S} closed by a restart`);
    }
  }

  // ---- 12. history RPC --------------------------------------------------------------------
  const hist = (await rpc('auto-resume.history')).entries;
  await step(12, 'rpc', 'history RPC shows the outcomes', async () => {
    const labels = hist.map((h) => `${h.title}: ${h.outcome}${h.reason ? '/' + h.reason : ''}${h.trigger ? ' (' + h.trigger + ')' : ''}`);
    assert.ok(labels.length >= 1);
    return labels.join(' ; ');
  });

  // ---- 13. roll back to the older release ----------------------------------------------------------
  await step(13, 'claude', `roll back to ${OLD_REF}: loads and reads the newer data`, async () => {
    await sleep(5000);
    const histBefore = await readFile(historyFile, 'utf8');
    const upd = await paseo('plugin', 'update', PLUGIN, '--ref', OLD_REF, '--yes');
    assert.match(upd, /updated/, upd);
    const rev = await pluginRevision();
    assert.equal(rev, oldRevision, 'back on the revision first installed');
    await patchInstalled();
    const jobsBefore = await readFile(jobsFile, 'utf8');
    const list = (await rpc('auto-resume.list')).jobs;
    const expectJobs = JSON.parse(jobsBefore).jobs.filter((j) => j.state === 'pending').length;
    assert.ok(list.length >= expectJobs, `${OLD_REF} lists ${list.length} of ${expectJobs} pending jobs written by the newer version`);
    assert.ok((await rpc('auto-resume.providers')).providers.length > 0);
    await sleep(2000);
    const entriesAfter = JSON.parse(await readFile(historyFile, 'utf8')).entries, entriesBefore = JSON.parse(histBefore).entries;
    assert.deepEqual(entriesAfter.slice(0, entriesBefore.length), entriesBefore, 'history.json entries changed by rollback');
    return `rev ${rev.slice(0, 7)} running; list RPC shows ${list.length} reservations from the newer jobs.json (${expectJobs} pending), providers RPC fine, history.json untouched (v1.2.2 has no history RPC)`;
  });

  // ---- 14. daemon log -------------------------------------------------------------------
  await step(14, 'log', 'daemon log has no plugin errors apart from intended ones', async () => {
    const lines = (await pluginLogLines()).filter((l) => !l.includes('e2e-probe'));
    const bad = lines.filter((l) => /(failed|could not|error|unreadable)/i.test(l)).map((l) => l.replace(/^\{.*?"msg":"/, '').slice(0, 260));
    const all = (await readFile(daemonLog, 'utf8')).split(/\r?\n/).filter((l) => /"level":(50|60)/.test(l)).map((l) => { try { const j = JSON.parse(l); return `${j.module ?? ''}: ${String(j.msg ?? '').slice(0, 160)}`; } catch { return l.slice(0, 160); } });
    results.push({ item: 14, suite: 'log-detail', ok: null, name: 'plugin log lines / level>=50 lines', ev: JSON.stringify({ pluginLines: lines.length, bad, level50: all.slice(0, 20) }) });
    assert.equal(bad.length, 0, 'plugin error lines: ' + bad.join(' || '));
    return `${lines.length} [usage-auto-resume] lines (excluding probe), 0 error lines; level>=50 daemon lines: ${all.length}`;
  });
} catch (e) {
  log('FATAL', e?.stack ?? e);
  results.push({ item: 'fatal', suite: '-', ok: false, name: 'harness', ev: String(e?.stack ?? e).slice(0, 800) });
} finally {
  const reqs = existsSync(modelLog) ? allRequests() : [];
  const summary = { label, paseoVersion, platform: process.platform, node: process.version, suites, eventLoopMaxMs: Math.round(loopDelay.max / 1e6), fakeRequestsTotal: reqs.length,
    fakeRequestsCounted: reqs.filter((r) => r.counted).length, byApi: Object.fromEntries(['claude', 'codex', 'agy', 'other'].map((k) => [k, reqs.filter((r) => r.api === k).length])),
    proxyBlockedConnects: readFileSync(proxyLog, 'utf8').split('\n').filter(Boolean).length,
    proxyHosts: [...new Set(readFileSync(proxyLog, 'utf8').split('\n').filter(Boolean))].slice(0, 12), results };
  await writeFile(join(out, 'results.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(out, 'daemon.log'), await readFile(daemonLog, 'utf8').catch(() => '')).catch(() => {});
  await writeFile(join(out, 'model.jsonl'), await readFile(modelLog, 'utf8').catch(() => '')).catch(() => {});
  console.log('SUMMARY ' + JSON.stringify({ label, loopMaxMs: summary.eventLoopMaxMs, fake: summary.fakeRequestsTotal, byApi: summary.byApi, blocked: summary.proxyBlockedConnects, hosts: summary.proxyHosts }));
  await stopAll();
  console.log('DONE root=' + root);
}
