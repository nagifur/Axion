// @ts-check
import { defineConfig } from 'astro/config';
import remarkAutoLinkReferences from './src/lib/remarkAutoLinkReferences';
import remarkArticleImage from './src/lib/remarkArticleImage';
import remarkHoverTooltip from './src/lib/remarkHoverTooltip';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.axionlabs.art',
  base: '/',
  markdown: {
    remarkPlugins: [remarkArticleImage, remarkHoverTooltip, [remarkAutoLinkReferences, { base: '' }]],
  },
  redirects: {
    "/caard": "http://nagifur.art",
    
  }


})
