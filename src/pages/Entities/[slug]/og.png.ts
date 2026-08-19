import sharp from 'sharp';
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
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new Response(png, { headers: { 'Content-Type': 'image/png' } });
}
