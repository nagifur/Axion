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

export interface StatusEffectDefinition {
  label: string;
  targets: readonly StatusTarget['kind'][];
  /** Optional character popup; effects without artwork remain simulation-only. Without an icon it is a plain coloured box. */
  popup?: { icon?: string; color: string; background?: string };
  /** Popups of these effects stay hidden while this one is active. */
  hidesPopups?: readonly string[];
  /** Pauses the target actor's tasks and movement while active. */
  blocksActions?: boolean;
  /** Simulation seconds; omitted means permanent until removed. */
  duration?: number;
  /** Cannot expire, be removed, or receive a duration override. */
  irreversible?: boolean;
  canApply?(target: StatusTarget): boolean;
  onApply?(target: StatusTarget): void;
  /** Receives only the part of the frame for which the effect is still active. */
  onUpdate?(target: StatusTarget, world: World, dt: number): void;
  onRemove?(target: StatusTarget, reason: StatusRemovalReason): void;
}

export const SHOCK_SECONDS = 2;
export const SCARED_SECONDS = 10;
export const EXHAUSTED_SECONDS = 5;

/** What swallowed prey turn into once the acid is done with them; the outcome picks which. */
function convertedStatus(label: string, color: string, background: string): StatusEffectDefinition {
  return { label, targets: ['agent', 'creature'], blocksActions: true, irreversible: true, hidesPopups: ['dead'], popup: { color, background } };
}

/** Add effects here; no artwork is required for simulation-only effects. */
export const STATUS_EFFECTS: Record<string, StatusEffectDefinition> = {
  dead: {
    label: 'Dead',
    targets: ['agent', 'creature'],
    blocksActions: true,
    irreversible: true,
    popup: {
      icon: new URL('../../sim_assets/icons/dead.svg', import.meta.url).href,
      color: '#ff4545',
      background: 'rgba(80, 8, 13, 0.92)',
    },
    onApply(target) {
      if (target.kind !== 'agent' && target.kind !== 'creature') return;
      target.entity.stats.hp.current = 0;
      if (target.kind === 'agent') {
        target.entity.moving = false;
        target.entity.napping = false;
        target.entity.bubble = null;
        target.entity.shake = 0;
        target.entity.eyeFlash = 0;
      } else {
        target.entity.releaseEscort();
      }
    },
  },
  broken: {
    label: 'Broken',
    targets: ['prop', 'door', 'panel'],
    canApply: (target) => target.kind !== 'prop' || target.entity.breakable,
  },
  shocked: {
    label: 'Shocked',
    targets: ['agent'],
    duration: SHOCK_SECONDS,
    blocksActions: true,
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
    targets: ['agent', 'creature'],
    popup: { color: '#3dff5a', background: 'rgba(8, 60, 18, 0.92)' },
    onUpdate(target, _world, dt) {
      if (target.kind !== 'agent' && target.kind !== 'creature') return;
      const { stats, vore } = target.entity;
      const digestion = vore.inside ? VORE_TYPES[vore.inside.type].digestion : 1;
      stats.hp.current -= VORE_TUNING.acidDps * digestion * dt;
    },
  },
  digested: convertedStatus('Digested', '#a8c23a', 'rgba(44, 52, 10, 0.92)'),
  cumified: convertedStatus('Cumified', '#f1efe2', 'rgba(70, 68, 58, 0.92)'),
  urine: convertedStatus('Turned into urine', '#f7d54b', 'rgba(76, 62, 10, 0.92)'),
  milkified: convertedStatus('Milkified', '#bfe2ff', 'rgba(24, 48, 70, 0.92)'),
};

/** Popups to show for the active effects, minus any that another active effect hides. */
export function statusPopups(active: readonly ActiveStatusEffect[]) {
  const hidden = new Set(active.flatMap(({ id }) => STATUS_EFFECTS[id]?.hidesPopups ?? []));
  return active.flatMap(({ id, label }) => {
    const popup = hidden.has(id) ? undefined : STATUS_EFFECTS[id]?.popup;
    return popup ? [{ id, label, ...popup }] : [];
  });
}

