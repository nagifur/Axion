import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { getCollection } from 'astro:content';
import { createDatabaseOgImage, getDatabaseImageDataUri } from '../../../lib/databaseOgImage';

export async function getStaticPaths() {
  const entries = await getCollection('entities', ({ data }) => !data.draft);
  return entries.map((entry) => ({
    params: { slug: entry.id.replace(/\.md$/, '') },
    props: { entry, slug: entry.id.replace(/\.md$/, '') },
  }));
}

export async function GET({ props }: { props: { entry: any; slug: string } }) {
  const { entry, slug } = props;
  const { data: entity } = entry;
  const svg = createDatabaseOgImage({
    title: entity.title,
    subtitle: entity.nickname,
    id: slug,
    tint: entity.colorTint,
    image: await getDatabaseImageDataUri(slug, entity.profileImage),
    fields: [
      { label: 'Containment Class', value: entity.containmentClass },
      { label: 'Type', value: entity.type },
      { label: 'Species', value: entity.species },
      { label: 'Gender', value: entity.gender },
      { label: 'Age', value: String(entity.age) },
      { label: 'Found On', value: entity.foundOn },
      { label: 'Trophic Role', value: entity.vorePreference.join(', ') },
    ],
  });
  const png = new Resvg(svg, {
    font: {
      fontFiles: [
        path.resolve(process.cwd(), 'public/fonts/Ethnocentric-Regular.otf'),
        path.resolve(process.cwd(), 'public/fonts/BOMBARD.ttf'),
      ],
    },
  }).render().asPng();
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
}
