import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { freePort, inherited, killTree, run, running, sleep, spawnLogged, waitFor } from './core.mjs';
import { locateScreenshotText } from './android-visual.mjs';

export const PACKAGE = 'sh.paseo';
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) =>
  entity[0] === '#' ? String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : entities[entity]);

function hierarchy(xml) {
  const stack = [], nodes = [];
  for (const [tag] of xml.matchAll(/<node\b[^>]*>|<\/node>/g)) {
    if (tag === '</node>') { stack.pop(); continue; }
    const attrs = Object.fromEntries(Array.from(tag.matchAll(/([\w-]+)="([^"]*)"/g), ([, key, value]) => [key, decode(value)]));
    const [left, top, right, bottom] = (attrs.bounds?.match(/-?\d+/g) ?? []).map(Number);
    const node = {
      text: attrs.text, desc: attrs['content-desc'], id: attrs['resource-id'], class: attrs.class, pkg: attrs.package,
      enabled: attrs.enabled === 'true', checked: attrs.checked === 'true',
      left, top, right, bottom, parent: stack.at(-1),
    };
    if (!tag.endsWith('/>')) stack.push(node);
    if (right > left && bottom > top) nodes.push(node);
  }
  return nodes;
}

export function matchNode(label) {
  if (typeof label === 'function') return label;
  return node => node.pkg === PACKAGE && [node.desc, node.text, node.id, node.id?.split(':id/').at(-1)]
    .some(value => value != null && (label instanceof RegExp ? label.test(value) : label === value));
}

export function within(node, ancestor) {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
}

export async function androidDevice(ctx, fixture, args) {
  const { report, root, out, dispose, artifacts } = ctx;
  const sdk = resolve(args.sdk), apk = resolve(args.apk);
  report.apk = apk;
  const port = Number(args.port);
  assert(Number.isInteger(port) && port >= 5554 && port <= 5682 && port % 2 === 0, 'Use an even emulator console port from 5554 to 5682');
  const avd = `usage-auto-resume-e2e-${randomUUID()}`, serial = 'emulator-' + port;
  const avdHome = join(root, 'avd'), androidHome = join(root, 'android-user');
  await Promise.all([avdHome, androidHome].map(dir => mkdir(dir)));
  const adbPort = await freePort();
  const env = { ...fixture.env, ...inherited(['JAVA_HOME', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']),
    ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: avdHome, ANDROID_USER_HOME: androidHome,
    ANDROID_EMULATOR_HOME: androidHome, ANDROID_ADB_SERVER_PORT: String(adbPort), ADB_LOCAL_TRANSPORT_MAX_PORT: '5683',
  };
  const adbBin = join(sdk, 'platform-tools', 'adb');
  const adbServer = ['-P', String(adbPort)];
  const adbDevice = [...adbServer, '-s', serial];
  const adb = async (args, { timeout = 30_000, encoding = 'utf8', direct = false } = {}) =>
    (await run(adbBin, [...(direct ? adbServer : adbDevice), ...args],
      { env, timeout, encoding, maxBuffer: 48 * 1024 * 1024 })).stdout;
  const shellCommand = (args, timeout) => adb(['shell', args.map(quote).join(' ')], { timeout });
  const shell = (...args) => shellCommand(args);
  const tapNode = (node, timeout) => shellCommand(['input', 'tap',
    Math.floor((node.left + node.right) / 2), Math.floor((node.top + node.bottom) / 2)], timeout);
  let emulator;
  report.anrDismissed = 0;

  const dump = timeout => adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout });
  async function nodes(timeout = 12_000) {
    let xml;
    try {
      xml = await dump(timeout);
      if (!xml.includes('<hierarchy')) return [];
    } catch (error) {
      if (emulator && !running(emulator)) throw new Error('Emulator exited during UI polling', { cause: error });
      return [];
    }
    const list = hierarchy(xml);
    const dialog = list.find(node => node.pkg === 'android' && node.id === 'android:id/alertTitle' &&
      /^(?:Process system|System UI|com\.android\.systemui) isn.t responding$/i.test(node.text));
    const wait = dialog && list.find(node => node.pkg === dialog.pkg && node.id === 'android:id/aerr_wait');
    if (wait) {
      await tapNode(wait);
      report.anrDismissed++;
      return [];
    }
    return list;
  }

  function find(label, timeout = 40_000, description = String(label)) {
    const start = performance.now();
    return waitFor(async () => {
      const remaining = Math.max(1, timeout - (performance.now() - start));
      return (await nodes(Math.min(12_000, remaining))).find(matchNode(label));
    }, `Android UI ${description}`, timeout, 100);
  }
  const tap = async (label, timeout) => {
    const matches = matchNode(label);
    await tapNode(await find(node => node.enabled && matches(node), timeout, `enabled ${label}`));
  };
  async function type(label, value) {
    const matches = matchNode(label);
    const input = node => node.pkg === PACKAGE && node.class === 'android.widget.EditText' &&
      matches({ ...node, text: undefined, id: undefined });
    const field = await find(input, 40_000, `${label} field`);
    assert(/^[ -~]*$/.test(value) && !value.includes('%s'), 'adb input text requires ASCII and reserves %s for a space');
    await tapNode(field);
    await shell('input', 'keyevent', 'KEYCODE_MOVE_END', ...Array(Math.max(1, field.text?.length ?? 0)).fill('KEYCODE_DEL'));
    // Give a controlled React Native input time to render each batch before injecting the next.
    let typed = '';
    for (const batch of value.match(/.{1,4}/g) ?? []) {
      await shell('input', 'text', batch.replaceAll(' ', '%s'));
      typed += batch;
      await find(node => input(node) && node.text === typed, 40_000, `typed text in ${label}`);
    }
  }

  const swipe = (x, y, endY) => shell('input', 'swipe', x, y, x, endY, 500);
  async function scrollTo(label, direction = 'down') {
    const matches = matchNode(label);
    const size = (await shell('wm', 'size')).trim().split('\n').at(-1).match(/(\d+)x(\d+)/);
    const width = Number(size[1]), height = Number(size[2]);
    for (let i = 0; i <= 7; i++) {
      const node = (await nodes()).find(matches);
      if (node) return node;
      if (i < 7) {
        const high = Math.floor(height * 0.23), low = Math.floor(height * 0.72);
        await swipe(Math.floor(width * 0.45), direction === 'down' ? low : high, direction === 'down' ? high : low);
      }
    }
    throw new Error(`Android UI ${label} was not visible after scrolling ${direction}`);
  }

  const screenshotPng = timeout => adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout });
  const shot = async name => writeFile(join(out, name + '.png'), await screenshotPng());
  async function recordScreen(video, action, tailMs) {
    const remote = '/data/local/tmp/uar-' + randomUUID() + '.mp4';
    const pidFile = remote + '.pid';
    // Android encodes changes directly from the display while adb is busy with input or RPCs.
    const startedAt = performance.now();
    let ended = false;
    const script = `screenrecord --time-limit 60 "${remote}" & pid=$!; echo "$pid" > "${pidFile}"; wait "$pid"`;
    const recording = Promise.allSettled([shellCommand(['sh', '-c', script], 70_000)
      .finally(() => { ended = true; })]);
    const interact = async () => {
      await waitFor(async () => {
        assert(!ended, 'Android screen recording stopped before the action');
        // An MP4 header can exist before the encoder has provided a video sample.
        return await shellCommand(['stat', '-c', '%s', remote], 2_000).then(size => Number(size) > 1024, () => false);
      }, 'first encoded Android screen frame', 8_000, 100);
      assert(!ended, 'Android screen recording stopped before the action');
      const readyAt = performance.now();
      const response = await action();
      await sleep(Math.max(0, response.at + tailMs - performance.now()));
      assert(!ended, 'Android screen recording stopped before the post-response capture window ended');
      return { ...response, startedAt, readyAt };
    };
    const stop = async () => {
      if (ended) return;
      const pid = (await shellCommand(['cat', pidFile], 5_000)).trim();
      assert(/^\d+$/.test(pid), 'Invalid Android screen recording PID');
      await shellCommand(['kill', '-INT', pid], 5_000);
    };
    const [response] = await Promise.allSettled([interact()]);
    const stopped = await Promise.allSettled([stop()]);
    const capture = await recording;
    const artifacts = await Promise.allSettled([adb(['pull', remote, video], { timeout: 30_000 })]);
    const cleanup = await Promise.allSettled([shellCommand(['rm', '-f', remote, pidFile], 5_000)]);
    const errors = [response, ...stopped, ...capture, ...artifacts, ...cleanup].filter(result => result.status === 'rejected');
    assert(!errors.length, errors.map(({ reason }) => reason.message).join('\n'));
    return response.value;
  }
  const launch = () => shell('monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1');
  const avdName = async () => (await adb(['emu', 'avd', 'name'], { timeout: 3000 })).trim().split(/\r?\n/)[0];

  async function boot() {
    await adb(['start-server'], { direct: true });
    dispose(() => adb(['kill-server'], { direct: true }));
    const devices = await adb(['devices'], { direct: true });
    assert(!devices.split(/\r?\n/).some(line => line.startsWith(serial + '\t')), `${serial} is already in use`);
    const createLog = join(root, 'avd-create.log');
    artifacts['avd-create.log'] = createLog;
    const create = spawn(join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager'),
      ['create', 'avd', '-n', avd, '-k', args['system-image'], '-d', 'pixel_6'],
      { env, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(120_000) });
    const output = [];
    create.stdout.on('data', chunk => output.push(chunk));
    create.stderr.on('data', chunk => output.push(chunk));
    create.stdin.on('error', () => {});
    create.stdin.end('no\n');
    let code;
    try { [code] = await once(create, 'close'); }
    finally { await writeFile(createLog, Buffer.concat(output)); }
    assert.equal(code, 0, 'avdmanager failed. See avd-create.log.');
    const log = join(root, 'emulator.log');
    artifacts['emulator.log'] = log;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    emulator = spawnLogged(join(sdk, 'emulator', 'emulator'),
      ['-avd', avd, '-port', String(port), '-wipe-data', '-no-window', '-no-audio', '-no-snapshot',
        '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-cores', '2', '-memory', '2048', '-timezone', timezone,
        '-no-metrics', '-crash-report-mode', 'disabled',
        '-network-user-mode-options', 'restrict=on', '-wifi-user-mode-options', 'restrict=on'],
      { env, log });
    dispose(async () => {
      try {
        if (running(emulator) && await avdName() === avd) await adb(['emu', 'kill'], { timeout: 10_000 });
      }
      catch { /* The process group is the fallback when adb is unavailable. */ }
      finally { await killTree(emulator); }
    });
    await waitFor(async () => {
      assert(running(emulator), 'Emulator exited during boot. See emulator.log.');
      const name = await avdName().catch(() => '');
      if (!name) return false;
      assert.equal(name, avd, 'Android emulator port is owned by another AVD');
      return (await adb(['shell', 'getprop', 'sys.boot_completed'], { timeout: 3000 }).catch(() => '')).trim() === '1';
    }, 'clean emulator boot', 600_000);
    report.android = (await shell('getprop', 'ro.build.version.release')).trim();
    ctx.screenshots(async name => {
      try { await shot(name); }
      finally { await writeFile(join(out, name + '.xml'), await dump(12_000)); }
    });
    const logcat = join(root, 'logcat.txt');
    artifacts['logcat.txt'] = logcat;
    const logger = spawnLogged(adbBin, [...adbDevice, 'logcat', '-b', 'all', '-v', 'threadtime'], { env, log: logcat });
    dispose(async () => {
      const marker = `end-${Date.now()}`;
      let records;
      try {
        await shell('log', '-t', 'UAR_E2E', marker);
        records = await waitFor(async () => {
          assert(running(logger), 'Android logcat stopped before fixture teardown');
          const text = await readFile(logcat, 'utf8');
          return text.includes(marker) ? text : null;
        }, 'Android logcat final marker', 15_000);
      } finally { await killTree(logger); }
      const appPids = new Set([...records.matchAll(/\bActivityManager\s*:\s*Start proc (\d+):sh\.paseo(?:[:/]|\b)/g)].map(match => match[1]));
      report.fatalLogcat = records.split('\n').filter(line => {
        if (/\bE AndroidRuntime\s*:\s*Process: sh\.paseo(?:[:,]|$)|\bF (?:DEBUG|libc)\s*:.*>>> sh\.paseo(?:[: ]|$)/.test(line)) return true;
        const js = line.match(/\s(\d+)\s+\d+\s+([EF]) ReactNativeJS\s*:\s*(.*)/);
        return js && appPids.has(js[1]) && (js[2] === 'F' || /^(?:Fatal|Unhandled JS Exception)\b/i.test(js[3]));
      });
      assert.deepEqual(report.fatalLogcat, [], 'Paseo Android logged a fatal error');
    });
  }

  async function connect(observerPort) {
    assert(running(emulator), 'Fixture emulator exited before APK installation');
    assert.equal(await avdName(), avd, 'Refusing to install on a different AVD');
    await adb(['install', apk], { timeout: 1_200_000 });
    // An AVD can expose a hardware keyboard. Keep the native IME available for the sheet.
    await shell('settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
    report.apkVersion = (await shell('dumpsys', 'package', PACKAGE)).match(/versionName=(\S+)/)?.[1];
    assert.equal(report.apkVersion, fixture.version, 'APK version must match the Paseo CLI');
    if (Number((await shell('getprop', 'ro.build.version.sdk')).trim()) >= 33)
      await shell('pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
    await adb(['reverse', `tcp:${fixture.port}`, `tcp:${observerPort}`]);
    await launch();
    let direct;
    try { direct = await find('Direct connection', 120_000); }
    catch (error) {
      if (error.message !== 'Timeout: Android UI Direct connection') throw error;
      // UI Automator can time out waiting for idle while the welcome button is already drawn.
      direct = await locateScreenshotText(await screenshotRaw(), 'Direct connection', join(out, 'direct-connection.pgm'));
    }
    await tapNode(direct);
    await type('Host', '127.0.0.1');
    await type('Port', String(fixture.port));
    await tap('Connect');
    await find('Open menu', 120_000);
  }

  async function screenshotRaw() {
    const raw = await adb(['exec-out', 'screencap'], { encoding: 'buffer' });
    const width = raw.readUInt32LE(0), height = raw.readUInt32LE(4), format = raw.readUInt32LE(8);
    assert.equal(format, 1, 'Expected RGBA_8888 from emulator screencap');
    const offset = raw.length - width * height * 4;
    assert(offset === 12 || offset === 16, 'Unexpected raw screenshot size');
    return { width, height, pixels: raw.subarray(offset) };
  }

  return { boot, connect, nodes, find, tap, tapNode, type, shell, scrollTo, shot, launch, swipe, recordScreen, screenshotRaw };
}
