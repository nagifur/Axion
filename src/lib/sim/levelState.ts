import type { Room } from './room.ts';
import type { World } from './world.ts';

export type LevelVariable = boolean | number | string | null;
export type LevelEventEndReason = 'stopped' | 'expired';

export interface LevelEventDefinition {
  /** Simulation seconds; omitted means the event runs until explicitly stopped. */
  duration?: number;
  onStart?(level: LevelState, world: World): void;
  /** Receives only the part of the frame for which the event is active. */
  onUpdate?(level: LevelState, world: World, dt: number): void;
  onEnd?(level: LevelState, world: World, reason: LevelEventEndReason): void;
}

export interface LevelDefinition {
  variables?: Readonly<Record<string, LevelVariable>>;
  events?: Readonly<Record<string, LevelEventDefinition>>;
  /** Optional trigger logic, run after active events have advanced for the frame. */
  onUpdate?(level: LevelState, world: World, dt: number): void;
}

export type LevelDefinitions = Readonly<Partial<Record<number, LevelDefinition>>>;

export interface ActiveLevelEvent {
  readonly id: string;
  readonly startedAt: number;
  readonly endsAt: number | null;
}

interface EventInstance {
  event: ActiveLevelEvent;
  definition: LevelEventDefinition;
}

export class LevelState {
  readonly variables: Map<string, LevelVariable>;
  private readonly events = new Map<string, EventInstance>();
  readonly number: number;
  readonly rooms: readonly Room[];
  private readonly world: World;
  private readonly definition: LevelDefinition;

  constructor(world: World, number: number, rooms: readonly Room[], definition: LevelDefinition = {}) {
    this.world = world;
    this.number = number;
    this.rooms = rooms;
    this.definition = definition;
    this.variables = new Map(Object.entries(definition.variables ?? {}));
  }

  hasEvent(id: string): boolean {
    return this.events.has(id);
  }

  get activeEvents(): readonly ActiveLevelEvent[] {
    return [...this.events.values()].map(({ event }) => ({ ...event }));
  }

  /** Starts one instance; an already-active event is not restarted or extended. */
  startEvent(id: string, duration?: number): boolean {
    const definitions = this.definition.events;
    const definition = definitions && Object.hasOwn(definitions, id) ? definitions[id] : undefined;
    if (!definition) throw new Error(`Unknown event "${id}" on Level ${this.number}.`);
    const seconds = duration ?? definition.duration;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
      throw new Error('Level event duration must be a positive, finite number of simulation seconds.');
    }
    if (this.events.has(id)) return false;
    const startedAt = this.world.time;
    const endsAt = seconds === undefined ? null : startedAt + seconds;
    this.events.set(id, { definition, event: { id, startedAt, endsAt } });
    definition.onStart?.(this, this.world);
    return true;
  }

  stopEvent(id: string): boolean {
    return this.endEvent(id, 'stopped');
  }

  private endEvent(id: string, reason: LevelEventEndReason): boolean {
    const entry = this.events.get(id);
    if (!entry) return false;
    this.events.delete(id);
    entry.definition.onEnd?.(this, this.world, reason);
    return true;
  }

  /** Called by World after advancing its clock. */
  update(frameStart: number, dt: number) {
    if (dt === 0) return;
    const frameEnd = this.world.time;
    if (this.events.size) {
      // Hooks can stop or replace other events. Do not advance a replacement in the same frame.
      for (const [id, entry] of [...this.events]) {
        if (this.events.get(id) !== entry) continue;
        const { event, definition } = entry;
        if (event.startedAt >= frameEnd) continue;
        const elapsed = Math.min(frameEnd, event.endsAt ?? frameEnd) - Math.max(frameStart, event.startedAt);
        if (elapsed > 0) definition.onUpdate?.(this, this.world, elapsed);
        if (event.endsAt !== null && event.endsAt <= frameEnd && this.events.get(id) === entry) {
          this.endEvent(id, 'expired');
        }
      }
    }
    this.definition.onUpdate?.(this, this.world, dt);
  }
}
