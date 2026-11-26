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

export async function assertRecordedToast({ video, frames, text, screenshot }) {
  await mkdir(frames);
  const fps = 5;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-i', video,
    '-map', '0:v:0', '-vf', `fps=${fps}`, '-threads', '2', '-start_number', '0', join(frames, '%04d.png')],
  { timeout: 30_000 });
  const files = (await readdir(frames)).sort();
  const seen = new Set();
  const deadline = performance.now() + 90_000;
  for (const file of files) {
    const frame = join(frames, file);
    const hash = createHash('sha256').update(await readFile(frame)).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    const remaining = Math.ceil(deadline - performance.now());
    assert(remaining > 0, `Timed out reading Android toast frames for ${text}`);
    if (text.test(await readScreenshotText(frame, remaining))) {
      await copyFile(frame, screenshot);
      return { elapsedMs: Number.parseInt(file, 10) * 1000 / fps };
    }
  }
  assert.fail(`No decoded Android frame showed ${text} in ${seen.size} distinct frames. See ${video}.`);
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
