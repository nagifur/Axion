import { defineCollection, z } from 'astro:content';

const colorTint = z.string().regex(
  /^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})|rgba?\(\s*(?:\d{1,3}%?\s*,\s*){2}\d{1,3}%?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/,
  'colorTint must be a hex, rgb(), or rgba() color',
).optional();

const galleryItem = z.object({
  file: z.string(),
  caption: z.string(),
});

const articles = defineCollection({
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.string(),
    author: z.string().optional(),
    colorTint,
    updatedAt: z.coerce.date().optional(),
    draft: z.boolean().default(false),
    patreonSubmission: z.boolean().default(false),
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
    author: z.string().optional(),
    colorTint,
    position: z.string().default('None'),
    species: z.string().default('None'),
    gender: z.string().default('None'),
    height: z.string().default('None'),
    employeeID: z.union([z.string(), z.number()]).default('None'),
    age: z.union([z.string(), z.number()]).default('None'),
    accessLevel: z.union([z.string(), z.number()]).default('None'),
    birthplace: z.string().default('None'),
    profileImage: z.string(),
    galleryAlt: z.string(),
    positiveTraits: z.array(z.string()).default([]),
    negativeTraits: z.array(z.string()).default([]),
    vorePreference: z.array(z.string()).default(['None']),
    gallery: z.array(galleryItem).default([]),
    draft: z.boolean().default(false),
    patreonSubmission: z.boolean().default(false),
  }),
});

const entities = defineCollection({
  schema: z.object({
    title: z.string(),
    author: z.string().optional(),
    colorTint,
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
    gallery: z.array(galleryItem).default([]),
    patreonSubmission: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { articles, personnel, entities, pages };