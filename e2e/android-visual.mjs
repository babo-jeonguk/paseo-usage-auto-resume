import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { run } from './core.mjs';

const words = text => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export async function assertScreenshotText(screenshot, bounds, expected, cropPath) {
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
  const { stdout } = await run('tesseract', [cropPath, 'stdout', '-l', 'eng', '--psm', '6'], { timeout: 20_000 });
  assert.deepEqual(words(stdout), words(expected), 'The screenshot must contain every word in the tooltip paragraph');
  return stdout.trim();
}
