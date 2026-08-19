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
    image: getProfileImage(slug, character.profileImage),
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
