type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

const HOVER_PATTERN = /\{\{([^{}|]+)\|([^{}]+)\}\}/g;
const protectedNodeTypes = new Set(['code', 'html', 'inlineCode', 'link', 'linkReference']);

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Turns "{{3 422 °C|6191.6 °F}}" written in markdown prose into a hover-tooltip span.
export default function remarkHoverTooltip() {
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
        HOVER_PATTERN.lastIndex = 0;

        for (const match of child.value.matchAll(HOVER_PATTERN)) {
          const matchIndex = match.index ?? 0;

          if (matchIndex > cursor) {
            parts.push({ type: 'text', value: child.value.slice(cursor, matchIndex) });
          }

          const [, visible, tooltip] = match;
          const visibleText = escapeHtml(visible.trim());
          const tooltipText = escapeHtml(tooltip.trim());
          parts.push({
            type: 'html',
            value: `<span class="hover-tooltip" data-tooltip="${tooltipText}" tabindex="0">${visibleText}<span class="tooltip-bubble" aria-hidden="true">${tooltipText}</span><span class="sr-only"> (${tooltipText})</span></span>`,
          });
          cursor = matchIndex + match[0].length;
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
