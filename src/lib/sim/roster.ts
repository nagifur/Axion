// Build-time helpers that turn database profiles into simulation characters.
// Kept free of Astro imports so it can be unit tested directly with node:test.

export interface SimBehavior {
  /** Walking speed multiplier (1 = normal). */
  speed: number;
  /** 0..1 chance to take a nap when resting. */
  napChance: number;
  /** Occasionally trips while walking. */
  clumsy: boolean;
  /** 0..1 how likely they start conversations. */
  social: number;
  /** Rendered translucent and can walk through solid objects. */
  ghost: boolean;
}

export interface SimCharacter {
  id: string;
  name: string;
  href: string;
  tint: string;
  /** Sprite scale relative to the base character sprite. */
  scale: number;
  position: string;
  species: string;
  accessLevel: string;
  employeeID: string;
  traits: string[];
  image?: string;
  /** Relative chance of showing up compared to other staff (1 = normal). */
  weight: number;
  behavior: SimBehavior;
}

export interface SimImpostor {
  id: string;
  name: string;
  nickname: string;
  href: string;
  image?: string;
  /** Relative chance of being picked when an impostor event triggers. */
  weight: number;
}

/** Staff keep to their clearance and below; unknown clearances use level 1. */
export function canVisitLevel(character: SimCharacter, level: number): boolean {
  const clearance = character.accessLevel.trim();
  if (/^admin$/i.test(clearance)) return true;
  const maximum = /^\d+$/.test(clearance) ? Number(clearance) : 1;
  return level <= maximum;
}

export interface SimOverride {
  exclude?: boolean;
  weight?: number;
}

// Per-character tweaks for things the profile data doesn't express yet.
export const SIM_OVERRIDES: Record<string, SimOverride> = {
  // Stays in her BioCare hive and has to be fed by her workers.
  mellisa: { exclude: true },
  // "Very few people have seen him in person."
  sypher: { weight: 0.15 },
};

export const DEFAULT_TINT = '#7ef5ff';
const BASE_HEIGHT_M = 1.75;
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.2;

/** Parses profile heights like `{{5'7"|1.70 m}}`, `172 cm`, or `5'5` into metres. */
export function parseHeightMeters(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[{}]/g, ' ');

  // Prefer the last metric value; ranges like "5cm up to 2.1m" end with the adult size.
  const metric = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(cm|m)\b/gi)].at(-1);
  if (metric) {
    const value = Number(metric[1]);
    return metric[2].toLowerCase() === 'cm' ? value / 100 : value;
  }

  const imperial = text.match(/(\d+)\s*'\s*(\d+(?:\.\d+)?)?/);
  if (imperial) {
    const feet = Number(imperial[1]);
    const inches = Number(imperial[2] ?? 0);
    return (feet * 12 + inches) * 0.0254;
  }

  return null;
}

export function heightToScale(meters: number | null): number {
  if (!meters || !Number.isFinite(meters)) return 1;
  const scale = meters / BASE_HEIGHT_M;
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) * 100) / 100;
}

const has = (traits: string[], pattern: RegExp) => traits.some((trait) => pattern.test(trait));

/** Maps free-text profile traits onto simulation behaviour. */
export function behaviorFromTraits(traits: string[], species = ''): SimBehavior {
  const antisocial = has(traits, /anti-?social|unsocial|uncooperative|\bshy\b/i);
  const social = has(traits, /friendly|cheerful|humorist|positive attitude|charismatic/i);

  let speed = 1;
  if (has(traits, /\bfast\b|very active|hyperactive|quick on/i)) speed = 1.35;
  if (has(traits, /\bslow\b/i)) speed = 0.75;

  return {
    speed,
    napChance: has(traits, /sleepy|always tired|unmotivated/i) ? 0.85 : 0.08,
    clumsy: has(traits, /clumsy/i),
    social: antisocial ? 0.1 : social ? 0.8 : 0.4,
    ghost: /ghost/i.test(species) || has(traits, /phase through/i),
  };
}

export interface PersonnelInput {
  id: string;
  data: {
    title: string;
    colorTint?: string;
    position: string;
    species: string;
    height: string;
    accessLevel: string | number;
    employeeID: string | number;
    positiveTraits: string[];
    negativeTraits: string[];
    wanted?: unknown;
  };
}

export function toSimCharacter(entry: PersonnelInput, base = '', image?: string): SimCharacter | null {
  const id = entry.id.replace(/\.md$/, '');
  const override = SIM_OVERRIDES[id] ?? {};
  // Wanted characters (e.g. fired staff) no longer badge in for shifts.
  if (override.exclude || entry.data.wanted) return null;

  const traits = [...entry.data.positiveTraits, ...entry.data.negativeTraits];
  return {
    id,
    name: entry.data.title,
    href: `${base}/Personnel/${id}`,
    tint: entry.data.colorTint ?? DEFAULT_TINT,
    scale: heightToScale(parseHeightMeters(entry.data.height)),
    position: entry.data.position.trim(),
    species: entry.data.species.trim(),
    accessLevel: String(entry.data.accessLevel),
    employeeID: String(entry.data.employeeID),
    traits,
    image,
    weight: override.weight ?? 1,
    behavior: behaviorFromTraits(traits, entry.data.species),
  };
}

export interface EntityInput {
  id: string;
  data: {
    title: string;
    nickname: string;
    usefulAbilities: string[];
    noteableEvents: string[];
  };
}

/** Entities that can shapeshift are able to sneak in disguised as staff. */
export function toSimImpostor(entry: EntityInput, base = '', image?: string): SimImpostor | null {
  const { usefulAbilities, noteableEvents } = entry.data;
  if (!has(usefulAbilities, /shapeshift/i)) return null;

  const id = entry.id.replace(/\.md$/, '');
  return {
    id,
    name: entry.data.title,
    nickname: entry.data.nickname,
    href: `${base}/Entities/${id}`,
    image,
    // Repeat escapees show up far more often than one-off breaches.
    weight: has(noteableEvents, /keeps escaping/i) ? 1 : 0.15,
  };
}
