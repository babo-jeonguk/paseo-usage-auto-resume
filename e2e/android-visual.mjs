import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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

export async function readScreenshotText(path, timeout) {
  const { stdout } = await ocr([path, 'stdout', '-l', 'eng', '--psm', '11'], timeout);
  return stdout.replace(/\s+/g, ' ').trim();
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
