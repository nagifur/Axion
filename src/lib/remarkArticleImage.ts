type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

type MarkdownFile = {
  path?: string;
  history?: string[];
  data?: {
    astro?: {
      frontmatter?: {
        title?: unknown;
      };
    };
  };
};

type ImageAlignment = 'full' | 'center' | 'left' | 'right';

const DIRECTIVE_PATTERN = /^::image\{(.+)\}$/;
const ATTRIBUTE_PATTERN = /\b(file|folder|alt|caption|align)=["“]((?:\\.|[^"“”\\])*)["”]/g;
const alignments = new Set<ImageAlignment>(['full', 'center', 'left', 'right']);

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const decodeAttribute = (value: string): string => value.replace(/\\(["\\])/g, '$1');
const slugify = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const articleSlug = (file: MarkdownFile): string | undefined => {
  const sourcePath = file.path || file.history?.at(-1);
  const normalizedPath = sourcePath?.replaceAll('\\', '/').split('?')[0];
  const filename = normalizedPath?.split('/').at(-1);
  const pathSlug = filename?.replace(/\.(?:md|mdx)$/, '');
  if (pathSlug) return pathSlug;

  const title = file.data?.astro?.frontmatter?.title;
  return typeof title === 'string' ? slugify(title) || undefined : undefined;
};

export default function remarkArticleImage() {
  return (tree: MarkdownNode, file: MarkdownFile) => {
    const inferredSlug = articleSlug(file);

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
        const slug = attributes.get('folder') || inferredSlug || '';
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return child;

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