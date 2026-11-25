import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

export async function androidDevice(ctx, fixture, args) {
  const { report, root, out, dispose, artifacts } = ctx;
  const sdk = resolve(args.sdk), apk = resolve(args.apk);
  report.apk = apk;
  const port = Number(args.port);
  assert(Number.isInteger(port) && port >= 5554 && port <= 5682 && port % 2 === 0, 'Use an even emulator console port from 5554 to 5682');
  const avd = 'usage-auto-resume-e2e', serial = 'emulator-' + port;
  const avdHome = join(root, 'avd'), androidHome = join(root, 'android-user');
  await Promise.all([avdHome, androidHome].map(dir => mkdir(dir)));
  const adbPort = await freePort();
  const env = { ...fixture.env, ...inherited(['JAVA_HOME', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']),
    ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: avdHome, ANDROID_USER_HOME: androidHome,
    ANDROID_EMULATOR_HOME: androidHome, ANDROID_ADB_SERVER_PORT: String(adbPort), ADB_LOCAL_TRANSPORT_MAX_PORT: '5683',
  };
  const adbBin = join(sdk, 'platform-tools', 'adb');
  const adb = async (args, { timeout = 30_000, encoding = 'utf8', direct = false } = {}) =>
    (await run(adbBin, ['-P', String(adbPort), ...(direct ? [] : ['-s', serial]), ...args],
      { env, timeout, encoding, maxBuffer: 48 * 1024 * 1024 })).stdout;
  const shell = (...args) => adb(['shell', args.map(quote).join(' ')]);
  const tapNode = node => shell('input', 'tap', Math.floor((node.left + node.right) / 2), Math.floor((node.top + node.bottom) / 2));
  let lastXml = '', emulator;
  report.anrDismissed = 0;

  async function nodes(timeout = 12_000) {
    try {
      const xml = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout });
      if (!xml.includes('<hierarchy')) return [];
      lastXml = xml;
    } catch (error) {
      if (emulator && !running(emulator)) throw new Error('Emulator exited during UI polling', { cause: error });
      return [];
    }
    const list = hierarchy(lastXml);
    const dialog = list.find(node => node.pkg !== PACKAGE && /^(System UI|com\.android\.systemui) isn.t responding/i.test(node.text));
    const wait = dialog && list.find(node => node.pkg === dialog.pkg && node.text === 'Wait');
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

  const shot = async name => writeFile(join(out, name + '.png'), await adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer' }));
  const launch = () => shell('monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1');

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
        '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-cores', '2', '-memory', '2048', '-timezone', timezone],
      { env, log });
    dispose(async () => {
      try { if (running(emulator)) await adb(['emu', 'kill'], { timeout: 10_000 }); }
      catch { /* The process group is the fallback when adb is unavailable. */ }
      finally { await killTree(emulator); }
    });
    await waitFor(async () => {
      assert(running(emulator), 'Emulator exited during boot. See emulator.log.');
      return (await adb(['shell', 'getprop', 'sys.boot_completed'], { timeout: 3000 }).catch(() => '')).trim() === '1';
    }, 'clean emulator boot', 600_000);
    report.android = (await shell('getprop', 'ro.build.version.release')).trim();
    ctx.screenshots(async name => {
      await nodes(5000);
      await shot(name);
      await writeFile(join(out, name + '.xml'), lastXml);
    });
    const logcat = join(root, 'logcat.txt');
    artifacts['logcat.txt'] = logcat;
    dispose(async () => {
      const records = await adb(['logcat', '-d', '-v', 'threadtime']);
      await writeFile(logcat, records);
      report.fatalLogcat = records.split('\n').filter(line =>
        /\b(?:E|F) ReactNativeJS\b.*(?:Error|Exception|Hermes)|\bF libc\b.*Fatal signal.*sh\.paseo|\bE AndroidRuntime\b.*Process: sh\.paseo\b|\bF DEBUG\b.*sh\.paseo/i.test(line));
      assert.deepEqual(report.fatalLogcat, [], 'Paseo Android logged a fatal error');
    });
  }

  async function connect() {
    await adb(['install', apk], { timeout: 1_200_000 });
    // An AVD can expose a hardware keyboard. Keep the native IME available for the sheet.
    await shell('settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
    report.apkVersion = (await shell('dumpsys', 'package', PACKAGE)).match(/versionName=(\S+)/)?.[1];
    assert.equal(report.apkVersion, fixture.version, 'APK version must match the Paseo CLI');
    if (Number((await shell('getprop', 'ro.build.version.sdk')).trim()) >= 33)
      await shell('pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
    await adb(['reverse', `tcp:${fixture.port}`, `tcp:${fixture.port}`]);
    await launch();
    await tap('Direct connection', 120_000);
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

  return { boot, connect, nodes, find, tap, tapNode, type, shell, scrollTo, shot, launch, swipe, screenshotRaw };
}
