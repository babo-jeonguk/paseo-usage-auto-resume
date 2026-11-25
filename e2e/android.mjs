import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { androidDevice, matchNode, PACKAGE, within } from './android-device.mjs';
import { assertScreenshotText } from './android-visual.mjs';
import { DEFAULT_CONTINUE_PROMPT } from '../shared/prompt.ts';
import { cliBin, iso, killTree, nativeRun, options, run, running, SOURCE, spawnLogged, waitFor } from './core.mjs';
import { assertDaemonLogs, editSavedJobs, localClock, nativeDefaults, nativeFixture, tomorrowAtNoon } from './native-fixture.mjs';
import { patchEntry } from './patch-plugin.mjs';
import { observeAndroidWire, scheduleWire } from './schedule-wire.mjs';

const args = options(['cli', 'apk'], { ...nativeDefaults, source: SOURCE, port: '5584',
  sdk: process.env.ANDROID_HOME ?? join(homedir(), 'Android', 'Sdk'),
  'system-image': 'system-images;android-34;google_apis;x86_64',
});

await nativeRun('android', args, async ctx => {
  const { root, out, artifacts, dispose, check, report } = ctx;
  assert.equal(process.platform, 'linux', 'The Android runner uses a Linux SDK and emulator');
  await access(args.apk);
  const { stdout: languages } = await run('tesseract', ['--list-langs'], { timeout: 10_000 });
  assert(languages.split(/\r?\n/).includes('eng'), 'Install Tesseract with its English OCR data');
  const fixture = await nativeFixture(ctx, args);
  await fixture.configure({ claude: { env: { ...fixture.claudeEnv, CLAUDE_CODE_OAUTH_TOKEN: 'e2e-fixture-only' } } });
  const device = await androidDevice(ctx, fixture, args);
  const wire = scheduleWire();
  const observer = await observeAndroidWire(fixture.cli, fixture.target, wire);
  dispose(() => observer.close());
  const log = join(root, 'daemon.log');
  artifacts['daemon.log'] = log;
  const { waitJob } = fixture;

  const menuButton = /^(Open|Close) menu$/;
  const autoResumeItem = 'plugin-sidebar-usage-auto-resume-scheduled';
  const menu = async label => {
    const item = await waitFor(async () => {
      const nodes = await device.nodes();
      const desired = nodes.find(node => node.enabled && matchNode(label)(node));
      if (desired) return desired;
      const closed = nodes.find(matchNode('Open menu'));
      if (closed) await device.tapNode(closed);
      return null;
    }, `Android drawer item ${label}`, 120_000, 250);
    const openedAt = performance.now();
    await device.tapNode(item);
    return openedAt;
  };
  const backToWorkspace = async () => {
    // Settings is a nested stack. The hardware Back key is reserved for dismissing the IME.
    for (let depth = 0; depth < 6; depth++) {
      const nodes = await device.nodes();
      if (nodes.some(matchNode(menuButton))) return;
      const back = nodes.find(matchNode(/^(Go back|Back(?: to plugins)?|Close settings|settings-back-to-workspace)$/i));
      if (back) await device.tapNode(back);
    }
    await device.find(menuButton);
  };
  const settings = async () => {
    await menu('sidebar-settings');
    await device.tapNode(await device.scrollTo('Plugins'));
    await device.tapNode(await device.scrollTo('Usage Auto Resume'));
    await device.find('Automatic resume');
  };
  // The drawer is closed on the conversation. The composer action's accessible name is stable
  // even when its visible countdown is grouped into the button by React Native.
  const pill = node => node.pkg === PACKAGE && node.class === 'android.widget.Button' && node.desc === 'Auto Resume';
  const composer = () => device.find(node => node.pkg === PACKAGE && node.class === 'android.widget.EditText' &&
    node.desc === 'Message agent...', 120_000, 'conversation composer');
  const row = job => matchNode('resume-row-' + job.id);
  const switchFor = agent => node => node.pkg === PACKAGE &&
    (node.desc ?? '').startsWith('Continue ' + agent.title + ' automatically');
  const closeKeyboard = () => device.shell('input', 'keyevent', 'KEYCODE_BACK');
  const confirmResume = async toast => {
    await device.tap('Resume now');
    const send = await device.find('Send');
    await Promise.all([device.find(toast, 15_000), device.tapNode(send)]);
  };

  const primaryTitle = 'Android live limit';
  let primary, primaryJob, liveList;
  await check('Clean AVD, APK version match, Direct connection, Hermes bundle and live push', async () => {
    let daemon;
    // The device registers logcat capture during boot. Capture before stopping the host daemon.
    dispose(async () => {
      if (!daemon) return;
      try {
        if (running(daemon)) await fixture.paseo('daemon', 'stop');
        await waitFor(() => !running(daemon), 'Android fixture daemon exit', 15_000);
      } finally { await killTree(daemon); }
    });
    await device.boot();
    daemon = spawnLogged(process.execPath, ['--no-maglev', cliBin(fixture.cli), 'daemon', 'run', '--home', fixture.home],
      { env: fixture.environment, cwd: fixture.work, log });
    await fixture.attach(() => running(daemon));
    await fixture.install(source => patchEntry(source, fixture.usageFile));
    await device.connect(observer.port);
    const openedAt = await menu(autoResumeItem);
    await device.find('Nothing scheduled');
    primary = await fixture.agent(primaryTitle);
    const client = await wire.ready(2);
    const mark = wire.checkpoint(client, openedAt);
    // Start UI Automator before sending the turn. Starting the device-side command only after
    // the daemon reports the row would count its cold launch against the UI’s push deadline.
    const visible = device.find('Open ' + primaryTitle, 90_000).then(() => performance.now());
    const [{ job, observedAt }, visibleAt] = await Promise.all([fixture.limit(primary), visible]);
    primaryJob = job;
    const pushed = wire.pushed(mark, job.id);
    await waitFor(() => wire.messagesSince(mark).some(message => message.method === 'auto-resume.history' &&
      message.request.at >= pushed.eventReceivedAt), 'the open list history response after the schedule event', 15_000);
    liveList = { client, at: pushed.listReceivedAt };
    const pushMs = Math.max(0, Math.round(visibleAt - Math.min(observedAt, pushed.eventReceivedAt)));
    assert(pushMs <= 5000, `Native row took ${pushMs} ms after the reservation reached the daemon`);
    await device.find('resume-row-' + job.id);
    await device.shot('live-push');
    return { pushMs, pushedRevision: pushed.revision, cliVersion: fixture.version, apkVersion: report.apkVersion, revision: report.revision };
  });

  await check('Pull-to-refresh reads changes that were not pushed to the open list', async () => {
    // Measure from the real pushed list response. There are no pending UI mutations here.
    const toggle = switchFor(primary);
    for (const enabled of [false, true]) {
      const node = await device.find(entry => toggle(entry) && entry.checked !== enabled);
      await wire.settled(liveList.client);
      await editSavedJobs(fixture, jobs => jobs.map(saved => saved.id === primaryJob.id ? { ...saved, enabled } : saved));
      assert.equal((await device.find(toggle)).checked, !enabled, 'The file edit must not update the open list');
      const mark = wire.checkpoint(liveList.client);
      const x = Math.floor((node.left + node.right) / 2);
      await device.swipe(x, node.top, node.top + 420);
      await device.find(entry => toggle(entry) && entry.checked === enabled);
      const messages = wire.messagesSince(mark);
      assert(!messages.some(message => message.subscriptionId), 'The swipe must not overlap an unrelated schedule push');
      assert(messages.some(message => message.jobs?.some(job => job.id === primaryJob.id && job.enabled === enabled)),
        'The swipe must fetch the edited reservation');
      await waitFor(() => wire.messagesSince(mark).some(message => message.method === 'auto-resume.history'), 'history refetch from pull-to-refresh', 5_000);
    }
    assert(performance.now() - liveList.at < 120_000, 'Refresh check overlapped the periodic list poll');
    assert.equal((await fixture.job(primary.id)).enabled, true);
  });

  const same = await fixture.agent('Android same-day reservation');
  const later = await fixture.agent('Android later-day reservation');
  await check('Compact list, Hermes days and spoken time, bulk and row toggles, and delay', async () => {
    const { job: initialSame } = await fixture.limit(same, 60);
    const { job: initialLater } = await fixture.limit(later);
    const laterDue = iso(Date.parse(initialLater.dueAt) + 3 * 86_400_000);
    // Some Claude releases omit the date from distant rate-limit notices. Schedule the later
    // day explicitly after the real limit created its reservation.
    for (const [agent, job, newDueAt] of [[same, initialSame, primaryJob.dueAt], [later, initialLater, laterDue]]) {
      assert.equal((await fixture.rpc('auto-resume.reschedule', {
        agentId: agent.id, id: job.id, dueAt: job.dueAt, newDueAt,
      })).changed, true);
    }
    const sameJob = await fixture.job(same.id);
    const laterJob = await fixture.job(later.id);
    const tracked = [primaryJob.id, sameJob.id, laterJob.id];
    const allEnabled = async enabled => {
      const jobs = await fixture.jobs();
      return tracked.every(id => jobs.some(job => job.id === id && job.enabled === enabled));
    };
    const findDay = async job => {
      const list = await device.nodes();
      const target = list.find(row(job));
      assert(target, 'Reservation row is missing from the hierarchy');
      // The native hierarchy can expose the day heading and its rows as siblings.
      const day = list.filter(matchNode(/^resume-day-/)).filter(node => node.top <= target.top).at(-1);
      assert(day, 'Reservation has no day section');
      return day.id;
    };
    await device.scrollTo(row(primaryJob), 'up');
    const primaryDay = await findDay(primaryJob);
    await device.scrollTo(row(sameJob), 'up');
    assert.equal(await findDay(sameJob), primaryDay, 'Two same-day reservations should share a section');
    await device.scrollTo(row(laterJob));
    const dayLabel = new Date(laterJob.dueAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    assert.equal((await findDay(laterJob)).split(':id/').at(-1), 'resume-day-' + dayLabel);
    await device.scrollTo(dayLabel, 'up');
    const spoken = await device.scrollTo(node => node.pkg === PACKAGE && /^in \d+d(?: \d+h)?$/.test(node.text ?? '') &&
      /^in \d+ days?(?: \d+ hours?)?$/.test(node.desc ?? ''));
    await device.shot('compact-list');
    await device.tapNode(await device.scrollTo('Turn all off', 'up'));
    await waitFor(() => allEnabled(false), 'tracked jobs off');
    const compactAllOn = await device.find(node => node.pkg === PACKAGE && node.desc === 'Turn all on');
    assert(compactAllOn.text === 'All on' || (await device.nodes()).some(node => node.text === 'All on'),
      'Compact bulk control must show All on');
    await device.tap('Turn all on');
    await waitFor(() => allEnabled(true), 'tracked jobs on');
    const rowSwitch = switchFor(primary);
    await device.tapNode(await device.scrollTo(rowSwitch));
    await waitJob(primary, job => job && !job.enabled, 'native switch off');
    await device.tap(rowSwitch);
    await waitJob(primary, job => job?.enabled, 'native switch on');
    const delay = /^Delay 10 minutes for Android live limit$/;
    await device.tap(delay);
    const bumpedDue = iso(Date.parse(primaryJob.dueAt) + 600_000);
    await waitJob(primary, job => job?.dueAt === bumpedDue, 'row +10m');
    await device.find(`Change time for ${primaryTitle}, now ${localClock(Date.parse(bumpedDue))}`);

    return { dayLabel, visual: spoken.text, spoken: spoken.desc };
  });

  const note = "ANDROID CONTINUE & 'verify'";
  await check('Conversation navigation and native sheet with stacked day choices and keyboard input', async () => {
    await device.tapNode(await device.scrollTo('Open ' + primaryTitle, 'up'));
    await composer();
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
    assert.equal(fixture.continues().length, 1, 'Send exactly one manual continue');
    return { modelContinues: 1 };
  });

  await check('Settings cancel, Labs tooltip pixels, Labs switch, and continue prompt edit/reset', async () => {
    await settings();
    await device.scrollTo('resume-provider-claude');
    const controls = await device.nodes();
    const provider = controls.find(matchNode('resume-provider-claude'));
    assert(provider, 'Claude provider setting');
    const providerToggle = node => node.pkg === PACKAGE && /Switch$/.test(node.class ?? '') &&
      (node === provider || within(node, provider));
    const toggle = controls.find(providerToggle) ?? provider;
    await device.tapNode(toggle);
    await waitJob(same, row => !row, 'provider cancels pending work');
    await waitJob(later, row => !row, 'provider cancels pending work across days');
    assert.equal((await fixture.history()).find(entry => entry.agentId === same.id)?.reason, 'provider_off');
    await device.tapNode(toggle);

    const info = await device.scrollTo('resume-labs-info');
    await device.tapNode(info);
    const body = 'If a turn fails because the provider is busy, retry the turn up to 3 times — about 3, 10, then 25 minutes later.';
    const details = 'Claude, Codex and Antigravity only. Usage limits are checked first.';
    const bodyBounds = await device.find(body);
    const detailsBounds = await device.find(details);
    const tooltip = await device.screenshotRaw();
    const tooltipText = [
      await assertScreenshotText(tooltip, bodyBounds, body, join(out, 'labs-tooltip-body.pgm')),
      await assertScreenshotText(tooltip, detailsBounds, details, join(out, 'labs-tooltip-details.pgm')),
    ];
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
    await device.scrollTo('Custom prompt');
    await device.scrollTo(prompt(custom), 'up');
    await device.tapNode(await device.scrollTo('Reset to default'));
    await device.scrollTo('Default prompt', 'up');
    await device.scrollTo(prompt(DEFAULT_CONTINUE_PROMPT), 'up');
    return { tooltipText };
  });

  await check('Recent activity shows native outcome text and Hermes dates', async () => {
    await backToWorkspace();
    await menu(autoResumeItem);
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
    const before = (await device.shell('pidof', PACKAGE)).trim();
    assert(before);
    await device.shell('am', 'force-stop', PACKAGE);
    assert.equal(await device.shell('pidof', PACKAGE).catch(() => ''), '');
    await device.launch();
    await menu(autoResumeItem);
    await device.find(row(job));
    await device.tap('Open ' + recovery.title);
    await composer();
    await device.find(pill);
    assert.notEqual((await device.shell('pidof', PACKAGE)).trim(), before);
    assert.equal((await fixture.job(recovery.id)).id, job.id);
    assert.equal(fixture.continues().length, 1, 'Cold reopen must leave the total at one manual continue');
    assert.equal(fixture.continues(note).length, 1);
    await device.shot('cold-reopen');
    assert.deepEqual(fixture.proxy.hits(), []);
    await assertDaemonLogs(report, log);
    return { reservationId: job.id, duplicateContinues: 0, anrDismissed: report.anrDismissed };
  });
});
