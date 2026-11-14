import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';
import sharpService from 'astro/assets/services/sharp';

test('Astro processes character images after the app loads sharp', async () => {
  const input = await readFile(new URL('../src/assets/images/webber/1.png', import.meta.url));
  await sharp(input).metadata();

  const result = await sharpService.transform(
    input,
    { src: '/webber/1.png', width: 128, format: 'webp' },
    { service: { config: {} } },
  );
  const metadata = await sharp(result.data).metadata();

  assert.equal(result.format, 'webp');
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 128);
});
