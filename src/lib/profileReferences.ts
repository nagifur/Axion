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