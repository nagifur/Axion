// @ts-check
import { defineConfig } from 'astro/config';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkAutoLinkReferences from './src/lib/remarkAutoLinkReferences';
import remarkArticleImage from './src/lib/remarkArticleImage';
import remarkHoverTooltip from './src/lib/remarkHoverTooltip';
import { rehypeSanitizeContent } from './src/lib/rehypeSanitizeContent';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.axionlabs.art',
  base: '/',
  markdown: {
    remarkPlugins: [remarkMath, remarkArticleImage, remarkHoverTooltip, [remarkAutoLinkReferences, { base: '' }]],
    // Sanitize before KaTeX so its generated math markup is left intact.
    rehypePlugins: [rehypeSanitizeContent, rehypeKatex],
  },
  redirects: {
    "/caard": "http://nagifur.art",
    
  }


})
