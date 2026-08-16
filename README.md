# Axion

The Axion Labs facility database is a static website built with [Astro](https://astro.build/)! It's a fictional universe I made for my OCs.

**Live site: [www.axionlabs.art](https://www.axionlabs.art)**

You can also contribute to the project by adding new content or fixing issues! Although for adding new characters/entities, I keep it to [Patreon](https://www.patreon.com/nagifur) supporters only!

If you want to launch a local copy of the site, follow the instructions below. 

## Requirements

- Node.js 18.17 or newer (Node.js 20 or newer is recommended)
- npm, included with Node.js
- Git, if you are cloning the repository

## Run Locally

The commands are the same after Node.js is installed. The examples below show how to open a terminal on each operating system.

### Windows

1. Install the current LTS version of [Node.js](https://nodejs.org/en/download/).
2. Open PowerShell or Windows Terminal.
3. Clone and enter the project:

	```powershell
	git clone <repository-url>
	cd axion
	```

4. Install the locked dependency versions:

	```powershell
	npm ci
	```

### macOS

1. Install Node.js from [nodejs.org](https://nodejs.org/en/download/), or with Homebrew:

	```bash
	brew install node
	```

2. Open Terminal and clone the project:

	```bash
	git clone <repository-url>
	cd axion
	npm ci
	```

### Linux

1. Install Node.js 20 or newer using your distribution's package manager or a version manager such as [nvm](https://github.com/nvm-sh/nvm). With nvm:

	```bash
	nvm install 20
	nvm use 20
	```

2. Open a terminal, clone the project, and install dependencies:

	```bash
	git clone <repository-url>
	cd axion
	npm ci
	```

Replace `<repository-url>` with the URL of this repository.

## Available Commands

Run these commands from the project directory:

| Command | Description |
| --- | --- |
| `npm run dev` | Start the local development server with hot reload. |
| `npm run build` | Build the production site into `dist/`. |

The development server is usually available at [http://localhost:4321](http://localhost:4321). Astro will report the exact URL in the terminal.

## Content Structure

Most database entries are Markdown files in `src/content/`:

```text
src/content/
├── articles/    # News and world-information articles
├── entities/    # Captured entities and their profiles
├── pages/       # Static Markdown pages
└── personnel/   # Personnel profiles
```

Each collection has a schema in `src/content.config.ts`. When adding or editing an entry, keep its frontmatter consistent with that schema. Set `draft: true` on articles, personnel, or entities that should not appear in the published database.

Images are stored in `src/assets/images/`, while files that need to be served directly are stored in `public/`.

## Production Build

Made automatically with GitHub Actions on the `main` branch. The production build is deployed to GitHub Pages at [https://www.axionlabs.art](https://www.axionlabs.art).


## Project Layout

```text
src/
├── components/  # Shared Astro components
├── content/     # Markdown content entries
├── lib/         # Markdown plugins and shared helpers
└── pages/       # File-based Astro routes
public/          # Static files, fonts, icons, and site scripts/styles
```

## License

No license has been specified for this project. Contact the project owner before reusing its code, writing, or artwork.
