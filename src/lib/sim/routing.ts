import type { Agent } from './agent.ts';
import { canVisitLevel, type SimCharacter } from './roster.ts';
import type { Door, Room } from './room.ts';
import type { World } from './world.ts';

// Where people may go. Two policies live here side by side so they stay consistent:
// - routing (work trips and exits) only takes passages the character is cleared for;
// - voluntary wandering may also slip through a door whose panel is stuck open.

/** Breadth-first search; returns the first step on the shortest route from `start` to a goal room. */
function firstStepToward<S>(
  start: Room,
  steps: (room: Room) => { next: Room; step: S }[],
  isGoal: (room: Room) => boolean,
): S | undefined {
  const firstStep = new Map<Room, S>();
  const queue = [start];
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift()!;
    for (const { next, step } of steps(current)) {
      if (seen.has(next)) continue;
      seen.add(next);
      const first = firstStep.get(current) ?? step;
      if (isGoal(next)) return first;
      firstStep.set(next, first);
      queue.push(next);
    }
  }
  return undefined;
}

/** Other rooms on camera that `room`'s elevator stops at, ordered by level. */
export function elevatorStops(world: World, room: Room): Room[] {
  const shaft = room.elevator?.shaft;
  if (!shaft) return [];
  return world.rooms.filter((other) => other !== room && other.elevator?.shaft === shaft).sort((a, b) => a.level - b.level);
}

/** Numeric staff work on their highest available floor; Admin has no floor preference. */
export function workRooms(world: World, character: SimCharacter): Room[] {
  const allowed = world.rooms.filter((room) => canVisitLevel(character, room.level));
  if (!allowed.length || /^admin$/i.test(character.accessLevel.trim())) return allowed;
  const level = Math.max(...allowed.map((room) => room.level));
  return allowed.filter((room) => room.level === level);
}

/** First door or elevator stop on a clearance-safe route to a work floor. */
export function stepTowardWork(world: World, character: SimCharacter, room: Room, agent?: Agent): Door | Room | undefined {
  const targets = new Set(workRooms(world, character));
  if (targets.has(room)) return undefined;
  return firstStepToward<Door | Room>(room, (current) => {
    const steps: { next: Room; step: Door | Room }[] = [];
    for (const door of current.linkedDoors) {
      const next = world.room(door.to!.room);
      if (next && (agent ? world.canAgentUsePassage(agent, door) : world.canUsePassage(character, door))) {
        steps.push({ next, step: door });
      }
    }
    for (const next of elevatorStops(world, current)) steps.push({ next, step: next });
    return steps.filter(({ next }) => canVisitLevel(character, next.level));
  }, (next) => targets.has(next));
}

/**
 * First door to take from `room` to reach the nearest room with a way out of the facility.
 * Null if `room` already has one. With `doorsOnly`, elevators don't count as a way out.
 * When an agent is supplied, every passage and the final exit must allow their cards;
 * with `tailgate`, doors out of `room` that are already fully open count too.
 */
export function doorTowardExit(world: World, room: Room, doorsOnly = false, agent?: Agent, tailgate = false): Door | null {
  const canUse = (door: Door, from: Room) => !agent ? !world.passageDoorFor(door)?.blocked
    : tailgate && from === room ? world.canAgentCross(agent, door) : world.canAgentUsePassage(agent, door);
  const hasExit = (candidate: Room) => (!doorsOnly && !!candidate.elevator) ||
    candidate.outerDoors.some((door) => canUse(door, candidate));
  if (hasExit(room)) return null;
  return firstStepToward<Door>(room, (current) => current.linkedDoors.flatMap((door) => {
    const next = world.room(door.to!.room);
    return next && canUse(door, current) ? [{ next, step: door }] : [];
  }), hasExit) ?? null;
}

/** Whether staff have no way out of their room that their own cards allow. */
export function isStranded(world: World, agent: Agent): boolean {
  const { room } = agent;
  return !agent.impostor && !agent.ghost && !room.elevator &&
    !room.outerDoors.some((door) => world.canAgentUsePassage(agent, door)) &&
    !doorTowardExit(world, room, false, agent);
}

/** Whether a stranded agent can leave right now through a door someone else has opened. */
export function canSlipOut(world: World, agent: Agent): boolean {
  return agent.room.outerDoors.some((door) => world.canAgentCross(agent, door)) ||
    !!doorTowardExit(world, agent.room, false, agent, true);
}

/** Whether an agent may choose to be in `room`: impostors ignore clearance. */
export function canAgentVisit(agent: Agent, room: Room): boolean {
  return !!agent.impostor || canVisitLevel(agent.character, room.level);
}

/** Doors to neighbouring rooms on camera that an agent may choose to wander through. */
export function wanderDoors(world: World, agent: Agent): Door[] {
  return agent.room.linkedDoors.filter((door) => {
    const destination = world.room(door.to!.room);
    return destination && (canAgentVisit(agent, destination) || world.passageDoorFor(door)?.stuckOpen) &&
      world.canAgentCross(agent, door);
  });
}

/** Other floors on camera an agent may choose to ride the elevator to. */
export function wanderFloors(world: World, agent: Agent): Room[] {
  return elevatorStops(world, agent.room).filter((room) => canAgentVisit(agent, room));
}
