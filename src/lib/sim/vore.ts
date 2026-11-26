// Vore rules: who may swallow whom, how the ways of swallowing differ, and what prey can do inside.
// Pure data and predicates; the swallow lifecycle itself lives in voreSystem.ts.
import type { Agent } from './agent.ts';
import type { Creature } from './creature.ts';
import { random, range, weightedPick } from './random.ts';
import type { Remains } from './remains.ts';

/** From the profile's `vorePreference`. */
export type VoreRole = 'predator' | 'prey' | 'switch' | 'none';
/** The side someone takes toward one particular other character; switches choose from circumstances. */
export type VoreStance = 'predator' | 'prey';
export type VoreType = keyof typeof VORE_TYPES;
export type VoreActor = Agent | Creature;

/** Unknown heights count as the base character sprite. */
export const DEFAULT_HEIGHT_METERS = 1.9;

export interface VoreProfile {
  role: VoreRole;
  /** Relative odds per way of swallowing; omitted means every type at its VORE_TYPES weight. */
  types?: Partial<Record<VoreType, number>>;
  /** Slimes and shapeshifters swallow regardless of size. */
  anySize: boolean;
  /** Prey that fit inside at once. */
  capacity: number;
}

export const NO_VORE: VoreProfile = Object.freeze({ role: 'none', anySize: false, capacity: 0 });

/** What the rules need to know about one character. */
export interface VoreFighter {
  vore?: VoreProfile;
  heightMeters?: number;
  /** Share of max HP left, 0..1. */
  hp: number;
}

export interface VoreOutcome {
  /** Artwork of the remains pile: src/sim_assets/remains/<look>.png. */
  look: string;
  /** Relative chance among this type's outcomes. */
  weight: number;
  /** Optional display name when the artwork filename is not the desired label. */
  label?: string;
  /** Status applied when digestion finishes. */
  converted: string;
  disposal: { activity: string; seconds: number };
}

export interface VoreTypeDefinition {
  label: string;
  /** Chance relative to the other types when a profile doesn't list its own. */
  weight: number;
  /** Weighted conversion and disposal outcomes. */
  outcomes: readonly VoreOutcome[];
  /** Per-type quirks, as multipliers on the shared tuning. */
  digestion: number;
  escape: number;
  absorption: number;
}

/** One entry per way of swallowing. Add quirks here; everything else reads from this table. */
export const VORE_TYPES = {
  oral: {
    label: 'Oral vore', weight: 6,
    outcomes: [
      { look: 'bones', weight: 1, converted: 'digested', disposal: { activity: 'Defecating', seconds: 12 } },
      { look: 'scat', weight: 1, converted: 'digested', disposal: { activity: 'Defecating', seconds: 12 } },
    ],
    digestion: 1, escape: 1, absorption: 1,
  },
  cock: {
    label: 'Cock vore', weight: 1,
    outcomes: [
      { look: 'pee', label: 'Urine', weight: 5, converted: 'urine', disposal: { activity: 'Urinating', seconds: 12 } },
      { look: 'cum', weight: 95, converted: 'cumified', disposal: { activity: 'Jerking Off', seconds: 20 } },
    ],
    digestion: 1, escape: 1, absorption: 1,
  },
  anal: {
    label: 'Anal vore', weight: 1,
    outcomes: [
      { look: 'bones', weight: 1, converted: 'digested', disposal: { activity: 'Defecating', seconds: 12 } },
      { look: 'scat', weight: 1, converted: 'digested', disposal: { activity: 'Defecating', seconds: 12 } },
    ],
    digestion: 1, escape: 1, absorption: 1,
  },
  breast: {
    label: 'Breast vore', weight: 1,
    outcomes: [
      { look: 'milk', weight: 1, converted: 'milkified', disposal: { activity: 'Milking themselves', seconds: 12 } },
    ],
    digestion: 1, escape: 1, absorption: 1,
  },
} satisfies Record<string, VoreTypeDefinition>;

export const VORE_TYPE_IDS = Object.keys(VORE_TYPES) as VoreType[];

