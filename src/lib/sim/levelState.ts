import type { Room } from './room.ts';
import type { World } from './world.ts';
import { EventState, type ActiveEvent, type ActiveEventAlert, type EventDefinition, type EventEndReason } from './eventState.ts';

export type LevelVariable = boolean | number | string | null;
export type LevelPower = 'normal' | 'off' | 'backup';
export type LevelEventEndReason = EventEndReason;
export type LevelEventDefinition = EventDefinition<LevelState>;

export interface LevelDefinition {
  variables?: Readonly<Record<string, LevelVariable>>;
  events?: Readonly<Record<string, LevelEventDefinition>>;
  /** Optional trigger logic, run after active events have advanced for the frame. */
  onUpdate?(level: LevelState, world: World, dt: number): void;
}

export type LevelDefinitions = Readonly<Partial<Record<number, LevelDefinition>>>;

export type ActiveLevelEvent = ActiveEvent;

export class LevelState {
  readonly variables: Map<string, LevelVariable>;
  private readonly events: EventState<LevelState>;
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
    this.events = new EventState(this, world, `Level ${number}`, definition.events ?? {});
  }

  hasEvent(id: string): boolean {
    return this.events.hasEvent(id);
  }

  get availableEvents(): readonly { id: string; label: string }[] {
    return this.events.availableEvents;
  }

  get activeEvents(): readonly ActiveLevelEvent[] {
    return this.events.activeEvents;
  }

  get activeAlerts(): readonly ActiveEventAlert[] {
    return this.events.activeAlerts;
  }

  /** Starts one instance; an already-active event is not restarted or extended. */
  startEvent(id: string, duration?: number): boolean {
    return this.events.startEvent(id, duration);
  }

  stopEvent(id: string): boolean {
    return this.events.stopEvent(id);
  }

  /** Called by World after advancing its clock. */
  update(frameStart: number, dt: number) {
    if (dt === 0) return;
    this.events.update(frameStart, dt);
    this.definition.onUpdate?.(this, this.world, dt);
  }
}
