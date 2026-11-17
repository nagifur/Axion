import type { Agent } from './agent.ts';
import type { Door, Room } from './room.ts';
import type { World } from './world.ts';
import { PASSAGE_DOOR_RANGE, PassageDoor } from './door.ts';

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
          Math.hypot(agent.x - door.inside.x, agent.y - door.inside.y) <= PASSAGE_DOOR_RANGE)));
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
      state.update(users.size > 0, dt);
    }
  }
}
