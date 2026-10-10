import { statSync } from 'node:fs';
import path from 'node:path';

const escapeAttribute = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export function resolveArticleImages(
  html: string,
  assets: Record<string, string>,
  publicDirectory = path.resolve(process.cwd(), 'public'),
): string {
  return html.replace(
    /(<figure class="article-image article-image--(?:full|center|left|right)"><img) src="\/images\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*\/[a-zA-Z0-9._-]+)"/g,
    (_, prefix: string, key: string) => {
      const assetUrl = assets[key];
      if (assetUrl) return `${prefix} src="${escapeAttribute(assetUrl)}"`;

      const publicPath = path.join(publicDirectory, 'images/articles', key);
      if (statSync(publicPath, { throwIfNoEntry: false })?.isFile()) {
        return `${prefix} src="/images/articles/${key}"`;
      }

      throw new Error(
        `Article image "${key}" was not found. Place it in src/assets/images/${key} (or public/images/articles/${key} for legacy images).`,
      );
    },
  );
}
