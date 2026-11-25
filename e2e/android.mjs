import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { androidDevice, matchNode, PACKAGE, within } from './android-device.mjs';
import { cliBin, DEFAULT_MARK, iso, killTree, nativeRun, options, running, SOURCE, spawnLogged, waitFor } from './core.mjs';
import { assertDaemonLogs, editSavedJobs, localClock, nativeDefaults, nativeFixture, tomorrowAtNoon } from './native-fixture.mjs';
import { patchEntry } from './patch-plugin.mjs';

const args = options(['cli', 'apk'], { ...nativeDefaults, source: SOURCE, port: '5584',
  sdk: process.env.ANDROID_HOME ?? join(homedir(), 'Android', 'Sdk'),
  'system-image': 'system-images;android-34;google_apis;x86_64',
});

await nativeRun('android', args, async ctx => {
  const { root, artifacts, dispose, check, report } = ctx;
  assert.equal(process.platform, 'linux', 'The Android runner uses a Linux SDK and emulator');
  await access(args.apk);
  const fixture = await nativeFixture(ctx, args);
  await fixture.configure({ claude: { env: { ...fixture.claudeEnv, CLAUDE_CODE_OAUTH_TOKEN: 'e2e-fixture-only' } } });
  const device = await androidDevice(ctx, fixture, args);
  const log = join(root, 'daemon.log');
  artifacts['daemon.log'] = log;
  let diagnostics;
  const waitJob = (agent, test, what) => waitFor(async () => test(await fixture.job(agent.id)), what, 20_000, 200);

  const menu = async label => {
    await device.tap('Open menu');
    await device.tap(label);
  };
  const backToWorkspace = async () => {
    // Settings is a nested stack. The hardware Back key is reserved for dismissing the IME.
    for (let depth = 0; depth < 6; depth++) {
      const nodes = await device.nodes();
      if (nodes.some(matchNode('Open menu'))) return;
      const back = nodes.find(matchNode(/^(Go back|Back|Close settings)$/));
      if (back) await device.tapNode(back);
    }
    await device.find('Open menu');
  };
  const settings = async () => {
    await menu('Settings');
    await device.tap('Plugins');
    await device.tap('Usage Auto Resume');
    await device.find('Automatic resume');
  };
  const pill = node => node.pkg === PACKAGE && /^Auto Resume(?:$|[, .])/.test(node.desc ?? '') &&
    (node.desc !== 'Auto Resume' || /^(Resume|Tmr|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Check|Resuming)\b/.test(node.text ?? ''));
  const row = job => matchNode('resume-row-' + job.id);
  const closeKeyboard = () => device.shell('input', 'keyevent', 'KEYCODE_BACK');
  const confirmResume = async toast => {
    await device.tap('Resume now');
    await device.tap('Send');
    await device.find(toast, 15_000);
  };

  const primaryTitle = 'Android live limit';
  let primary, primaryJob;
  await check('Clean AVD, APK version match, Direct connection, Hermes bundle and live push', async () => {
    diagnostics = await device.boot();
    const daemon = spawnLogged(process.execPath, ['--no-maglev', cliBin(fixture.cli), 'daemon', 'run', '--home', fixture.home],
      { env: fixture.environment, cwd: fixture.work, log });
    dispose(async () => {
      try {
        if (running(daemon)) await fixture.paseo('daemon', 'stop');
        await waitFor(() => !running(daemon), 'Android fixture daemon exit', 15_000);
      } finally { await killTree(daemon); }
    });
    await fixture.attach(() => running(daemon));
    await fixture.install(source => patchEntry(source, fixture.usageFile));
    await device.connect();
    await menu('Auto Resume');
    await device.find('Nothing scheduled');
    primary = await fixture.agent(primaryTitle);
    const { job, observedAt } = await fixture.limit(primary);
    primaryJob = job;
    await device.find(row(job), 5000);
    const pushMs = Math.round(performance.now() - observedAt);
    assert(pushMs <= 5000, `Native row took ${pushMs} ms after the reservation reached the daemon`);
    await device.shot('live-push');
    return { pushMs, cliVersion: fixture.version, apkVersion: report.apkVersion, revision: report.revision };
  });

  const same = await fixture.agent('Android same-day reservation');
  const later = await fixture.agent('Android later-day reservation');
  await check('Compact list, Hermes days and spoken time, bulk and row toggles, delay, and pull-to-refresh', async () => {
    const sameDay = Date.parse(primaryJob.dueAt) - 122_000;
    const { job: sameJob } = await fixture.limit(same, Math.max(60, Math.floor((sameDay - Date.now()) / 1000)));
    const { job: laterJob } = await fixture.limit(later, 3 * 86400);
    const findDay = async job => {
      const list = await device.nodes();
      const target = list.find(row(job));
      assert(target, 'Reservation row is missing from the hierarchy');
      const day = list.find(node => matchNode(/^resume-day-/)(node) && within(target, node));
      assert(day, 'Reservation has no day section');
      return day.id;
    };
    await device.scrollTo(row(primaryJob), 'up');
    const primaryDay = await findDay(primaryJob);
    await device.scrollTo(row(sameJob));
    assert.equal(await findDay(sameJob), primaryDay, 'Two same-day reservations should share a section');
    await device.scrollTo(row(laterJob));
    const dayLabel = new Date(laterJob.dueAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    assert.match(await findDay(laterJob), /^(.+:id\/)?resume-day-/);
    await device.scrollTo(dayLabel, 'up');
    const spoken = await device.scrollTo(node => node.pkg === PACKAGE && /^in \d+d(?: \d+h)?$/.test(node.text ?? '') &&
      /^in \d+ days?(?: \d+ hours?)?$/.test(node.desc ?? ''));
    await device.shot('compact-list');
    await device.tapNode(await device.scrollTo('Turn all off', 'up'));
    await waitFor(async () => (await fixture.jobs()).every(job => !job.enabled), 'all jobs off');
    const compactAllOn = await device.find(node => node.pkg === PACKAGE && node.desc === 'Turn all on');
    assert(compactAllOn.text === 'All on' || (await device.nodes()).some(node => node.text === 'All on'),
      'Compact bulk control must show All on');
    await device.tap('Turn all on');
    await waitFor(async () => (await fixture.jobs()).every(job => job.enabled), 'all jobs on');
    const rowSwitch = node => node.pkg === PACKAGE && (node.desc ?? '').startsWith('Continue ' + primaryTitle + ' automatically');
    await device.tapNode(await device.scrollTo(rowSwitch));
    await waitJob(primary, job => job && !job.enabled, 'native switch off');
    await device.tap(rowSwitch);
    await waitJob(primary, job => job?.enabled, 'native switch on');
    await device.tap(/^Delay 10 minutes for Android live limit$/);
    await waitJob(primary, job => job?.dueAt === iso(Date.parse(primaryJob.dueAt) + 600_000), 'row +10m');

    // An offline change to the fixture store cannot push. The gesture must fetch the new row state.
    await device.scrollTo('Turn all off', 'up');
    const coords = await device.find(rowSwitch);
    await editSavedJobs(fixture, jobs => jobs.map(job => job.id === primaryJob.id ? { ...job, enabled: false } : job));
    const width = Math.floor((coords.left + coords.right) / 2);
    await device.swipe(width, coords.top, coords.top + 420);
    await device.find(node => rowSwitch(node) && !node.checked);
    assert.equal((await fixture.job(primary.id)).enabled, false);
    await device.tap(rowSwitch);
    await waitJob(primary, job => job?.enabled, 'reservation enabled again');
    return { dayLabel, visual: spoken.text, spoken: spoken.desc };
  });

  const note = "ANDROID CONTINUE & 'verify'";
  await check('Conversation navigation and native sheet with stacked day choices and keyboard input', async () => {
    await device.tapNode(await device.scrollTo('Open ' + primaryTitle, 'up'));
    await device.tap(pill);
    await device.tap('Delay 10 minutes');
    const bumped = iso(Date.parse(primaryJob.dueAt) + 20 * 60_000);
    await waitJob(primary, row => row?.dueAt === bumped, 'sheet +10m');
    await device.tap('Change time');
    const field = await device.find(node => node.class === 'android.widget.EditText' && node.desc === `New time for ${primaryTitle}`);
    const tomorrow = await device.find('resume-day-choice-1');
    assert(tomorrow.top >= field.bottom, 'Compact day choices must be below the time field');
    await device.tapNode(tomorrow);
    const due = tomorrowAtNoon();
    await device.type(`New time for ${primaryTitle}`, localClock(due));
    await closeKeyboard();
    await device.tap('Save time');
    await waitJob(primary, row => row?.dueAt === iso(due), 'native time edit');
    await device.tap('Add extra instructions');
    await device.type(`Extra instructions for ${primaryTitle}`, note);
    await closeKeyboard();
    await device.tap('Save extra instructions');
    await waitJob(primary, row => row?.note === note, 'native note save');
    await device.shot('native-sheet');
    return { dueAt: iso(due), note };
  });

  await check('Resume now shows blocked and successful toasts and sends exactly one continue', async () => {
    const before = await fixture.job(primary.id);
    await fixture.setUsage('limited', iso(Date.now() + 40 * 60_000));
    await confirmResume(/^Usage is still used up/);
    assert.deepEqual(await fixture.job(primary.id), before);
    assert.equal(fixture.continues().length, 0);
    await fixture.setUsage('ready');
    await confirmResume('Continue sent');
    await waitJob(primary, row => !row, 'continued row clears');
    const lists = await device.nodes();
    assert(lists.some(node => node.pkg === PACKAGE), 'Paseo must still be in the foreground');
    assert(!lists.some(pill), 'Composer pill must be gone');
    assert(!lists.some(matchNode('Resume now')), 'Native sheet must close');
    await waitFor(() => fixture.continues(note).length, 'continue at the fake model');
    assert.equal(fixture.continues(note).length, 1);
    return { modelContinues: 1 };
  });

  await check('Settings cancel, Labs tooltip pixels, Labs switch, and continue prompt edit/reset', async () => {
    await settings();
    const provider = await device.scrollTo('resume-provider-claude');
    await device.tapNode(provider);
    await waitJob(same, row => !row, 'provider cancels pending work');
    await waitJob(later, row => !row, 'provider cancels pending work across days');
    assert.equal((await fixture.history()).find(entry => entry.agentId === same.id)?.reason, 'provider_off');
    await device.tap('resume-provider-claude');

    const info = await device.scrollTo('resume-labs-info');
    const before = await device.screenshotRaw();
    await device.tapNode(info);
    const tooltip = await device.find(/^If a turn fails because the provider is busy/);
    const after = await device.screenshotRaw();
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);
    assert(tooltip.left >= 0 && tooltip.top >= 0 && tooltip.right <= after.width && tooltip.bottom <= after.height,
      'Tooltip body falls outside the visible screen');
    let changed = 0;
    for (let y = tooltip.top; y < tooltip.bottom; y += 2) {
      for (let x = tooltip.left; x < tooltip.right; x += 2) {
        const at = (y * after.width + x) * 4;
        if (after.pixels[at] !== before.pixels[at] || after.pixels[at + 1] !== before.pixels[at + 1] ||
          after.pixels[at + 2] !== before.pixels[at + 2]) changed++;
      }
    }
    assert(changed > 20, 'Tooltip text region did not render on the display');
    await device.shot('labs-tooltip');
    await device.tap('resume-labs-info');
    const labs = matchNode('resume-labs-toggle');
    const initial = (await device.find(labs)).checked;
    await device.tap(labs);
    await device.find(node => labs(node) && node.checked !== initial);
    await device.tap(labs);
    await device.find(node => labs(node) && node.checked === initial);
    await device.scrollTo('Continue prompt', 'up');
    const custom = "Continue with 'Android' & check.";
    await device.type('Continue prompt', custom);
    await closeKeyboard();
    await device.tap('Save');
    const prompt = text => node => node.class === 'android.widget.EditText' && node.desc === 'Continue prompt' && node.text === text;
    await device.find(prompt(custom));
    await device.tap('Reset to default');
    await device.find(prompt(DEFAULT_MARK));
    return { tooltipChangedPixels: changed };
  });

  await check('Recent activity shows native outcome text and Hermes dates', async () => {
    await backToWorkspace();
    await menu('Auto Resume');
    await device.tapNode(await device.scrollTo('resume-history-header'));
    const history = await fixture.history();
    for (const [agent, outcome] of [[primary, /^Continued/], [same, /^Canceled/]]) {
      const entry = history.find(item => item.agentId === agent.id);
      await device.scrollTo('resume-history-row-' + entry.id);
      const day = new Date(entry.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      // A later hierarchy has fresh objects. Locate the ancestor again for the descendant assertions.
      const list = await device.nodes();
      const current = list.find(matchNode('resume-history-row-' + entry.id));
      assert(current);
      assert(list.some(node => within(node, current) && node.text === day), `History row date ${day}`);
      assert(list.some(node => within(node, current) && outcome.test(node.text)), `History outcome ${outcome}`);
    }
    await device.shot('recent-activity');
  });

  await check('Force-stop and cold reopen restore both surfaces without another continue', async () => {
    const recovery = await fixture.agent('Android cold reopen');
    const { job } = await fixture.limit(recovery);
    await device.scrollTo(row(job), 'up');
    const sent = fixture.continues().length;
    const before = (await device.shell('pidof', PACKAGE)).trim();
    assert(before);
    await device.shell('am', 'force-stop', PACKAGE);
    assert.equal(await device.shell('pidof', PACKAGE).catch(() => ''), '');
    await device.launch();
    await device.find('Open menu', 120_000);
    await menu('Auto Resume');
    await device.find(row(job));
    await device.tap('Open ' + recovery.title);
    await device.find(pill);
    assert.notEqual((await device.shell('pidof', PACKAGE)).trim(), before);
    assert.equal((await fixture.job(recovery.id)).id, job.id);
    assert.equal(fixture.continues().length, sent);
    assert.equal(fixture.continues(note).length, 1);
    await device.shot('cold-reopen');
    await diagnostics.captureLogcat();
    const logcat = await readFile(diagnostics.logcat, 'utf8');
    report.fatalLogcat = logcat.split('\n').filter(line =>
      /\b(?:E|F) ReactNativeJS\b.*(?:Error|Exception|Hermes)|\bF libc\b.*Fatal signal|\bE AndroidRuntime\b.*Process: sh\.paseo\b|\bF DEBUG\b.*sh\.paseo/i.test(line));
    assert.deepEqual(report.fatalLogcat, []);
    assert.deepEqual(fixture.proxy.hits(), []);
    await assertDaemonLogs(report, log);
    return { reservationId: job.id, duplicateContinues: 0, anrDismissed: report.anrDismissed };
  });
});
