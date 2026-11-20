import type { Agent } from './agent.ts';
import type { PassageDoor } from './door.ts';
import type { Item } from './item.ts';
import type { Prop } from './prop.ts';
import type { World } from './world.ts';

export type StatusTarget =
  | { kind: 'agent'; entity: Agent }
  | { kind: 'prop'; entity: Prop }
  | { kind: 'item'; entity: Item }
  | { kind: 'door' | 'panel'; entity: PassageDoor };

export type StatusRemovalReason = 'removed' | 'expired';

export interface StatusEffectDefinition {
  label: string;
  targets: readonly StatusTarget['kind'][];
  /** Simulation seconds; omitted means permanent until removed. */
  duration?: number;
  canApply?(target: StatusTarget): boolean;
  onApply?(target: StatusTarget): void;
  /** Receives only the part of the frame for which the effect is still active. */
  onUpdate?(target: StatusTarget, world: World, dt: number): void;
  onRemove?(target: StatusTarget, reason: StatusRemovalReason): void;
}

/** Add effects here; no artwork is required for simulation-only effects. */
export const STATUS_EFFECTS: Record<string, StatusEffectDefinition> = {
  broken: {
    label: 'Broken',
    targets: ['prop', 'door', 'panel'],
    canApply: (target) => target.kind !== 'prop' || target.entity.breakable,
  },
};

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
    if (!effect) return false;
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