export interface ActiveStatusEffect {
  readonly id: string;
  readonly label: string;
  /** null means permanent. */
  readonly remaining: number | null;
}

interface StatusInstance {
  definition: StatusEffectDefinition;
  remaining: number | null;
}

function validateDuration(duration: number | undefined) {
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) {
    throw new Error('Status effect duration must be a positive, finite number of simulation seconds.');
  }
}

/** One instance of each effect per target. Reapplication refreshes, never stacks. */
export class StatusEffects {
  private readonly effects = new Map<string, StatusInstance>();
  private readonly target: StatusTarget;
  private readonly changed?: (id: string, active: boolean) => void;

  constructor(target: StatusTarget, changed?: (id: string, active: boolean) => void) {
    this.target = target;
    this.changed = changed;
  }

  has(id: string): boolean {
    return this.effects.has(id);
  }

  get actionBlockRemaining(): number {
    let remaining = 0;
    for (const effect of this.effects.values()) {
      if (effect.definition.blocksActions) remaining = Math.max(remaining, effect.remaining ?? Infinity);
    }
    return remaining;
  }

  get(id: string): ActiveStatusEffect | undefined {
    const effect = this.effects.get(id);
    return effect && { id, label: effect.definition.label, remaining: effect.remaining };
  }

  get active(): readonly ActiveStatusEffect[] {
    return [...this.effects].map(([id, effect]) => ({
      id, label: effect.definition.label, remaining: effect.remaining,
    }));
  }

  /** False for ineligible targets or an already-permanent effect; timed effects refresh. */
  apply(id: string, duration?: number): boolean {
    const definition = Object.hasOwn(STATUS_EFFECTS, id) ? STATUS_EFFECTS[id] : undefined;
    if (!definition) throw new Error(`Unknown status effect "${id}". Add it to STATUS_EFFECTS first.`);
    if (definition.irreversible && (duration !== undefined || definition.duration !== undefined)) {
      throw new Error(`Status effect "${id}" is irreversible and cannot have a duration.`);
    }
    const seconds = duration ?? definition.duration;
    validateDuration(seconds);
    if (!definition.targets.includes(this.target.kind) || definition.canApply?.(this.target) === false) return false;
    const existing = this.effects.get(id);
    if (existing && existing.remaining === null && seconds === undefined) return false;
    this.effects.set(id, { definition, remaining: seconds ?? null });
    if (!existing) {
      this.changed?.(id, true);
      definition.onApply?.(this.target);
    }
    return true;
  }

  remove(id: string): boolean {
    return this.removeEffect(id, 'removed');
  }

  clear() {
    for (const id of [...this.effects.keys()]) this.remove(id);
  }

  private removeEffect(id: string, reason: StatusRemovalReason): boolean {
    const effect = this.effects.get(id);
    if (!effect || effect.definition.irreversible) return false;
    this.effects.delete(id);
    this.changed?.(id, false);
    effect.definition.onRemove?.(this.target, reason);
    return true;
  }

  update(world: World, dt: number) {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('Status effect update needs a finite, non-negative timestep.');
    if (dt === 0) return;
    // Hooks may remove, refresh, or add effects. New instances start ticking next frame.
    for (const [id, effect] of [...this.effects]) {
      if (this.effects.get(id) !== effect) continue;
      const elapsed = effect.remaining === null ? dt : Math.min(dt, effect.remaining);
      effect.definition.onUpdate?.(this.target, world, elapsed);
      if (this.effects.get(id) !== effect || effect.remaining === null) continue;
      effect.remaining = Math.max(0, effect.remaining - elapsed);
      if (effect.remaining === 0) this.removeEffect(id, 'expired');
    }
  }
}
