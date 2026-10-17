// Converts pixel-art PNGs into lossless SVGs by merging same-coloured pixels into rectangles.
// Usage: node scripts/pixel-png-to-svg.mjs <input.png> <output.svg> [<input.png> <output.svg> ...]
import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const hex = (n) => n.toString(16).padStart(2, '0');

async function convert(input, output) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Fully transparent pixels get key -1 so they are skipped.
  const keys = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    keys[i] = data[i * 4 + 3] === 0 ? -1 : data.readUInt32BE(i * 4);
  }

  const visited = new Uint8Array(width * height);
  const paths = new Map();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const key = keys[idx];
      if (key === -1 || visited[idx]) continue;

      let w = 1;
      while (x + w < width && !visited[idx + w] && keys[idx + w] === key) w++;

      let h = 1;
      grow: while (y + h < height) {
        const row = (y + h) * width + x;
        for (let i = 0; i < w; i++) {
          if (visited[row + i] || keys[row + i] !== key) break grow;
        }
        h++;
      }

      for (let dy = 0; dy < h; dy++) visited.fill(1, (y + dy) * width + x, (y + dy) * width + x + w);
      paths.set(key, (paths.get(key) ?? '') + `M${x} ${y}h${w}v${h}h-${w}z`);
    }
  }

  const body = [...paths.entries()].map(([key, d]) => {
    const r = Math.floor(key / 2 ** 24) & 255;
    const g = Math.floor(key / 2 ** 16) & 255;
    const b = Math.floor(key / 2 ** 8) & 255;
    const a = key & 255;
    const opacity = a === 255 ? '' : ` fill-opacity="${+(a / 255).toFixed(3)}"`;
    return `<path fill="#${hex(r)}${hex(g)}${hex(b)}"${opacity} d="${d}"/>`;
  }).join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges">\n${body}\n</svg>\n`;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, svg);
  console.log(`${input} -> ${output} (${width}x${height}, ${paths.size} colours, ${(svg.length / 1024).toFixed(1)} KB)`);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error('Usage: node scripts/pixel-png-to-svg.mjs <input.png> <output.svg> [...]');
  process.exit(1);
}
for (let i = 0; i < args.length; i += 2) await convert(args[i], args[i + 1]);
