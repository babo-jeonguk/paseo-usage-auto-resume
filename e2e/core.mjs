// Shared mechanics for the manual runners. Scenarios stay with the clients that drive them.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { modelServer } from './fake-models.mjs';
import { refusingProxy } from './blackhole-proxy.mjs';

export { sleep };
export const PLUGIN = 'usage-auto-resume';
export const SOURCE = 'git:babo-jeonguk/paseo-usage-auto-resume';
export const DEFAULT_MARK = 'Continue the unfinished work from where it stopped.';
export const isWin = process.platform === 'win32';
export const run = promisify(execFile);
export const iso = ms => new Date(ms).toISOString();
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export function options(required, defaults, argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(['node', basename(process.argv[1]), ...required.map(key => `--${key} <value>`),
      ...Object.keys(defaults).map(key => `[--${key} <value>]`)].join(' '));
    process.exit(0);
  }
  const result = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], key = flag.slice(2), value = argv[i + 1];
    assert(flag.startsWith('--') && (required.includes(key) || Object.hasOwn(defaults, key)), `Unknown option: ${flag}`);
    assert(value && !value.startsWith('--'), `Missing value: ${flag}`);
    assert(!result.has(key), `Repeated option: ${flag}`);
    result.set(key, value);
  }
  for (const key of required) assert(result.has(key), `Specify --${key} (see e2e/README.md)`);
  return { ...defaults, ...Object.fromEntries(result) };
}

export async function waitFor(fn, what, timeout = 180_000, interval = 500) {
  const deadline = performance.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await sleep(Math.min(remaining, interval));
  } while (performance.now() < deadline);
  throw new Error('Timeout: ' + what);
}

export async function withDeadline(action, what, timeout) {
  const timer = new AbortController();
  try {
    return await Promise.race([
      action(),
      sleep(timeout, undefined, { signal: timer.signal }).then(() => { throw new Error('Timeout: ' + what); }),
    ]);
  } finally {
    timer.abort();
  }
}

export async function listen(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      done();
    });
  });
  return {
    port: server.address().port,
    close: () => new Promise(done => {
      server.close(done);
      for (const socket of sockets) socket.destroy();
    }),
  };
}

export async function freePort() {
  const server = await listen(createServer());
  await server.close();
  return server.port;
}

export async function replace(path, text) {
  await writeFile(path + '.tmp', text);
  // Windows can temporarily refuse a rename while another process reads the file.
  for (const until = Date.now() + 10_000; ; await sleep(100)) {
    try { return await rename(path + '.tmp', path); }
    catch (error) {
      if (!isWin || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() > until) throw error;
    }
  }
}

export async function startProxy(log) {
  await writeFile(log, '');
  const server = await listen(refusingProxy(log));
  const url = `http://127.0.0.1:${server.port}`;
  const hits = () => readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
  const bypass = '127.0.0.1,localhost,::1';
  return { ...server, url, hits, env: { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: bypass, no_proxy: bypass } };
}

