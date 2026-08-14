// @ts-check
import { defineConfig } from 'astro/config';
import remarkAutoLinkReferences from './src/lib/remarkAutoLinkReferences';

// https://astro.build/config
export default defineConfig({
  site: 'https://nagifur.github.io',
  base: '/Axion',
  markdown: {
    remarkPlugins: [[remarkAutoLinkReferences, { base: '/Axion' }]],
  },
  redirects: {
    "/caard": "http://nagifur.art",
    
  }


})
