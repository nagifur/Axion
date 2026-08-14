import entities from '../data/entities.json';
import personnel from '../data/personnel.json';

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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeBase = (base: string): string => base.replace(/\/$/, '');
const protectedNodeTypes = new Set(['code', 'html', 'inlineCode', 'link', 'linkReference']);

export default function remarkAutoLinkReferences({ base }: PluginOptions) {
  const normalizedBase = normalizeBase(base);
  const references: Reference[] = [
    ...Object.entries(personnel).map(([slug, person]) => ({
      name: person.name,
      url: `${normalizedBase}/Personnel/${slug}`,
    })),
    ...Object.entries(entities).map(([slug, entity]) => ({
      name: entity.name,
      url: `${normalizedBase}/Entities/${slug}`,
    })),
  ].sort((first, second) => second.name.length - first.name.length);

  const referenceByName = new Map(references.map((reference) => [reference.name, reference]));
  const referencePattern = new RegExp(
    `\\b(${references.map((reference) => escapeRegExp(reference.name)).join('|')})\\b`,
    'g',
  );

  return (tree: MarkdownNode) => {
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