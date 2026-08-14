import { defineCollection, z } from 'astro:content';

const galleryItem = z.object({
  file: z.string(),
  caption: z.string(),
});

const articles = defineCollection({
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    category: z.string(),
    author: z.string().optional(),
    updatedAt: z.coerce.date().optional(),
    draft: z.boolean().default(false),
  }),
});

const personnel = defineCollection({
  schema: z.object({
    title: z.string(),
    position: z.string(),
    species: z.string(),
    gender: z.string(),
    height: z.string(),
    age: z.union([z.string(), z.number()]),
    accessLevel: z.union([z.string(), z.number()]),
    birthplace: z.string(),
    profileImage: z.string(),
    galleryAlt: z.string(),
    positiveTraits: z.array(z.string()),
    negativeTraits: z.array(z.string()),
    gallery: z.array(galleryItem),
    draft: z.boolean().default(false),
  }),
});

const entities = defineCollection({
  schema: z.object({
    title: z.string(),
    nickname: z.string(),
    containmentClass: z.string(),
    type: z.string(),
    species: z.string(),
    gender: z.string(),
    age: z.union([z.string(), z.number()]),
    foundOn: z.string(),
    profileImage: z.string(),
    galleryAlt: z.string(),
    usefulAbilities: z.array(z.string()),
    noteableEvents: z.array(z.string()),
    gallery: z.array(galleryItem),
    draft: z.boolean().default(false),
  }),
});

export const collections = { articles, personnel, entities };