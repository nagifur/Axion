import { entityReferences, personnelReferences } from './profileReferences';

type Reference = {
  name: string;
  url: string;
};

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

type PluginOptions = {
  base: string;
};

type MarkdownFile = {
  path?: string;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeBase = (base: string): string => base.replace(/\/$/, '');
const protectedNodeTypes = new Set(['code', 'html', 'inlineCode', 'link', 'linkReference']);

const getCurrentProfileUrl = (file: MarkdownFile, base: string): string | undefined => {
  const filePath = file.path?.replaceAll('\\', '/');
  const match = filePath?.match(/\/content\/(personnel|entities)\/([^/]+)\.md$/);

  if (!match) {
    return undefined;
  }

  const [, collection, slug] = match;
  const route = collection === 'personnel' ? 'Personnel' : 'Entities';
  return `${base}/${route}/${slug}`;
};

export default function remarkAutoLinkReferences({ base }: PluginOptions) {
  const normalizedBase = normalizeBase(base);
  const allReferences: Reference[] = [
    ...personnelReferences.map(({ name, slug }) => ({
      name,
      url: `${normalizedBase}/Personnel/${slug}`,
    })),
    ...entityReferences.map(({ name, slug }) => ({
      name,
      url: `${normalizedBase}/Entities/${slug}`,
    })),
  ].sort((first, second) => second.name.length - first.name.length);

  return (tree: MarkdownNode, file: MarkdownFile) => {
    const currentProfileUrl = getCurrentProfileUrl(file, normalizedBase);
    const references = allReferences.filter((reference) => reference.url !== currentProfileUrl);
    const referenceByName = new Map(references.map((reference) => [reference.name, reference]));
    const referencePattern = new RegExp(
      `\\b(${references.map((reference) => escapeRegExp(reference.name)).join('|')})\\b`,
      'g',
    );

    const transformChildren = (node: MarkdownNode) => {
      if (protectedNodeTypes.has(node.type) || !node.children) {
        return;
      }

      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value) {
          transformChildren(child);
          return child;
        }

        const parts: MarkdownNode[] = [];
        let cursor = 0;
        referencePattern.lastIndex = 0;

        for (const match of child.value.matchAll(referencePattern)) {
          const matchIndex = match.index ?? 0;
          const reference = referenceByName.get(match[0]);

          if (!reference) {
            continue;
          }

          if (matchIndex > cursor) {
            parts.push({ type: 'text', value: child.value.slice(cursor, matchIndex) });
          }

          parts.push({
            type: 'link',
            url: reference.url,
            children: [{ type: 'text', value: reference.name }],
          });
          cursor = matchIndex + reference.name.length;
        }

        if (parts.length === 0) {
          return child;
        }

        if (cursor < child.value.length) {
          parts.push({ type: 'text', value: child.value.slice(cursor) });
        }

        return parts;
      });
    };

    transformChildren(tree);
  };
}