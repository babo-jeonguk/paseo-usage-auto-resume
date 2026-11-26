import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './core.mjs';

const words = text => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const ocr = (args, timeout = 20_000) => run('tesseract', args, { env: { ...process.env, OMP_THREAD_LIMIT: '1' }, timeout });

async function writeScreenshotCrop(screenshot, bounds, cropPath) {
  const { left, top, right, bottom } = bounds;
  assert(left >= 0 && top >= 0 && right <= screenshot.width && bottom <= screenshot.height &&
    left < right && top < bottom, 'Text region is outside the display');
  const padding = 10;
  const width = right - left + 2 * padding;
  const height = bottom - top + 2 * padding;
  const gray = (x, y) => {
    const at = (y * screenshot.width + x) * 4;
    return Math.round((screenshot.pixels[at] + screenshot.pixels[at + 1] + screenshot.pixels[at + 2]) / 3);
  };
  const pixels = Buffer.alloc(width * height, gray(left, top));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) pixels[(y - top + padding) * width + x - left + padding] = gray(x, y);
  }
  await writeFile(cropPath, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]));
  return padding;
}

export async function assertScreenshotText(screenshot, bounds, expected, cropPath) {
  await writeScreenshotCrop(screenshot, bounds, cropPath);
  const { stdout } = await ocr([cropPath, 'stdout', '-l', 'eng', '--psm', '6']);
  assert.deepEqual(words(stdout), words(expected), 'The screenshot must contain every word in the tooltip paragraph');
  return stdout.trim();
}

async function readScreenshotText(path, timeout) {
  const { stdout } = await ocr([path, 'stdout', '-l', 'eng', '--psm', '11'], timeout);
  return stdout.replace(/\s+/g, ' ').trim();
}

export function androidToastWindow(responseAt, samples, tailMs) {
  // The guest reads CLOCK_BOOTTIME between the two host timestamps. /proc/uptime
  // truncates to hundredths of a second, so each sample bounds the clock offset.
  const earliest = responseAt + Math.max(...samples.map(sample => sample.elapsedMs - sample.after));
  const latest = responseAt + Math.min(...samples.map(sample => sample.elapsedMs + 10 - sample.before));
  assert(earliest <= latest, 'Android clock samples disagree across Resume now');
  return { earliest, latest, end: latest + tailMs };
}

export function toastFrameTime(time, window) {
  if (time < window.earliest || time > window.end) return 'outside';
  return time < window.latest ? 'uncertain' : 'after';
}

export function hasToastFrameCoverage(times, window) {
  const gaps = [window.earliest, ...times.filter(time => time > window.earliest && time < window.end), window.end];
  return gaps.slice(1).every((time, index) => time - gaps[index] <= 1000);
}

export function androidRecordingTimes(metadata) {
  // Android screenrecord's second data track is the version 2 Winscope
  // metadata. Its samples use elapsed realtime (CLOCK_BOOTTIME), as does uptime.
  const headerBytes = 32;
  assert(metadata.length >= headerBytes && metadata.subarray(0, 16).toString() === '#VV1NSC0PET1ME2#' &&
    metadata.readUInt32LE(16) === 2, 'Expected version 2 Winscope screen recording metadata');
  const count = metadata.readUInt32LE(28);
  assert(count > 0 && metadata.length === headerBytes + count * 8, 'Incomplete Android screen recording metadata');
  return Array.from({ length: count }, (_, index) => Number(metadata.readBigUInt64LE(headerBytes + index * 8)) / 1e6);
}

export async function assertRecordedToast({ video, frames, text, screenshot, capture, tailMs }) {
  await mkdir(frames);
  const metadataPath = join(frames, 'winscope.bin');
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-threads', '2', '-i', video,
    '-map', '0:d:1', '-c', 'copy', '-f', 'data', metadataPath,
    '-map', '0:v:0', '-vf', 'showinfo', '-vsync', '0', '-threads', '2', '-start_number', '0', join(frames, '%04d.png')],
  { timeout: 45_000, maxBuffer: 16 * 1024 * 1024 });
  const times = androidRecordingTimes(await readFile(metadataPath)).sort((a, b) => a - b);
  const files = (await readdir(frames)).filter(file => file.endsWith('.png')).sort();
  const pts = [...stderr.matchAll(/\bpts_time:\s*([\d.e+-]+)/g)].map(match => Number(match[1]) * 1000);
  assert(files.length === times.length && times.length === pts.length && pts.every((time, index) =>
    Math.abs((time - pts[0]) - (times[index] - times[0])) < 1),
  `Decoded Android frames do not match their Winscope timestamps. See ${video}.`);
  const window = androidToastWindow(capture.at, capture.clocks, tailMs);
  const recognized = new Map();
  let matchInUncertainWindow = false;
  const deadline = performance.now() + 90_000;
  for (const [index, time] of times.entries()) {
    const timing = toastFrameTime(time, window);
    if (timing === 'outside') continue;
    const frame = join(frames, files[index]);
    const hash = createHash('sha256').update(await readFile(frame)).digest('hex');
    if (!recognized.has(hash)) {
      const remaining = Math.ceil(deadline - performance.now());
      assert(remaining > 0, `Timed out reading Android toast frames for ${text}`);
      recognized.set(hash, text.test(await readScreenshotText(frame, remaining)));
    }
    if (!recognized.get(hash)) continue;
    if (timing === 'uncertain') {
      matchInUncertainWindow = true;
      continue;
    }
    await copyFile(frame, screenshot);
    return { elapsedMs: Math.round(time - times[0]) };
  }
  const details = `${times.length} frames; ${recognized.size} distinct frames examined; last frame ${Math.round(times.at(-1))} ms, response window ${Math.round(window.earliest)}–${Math.round(window.end)} ms since boot. See ${video}.`;
  assert(!matchInUncertainWindow, `Android toast capture is inconclusive: text matched only while response timing was uncertain (${details})`);
  // The encoder can omit static frames. Only report missing UI feedback when the source recording
  // actually sampled the whole response window without a gap that could hide a short toast.
  assert(hasToastFrameCoverage(times, window),
    `Android toast capture is inconclusive: insufficient encoded frame coverage (${details})`);
  assert.fail(`No decoded Android frame showed ${text} (${details})`);
}

export async function locateScreenshotText(screenshot, expected, cropPath) {
  const padding = await writeScreenshotCrop(screenshot,
    { left: 0, top: 0, right: screenshot.width, bottom: screenshot.height }, cropPath);
  const { stdout } = await ocr([cropPath, 'stdout', '-l', 'eng', '--psm', '11', '-c', 'tessedit_create_tsv=1', '-c', 'tessedit_create_txt=0']);
  const lines = new Map();
  for (const row of stdout.split('\n').slice(1)) {
    const [level, page, block, paragraph, line, , x, y, width, height, , text] = row.split('\t');
    if (level !== '5' || !text) continue;
    const key = [page, block, paragraph, line].join(':');
    const left = Number(x) - padding, top = Number(y) - padding;
    const box = lines.get(key) ?? { left, top, right: left, bottom: top, text: '' };
    box.left = Math.min(box.left, left);
    box.top = Math.min(box.top, top);
    box.right = Math.max(box.right, left + Number(width));
    box.bottom = Math.max(box.bottom, top + Number(height));
    box.text += ` ${text}`;
    lines.set(key, box);
  }
  const matches = [...lines.values()].filter(line => words(line.text).join(' ') === words(expected).join(' '));
  assert.equal(matches.length, 1, `The screenshot must show one ${expected} label`);
  return matches[0];
}
