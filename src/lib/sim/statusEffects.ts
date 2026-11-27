import type { World } from './world.ts';
import { STATUS_EFFECTS, type StatusEffectDefinition, type StatusPolarity, type StatusRemovalReason, type StatusTarget } from './statusDefinitions.ts';

export * from './statusDefinitions.ts';

/** Active effects minus any that another active effect hides; name-tag popups and the vitals HUD both use it. */
export function shownStatuses(active: readonly ActiveStatusEffect[]): ActiveStatusEffect[] {
  const hidden = new Set(active.flatMap(({ id }) => STATUS_EFFECTS[id]?.hidesPopups ?? []));
  return active.filter(({ id }) => !hidden.has(id));
}

/** Popups to show for the active effects, minus any that another active effect hides. */
export function statusPopups(active: readonly ActiveStatusEffect[]) {
  return shownStatuses(active).flatMap(({ id, label }) => {
    const popup = STATUS_EFFECTS[id]?.popup;
    return popup ? [{ id, label, ...popup }] : [];
  });
}

export interface ActiveStatusEffect {
  readonly id: string;
  readonly label: string;
  readonly polarity: StatusPolarity;
  /** null means permanent. */
  readonly remaining: number | null;
  /** Length of the current timed instance (refreshes reset it); null means permanent. */
  readonly duration: number | null;
}

interface StatusInstance {
  definition: StatusEffectDefinition;
  remaining: number | null;
  duration: number | null;
}

function validateDuration(duration: number | undefined) {
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) {
    throw new Error('Status effect duration must be a positive, finite number of simulation seconds.');
  }
}

function snapshot(id: string, { definition, remaining, duration }: StatusInstance): ActiveStatusEffect {
  return { id, label: definition.label, polarity: definition.polarity, remaining, duration };
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

  get tripChancePerSecond(): number {
    let chance = 0;
    for (const { definition } of this.effects.values()) chance += definition.tripChancePerSecond ?? 0;
    return chance;
  }

  get avoidsRoom(): boolean {
    for (const { definition } of this.effects.values()) if (definition.avoidsRoom) return true;
    return false;
  }

  /** The remains status this target has become, if any. */
  get remainsForm(): string | undefined {
    for (const [id, { definition }] of this.effects) if (definition.remains) return id;
    return undefined;
  }

  get actionBlockRemaining(): number {
    let remaining = 0;
    for (const effect of this.effects.values()) {
      if (effect.definition.blocksActions) remaining = Math.max(remaining, effect.remaining ?? Infinity);
    }
    return remaining;
  }

  /** True while any active status pauses tasks, movement, and autonomous reactions. */
  get blocksActions(): boolean {
    return this.actionBlockRemaining > 0;
  }

  /** True while any active status incapacitates the actor (cannot be dragged or simply woken). */
  get incapacitated(): boolean {
    for (const { definition } of this.effects.values()) {
      if (definition.blocksActions && !definition.wakeable) return true;
    }
    return false;
  }

  /** True while any active status can be cleared by waking or redirecting the actor. */
  get wakeable(): boolean {
    for (const { definition } of this.effects.values()) {
      if (definition.wakeable) return true;
    }
    return false;
  }

  /** Highest-priority activity label claimed by an active status, if any. */
  get activity(): string | undefined {
    let best: { label: string; priority: number } | undefined;
    for (const { definition } of this.effects.values()) {
      if (definition.activity && (!best || definition.activity.priority > best.priority)) best = definition.activity;
    }
    return best?.label;
  }

  /** Clears all wakeable statuses. Returns true if any were removed. */
  wake(): boolean {
    let woke = false;
    for (const [id, { definition }] of [...this.effects]) {
      if (definition.wakeable && this.remove(id)) woke = true;
    }
    return woke;
  }

  get(id: string): ActiveStatusEffect | undefined {
    const effect = this.effects.get(id);
    return effect && snapshot(id, effect);
  }

  get active(): readonly ActiveStatusEffect[] {
    return [...this.effects].map(([id, effect]) => snapshot(id, effect));
  }

  /** False for ineligible targets or an already-permanent effect; timed effects refresh. */
  apply(id: string, duration?: number): boolean {
    const definition = Object.hasOwn(STATUS_EFFECTS, id) ? STATUS_EFFECTS[id] : undefined;
    if (!definition) throw new Error(`Unknown status effect "${id}". Add it to STATUS_EFFECTS first.`);
    if (definition.permanent && (duration !== undefined || definition.duration !== undefined)) {
      throw new Error(`Status effect "${id}" is permanent and cannot have a duration.`);
    }
    const seconds = duration ?? definition.duration;
    validateDuration(seconds);
    if (!definition.targets.includes(this.target.kind) || definition.canApply?.(this.target) === false) return false;
    const existing = this.effects.get(id);
    if (existing && existing.remaining === null && seconds === undefined) return false;
    for (const replaced of definition.replaces ?? []) this.remove(replaced);
    this.effects.set(id, { definition, remaining: seconds ?? null, duration: seconds ?? null });
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
