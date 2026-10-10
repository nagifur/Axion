import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import remarkArticleImage from '../src/lib/remarkArticleImage.ts';
import { resolveArticleImages } from '../src/lib/articleImages.ts';

const processor = await createMarkdownProcessor({
  remarkPlugins: [remarkArticleImage],
});
const fileURL = pathToFileURL(path.resolve('src/content/articles/magic-system.md'));
const directive = '::image{file="example.gif" alt="Nagi explaining magic" caption="Magic & particles" align="center"}';

test('resolves inferred article images to native bundled asset URLs', async () => {
  const { code } = await processor.render(directive, { fileURL });
  const html = resolveArticleImages(code, {
    'magic-system/example.gif': '/_astro/example.hash.gif',
  });
  assert.match(html, /class="article-image article-image--center"/);
  assert.match(html, /src="\/_astro\/example.hash.gif"/);
  assert.match(html, /alt="Nagi explaining magic"/);
  assert.match(html, /<figcaption>Magic &#x26; particles<\/figcaption>/);
  assert.doesNotMatch(html, /data-article-image|__ASTRO_IMAGE_/);
});

test('supports explicit folders, escaped asset URLs, and all alignments', async () => {
  for (const alignment of ['full', 'center', 'left', 'right']) {
    const { code } = await processor.render(
      `::image{file="example.png" folder="shared" caption="A caption" align="${alignment}"}`,
      { fileURL },
    );
    const html = resolveArticleImages(code, { 'shared/example.png': '/_astro/example.png?v=1&x=2' });
    assert.match(html, new RegExp(`article-image--${alignment}`));
    assert.match(html, /src="\/_astro\/example.png\?v=1&amp;x=2"/);
    assert.match(html, /<figcaption>A caption<\/figcaption>/);
  }
});

test('preserves legacy public images and prefers assets when both exist', async () => {
  const publicDirectory = mkdtempSync(path.join(os.tmpdir(), 'axion-article-images-'));
  try {
    const folder = path.join(publicDirectory, 'images/articles/magic-system');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'example.gif'), 'legacy image');
    const { code } = await processor.render(directive, { fileURL });
    assert.match(resolveArticleImages(code, {}, publicDirectory), /src="\/images\/articles\/magic-system\/example.gif"/);
    assert.match(resolveArticleImages(code, {
      'magic-system/example.gif': '/_astro/example.hash.gif',
    }, publicDirectory), /src="\/_astro\/example.hash.gif"/);
  } finally {
    rmSync(publicDirectory, { recursive: true });
  }
});

test('reports missing images instead of rendering broken URLs', async () => {
  const { code } = await processor.render(directive, { fileURL });
  assert.throws(() => resolveArticleImages(code, {}), /Article image "magic-system\/example.gif" was not found/);
});

test('leaves ordinary Markdown, native images, and code examples unchanged', async () => {
  const { code } = await processor.render('**Magic**\n\n![Other image](/other.png)\n\n`::image{file="example.gif"}`', { fileURL });
  assert.equal(resolveArticleImages(code, {}), code);
  assert.match(code, /<strong>Magic<\/strong>/);
});
