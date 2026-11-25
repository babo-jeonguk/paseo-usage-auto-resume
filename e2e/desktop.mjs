import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { freePort, inherited, isWin, iso, killTree, nativeRun, options, pidAlive, readJson,
  run, running, spawnLogged, startProxy, waitFor, withDeadline } from './core.mjs';
import { assertDesktopOffline, isOfflineRegistryFailure } from './desktop-network.mjs';
import { assertSubscriptionRequests, patchDesktopEntry, prepareLogins } from './desktop-subscription.mjs';
import { assertDaemonLogs, editSavedJobs, localClock, nativeDefaults, nativeFixture, tomorrowAtNoon } from './native-fixture.mjs';
import { scheduleWire } from './schedule-wire.mjs';
import { trackWindowsChildren } from './windows-process-tree.mjs';

const args = options(['cli', 'app', 'source', 'to'], {
  out: nativeDefaults.out, path: nativeDefaults.path, 'expect-platform': process.platform,
});
await nativeRun('desktop', args, async ctx => {
  const { root, out, report, artifacts, dispose, check } = ctx;
  assert(['linux', 'win32'].includes(process.platform), 'Desktop E2E requires Linux or Windows');
  assert.equal(process.platform, args['expect-platform'], 'Use Node on the requested native OS');
  const source = new URL(args.source);
  assert(source.protocol === 'file:' && !source.hostname, 'Use the local file URL produced by desktop-source.mjs');
  assert.match(args.to, /^[a-f0-9]{40}$/, 'Use the full verified commit from desktop-source.mjs');
  await check('The operating system rejects direct external TCP connections', assertDesktopOffline);
  assert(isWin || process.env.DISPLAY || process.env.WAYLAND_DISPLAY, 'Run under xvfb-run on a headless Linux host');
  const appDir = resolve(args.app);
  report.app = appDir;
  const executable = join(appDir, isWin ? 'Paseo.exe' : 'Paseo');
  const binary = await realpath(join(appDir, isWin ? 'Paseo.exe' : 'Paseo.bin'));
  await access(executable);
  assert(process.env.PW_ROOT, 'Set PW_ROOT to the node_modules directory containing playwright-core');
  const { chromium } = createRequire(join(resolve(process.env.PW_ROOT), '_e2e.cjs'))('playwright-core');
  const fixture = await nativeFixture(ctx, args);
  const wire = scheduleWire();
  const emails = await prepareLogins(fixture.profile);
  if (!isWin) await writeFile(join(fixture.profile, '.hushlogin'), '');
  await fixture.configure({
    claude: { env: fixture.claudeEnv },
    codex: { env: fixture.proxy.env },
  });
  const appProxyLog = join(root, 'electron-proxy.log');
  const appProxy = await startProxy(appProxyLog);
  dispose(() => appProxy.close());
  artifacts['electron-proxy.log'] = appProxyLog;
  const daemonLog = join(fixture.home, 'daemon.log');
  const fetchLog = join(root, 'subscription.jsonl');
  artifacts['daemon.log'] = daemonLog;
  artifacts['subscription.jsonl'] = fetchLog;
  await writeFile(fetchLog, '');
  report.pageErrors = [];
  report.appStartupRetries = [];
  const shutdowns = [];

  const display = inherited(['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']);
  const environment = {
    ...fixture.environment, ...display,
    PASEO_ELECTRON_USER_DATA_DIR: join(root, 'electron'),
    PASEO_ELECTRON_FLAGS: `--proxy-server=${appProxy.url} --proxy-bypass-list=localhost;127.0.0.1;[::1] --lang=en-US`,
  };
  const runtimeProbe = await run(binary, ['-e', `let sqlite;
    try { require('node:sqlite'); sqlite = { available: true }; }
    catch (error) { sqlite = { available: false, error: error.message }; }
    console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, sqlite }))`],
  { env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000, windowsHide: true });
  report.runtime = JSON.parse(runtimeProbe.stdout);
  assert(report.runtime.electron && report.runtime.node, 'Expected Electron bundled runtime');

  let app, browser, page, launch = 0;
  const windowsShutdown = new Map();
  const windowsRoots = new Map();
  const closeBrowser = () => withDeadline(() => browser?.close(), 'Electron CDP disconnect', 10_000);
  const daemonInstance = () => readJson(join(fixture.home, 'paseo.pid'));
  const shot = name => page?.screenshot({ path: join(out, name + '.png'), timeout: 10_000 });
  ctx.screenshots(async name => {
    if (!page) return;
    await shot(name);
    await writeFile(join(out, name + '.txt'), await page.locator('body').ariaSnapshot({ timeout: 5000 }));
  });
  async function startApp() {
    const port = await freePort();
    const appLog = join(root, `electron-${++launch}.log`);
    artifacts[`electron-${launch}.log`] = appLog;
    app = spawnLogged(executable, ['--no-sandbox', `--remote-debugging-port=${port}`], { env: environment, cwd: root, log: appLog });
    if (isWin) {
      const identity = (await processTable()).find(row => row.pid === app.pid);
      assert(running(app) && identity?.started, 'Identify the launched Windows Electron process');
      windowsRoots.set(identity.pid, identity.started);
    }
    browser = await waitFor(async () => {
      assert(running(app), 'Electron exited during startup');
      return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }).catch(() => null);
    }, 'Electron CDP');
    page = await waitFor(() => browser.contexts().flatMap(context => context.pages()).find(tab => tab.url().startsWith('paseo://')), 'Paseo window');
    page.setDefaultTimeout(30_000);
    page.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/ws') return;
      const observer = wire.connect();
      socket.on('framesent', ({ payload }) => observer.frame('sent', payload));
      socket.on('framereceived', ({ payload }) => observer.frame('received', payload));
      socket.once('close', observer.close);
    });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    const ready = page.getByText('New workspace', { exact: true }).first();
    const failure = page.getByText(/did not return a server id|failed to start/i).first();
    const skip = page.getByText('Skip setup', { exact: true });
    for (let attempt = 0; ; attempt++) {
      const state = await waitFor(async () => {
        if (await failure.isVisible()) return 'failed';
        if (await skip.isVisible()) await skip.click();
        return await ready.isVisible() ? 'ready' : null;
      }, 'Desktop daemon ready', 240_000);
      if (state === 'ready') break;
      assert(attempt < 3, 'Desktop daemon did not become ready after three retries');
      report.appStartupRetries.push({ launch, attempt: attempt + 1, message: await failure.innerText() });
      await shot(`startup-error-${launch}-${attempt + 1}`);
      await page.getByText('Retry', { exact: true }).click();
      await failure.waitFor({ state: 'hidden', timeout: 60_000 });
    }
    await fixture.attach(() => running(app));
  }
  async function assertManaged() {
    const instance = await daemonInstance();
    assert.equal(instance.desktopManaged, true);
    assert(Number.isSafeInteger(instance.pid) && instance.pid > 0, 'Desktop daemon PID');
    const executablePath = isWin
      ? (await run('powershell.exe', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${instance.pid}").ExecutablePath`], { timeout: 15_000, windowsHide: true })).stdout.trim()
      : `/proc/${instance.pid}/exe`;
    const daemonPath = await realpath(executablePath);
    assert.equal(isWin ? daemonPath.toLowerCase() : daemonPath, isWin ? binary.toLowerCase() : binary);
    const status = JSON.parse(await fixture.paseo('daemon', 'status', '--json'));
    const match = JSON.stringify(status).match(/"daemonVersion":"([^"]+)"/);
    assert.equal(match?.[1], fixture.version, 'Electron daemon version must match --cli');
    if (isWin) {
      const identity = (await processTable()).find(row => row.pid === instance.pid);
      assert(identity?.started, 'Identify the Windows desktop-managed daemon');
      windowsRoots.set(identity.pid, identity.started);
    }
    return { pid: instance.pid, executable: daemonPath, version: match[1] };
  }

  async function processTable() {
    if (isWin) {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Started';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffffZ')}}} | ConvertTo-Json -Compress"],
      { timeout: 15_000, windowsHide: true });
      return JSON.parse(stdout).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, started: row.Started }));
    }
    const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,pgid=,stat='], { timeout: 10_000 });
    return stdout.trim().split('\n').map(row => row.trim().split(/\s+/))
      .filter(([, , , state]) => !state.startsWith('Z'))
      .map(([pid, parent, group]) => ({ pid: Number(pid), parent: Number(parent), group: Number(group) }));
  }
  const isWindowsSurvivor = ({ pid, started }) => started && windowsShutdown.get(pid) === started;
  async function stopWindowsSurvivors() {
    const errors = [];
    for (const { pid, started } of (await processTable()).filter(isWindowsSurvivor)) {
      assert(Number.isSafeInteger(pid) && /^\d{14}\.\d{6}Z$/.test(started), 'Tracked Windows process identity');
      // Open the process handle and verify its creation time in the same command that stops it.
      try { await run('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop';
        $process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;
        if ($process) {
          try {
            $null = $process.Handle;
            if ($process.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffffZ') -eq '${started}') {
              $process.Kill();
              if (!$process.WaitForExit(10000)) { throw 'Tracked process did not exit' }
            }
          } catch { if (!$process.HasExited) { throw } }
        }`], { timeout: 15_000, windowsHide: true }); }
      catch (error) { errors.push(error); }
    }
    try { await waitFor(async () => !(await processTable()).some(isWindowsSurvivor), 'tracked Windows children exit', 15_000); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  }
  async function closeApp(daemon) {
    const groups = new Set([app.pid, daemon.pid]);
    const children = new Set(groups);
    const processes = await processTable();
    for (let previous; previous !== children.size;) {
      previous = children.size;
      for (const { pid, parent, group } of processes) {
        if (children.has(parent) || groups.has(group)) children.add(pid);
      }
    }
    if (isWin) trackWindowsChildren(windowsShutdown, windowsRoots, processes);
    const startedAt = Date.now();
    await withDeadline(() => page.evaluate(() => window.close()), 'Electron window close', 15_000);
    const owned = isWin ? isWindowsSurvivor : ({ pid, group }) => children.has(pid) || groups.has(group);
    await waitFor(async () => !running(app) && !(await processTable()).some(owned), 'desktop daemon and child processes exit', 60_000);
    windowsShutdown.clear();
    windowsRoots.clear();
    shutdowns.push({ startedAt, finishedAt: Date.now() });
    await closeBrowser();
    browser = page = app = undefined;
  }
  dispose(async () => {
    const instance = await daemonInstance().catch(() => null);
    const managedAlive = async () => instance?.desktopManaged && pidAlive(instance.pid) && (!isWin ||
      (await processTable()).some(row => row.pid === instance.pid && row.started && windowsRoots.get(row.pid) === row.started));
    try {
      if (page && await managedAlive()) await closeApp(instance);
    } finally {
      try {
        if (await managedAlive()) {
          await fixture.paseo('daemon', 'stop');
          await waitFor(async () => !await managedAlive(), 'managed daemon cleanup', 20_000);
        }
      } finally {
        try {
          if (isWin) {
            trackWindowsChildren(windowsShutdown, windowsRoots, await processTable());
            if (windowsShutdown.size) await stopWindowsSurvivors();
          } else await killTree(app);
        } finally { await closeBrowser(); }
      }
    }
  });

  const button = (name, scope = page) => scope.getByRole('button', { name, exact: typeof name === 'string' });
  const pill = () => button('Auto Resume').filter({ hasText: /^(Resume|Tmr|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Check|Resuming)\b/ });
  const screen = async () => button('Auto Resume').filter({ hasText: 'Auto Resume' }).first().click();
  const conversation = async agent => {
    const tab = page.getByTestId('workspace-tab-agent_' + agent.id);
    if (!(await tab.isVisible())) await button(/^Usage Auto Resume E2E/).first().click();
    await tab.click();
  };
  const settings = async () => {
    await button('Settings').first().click();
    await button('Plugins').first().click();
    await button('Usage Auto Resume').last().click();
    await page.getByRole('heading', { name: 'Automatic resume' }).waitFor();
  };
  const panel = async agent => {
    await pill().click();
    const view = page.getByTestId('resume-conversation-' + agent.id);
    await view.waitFor();
    return view;
  };
  const resume = async (view, toast) => {
    await button('Resume now', view).click();
    await button('Send', view).click();
    await page.getByText(toast, { exact: typeof toast === 'string' }).waitFor();
  };
  const { waitJob } = fixture;

  await check('Electron owns the version-matched daemon and loads the installed plugin', async () => {
    await startApp();
    report.daemon = await assertManaged();
    report.installStartedAt = Date.now();
    await fixture.install(source => patchDesktopEntry(source, fixture.usageFile, fetchLog));
    assert.equal(report.revision, args.to, 'Desktop must load the same commit verified in the online stage');
    report.installFinishedAt = Date.now();
    await page.reload();
    const skip = page.getByText('Skip setup', { exact: true });
    if (await skip.isVisible()) await skip.click();
    await screen();
    await page.getByText('Nothing scheduled', { exact: false }).waitFor();
    await settings();
    for (const email of Object.values(emails)) await page.getByText(email, { exact: false }).first().waitFor();
    await shot('provider-accounts');
    return { daemon: report.daemon, revision: report.revision, accounts: emails };
  });

  const leaveSettings = () => button('Back', page.getByRole('navigation', { name: 'Settings' })).click();
  const primary = await fixture.agent('Desktop live limit');
  await check('Live composer pill, keyboard editing, and guarded Resume now on the real Claude CLI', async () => {
    await leaveSettings();
    await conversation(primary);
    // Start before this renderer installs its composer poll. No reload occurs during the measurement.
    const screenStartedAt = performance.now();
    await page.reload();
    await conversation(primary);
    assert.equal(await pill().count(), 0);
    const mark = wire.checkpoint(await wire.ready(1), screenStartedAt);
    const visible = pill().waitFor({ timeout: 90_000 }).then(() => performance.now());
    const [{ job, observedAt }, visibleAt] = await Promise.all([fixture.limit(primary), visible]);
    const pushed = wire.pushed(mark, job.id);
    const pushMs = Math.max(0, Math.round(visibleAt - Math.min(observedAt, pushed.eventReceivedAt)));
    assert(pushMs <= 5000, `Pill took ${pushMs} ms after the reservation reached the daemon`);
    const view = await panel(primary);
    await button('Delay 10 minutes', view).click();
    await waitJob(primary, row => row?.dueAt === iso(Date.parse(job.dueAt) + 600_000), '+10m');
    await button('Change time', view).click();
    const time = view.getByRole('textbox', { name: /^New time for / });
    const due = tomorrowAtNoon();
    await view.getByRole('radio', { name: 'Tomorrow' }).click();
    await time.fill('');
    await time.pressSequentially(localClock(due));
    await button('Save time', view).click();
    await waitJob(primary, row => row?.dueAt === iso(due), 'keyboard time edit');
    const note = 'DESKTOP MANUAL CONTINUE';
    await button('Add extra instructions', view).click();
    await view.getByRole('textbox', { name: /^Extra instructions for / }).fill(note);
    await button('Save extra instructions', view).click();
    await waitJob(primary, row => row?.note === note, 'extra instructions');
    const before = await fixture.job(primary.id);
    await fixture.setUsage('limited', iso(Date.now() + 40 * 60_000));
    await resume(view, /^Usage is still used up/);
    assert.deepEqual(await fixture.job(primary.id), before);
    await fixture.setUsage('auth');
    await resume(view, /^Couldn’t verify usage/);
    assert.deepEqual(await fixture.job(primary.id), before);
    assert.equal(fixture.continues().length, 0);
    await shot('desktop-popover');
    await fixture.setUsage('ready');
    await resume(view, 'Continue sent');
    await pill().waitFor({ state: 'hidden' });
    await waitFor(() => fixture.continues(note).length, 'manual continue at the model');
    assert.equal(fixture.continues(note).length, 1);
    assert.equal(fixture.continues().length, 1, 'Send exactly one manual continue');
    assert.equal((await fixture.history()).find(entry => entry.agentId === primary.id)?.trigger, 'manual');
    return { pushMs, note, modelContinues: 1 };
  });

  await check('The clean Codex probe spawns app-server and sends the fixture bearer to usage fetch', async () => {
    const agent = await fixture.agent('Desktop Codex subscription probe', 'codex', 'gpt-5.5');
    const snapshot = await fixture.client.fetchAgent(agent.id);
    const dueAt = iso(tomorrowAtNoon());
    const seed = { id: randomUUID(), agentId: agent.id, provider: 'codex', dueAt, resetAt: null,
      baseline: snapshot.agent.lastUserMessageAt ?? null, attempts: 0, state: 'pending', enabled: true };
    await editSavedJobs(fixture, jobs => [...jobs, seed]);
    // The file seed sends no subscription update. Reschedule through the daemon to publish the row.
    assert.equal((await fixture.rpc('auto-resume.reschedule', {
      agentId: agent.id, id: seed.id, dueAt, newDueAt: iso(Date.parse(dueAt) + 600_000),
    })).changed, true);
    await fixture.setUsage('limited', iso(Date.now() + 40 * 60_000));
    await screen();
    await button('Open ' + agent.title, page.getByTestId('resume-row-' + seed.id)).click();
    await resume(await panel(agent), /^Usage is still used up/);
    assert.equal((await fixture.job(agent.id)).id, seed.id);
    const fetches = assertSubscriptionRequests(fetchLog, [
      ['claude', 'limited'], ['claude', 'auth'], ['claude', 'ready'], ['codex', 'limited'],
    ]);
    await editSavedJobs(fixture, jobs => jobs.filter(job => job.id !== seed.id));
    await fixture.setUsage('ready');
    return { fetches, codexSent: 0 };
  });

  await check('Auto Resume day headings and navigation, Labs tooltip, and cancellation from Settings', async () => {
    const agent = await fixture.agent('Desktop setting cancellation');
    const { job } = await fixture.limit(agent);
    await screen();
    const day = page.getByTestId(/^resume-day-/).filter({ has: page.getByTestId('resume-row-' + job.id) });
    assert.match(await day.getByRole('heading').innerText(), /^(Today|Tomorrow)$/);
    await button('Open ' + agent.title, day).click();
    await pill().waitFor();
    await settings();
    await page.getByTestId('resume-labs-info').hover();
    await page.getByTestId('resume-labs-tooltip').getByText(/If a turn fails because the provider is busy/).waitFor();
    await shot('labs-tooltip');
    const provider = page.getByTestId('resume-provider-claude');
    const toggle = provider.and(page.getByRole('switch')).or(provider.getByRole('switch'));
    await toggle.click();
    await waitJob(agent, row => !row, 'provider cancellation');
    assert.equal((await fixture.history()).find(entry => entry.agentId === agent.id)?.reason, 'provider_off');
    await toggle.click();
    await waitFor(async () => await toggle.getAttribute('aria-checked') === 'true', 'Claude provider switch is on');
    await leaveSettings();
    return 'Day heading, conversation pill, hover tooltip and provider_off history';
  });

  await check('Closing and relaunching Electron restores a closed agent and the 30-second tick sends once', async () => {
    const agent = await fixture.agent('Desktop closed-agent recovery');
    const { job } = await fixture.limit(agent);
    const before = await assertManaged();
    const requests = fixture.continues().length;
    await closeApp(before);
    await startApp();
    const after = await assertManaged();
    assert.notEqual(after.pid, before.pid);
    assert.equal((await fixture.client.fetchAgent(agent.id)).agent.status, 'closed');
    assert.equal((await fixture.job(agent.id)).id, job.id);
    assert.equal(fixture.continues().length, requests);
    await screen();
    await page.getByTestId('resume-row-' + job.id).waitFor();
    await shot('restored');
    const advancedAt = performance.now();
    await editSavedJobs(fixture, jobs => jobs.map(row => row.id === job.id
      ? { ...row, resetAt: iso(Date.now() - 120_000), dueAt: iso(Date.now() - 60_000) } : row));
    await waitFor(async () => (await fixture.history()).some(entry => entry.agentId === agent.id && entry.outcome === 'continued'),
      'real tick on restarted daemon', 75_000, 500);
    assert.equal(await fixture.job(agent.id), undefined);
    await closeApp(after);
    assert.equal(fixture.continues().length, requests + 1);
    assert.equal(fixture.continues('DESKTOP MANUAL CONTINUE').length, 1);
    return { before, after, deliveryMs: Math.round(performance.now() - advancedAt), modelContinues: 1 };
  });

  await check('No direct external connections, self-update files, renderer errors or unexpected daemon errors', async () => {
    const directTcp = await assertDesktopOffline();
    const cache = await readdir(fixture.cache, { recursive: true, withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    report.updateFiles = cache.filter(entry => entry.isFile() && /updater/i.test(entry.parentPath)).map(entry => entry.name);
    report.appProxyHits = appProxy.hits();
    report.providerProxyHits = fixture.proxy.hits();
    report.offlineRegistryFailures = 0;
    await assertDaemonLogs(report, daemonLog, entry => {
      // Settings reads the directory from the real Desktop-managed daemon, which is offline.
      if (isOfflineRegistryFailure(entry)) {
        report.offlineRegistryFailures++;
        return true;
      }
      // An in-flight renderer RPC can lose its plugin worker as the isolated app reloads or quits.
      const message = entry.error?.message;
      return (message === 'Plugin is not available: usage-auto-resume' &&
        entry.time >= report.installStartedAt && entry.time <= report.installFinishedAt) ||
        (message === 'Plugin stopped: usage-auto-resume' &&
          shutdowns.some(({ startedAt, finishedAt }) => entry.time >= startedAt && entry.time <= finishedAt));
    });
    assert.deepEqual(report.updateFiles, []);
    assert.deepEqual(report.pageErrors, []);
    return { directTcp, refusedProviderRequests: report.providerProxyHits.length, offlineRegistryFailures: report.offlineRegistryFailures };
  });
});
