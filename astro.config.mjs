// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://nagifur.github.io',
  base: '/Axion',
  redirects: {
    "/caard": "http://nagifur.art",
    
  }


})
