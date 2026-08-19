import sharp from 'sharp';
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
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new Response(png, { headers: { 'Content-Type': 'image/png' } });
}
