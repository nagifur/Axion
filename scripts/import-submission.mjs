#!/usr/bin/env node
// Safely unpacks a submission .zip from the Discord webhook into the repo.
// Usage: npm run import-submission -- path/to/submission.zip [--overwrite]
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import yaml from 'js-yaml';
import { findUnsafeMarkdown, isCleanText, sniffImageExtension } from './submissionSafety.mjs';

const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_BYTES = 15 * 1024 * 1024;
const MARKDOWN_PATH = /^src\/content\/(personnel|synthetics|entities|articles)\/[A-Za-z0-9_-]+\.md$/;
const IMAGE_PATH = /^src\/assets\/images\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/;

// A frontmatter YAML error makes Astro fail to load the whole content collection, taking the site down.
export function findFrontmatterProblem(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return 'missing frontmatter (the file must start with a --- block)';
  try {
    const data = yaml.load(match[1]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'frontmatter is not a key/value block';
  } catch (error) {
    return `invalid frontmatter YAML: ${error.reason ?? error.message}${error.mark ? ` (line ${error.mark.line + 2})` : ''}`;
  }
  return null;
}

export async function checkSubmissionZip(zipBytes) {
  const problems = [];
  const files = [];
  const zip = await JSZip.loadAsync(zipBytes);

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const isMarkdown = MARKDOWN_PATH.test(entry.name);
    if (!isMarkdown && !IMAGE_PATH.test(entry.name)) {
      problems.push(`Unexpected path: ${entry.name}`);
      continue;
    }
    // Guard against zip bombs before inflating anything.
    if ((entry._data?.uncompressedSize ?? 0) > MAX_ENTRY_BYTES) {
      problems.push(`Too large: ${entry.name}`);
      continue;
    }

    const data = await entry.async('uint8array');
    if (data.length > MAX_ENTRY_BYTES) {
      problems.push(`Too large: ${entry.name}`);
      continue;
    }

    if (isMarkdown) {
      const text = isCleanText(data) ? new TextDecoder().decode(data) : null;
      const reason = text === null ? 'not clean text' : findUnsafeMarkdown(text) ?? findFrontmatterProblem(text);
      if (reason) problems.push(`${entry.name}: ${reason}`);
    } else {
      const ext = entry.name.split('.').pop().toLowerCase();
      if (sniffImageExtension(data) !== ext.replace('jpeg', 'jpg')) {
        problems.push(`${entry.name}: content is not a ${ext} image`);
      }
    }
    files.push({ path: entry.name, data });
  }

  if (files.filter((file) => file.path.endsWith('.md')).length !== 1) {
    problems.push('The zip must contain exactly one markdown file.');
  }
  return { files, problems };
}

async function main(args) {
  const overwrite = args.includes('--overwrite');
  const zipPath = args.find((arg) => !arg.startsWith('--'));
  if (!zipPath) {
    console.error('Usage: npm run import-submission -- path/to/submission.zip [--overwrite]');
    return 1;
  }
  if ((await stat(zipPath)).size > MAX_ZIP_BYTES) {
    console.error('Refusing to import: the zip is larger than 25 MB.');
    return 1;
  }

  const { files, problems } = await checkSubmissionZip(await readFile(zipPath));
  if (problems.length) {
    console.error('Refusing to import:\n' + problems.map((problem) => `  - ${problem}`).join('\n'));
    return 1;
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const existing = files.filter((file) => existsSync(join(root, file.path)));
  if (existing.length && !overwrite) {
    console.error(
      'Refusing to import: these files already exist and would be replaced:\n' +
        existing.map((file) => `  - ${file.path}`).join('\n') +
        '\nCheck that this submission is meant to update that page, then rerun with --overwrite.',
    );
    return 1;
  }

  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
    console.log(`${existing.includes(file) ? 'Replaced' : 'Added'} ${file.path}`);
  }
  console.log('\nReview the result with `git status` and `git diff` before committing.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
