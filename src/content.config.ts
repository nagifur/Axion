import { defineCollection, z } from 'astro:content';

const colorTint = z.string().regex(
  /^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})|rgba?\(\s*(?:\d{1,3}%?\s*,\s*){2}\d{1,3}%?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/,
  'colorTint must be a hex, rgb(), or rgba() color',
).optional();

const galleryItem = z.object({
  file: z.string(),
  caption: z.string(),
});

// Marks a character/entity as being actively hunted by Axion (fired + wanted, escaped, etc.).
// `status` is the headline shown on the page (e.g. "Wanted", "Escaped").
const wanted = z.object({
  status: z.string().default('Wanted'),
  reason: z.string().optional(),
  instruction: z.string().default('If sighted, do not engage. Contact Axion Security immediately.'),
}).optional();

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
    accessDenied: z.boolean().default(false),
    requiredClearance: z.union([z.string(), z.number()]).optional(),
    viewerClearance: z.union([z.string(), z.number()]).optional(),
    denialNotice: z.string().optional(),
  }),
});

const personnel = defineCollection({
  schema: z.object({
    title: z.string(),
    author: z.string().optional(),
    colorTint,
    position: z.string().default('█████'),
    species: z.string().default('█████'),
    gender: z.string().default('█████'),
    height: z.string().default('█████'),
    employeeID: z.union([z.string(), z.number()]).default('█████'),
    age: z.union([z.string(), z.number()]).default('█████'),
    accessLevel: z.union([z.string(), z.number()]).default('█████'),
    birthplace: z.string().default('█████'),
    profileImage: z.string(),
    galleryAlt: z.string(),
    positiveTraits: z.array(z.string()).default([]),
    negativeTraits: z.array(z.string()).default([]),
    vorePreference: z.array(z.string()).default(['None']),
    gallery: z.array(galleryItem).default([]),
    wanted,
    draft: z.boolean().default(false),
    patreonSubmission: z.boolean().default(false),
  }),
});

const entities = defineCollection({
  schema: z.object({
    title: z.string(),
    author: z.string().optional(),
    colorTint,
    nickname: z.string().default('█████'),
    containmentClass: z.string().default('None'),
    type: z.string().default('█████'),
    species: z.string().default('█████'),
    gender: z.string().default('█████'),
    age: z.union([z.string(), z.number()]).default('█████'),
    foundOn: z.string().default('█████'),
    profileImage: z.string(),
    height: z.string().default('█████'),
    galleryAlt: z.string(),
    usefulAbilities: z.array(z.string()).default([]),
    noteableEvents: z.array(z.string()).default([]),
    vorePreference: z.array(z.string()).default(['None']),
    gallery: z.array(galleryItem).default([]),
    wanted,
    patreonSubmission: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

const synthetics = defineCollection({
  schema: z.object({
    title: z.string(),
    author: z.string().optional(),
    colorTint,
    nickname: z.string().default('None'),
    position: z.string().default('None'),
    type: z.string().default('None'),
    gender: z.string().default('None'),
    height: z.string().default('None'),
    syntheticID: z.union([z.string(), z.number()]).default('None'),
    age: z.union([z.string(), z.number()]).default('None'),
    accessLevel: z.union([z.string(), z.number()]).default('None'),
    createdOn: z.string().default('None'),
    profileImage: z.string(),
    galleryAlt: z.string(),
    positiveTraits: z.array(z.string()).default([]),
    negativeTraits: z.array(z.string()).default([]),
    vorePreference: z.array(z.string()).default(['None']),
    gallery: z.array(galleryItem).default([]),
    wanted,
    draft: z.boolean().default(false),
    patreonSubmission: z.boolean().default(false),
  }),
});

export const collections = { articles, personnel, entities, pages, synthetics };