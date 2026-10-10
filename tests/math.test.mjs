import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

const processor = await createMarkdownProcessor({
  remarkPlugins: [remarkMath],
  rehypePlugins: [rehypeKatex],
});

test('renders scientific notation with accessible exponents and subscripts', async () => {
  const { code } = await processor.render(String.raw`Density: $\rho_M \approx 1.2 \times 10^8 \,\mathrm{p}/\mathrm{m}^3$.`);
  assert.match(code, /class="katex"/);
  assert.match(code, /<math[^>]*xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(code, /<msup>/);
  assert.match(code, /<msub>/);
});

test('renders block fractions and negative exponents', async () => {
  const { code } = await processor.render('$$\n\\frac{1}{10^{-8}}\n$$');
  assert.match(code, /katex-display/);
  assert.match(code, /<mfrac>/);
  assert.match(code, /<msup>/);
});

test('keeps math syntax literal inside inline and fenced code', async () => {
  const { code } = await processor.render('`$10^8$`\n\n```text\n$10^8$\n```');
  assert.doesNotMatch(code, /class="katex"/);
  assert.match(code, /\$10\^8\$/);
});

test('preserves ordinary Markdown alongside math', async () => {
  const { code } = await processor.render('**Density** is $10^8$.\n\n- *Example*\n\n[Link](https://example.com)');
  assert.match(code, /<strong>Density<\/strong>/);
  assert.match(code, /<em>Example<\/em>/);
  assert.match(code, /href="https:\/\/example.com"/);
});

test('shows unsupported math commands as visible errors', async () => {
  const { code } = await processor.render('$\\notARealCommand$');
  assert.match(code, /mathcolor="#cc0000"/);
  assert.match(code, /\\notARealCommand/);
});
