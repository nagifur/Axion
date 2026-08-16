import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type ProfileReference = {
  name: string;
  slug: string;
};

const contentDirectory = fileURLToPath(new URL('../content/', import.meta.url));

const readReferences = (collection: 'personnel' | 'entities'): ProfileReference[] => {
  const directory = join(contentDirectory, collection);

  return readdirSync(directory)
    .filter((filename) => filename.endsWith('.md'))
    .map((filename) => {
      const source = readFileSync(join(directory, filename), 'utf8');
      const title = source.match(/^title:\s*(.+)$/m)?.[1]?.trim();

      if (!title) {
        throw new Error(`Missing title frontmatter in ${collection}/${filename}`);
      }

      return { name: title.replace(/^['"]|['"]$/g, ''), slug: filename.slice(0, -3) };
    });
};

export const personnelReferences = readReferences('personnel');
export const entityReferences = readReferences('entities');

const pagesDirectory = join(contentDirectory, 'pages');

// "Level 0".md -> reference named "Level 0" pointing at slug "0".
const readLevelReferences = (): ProfileReference[] => {
  return readdirSync(pagesDirectory)
    .filter((filename) => /^level-\d+\.md$/.test(filename))
    .map((filename) => {
      const source = readFileSync(join(pagesDirectory, filename), 'utf8');
      const title = source.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');

      if (!title) {
        throw new Error(`Missing title frontmatter in pages/${filename}`);
      }

      const level = filename.replace(/^level-|\.md$/g, '');
      return { name: title, slug: level };
    });
};

// class-a.md -> letter "A" (from filename) + label from title, works whether the
// title is just "Ally" or the older "Class A - Ally" format.
const readClassReferences = (): ProfileReference[] => {
  return readdirSync(pagesDirectory)
    .filter((filename) => /^class-[a-z]\.md$/.test(filename))
    .flatMap((filename) => {
      const source = readFileSync(join(pagesDirectory, filename), 'utf8');
      const title = source.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');

      if (!title) {
        throw new Error(`Missing title frontmatter in pages/${filename}`);
      }

      const slug = filename.slice('class-'.length, -3);
      const letter = slug.toUpperCase();
      const label = title.replace(/^Class\s+\S+\s*-\s*/i, '').trim();
      const aliases = [`${letter} class`, `Class ${letter}`, `${label} class`, `Class ${label}`];
      return aliases.map((name) => ({ name, slug }));
    });
};

export const levelReferences = readLevelReferences();
export const classReferences = readClassReferences();