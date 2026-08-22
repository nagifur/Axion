type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

type MarkdownFile = {
  path?: string;
};

type ImageAlignment = 'full' | 'center' | 'left' | 'right';

const DIRECTIVE_PATTERN = /^::image\{(.+)\}$/;
const ATTRIBUTE_PATTERN = /\b(file|alt|caption|align)="((?:\\.|[^"\\])*)"/g;
const alignments = new Set<ImageAlignment>(['full', 'center', 'left', 'right']);

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const decodeAttribute = (value: string): string => value.replace(/\\(["\\])/g, '$1');

const articleSlug = (file: MarkdownFile): string | undefined => {
  const normalizedPath = file.path?.replaceAll('\\', '/');
  return normalizedPath?.match(/\/content\/articles\/([^/]+)\.md$/)?.[1];
};

export default function remarkArticleImage() {
  return (tree: MarkdownNode, file: MarkdownFile) => {
    const slug = articleSlug(file);
    if (!slug) return;

    const transformChildren = (node: MarkdownNode) => {
      if (!node.children) return;

      node.children = node.children.map((child) => {
        const text = child.type === 'paragraph' && child.children?.length === 1 && child.children[0].type === 'text'
          ? child.children[0].value
          : undefined;
        const directive = text?.match(DIRECTIVE_PATTERN);

        if (!directive) {
          transformChildren(child);
          return child;
        }

        const attributes = new Map<string, string>();
        ATTRIBUTE_PATTERN.lastIndex = 0;
        for (const match of directive[1].matchAll(ATTRIBUTE_PATTERN)) {
          attributes.set(match[1], decodeAttribute(match[2]));
        }

        const imageFile = attributes.get('file') ?? '';
        if (!/^[a-zA-Z0-9._-]+$/.test(imageFile)) return child;

        const requestedAlignment = attributes.get('align') as ImageAlignment | undefined;
        const alignment = requestedAlignment && alignments.has(requestedAlignment) ? requestedAlignment : 'full';
        const alt = attributes.get('alt') || attributes.get('caption') || imageFile;
        const caption = attributes.get('caption') ?? '';
        const src = `/images/articles/${encodeURIComponent(slug)}/${encodeURIComponent(imageFile)}`;

        return {
          type: 'html',
          value: `<figure class="article-image article-image--${alignment}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" />${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`,
        };
      });
    };

    transformChildren(tree);
  };
}