export const VORE_PROFILE_RULES = {
  anySizeSpecies: [/slime/i],
  anySizeCapacity: 3,
  defaultCapacity: 1,
  capacityBands: [
    { minHeight: 3, capacity: 2 },
    { minHeight: 6, capacity: 3 },
  ],
};

export const VORE_STAFF_RULES: {
  predatorRoles: VoreRole[];
  preyRoles: VoreRole[];
  requirePrivacy: boolean;
} = {
  predatorRoles: ['predator'],
  preyRoles: ['prey'],
  requirePrivacy: true,
};

/** Exported and mutable so tests (and later, difficulty settings) can adjust them. */
export const VORE_TUNING = {
  /** A predator must be this many times taller than its prey (1 = merely taller). */
  predatorSizeRatio: 1,
  /** Prey-side characters only swallow someone at least this many times shorter than themselves. */
  preyOversizeRatio: 3,
  /** Private staff-on-staff encounters require at least this height advantage. */
  staffSizeRatio: 3,
  /** A switch at or below this share of its HP acts as prey. */
  switchWeakHp: 0.35,
  /** HP share by which a switch must lead another switch to act as the predator against it. */
  switchHpEdge: 0.2,
  /** Chance per second that a free swallower with a valid target in its room goes after one. */
  huntRate: { predator: 0.02, switch: 0.01, prey: 0.003 },
  /** Seconds a hunt chases before giving up. */
  huntTimeout: 12,
  stalkSpeed: 1.8,
  rerouteSeconds: { agent: 1, creature: 0.5 },
  gulpSeconds: 2,
  /** How close, in room pixels, a hunter must get to swallow. */
  reach: 14,
  /** Seconds a swallower leaves between catches. */
  cooldown: { min: 30, max: 60 },
  /** Seconds someone spat out can't be swallowed again. */
  safeAfterSpit: 45,
  spitOffset: { x: 10, y: 3 },
  dazedSeconds: 3,
  /** Acid damage per second while inside. */
  acidDps: 2,
  /** Seconds the predator spends absorbing digested prey. */
  absorbSeconds: 45,
  /** Share of the prey's max HP the predator heals while absorbing. */
  healFraction: 1,
  /** Seconds before disposing becomes a priority; the activity itself takes additional time. */
  disposalDelay: { min: 20, max: 45 },
  itemSpread: { first: 12, step: 10, depth: 2 },
};

export interface InsideAction {
  id: string;
  /** Shown as the prey's activity while it lasts. */
  label: string;
  weight: number;
  /** Seconds one go takes. */
  duration: { min: number; max: number };
  /** Chance, when it finishes, that the predator spits the prey back out. */
  escapeChance?: number;
}

/** What prey can plan to do while inside; add entries for new options. */
export const INSIDE_ACTIONS: InsideAction[] = [
  { id: 'struggle', label: 'Struggling', weight: 1, duration: { min: 3, max: 6 }, escapeChance: 0.04 },
];

/** What prey fall back to when INSIDE_ACTIONS has nothing to offer. */
const IDLE_ACTION: InsideAction = { id: 'idle', label: 'Waiting', weight: 1, duration: { min: 3, max: 6 } };

export function pickInsideAction(): InsideAction {
  return weightedPick(INSIDE_ACTIONS) ?? IDLE_ACTION;
}

export function insideActionSeconds(action: InsideAction): number {
  return range(action.duration.min, action.duration.max);
}

/** A fresh run of one of the things prey can do inside. */
export function startInsideAction(action: InsideAction = pickInsideAction()) {
  return { id: action.id, label: action.label, escapeChance: action.escapeChance ?? 0, remaining: insideActionSeconds(action) };
}

/** Maps profile values like `[Predator]`, `[Switch]` or `[Predator, Non-Vore]` onto a role. */
export function parseVoreRole(values: readonly string[] | undefined): VoreRole {
  const tokens = (values ?? []).map((value) => value.trim().toLowerCase());
  if (tokens.some((token) => /^(?:none|non[- ]?vore)$/.test(token))) return 'none';
  const predator = tokens.some((token) => /^pred(?:ator)?$/.test(token));
  const prey = tokens.includes('prey');
  if (tokens.includes('switch') || (predator && prey)) return 'switch';
  return predator ? 'predator' : prey ? 'prey' : 'none';
}

