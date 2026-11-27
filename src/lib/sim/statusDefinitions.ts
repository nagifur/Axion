import type { Agent } from './agent.ts';
import type { Creature } from './creature.ts';
import type { PassageDoor } from './door.ts';
import type { Item } from './item.ts';
import type { Prop } from './prop.ts';
import type { World } from './world.ts';
import { VORE_TUNING, VORE_TYPES } from './vore.ts';

export type StatusTarget =
  | { kind: 'agent'; entity: Agent }
  | { kind: 'creature'; entity: Creature }
  | { kind: 'prop'; entity: Prop }
  | { kind: 'item'; entity: Item }
  | { kind: 'door' | 'panel'; entity: PassageDoor };

export type StatusRemovalReason = 'removed' | 'expired';

/** Whether an effect helps, harms, or merely describes its target. */
export type StatusPolarity = 'positive' | 'negative' | 'neutral';

/** How each polarity reads in the UI; the vitals HUD draws a +, − or ◦ sign in this colour. */
export const STATUS_POLARITIES: Readonly<Record<StatusPolarity, { label: string; color: string }>> = {
  positive: { label: 'Positive', color: '#4dff88' },
  negative: { label: 'Negative', color: '#ff4d5e' },
  neutral: { label: 'Neutral', color: '#7ef5ff' },
};

export interface StatusEffectDefinition {
  label: string;
  polarity: StatusPolarity;
  targets: readonly StatusTarget['kind'][];
  /** Optional character popup; effects without artwork remain simulation-only. Without an icon it is a plain coloured box. */
  popup?: { icon?: string; color: string; background?: string };
  /** Popups of these effects stay hidden while this one is active. */
  hidesPopups?: readonly string[];
  /** Applying this removes these effects: a later stage superseding earlier ones, like acid → absorbing. */
  replaces?: readonly string[];
  /**
   * The target becomes a remains pile with this artwork (src/sim_assets/remains/<look>.png) while this is active.
   * The vore system turns anyone with such a status into the pile; VORE_TYPES outcomes name which one prey become.
   */
  remains?: { look: string };
  /** Pauses the target actor's tasks and movement while active. */
  blocksActions?: boolean;
  /**
   * Can be cleared by waking or redirecting the actor (clicking them, dragging, or assigning a new plan).
   * Wakeable action-blockers pause autonomous activity without incapacitating the actor against interaction.
   */
  wakeable?: boolean;
  /** Overrides the actor's reported activity while active; higher priority wins. */
  activity?: { label: string; priority: number };
  /** Additional trip probability per walking second. */
  tripChancePerSecond?: number;
  /** Encourages leaving this room and defers ordinary work travel. */
  avoidsRoom?: boolean;
  /** Simulation seconds; omitted means permanent until removed. */
  duration?: number;
  /** Never expires or receives a duration override; explicit removal is still allowed. */
  permanent?: boolean;
  canApply?(target: StatusTarget): boolean;
  onApply?(target: StatusTarget): void;
  /** Receives only the part of the frame for which the effect is still active. */
  onUpdate?(target: StatusTarget, world: World, dt: number): void;
  onRemove?(target: StatusTarget, reason: StatusRemovalReason): void;
}

export const SHOCK_SECONDS = 2;
export const SCARED_SECONDS = 10;
export const EXHAUSTED_SECONDS = 5;
export const NAP_SECONDS = 20;

const isActor = (target: StatusTarget): target is Extract<StatusTarget, { kind: 'agent' | 'creature' }> =>
  target.kind === 'agent' || target.kind === 'creature';

/**
 * What someone ends up as: absorbed prey, or anyone given the status directly. It kills them, and the vore
 * system then turns them into the pile. Shapeshifters in disguise can't be turned, and nobody becomes two piles.
 */
function remainsForm(label: string, look: string, icon: string, color: string, background: string): StatusEffectDefinition {
  return {
    label, polarity: 'negative', targets: ['agent', 'creature'], blocksActions: true, permanent: true,
    remains: { look }, replaces: ['acid', 'absorbing'], hidesPopups: ['dead'], popup: { icon, color, background },
    canApply: (target) => isActor(target) && !target.entity.statuses.remainsForm &&
      !(target.kind === 'agent' && target.entity.impostor),
    onApply(target) {
      if (isActor(target)) target.entity.statuses.apply('dead');
    },
    onRemove(target) {
      if (!isActor(target)) return;
      const remains = target.entity.vore.ownRemains;
      if (remains) {
        if (!remains.restore) throw new Error(`Cannot restore ${remains.name}: remains have no restore handler.`);
        remains.restore();
      }
    },
  };
}

