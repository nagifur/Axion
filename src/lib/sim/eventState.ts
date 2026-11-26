import type { World } from './world.ts';

export type EventEndReason = 'stopped' | 'expired';

export interface EventDefinition<Context> {
  label?: string;
  /** Simulation seconds; omitted means the event runs until explicitly stopped. */
  duration?: number;
  /** Display pixels and oscillation speed in radians per simulation second. */
  cameraShake?: { amplitude: number; speed: number };
  onStart?(context: Context, world: World): void;
  /** Receives only the part of the frame for which the event is active. */
  onUpdate?(context: Context, world: World, dt: number): void;
  onEnd?(context: Context, world: World, reason: EventEndReason): void;
}

export interface ActiveEvent {
  readonly id: string;
  readonly startedAt: number;
  readonly endsAt: number | null;
}

/** Shared lifecycle for floor and facility events; state belongs to one world. */
export class EventState<Context> {
  private readonly events = new Map<string, {
    event: ActiveEvent;
    definition: EventDefinition<Context>;
  }>();
  private readonly context: Context;
  private readonly world: World;
  private readonly scope: string;
  private readonly definitions: Readonly<Record<string, EventDefinition<Context>>>;

  constructor(context: Context, world: World, scope: string, definitions: Readonly<Record<string, EventDefinition<Context>>>) {
    this.context = context;
    this.world = world;
    this.scope = scope;
    this.definitions = definitions;
  }

  hasEvent(id: string): boolean {
    return this.events.has(id);
  }

  get availableEvents(): readonly { id: string; label: string }[] {
    return Object.entries(this.definitions).map(([id, event]) => ({ id, label: event.label ?? id }));
  }

  get activeEvents(): readonly ActiveEvent[] {
    return [...this.events.values()].map(({ event }) => ({ ...event }));
  }

  get cameraShake(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const { event, definition } of this.events.values()) {
      const shake = definition.cameraShake;
      if (!shake) continue;
      const phase = (this.world.time - event.startedAt) * shake.speed;
      x += Math.sin(phase) * shake.amplitude;
      y += Math.sin(phase * 1.37) * shake.amplitude;
    }
    return { x, y };
  }

  /** An already-active event is not restarted or extended. */
  startEvent(id: string, duration?: number): boolean {
    const definition = Object.hasOwn(this.definitions, id) ? this.definitions[id] : undefined;
    if (!definition) throw new Error(`Unknown event "${id}" on ${this.scope}.`);
    const seconds = duration ?? definition.duration;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
      throw new Error('Event duration must be a positive, finite number of simulation seconds.');
    }
    if (this.events.has(id)) return false;
    const startedAt = this.world.time;
    const endsAt = seconds === undefined ? null : startedAt + seconds;
    this.events.set(id, { definition, event: { id, startedAt, endsAt } });
    definition.onStart?.(this.context, this.world);
    return true;
  }

  stopEvent(id: string): boolean {
    return this.endEvent(id, 'stopped');
  }

  private endEvent(id: string, reason: EventEndReason): boolean {
    const entry = this.events.get(id);
    if (!entry) return false;
    this.events.delete(id);
    entry.definition.onEnd?.(this.context, this.world, reason);
    return true;
  }

  /** Called after World advances its clock. Hooks can stop or replace other events. */
  update(frameStart: number, dt: number) {
    if (dt === 0) return;
    const frameEnd = this.world.time;
    for (const [id, entry] of [...this.events]) {
      if (this.events.get(id) !== entry) continue;
      const { event, definition } = entry;
      if (event.startedAt >= frameEnd) continue;
      const elapsed = Math.min(frameEnd, event.endsAt ?? frameEnd) - Math.max(frameStart, event.startedAt);
      if (elapsed > 0) definition.onUpdate?.(this.context, this.world, elapsed);
      if (event.endsAt !== null && event.endsAt <= frameEnd && this.events.get(id) === entry) {
        this.endEvent(id, 'expired');
      }
    }
  }
}
