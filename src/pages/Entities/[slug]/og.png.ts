import sharp from 'sharp';
import { getCollection } from 'astro:content';
import { createDatabaseOgImage } from '../../../lib/databaseOgImage';

const images = import.meta.glob('../../../assets/images/*/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const getProfileImage = (slug: string, filename: string) => {
  const exactPath = `../../../assets/images/${slug}/${filename}`;
  if (images[exactPath]) return images[exactPath];
  const basename = filename.replace(/\.[^/.]+$/, '');
  return Object.entries(images).find(([path]) => path.includes(`/${slug}/`) && path.split('/').pop()?.replace(/\.[^/.]+$/, '') === basename)?.[1];
};

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
    image: getProfileImage(slug, entity.profileImage),
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
