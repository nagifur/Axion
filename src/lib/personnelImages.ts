import type { ImageMetadata } from 'astro';

export function getPersonnelImages() {
  const images = import.meta.glob<{ default: ImageMetadata }>(
    '../assets/images/*/*.{png,jpg,jpeg,webp}',
    { eager: true },
  );
  return Object.fromEntries(
    Object.entries(images).map(([path, mod]) => {
      const key = path.replace(/^\.\.\/assets\/images\//, '');
      return [key, mod.default];
    })
  );
}