/** Giants hold more than one; everything else fits a single prey unless a profile says otherwise. */
function defaultCapacity(heightMeters: number | undefined, anySize: boolean): number {
  if (anySize) return VORE_PROFILE_RULES.anySizeCapacity;
  const height = heightMeters ?? DEFAULT_HEIGHT_METERS;
  const band = VORE_PROFILE_RULES.capacityBands
    .filter(({ minHeight }) => height >= minHeight)
    .sort((a, b) => b.minHeight - a.minHeight)[0];
  return band?.capacity ?? VORE_PROFILE_RULES.defaultCapacity;
}

export interface VoreOverride {
  role?: VoreRole;
  types?: Partial<Record<VoreType, number>>;
  anySize?: boolean;
  capacity?: number;
}

export function createVoreProfile(
  role: VoreRole,
  traits: { species?: string; heightMeters?: number; heightVaries?: boolean } = {},
  override: VoreOverride = {},
): VoreProfile {
  const anySize = override.anySize ?? (
    VORE_PROFILE_RULES.anySizeSpecies.some((pattern) => pattern.test(traits.species ?? '')) || !!traits.heightVaries
  );
  const profile: VoreProfile = {
    role: override.role ?? role,
    anySize,
    capacity: override.capacity ?? defaultCapacity(traits.heightMeters, anySize),
  };
  if (!Number.isInteger(profile.capacity) || profile.capacity < 0) {
    throw new Error('Vore capacity must be a non-negative integer.');
  }
  if (override.types) {
    for (const [type, weight] of Object.entries(override.types)) {
      if (!Object.hasOwn(VORE_TYPES, type) || !Number.isFinite(weight) || weight < 0) {
        throw new Error(`Invalid vore type weight "${type}": expected a known type and a finite, non-negative weight.`);
      }
    }
    profile.types = { ...override.types };
  }
  return profile;
}

export const heightOf = (fighter: Pick<VoreFighter, 'heightMeters'>) => fighter.heightMeters ?? DEFAULT_HEIGHT_METERS;

export function fighterOf(actor: VoreActor): VoreFighter {
  const { character, stats } = actor;
  return { vore: character.vore, heightMeters: character.heightMeters, hp: stats.hp.current / stats.hp.max };
}

/**
 * Which side `self` takes against `other`. Predators and prey keep theirs. A switch yields when it
 * is badly hurt, otherwise takes the opposite side to a fixed role, and between two switches the
 * one overpowering the other becomes the predator. Null means neither (and is never swallowable).
 */
export function voreStance(self: VoreFighter, other: VoreFighter): VoreStance | null {
  const role = self.vore?.role ?? 'none';
  if (role === 'predator' || role === 'prey') return role;
  if (role === 'none') return null;
  if (self.hp <= VORE_TUNING.switchWeakHp) return 'prey';
  switch (other.vore?.role ?? 'none') {
    case 'prey': return 'predator';
    case 'predator': return 'prey';
    case 'switch': {
      const edge = self.hp - other.hp;
      return edge >= VORE_TUNING.switchHpEdge ? 'predator' : edge <= -VORE_TUNING.switchHpEdge ? 'prey' : null;
    }
    default: return null;
  }
}

/**
 * Chance per second that `swallower` goes after `target`; 0 when it can't. Targets must be prey
 * from their own side of the encounter. Predators need the size advantage (or be a slime or
 * shapeshifter); prey-side characters only manage it against someone far smaller, and rarely.
 */
export function huntRate(swallower: VoreFighter, target: VoreFighter): number {
  const own = swallower.vore;
  if (!own || own.role === 'none' || !hasVoreTypes(own)) return 0;
  if (voreStance(target, swallower) !== 'prey') return 0;
  const stance = voreStance(swallower, target);
  if (!stance) return 0;
  const ours = heightOf(swallower);
  const theirs = heightOf(target);
  if (stance === 'predator') {
    if (!own.anySize && ours <= theirs * VORE_TUNING.predatorSizeRatio) return 0;
    return own.role === 'switch' ? VORE_TUNING.huntRate.switch : VORE_TUNING.huntRate.predator;
  }
  return ours >= theirs * VORE_TUNING.preyOversizeRatio ? VORE_TUNING.huntRate.prey : 0;
}