/** Add effects here; no artwork is required for simulation-only effects. */
export const STATUS_EFFECTS: Record<string, StatusEffectDefinition> = {
  dead: {
    label: 'Dead',
    polarity: 'negative',
    targets: ['agent', 'creature'],
    blocksActions: true,
    permanent: true,
    replaces: ['napping'],
    activity: { label: 'Dead', priority: 100 },
    popup: {
      icon: new URL('../../sim_assets/icons/dead.svg', import.meta.url).href,
      color: '#ff4545',
      background: 'rgba(80, 8, 13, 0.92)',
    },
    onApply(target) {
      if (target.kind !== 'agent' && target.kind !== 'creature') return;
      target.entity.statuses.wake();
      target.entity.stats.hp.current = 0;
      if (target.kind === 'agent') {
        target.entity.moving = false;
        target.entity.bubble = null;
        target.entity.shake = 0;
        target.entity.eyeFlash = 0;
      } else {
        target.entity.releaseEscort();
      }
    },
    onRemove(target) {
      if (isActor(target)) target.entity.stats.hp.current = target.entity.stats.hp.max;
    },
  },
  broken: {
    label: 'Broken',
    polarity: 'negative',
    targets: ['prop', 'door', 'panel'],
    canApply: (target) => target.kind !== 'prop' || target.entity.breakable,
  },
  darkness: {
    label: 'Darkness',
    polarity: 'negative',
    targets: ['agent'],
    tripChancePerSecond: 0.012,
    avoidsRoom: true,
    popup: {
      icon: new URL('../../sim_assets/icons/darkness.svg', import.meta.url).href,
      color: '#a9b4df',
    },
  },
  napping: {
    label: 'Napping',
    polarity: 'neutral',
    targets: ['agent'],
    duration: NAP_SECONDS,
    blocksActions: true,
    wakeable: true,
    activity: { label: 'Napping', priority: 20 },
    popup: {
      icon: new URL('../../sim_assets/icons/napping.svg', import.meta.url).href,
      color: '#9ec5ff',
    },
    canApply: (target) => target.kind === 'agent' && !target.entity.dead && target.entity.exposed,
    onApply(target) {
      if (target.kind === 'agent') target.entity.moving = false;
    },
  },
  shocked: {
    label: 'Shocked',
    polarity: 'negative',
    targets: ['agent'],
    duration: SHOCK_SECONDS,
    blocksActions: true,
    activity: { label: 'Shocked', priority: 60 },
    popup: {
      icon: new URL('../../sim_assets/icons/shocked.svg', import.meta.url).href,
      color: '#ffbc00',
    },
    onApply(target) {
      if (target.kind !== 'agent') return;
      target.entity.moving = false;
      target.entity.shake = SHOCK_SECONDS;
    },
  },
  scared: {
    label: 'Scared',
    polarity: 'negative',
    targets: ['agent'],
    duration: SCARED_SECONDS,
    popup: {
      icon: new URL('../../sim_assets/icons/scared.svg', import.meta.url).href,
      color: '#ffffff',
    },
    onApply(target) {
      if (target.kind === 'agent') target.entity.shake = 0.6;
    },
  },
  // Applied by spendStamina when stamina runs dry; no running or dashing until it wears off.
  exhausted: {
    label: 'Exhausted',
    polarity: 'negative',
    targets: ['agent', 'creature'],
    duration: EXHAUSTED_SECONDS,
    popup: {
      icon: new URL('../../sim_assets/icons/exhausted.svg', import.meta.url).href,
      color: '#73cf9c',
    },
  },
  // Swallowed prey take damage over time until the predator spits them out or they are digested.
  acid: {
    label: 'Acid',
    polarity: 'negative',
    targets: ['agent', 'creature'],
    replaces: ['napping'],
    popup: { color: '#3dff5a', background: 'rgba(8, 60, 18, 0.92)' },
    onUpdate(target, _world, dt) {
      if (target.kind !== 'agent' && target.kind !== 'creature') return;
      const { stats, vore } = target.entity;
      const digestion = vore.inside ? VORE_TYPES[vore.inside.type].digestion : 1;
      stats.hp.current -= VORE_TUNING.acidDps * digestion * dt;
    },
  },
  // Digested prey while their predator absorbs them. The vore system applies it for the absorption's length and
  // finishes absorbing when it runs out or is removed; applying it to living prey digests them on the spot.
  absorbing: {
    label: 'Being absorbed',
    polarity: 'negative',
    targets: ['agent', 'creature'],
    blocksActions: true,
    replaces: ['acid'],
    hidesPopups: ['dead'],
    popup: { color: '#a8c23a', background: 'rgba(44, 52, 10, 0.92)' },
    canApply: (target) => isActor(target) && target.entity.vore.inside !== null,
  },
  bones: remainsForm('Bones', 'bones', new URL('../../sim_assets/remains/bones.png', import.meta.url).href,
    '#e8e0cc', 'rgba(60, 54, 44, 0.92)'),
  scat: remainsForm('Scat', 'scat', new URL('../../sim_assets/remains/scat.png', import.meta.url).href,
    '#c08a4f', 'rgba(54, 34, 14, 0.92)'),
  urine: remainsForm('Urine', 'pee', new URL('../../sim_assets/remains/pee.png', import.meta.url).href,
    '#f7d54b', 'rgba(76, 62, 10, 0.92)'),
  cum: remainsForm('Cum', 'cum', new URL('../../sim_assets/remains/cum.png', import.meta.url).href,
    '#f1efe2', 'rgba(70, 68, 58, 0.92)'),
  milk: remainsForm('Milk', 'milk', new URL('../../sim_assets/remains/milk.png', import.meta.url).href,
    '#bfe2ff', 'rgba(24, 48, 70, 0.92)'),
};
