import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';
import type { Root } from 'hast';
import type { Plugin } from 'unified';

// Keeps the markup used by our own content and plugins (classes, inline styles, ids,
// figures, hover tooltips) while stripping scripts, event handlers, iframes, forms and
// javascript:/data: URLs from anything that ends up in markdown, including submissions.
const allowAnyClass = (definitions: NonNullable<SanitizeSchema['attributes']>[string] = []) => [
  ...definitions.filter((definition) => !(Array.isArray(definition) && definition[0] === 'className')),
  'className',
];

export const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  // Our own anchors (e.g. level sector ids) must keep their exact ids.
  clobber: [],
  clobberPrefix: '',
  tagNames: [...(defaultSchema.tagNames ?? []), 'figure', 'figcaption'],
  attributes: {
    ...Object.fromEntries(
      Object.entries(defaultSchema.attributes ?? {}).map(([tagName, definitions]) => [
        tagName,
        tagName === '*' ? definitions : allowAnyClass(definitions),
      ]),
    ),
    '*': [
      ...(defaultSchema.attributes?.['*'] ?? []),
      'className',
      'style',
      'ariaHidden',
      'ariaLabel',
      'role',
      'dataTooltip',
    ],
    img: [...allowAnyClass(defaultSchema.attributes?.img), 'loading', 'decoding'],
  },
};

// Astro only converts raw HTML into elements at the very end of its pipeline, after user
// rehype plugins, so parse it here first; otherwise the sanitizer would drop it unseen.
export const rehypeSanitizeContent: Plugin<[], Root> = function () {
  const parseRaw = rehypeRaw.call(this) as (tree: Root, file: unknown) => Root;
  const sanitize = rehypeSanitize.call(this, sanitizeSchema) as (tree: Root) => Root;
  return (tree, file) => sanitize(parseRaw(tree, file));
};
