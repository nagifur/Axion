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

// Simple static markdown pages (About, etc.) — no dates/category/author needed.
const pages = defineCollection({
  schema: z.object({
    title: z.string(),
  }),
});

const personnel = defineCollection({
  schema: z.object({
    title: z.string(),
    position: z.string().default('None'),
    species: z.string().default('None'),
    gender: z.string().default('None'),
    height: z.string().default('None'),
    age: z.union([z.string(), z.number()]).default('None'),
    accessLevel: z.union([z.string(), z.number()]).default('None'),
    birthplace: z.string().default('None'),
    profileImage: z.string(),
    galleryAlt: z.string(),
    positiveTraits: z.array(z.string()).default([]),
    negativeTraits: z.array(z.string()).default([]),
    vorePreference: z.array(z.string()).default(['None']),
    gallery: z.array(galleryItem),
    draft: z.boolean().default(false),
  }),
});

const entities = defineCollection({
  schema: z.object({
    title: z.string(),
    nickname: z.string().default('None'),
    containmentClass: z.string().default('None'),
    type: z.string().default('None'),
    species: z.string().default('None'),
    gender: z.string().default('None'),
    age: z.union([z.string(), z.number()]).default('None'),
    foundOn: z.string().default('None'),
    profileImage: z.string(),
    galleryAlt: z.string(),
    usefulAbilities: z.array(z.string()).default([]),
    noteableEvents: z.array(z.string()).default([]),
    vorePreference: z.array(z.string()).default(['None']),
    gallery: z.array(galleryItem),
    draft: z.boolean().default(false),
  }),
});

export const collections = { articles, personnel, entities, pages };