export const canSwallow = (swallower: VoreFighter, target: VoreFighter) => huntRate(swallower, target) > 0;

function voreTypeWeight(type: VoreType, profile: VoreProfile | undefined): number {
  return profile?.types ? profile.types[type] ?? 0 : VORE_TYPES[type].weight;
}

/** One of the profile's enabled ways of swallowing; all-zero weights disable swallowing. */
export function pickVoreType(profile: VoreProfile | undefined): VoreType {
  const selected = weightedPick(VORE_TYPE_IDS.map((type) => ({ type, weight: voreTypeWeight(type, profile) })));
  if (!selected) throw new Error('Cannot choose a vore type: at least one type must have a positive weight.');
  return selected.type;
}

export function hasVoreTypes(profile: VoreProfile | undefined): boolean {
  return VORE_TYPE_IDS.some((type) => {
    const weight = voreTypeWeight(type, profile);
    return Number.isFinite(weight) && weight > 0;
  });
}

export function voreTypeLabel(type: VoreType): string {
  return VORE_TYPES[type].label;
}

export function pickRemainsOutcome(type: VoreType): VoreOutcome {
  const outcomes: readonly VoreOutcome[] = VORE_TYPES[type].outcomes;
  const outcome = weightedPick(outcomes, { boundary: 'next' });
  if (!outcome) throw new Error(`Cannot choose a remains outcome for "${type}": at least one outcome must have a positive weight.`);
  return outcome;
}

/** A prey who is currently being digested or absorbed by its predator. */
export interface Ingestion {
  readonly predator: VoreActor;
  readonly prey: VoreActor;
  readonly type: VoreType;
  phase:
    | { kind: 'digesting'; action: ReturnType<typeof startInsideAction> }
    | { kind: 'absorbing'; elapsed: number; outcome: VoreOutcome };
}

export interface AbsorptionEvent {
  readonly predator: VoreActor;
  readonly prey: VoreActor;
  readonly type: VoreType;
}

/** Called once prey has been fully absorbed; push listeners here for bonus effects (a slime growing, new statuses, ...). */
export const ABSORPTION_HOOKS: Array<(event: AbsorptionEvent) => void> = [];

/** The prey's activity line while inside. */
export function insideActivity({ predator, phase }: Ingestion): string {
  const { name } = predator.character;
  return phase.kind === 'absorbing' ? `Being absorbed by ${name}` : `${phase.action.label} inside ${name}`;
}

/** Vore state that every agent and creature owns, like LiveStats. */
export class VoreState {
  /** Set while this character is inside a predator. */
  inside: Ingestion | null = null;
  /** Prey inside this character, being digested or absorbed. */
  readonly contents: Ingestion[] = [];
  /** Fully absorbed prey this character hasn't gotten rid of yet. */
  readonly remains: Remains[] = [];
  /** This character's own remains once absorption is complete. */
  ownRemains: Remains | null = null;
  /** Seconds until this character may swallow again. */
  cooldown = 0;
  /** Seconds this character can't be swallowed, after being spat out. */
  safeFor = 0;

  get full(): boolean {
    return this.contents.length > 0;
  }
}

/** Random wait before the predator prioritizes disposing of fresh remains. */
export function disposalWait(): number {
  return range(VORE_TUNING.disposalDelay.min, VORE_TUNING.disposalDelay.max);
}

/** Random wait before a swallower may try again. */
export function cooldownSeconds(): number {
  return range(VORE_TUNING.cooldown.min, VORE_TUNING.cooldown.max);
}

/** True with the given per-second rate over a frame; rates are small so this stays linear. */
export function rolls(ratePerSecond: number, dt: number): boolean {
  return ratePerSecond > 0 && random() < ratePerSecond * dt;
}
