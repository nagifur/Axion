import type { Agent } from './agent.ts';
import type { Door, Point, Room } from './room.ts';
import type { World } from './world.ts';
import { PASSAGE_DOOR_RANGE, PassageDoor } from './door.ts';

/** Distance from a point to the doorway, from its threshold to where people fade out. */
function distanceToDoorway(point: Point, door: Door): number {
  const dx = door.outside.x - door.inside.x;
  const dy = door.outside.y - door.inside.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point.x - door.inside.x) * dx + (point.y - door.inside.y) * dy) / length)) : 0;
  return Math.hypot(point.x - (door.inside.x + t * dx), point.y - (door.inside.y + t * dy));
}

/** How close to the doorway line a fading agent counts as standing in it. */
const DOORWAY_OCCUPIED = 4;

/** One door seen from one room; a linked passage has an endpoint on each side. */
interface Endpoint {
  room: Room;
  door: Door;
}

/** The physical doors between rooms: shared state for both sides of a passage, and who is opening them. */
export class PassageNetwork {
  private readonly states = new Map<Door, PassageDoor>();
  private readonly endpoints = new Map<PassageDoor, Endpoint[]>();
  private readonly users = new Map<PassageDoor, Set<Agent>>();

  constructor(rooms: readonly Room[], roomById: (id: string) => Room | undefined) {
    for (const room of rooms) {
      for (const door of room.doors) {
        if (!door.appearance) continue;
        const otherRoom = door.to && roomById(door.to.room);
        const otherDoor = otherRoom?.doors.find((candidate) => candidate.id === door.to?.door);
        const state = this.states.get(door) ?? new PassageDoor(door.appearance.clearance);
        if (state.clearance !== door.appearance.clearance) {
          throw new Error(`Linked passage doors in ${room.id} must have the same clearance.`);
        }
        this.states.set(door, state);
        if (otherDoor) this.states.set(otherDoor, state);
      }
    }
    for (const room of rooms) {
      for (const door of room.doors) {
        const state = this.states.get(door);
        if (!state) continue;
        const endpoints = this.endpoints.get(state) ?? [];
        endpoints.push({ room, door });
        this.endpoints.set(state, endpoints);
      }
    }
  }

  stateFor(door: Door): PassageDoor | undefined {
    return this.states.get(door);
  }

  /** Opens doors for authorized agents nearby; each new approach may break the door or its panel. */
  update(world: World, dt: number) {
    for (const [state, endpoints] of this.endpoints) {
      const users = new Set(world.agents.filter((agent) =>
        !agent.removed && !agent.held && agent.layer === 'room' &&
        endpoints.some(({ room, door }) => agent.room === room && world.canAgentUsePassage(agent, door) &&
          distanceToDoorway(agent, door) <= PASSAGE_DOOR_RANGE)));
      const previous = this.users.get(state);
      for (const agent of users) {
        if (previous?.has(agent)) continue;
        for (const broken of state.breakOnUse()) {
          const endpoint = endpoints.find(({ room }) => room === agent.room)!;
          world.log(`${agent.character.name} broke the ${endpoint.door.id} door${broken === 'panel' ? ' panel' : ''} in ${endpoint.room.name}.`, 'warn');
          agent.say('!', 1.5);
        }
      }
      this.users.set(state, users);
      const occupied = world.agents.some((agent) =>
        !agent.removed && !agent.held && agent.layer === 'room' && agent.alpha < 1 &&
        endpoints.some(({ room, door }) => agent.room === room && distanceToDoorway(agent, door) <= DOORWAY_OCCUPIED));
      state.update(users.size > 0, dt, occupied);
    }
  }
}
