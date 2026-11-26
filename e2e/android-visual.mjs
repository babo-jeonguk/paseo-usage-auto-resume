import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { run, sleep } from './core.mjs';

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

export async function observeToast({ capturePng, action, text, screenshot }) {
  const frames = [];
  let until = Infinity;
  const capture = async () => {
    while (performance.now() < until) {
      const next = performance.now() + 400;
      frames.push(await capturePng(10_000));
      const pause = Math.min(next, until) - performance.now();
      if (pause > 0) await sleep(pause);
    }
  };
  const send = async () => {
    try {
      await action();
      until = performance.now() + 8_000;
    } catch (error) {
      until = performance.now();
      throw error;
    }
  };
  const results = await Promise.allSettled([capture(), send()]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
  const deadline = performance.now() + 25_000;
  for (const frame of frames) {
    const remaining = Math.ceil(deadline - performance.now());
    assert(remaining > 0, `Timed out reading Android toast frames for ${text}`);
    await writeFile(screenshot, frame);
    if (text.test(await readScreenshotText(screenshot, remaining))) return;
  }
  assert.fail(`No Android screenshot showed ${text} in ${frames.length} captured frames`);
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