export async function runHome(root, extraPath = '') {
  const home = join(root, 'paseo'), profile = join(root, isWin ? 'profile' : 'home'), work = join(root, 'work');
  const temp = join(root, 'tmp');
  await Promise.all([home, profile, work, temp].map(dir => mkdir(dir, { recursive: true })));
  const sys = process.env.SystemRoot;
  const path = [dirname(process.execPath), ...extraPath.split(delimiter).filter(Boolean)];
  const cache = isWin ? join(profile, 'AppData', 'Local') : join(profile, '.cache');
  const windows = ['ComSpec', 'PATHEXT', 'SystemDrive', 'USERNAME', 'COMPUTERNAME', 'PSModulePath', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
  const env = isWin ? {
    ...inherited(windows), SystemRoot: sys, windir: sys, TEMP: temp, TMP: temp, HOME: profile, USERPROFILE: profile,
    APPDATA: join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: cache,
    PATH: [...path, join(sys, 'System32'), sys, join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(delimiter),
  } : {
    ...inherited(['TZ']), HOME: profile, TMPDIR: temp, XDG_CACHE_HOME: cache, LANG: 'C.UTF-8',
    PATH: [...path, '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
  };
  return { root, home, profile, work, cache, env };
}

export function inherited(keys) {
  return Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

export async function startModels(root) {
  const control = join(root, 'model.json'), log = join(root, 'model.jsonl');
  await writeFile(control, '{}');
  await writeFile(log, '');
  const server = await listen(modelServer(control, log));
  const state = {};
  return {
    ...server, log, url: `http://127.0.0.1:${server.port}`,
    requests: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
    set(api, value) { state[api] = value; return replace(control, JSON.stringify(state)); },
  };
}

export function providerEnvironment(modelUrl, proxyEnv) {
  return { ANTHROPIC_BASE_URL: modelUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', ...proxyEnv };
}

export const cliBin = cli => join(cli, 'bin', 'paseo');
export const paseoCommand = (bin, home, env) => async (...args) =>
  (await run(process.execPath, [bin(), ...args, '--home', home], { encoding: 'utf8', env: { ...env, PASEO_HOME: home }, timeout: 240_000, windowsHide: true })).stdout;

export async function connectToDaemon(cli, version, home, target, alive) {
  const tools = createRequire(join(resolve(cli), 'package.json'));
  const { DaemonClient } = await import(pathToFileURL(tools.resolve('@getpaseo/client/internal/daemon-client')));
  const { readLocalCredentialForTarget } = await import(pathToFileURL(tools.resolve('@getpaseo/server/daemon-control')));
  const { WebSocket } = tools('ws');
  return waitFor(async () => {
    assert(alive(), 'Paseo exited before the daemon connection was ready');
    const client = new DaemonClient({ url: `ws://${target}/ws`, clientId: 'uar-e2e', clientType: 'cli', appVersion: version,
      localCredential: () => readLocalCredentialForTarget(home, target) ?? undefined,
      webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }),
      reconnect: { enabled: false }, connectTimeoutMs: 1000 });
    try { await client.connect(); return client; }
    catch { await client.close().catch(() => {}); return null; }
  }, 'daemon connection', 240_000);
}

export async function installedPlugin(paseo) {
  const listing = JSON.parse(await paseo('plugin', 'ls', PLUGIN, '--json'));
  const plugin = Array.isArray(listing) ? listing.find(entry => entry.id === PLUGIN) : listing;
  assert(plugin, `${PLUGIN} is missing from the plugin list`);
  return plugin;
}
export const revisionOf = plugin => plugin.installation?.currentRevision ?? plugin.commit ?? plugin.revision ?? '';
export const pluginDirectory = plugin => plugin.path ?? plugin.directory ?? plugin.dir;

export async function installPlugin(paseo, source, ref, env) {
  await paseo('plugin', 'install', source, '--ref', ref, '--json');
  const plugin = await installedPlugin(paseo);
  assert.equal(plugin.status, 'running', JSON.stringify(plugin));
  const revision = revisionOf(plugin);
  assert(revision, 'No installed revision reported');
  if (source.startsWith('git:')) {
    const { stdout } = await run('git', ['ls-remote', `https://github.com/${source.slice(4)}.git`, ref, `${ref}^{}`],
      { cwd: tmpdir(), env, timeout: 60_000, windowsHide: true });
    const rows = stdout.trim().split('\n').map(line => line.split(/\s+/));
    const expected = rows.find(([, name]) => name?.endsWith('^{}')) ?? rows[0];
    if (expected[0]) assert.equal(revision, expected[0]);
    else assert.equal(revision, ref, 'The requested branch, tag or full commit SHA must match the installed revision');
  }
  return plugin;
}

export async function patchInstalled({ paseo, client, patch }) {
  const entry = join(pluginDirectory(await installedPlugin(paseo)), 'index.server.ts');
  await writeFile(entry, patch(await readFile(entry, 'utf8')));
  await client.reloadPlugin(PLUGIN);
  await waitFor(async () => (await client.invokePluginRpc(PLUGIN, 'auto-resume.list', {}).catch(() => null))?.jobs,
    'plugin answering after reload', 90_000);
}

export function daemonErrors(text) {
  const plugin = [], daemon = [];
  for (const line of text.split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line); } catch {}
    const message = String(record?.output ?? record?.message ?? record?.msg ?? line);
    const own = record?.pluginId === PLUGIN || line.includes(`[${PLUGIN}]`);
    if (own && !/e2e-(probe|outcome)/.test(message) &&
        (record?.stream === 'stderr' || /failed|could not|error|unreadable/i.test(message))) plugin.push(message);
    if (record?.level >= 50 || ['error', 'fatal'].includes(record?.level)) daemon.push({ time: record.time, module: record.module, message, error: record.err, pluginId: record.pluginId });
  }
  return { plugin, daemon };
}

export function spawnLogged(command, args, { log, env, cwd }) {
  const fd = openSync(log, 'a');
  try {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', fd, fd], detached: !isWin, windowsHide: true });
    const onError = error => { child.launchError = error; };
    child.on('error', onError);
    return child;
  } finally { closeSync(fd); }
}
export function running(child) {
  if (child.launchError) throw child.launchError;
  return child.exitCode === null && child.signalCode === null;
}
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
export async function killTree(child) {
  if (!child?.pid) return;
  if (isWin) {
    if (pidAlive(child.pid)) await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15_000, windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await waitFor(() => !pidAlive(child.pid), `process ${child.pid} exit`, 15_000);
}

export async function saveReport(out, report, artifacts = {}) {
  for (const [name, path] of Object.entries(artifacts)) {
    try { await copyFile(path, join(out, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}

function describeFailure(error) {
  const status = error?.signal ? `Process signal: ${error.signal}` : '';
  return [String(error?.stack ?? error), status, String(error?.stderr ?? '').trim().slice(-2000)]
    .filter(Boolean).join('\n');
}

export async function nativeRun(platform, args, scenario) {
  await mkdir(resolve(args.out), { recursive: true });
  const out = await mkdtemp(join(resolve(args.out), `${platform}-`));
  const root = await mkdtemp(join(tmpdir(), `Usage Auto Resume ${platform} 한글 `));
  const report = { platform, os: process.platform, node: process.version, source: args.source, ref: args.to,
    startedAt: iso(Date.now()), root, result: 'running', checks: [], errors: [] };
  const artifacts = {};
  const cleanup = [];
  let screenshot;
  const ctx = {
    report, out, root, artifacts,
    dispose(fn) { cleanup.unshift(fn); },
    screenshots(fn) { screenshot = fn; },
    async check(name, fn) {
      const entry = { name, startedAt: iso(Date.now()) };
      report.checks.push(entry);
      await saveReport(out, report);
      try { entry.evidence = await fn(); entry.ok = true; console.log('OK', name); }
      catch (error) { entry.ok = false; throw error; }
      finally { await saveReport(out, report); }
    },
  };
  try { await scenario(ctx); }
  catch (error) {
    report.errors.push(describeFailure(error));
    if (screenshot) {
      try { await withDeadline(() => screenshot('failure'), 'failure screenshot', 60_000); }
      catch (error) { report.errors.push('Screenshot: ' + error.message); }
    }
  } finally {
    for (const stop of cleanup) {
      try { await stop(); } catch (error) { report.errors.push(describeFailure(error)); }
    }
  }
  if (!report.errors.length) {
    try {
      // Copy evidence before removing the temporary profile.
      await saveReport(out, report, artifacts);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) { report.errors.push(describeFailure(error)); }
  }
  report.result = report.errors.length ? 'failed' : 'passed';
  report.finishedAt = iso(Date.now());
  await saveReport(out, report, report.result === 'failed' ? artifacts : {});
  console.log(`${report.result} · ${out}`);
  if (report.errors.length) {
    console.error(report.errors.join('\n'), '\nTemporary profile:', root);
    process.exitCode = 1;
  }
}
