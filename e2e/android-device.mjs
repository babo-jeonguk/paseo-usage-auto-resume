import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { freePort, inherited, killTree, run, running, spawnLogged, waitFor } from './core.mjs';

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

export function androidUi({ dump, shell, tapNode, report, emulatorExited = () => false }) {
  report.anrDismissed = 0;

  async function nodes(timeout = 60_000, observe) {
    let xml;
    try {
      xml = await dump(timeout);
    } catch (error) {
      if (emulatorExited()) throw new Error('Emulator exited during UI polling', { cause: error });
      observe?.(error.killed && error.signal === 'SIGTERM' ? 'dumpTimeout' : 'dumpError');
      return [];
    }
    if (!xml.includes('<hierarchy')) {
      observe?.('noHierarchy');
      return [];
    }
    const list = hierarchy(xml);
    const dialog = list.find(node => node.pkg === 'android' && node.id === 'android:id/alertTitle' &&
      / isn['’]t responding$/i.test(node.text));
    if (dialog) {
      const titles = report.anrDialogs ??= [];
      if (!titles.includes(dialog.text)) titles.push(dialog.text);
      if (/^(?:Paseo|sh\.paseo) isn['’]t responding$/i.test(dialog.text)) {
        throw new Error('Paseo ANR: ' + dialog.text);
      }
      // Android owns every ANR dialog window. The title identifies the stalled process.
      const wait = /^(?:System UI|com\.android\.systemui|Process system) isn['’]t responding$/i.test(dialog.text) &&
        list.find(node => node.pkg === 'android' && node.id === 'android:id/aerr_wait' && node.enabled);
      if (wait) {
        await tapNode(wait);
        report.anrDismissed++;
      }
      observe?.(wait ? 'systemAnrDismissed' : 'unhandledAnr');
      return [];
    }
    return list;
  }

  async function find(label, timeout = 120_000, description = String(label)) {
    const start = performance.now();
    const observations = {};
    const observe = outcome => { observations[outcome] = (observations[outcome] ?? 0) + 1; };
    const matches = matchNode(label);
    try {
      return await waitFor(async () => {
        const remaining = Math.max(1, timeout - (performance.now() - start));
        let outcome = 'noMatch';
        const list = await nodes(Math.min(60_000, remaining), result => { outcome = result; });
        const match = list.find(matches);
        observe(match ? 'matched' : outcome);
        return match;
      }, `Android UI ${description}`, timeout, 100);
    } catch (error) {
      report.uiWaitFailure = { description, elapsedMs: Math.round(performance.now() - start), observations };
      throw error;
    }
  }

  async function tap(label, timeout) {
    const matches = matchNode(label);
    await tapNode(await find(node => node.enabled && matches(node), timeout, `enabled ${label}`));
  }

  async function type(label, value) {
    const input = node => node.pkg === PACKAGE && node.class === 'android.widget.EditText' && node.desc === label;
    const field = await find(input, undefined, `${label} field`);
    assert(/^[ -~]*$/.test(value) && !value.includes('%s'), 'adb input text requires ASCII and reserves %s for a space');
    await tapNode(field);
    await shell('input', 'keyevent', 'KEYCODE_MOVE_END', ...Array(Math.max(1, field.text?.length ?? 0)).fill('KEYCODE_DEL'));
    if (value) await shell('input', 'text', value.replaceAll(' ', '%s'));
    let lastValue;
    try {
      await find(node => {
        if (!input(node)) return false;
        lastValue = node.text;
        return lastValue === value;
      }, undefined, `entered value for ${label}`);
    } catch (error) {
      report.inputFailure = { label, expected: value, lastValue };
      throw error;
    }
  }

  return { nodes, find, tap, type };
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
  const dump = timeout => adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout });
  const ui = androidUi({ dump, shell, tapNode, report, emulatorExited: () => emulator && !running(emulator) });

  const swipe = (x, y, endY) => shell('input', 'swipe', x, y, x, endY, 500);
  async function scrollTo(label, direction = 'down') {
    const matches = matchNode(label);
    const size = (await shell('wm', 'size')).trim().split('\n').at(-1).match(/(\d+)x(\d+)/);
    const width = Number(size[1]), height = Number(size[2]);
    for (let i = 0; i <= 7; i++) {
      const node = (await ui.nodes()).find(matches);
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
      ['-avd', avd, '-port', String(port), '-wipe-data', ...(args.visual === '1' ? [] : ['-no-window']), '-no-audio', '-no-snapshot',
        '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-cores', '2', '-memory', '2048', '-timezone', timezone,
        '-no-metrics', '-crash-report-mode', 'disabled'],
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
      report.paseoAnrs = records.split('\n').filter(line => /\bActivityManager\s*:\s*ANR in sh\.paseo(?=[:\s(]|$)/.test(line));
      assert(report.fatalLogcat.length === 0 && report.paseoAnrs.length === 0, 'Paseo Android logged a fatal error or ANR');
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
    report.connectionLaunchAt = new Date().toISOString();
    await launch();
    await ui.tap('Direct connection', 120_000);
    report.directConnectionTappedAt = new Date().toISOString();
    await ui.type('Host', '127.0.0.1');
    await ui.type('Port', String(fixture.port));
    await ui.tap('Connect');
    await ui.find('Open menu', 120_000);
  }

  return { ...ui, boot, connect, tapNode, shell, scrollTo, shot, launch, swipe };
}
