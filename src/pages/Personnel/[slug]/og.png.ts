import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { getCollection } from 'astro:content';
import { createDatabaseOgImage, getDatabaseImageDataUri } from '../../../lib/databaseOgImage';

export async function getStaticPaths() {
  const entries = await getCollection('personnel', ({ data }) => !data.draft);
  return entries.map((entry) => ({
    params: { slug: entry.id.replace(/\.md$/, '') },
    props: { entry, slug: entry.id.replace(/\.md$/, '') },
  }));
}

export async function GET({ props }: { props: { entry: any; slug: string } }) {
  const { entry, slug } = props;
  const { data: character } = entry;
  const svg = createDatabaseOgImage({
    title: character.title,
    id: String(character.employeeID),
    tint: character.colorTint,
    image: await getDatabaseImageDataUri(slug, character.profileImage),
    fields: [
      { label: 'Access Level', value: `Level ${character.accessLevel}` },
      { label: 'Facility Position', value: character.position },
      { label: 'Species', value: character.species },
      { label: 'Gender', value: character.gender },
      { label: 'Height', value: character.height },
      { label: 'Age', value: String(character.age) },
      { label: 'Birthplace', value: character.birthplace },
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
  return new Response(png, { headers: { 'Content-Type': 'image/png' } });
}
