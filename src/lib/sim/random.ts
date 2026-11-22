// Every random roll in the simulation goes through here, so a test or replay can make it deterministic
// with setRandomSource(seededRandom(seed)). By default it reads Math.random at call time, which keeps
// existing `t.mock.method(Math, 'random', ...)` test stubs working.

export type RandomSource = () => number;

let source: RandomSource | null = null;

/** Replaces the random source for the whole simulation; `null` restores Math.random. */
export function setRandomSource(next: RandomSource | null) {
  source = next;
}

/** A number in [0, 1). */
export const random = (): number => (source ? source() : Math.random());

export const chance = (probability: number) => random() < probability;

export const range = (min: number, max: number) => min + random() * (max - min);

/** One element of a non-empty list. */
export function pick<T>(items: readonly T[]): T {
  if (!items.length) throw new Error('Cannot pick from an empty list.');
  return items[Math.floor(random() * items.length)];
}

/** One element, or undefined when there is nothing to choose from. */
export function maybePick<T>(items: readonly T[]): T | undefined {
  return items.length ? items[Math.floor(random() * items.length)] : undefined;
}

export function weightedPick<T extends { weight: number }>(items: readonly T[]): T | undefined {
  const total = items.reduce((sum, item) => sum + (Number.isFinite(item.weight) ? Math.max(0, item.weight) : 0), 0);
  if (total <= 0) return undefined;
  let roll = random() * total;
  for (const item of items) {
    const weight = Number.isFinite(item.weight) ? Math.max(0, item.weight) : 0;
    if (weight === 0) continue;
    if (roll <= weight) return item;
    roll -= weight;
  }
  return undefined;
}

/** Small, fast deterministic generator (mulberry32). */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
