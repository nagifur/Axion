// Shared "{{visible text|tooltip text}}" syntax used both in markdown prose (via remarkHoverTooltip)
// and directly in Astro templates for frontmatter fields (e.g. height, temperature).
const HOVER_PATTERN = /\{\{([^{}|]+)\|([^{}]+)\}\}/g;

export type HoverSegment = { text: string; tooltip?: string };

// Splits a plain string on the hover syntax so it can be rendered as a mix of
// plain text and <span data-tooltip> segments in .astro templates.
export const parseHoverSegments = (value: string): HoverSegment[] => {
  const segments: HoverSegment[] = [];
  let cursor = 0;
  HOVER_PATTERN.lastIndex = 0;

  for (const match of value.matchAll(HOVER_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) {
      segments.push({ text: value.slice(cursor, matchIndex) });
    }

    const [, visible, tooltip] = match;
    segments.push({ text: visible.trim(), tooltip: tooltip.trim() });
    cursor = matchIndex + match[0].length;
  }

  if (cursor < value.length) {
    segments.push({ text: value.slice(cursor) });
  }

  return segments.length ? segments : [{ text: value }];
};
