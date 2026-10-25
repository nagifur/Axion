# Development and Content Guide

Technical reference for maintaining the Axion website and authoring its content.
For character submissions, start with the [content templates](../templates/README.md).

## Local Development

Install Node.js and npm. The deployment workflow uses Node.js 20.
From the repository root, run:

```sh
npm ci
npm run dev
```

The development server is usually available at [http://localhost:4321](http://localhost:4321).
Astro reports the exact URL in the terminal.

| Command | Description |
| --- | --- |
| `npm run dev` | Start the local development server with hot reload. |
| `npm run build` | Build the production site into `dist/`. |
| `npm run preview` | Preview the production build locally after building. |

Pushes to `main` trigger a production build and deployment to GitHub Pages through
[GitHub Actions](../.github/workflows/deploy.yml). The workflow can also be run manually.

## Content Structure

Most database entries are Markdown files in [`src/content/`](../src/content/):

```text
src/content/
|-- articles/    # News and world-information articles
|-- entities/    # Captured entities and their profiles
|-- pages/       # Static Markdown pages
|-- personnel/   # Personnel profiles
`-- synthetics/  # Synthetic profiles
```

Each collection has a schema in [`src/content.config.ts`](../src/content.config.ts).
When adding or editing an entry, keep its frontmatter consistent with that schema.
Set `draft: true` on articles, personnel, entities, or synthetics that should not
appear in the published database. Draft files committed to this public repository
are still publicly readable; this is not a privacy setting.

Images are stored in [`src/assets/images/`](../src/assets/images/), while files
that need to be served directly are stored in [`public/`](../public/).

### Article Images

Place article images in `src/assets/images/<article-slug>/`, where the slug is
the Markdown filename without `.md`. For example, `magic-system.md` uses
`src/assets/images/magic-system/`.

Insert an image on its own line, separated from surrounding text by blank lines:

```markdown
::image{file="nagi-explaining-magic.gif" alt="Nagi explaining magic" caption="Nagi explaining magic" align="center"}
```

The folder is inferred from the article filename. To use another image folder,
add `folder="actual-folder-name"`; `folder="slug"` is a literal folder name, not
a placeholder. Alignment supports `full` (the default), `center`, `left`, and
`right`. Captions are optional.

Images are bundled with build-generated URLs without re-encoding, preserving
animated GIFs. Existing files in `public/images/articles/<article-slug>/` remain
supported, but assets take priority. Missing images cause an explicit rendering
error. Report submission ZIPs include images under `src/assets/images/`.

### Math Notation

Markdown bodies support LaTeX-style math, rendered locally with KaTeX (no external
rendering service). Use `$...$` inline:

```markdown
The density is $\rho_M \approx 1.2 \times 10^8 \,\mathrm{p}/\mathrm{m}^3$.
```

For a centered equation, place `$$` on separate lines:

```markdown
$$
\rho_M \approx \frac{1.2 \times 10^8 \,\mathrm{p}}{\mathrm{m}^3}
$$
```

Use `^` for exponents, `_` for subscripts, and braces for multiple characters
(`10^{-8}`, `x_{total}`). The submission body preview also supports inline math
and standalone `$$` blocks. Backtick code spans show math syntax literally.

## Project Layout

```text
src/
|-- components/  # Shared Astro components
|-- content/     # Markdown content entries
|-- lib/         # Markdown plugins and shared helpers
`-- pages/       # File-based Astro routes
public/          # Static files, fonts, icons, and site scripts/styles
scripts/         # Maintenance scripts
```

### Facility Map Art

The facility map art in [`public/facility/`](../public/facility/) is generated
from pixel-art PNGs with [`scripts/pixel-png-to-svg.mjs`](../scripts/pixel-png-to-svg.mjs).
For example, from the repository root:

```sh
node scripts/pixel-png-to-svg.mjs public/Level_0.png public/facility/level-0.svg
```
