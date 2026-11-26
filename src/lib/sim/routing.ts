import type { Agent } from './agent.ts';
import { canVisitLevel, type SimCharacter } from './roster.ts';
import type { Door, Point, Room } from './room.ts';
import type { World } from './world.ts';
import type { Creature } from './creature.ts';

// Where people may go. Two policies live here side by side so they stay consistent:
// - routing (work trips and exits) only takes passages the character is cleared for;
// - voluntary wandering may also slip through a door whose panel is stuck open.

interface Location {
  room: Room;
  point?: Point;
}

/** Breadth-first search over rooms and the floor areas where travellers arrive. */
function firstStepToward<S>(
  start: Location,
  steps: (location: Location) => { next: Location; step: S }[],
  isGoal: (location: Location) => boolean,
): S | undefined {
  const key = ({ room, point }: Location) => `${room.id}:${point ? room.floorArea(point) : 'all'}`;
  const firstStep = new Map<string, S>();
  const queue = [start];
  const seen = new Set([key(start)]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const { next, step } of steps(current)) {
      if (seen.has(key(next))) continue;
      seen.add(key(next));
      const first = firstStep.get(key(current)) ?? step;
      if (isGoal(next)) return first;
      firstStep.set(key(next), first);
      queue.push(next);
    }
  }
  return undefined;
}

const reachable = (location: Location, point: Point, agent?: Agent) =>
  !location.point || location.room.canReach(location.point, point, agent?.ghost);

function doorDestination(world: World, door: Door, trackFloor: boolean): Location | undefined {
  const link = door.to;
  if (!link) return undefined;
  const room = world.room(link.room);
  const entry = room?.doors.find((candidate) => candidate.id === link.door);
  return room && entry ? { room, point: trackFloor ? entry.inside : undefined } : undefined;
}

/** Other rooms on camera that `room`'s elevator stops at, ordered by level. */
export function elevatorStops(world: World, room: Room): Room[] {
  const shaft = room.elevator?.shaft;
  if (!shaft) return [];
  return world.rooms.filter((other) => other !== room && other.elevator?.shaft === shaft).sort((a, b) => a.level - b.level);
}

/** Numeric staff work on their highest available floor; Admin has no floor preference. */
export function workRooms(world: World, character: SimCharacter): Room[] {
  const allowed = world.rooms.filter((room) => !room.cell && canVisitLevel(character, room.level));
  if (!allowed.length || /^admin$/i.test(character.accessLevel.trim())) return allowed;
  const level = Math.max(...allowed.map((room) => room.level));
  return allowed.filter((room) => room.level === level);
}

/** First door or elevator stop on a clearance-safe route to a work floor. */
export function stepTowardWork(world: World, character: SimCharacter, room: Room, agent?: Agent): Door | Room | undefined {
  const targets = new Set(workRooms(world, character));
  if (targets.has(room)) return undefined;
  return travelStep(world, character, room, agent, (next) => targets.has(next.room));
}

/** Route to the right floor area, not just to any entrance of the destination room. */
export function stepTowardRoom(world: World, agent: Agent, destination: Room, point?: Point, sameLevelOnly = false) {
  return travelStep(world, agent.character, agent.room, agent,
    (next) => next.room === destination && (!point || reachable(next, point, agent)), sameLevelOnly);
}

/** Creatures can leave through exterior doors but cannot enter cells. */
export function creatureMayUseDoor(door: Door, destination: Room | undefined): boolean {
  return !door.cell && (!door.to || (!!destination && !destination.cell));
}

/** Creatures follow linked doors they can already squeeze through. */
export function stepTowardCreatureRoom(world: World, creature: Creature, destination: Room): Door | undefined {
  return firstStepToward<Door>({ room: creature.room, point: creature }, (location) =>
    location.room.linkedDoors.flatMap((door) => {
      const next = doorDestination(world, door, true);
      return next && creatureMayUseDoor(door, next.room) && reachable(location, door.inside) &&
        creature.canSqueezeThrough(world, door) ? [{ next, step: door }] : [];
    }), (next) => next.room === destination);
}

function travelStep(world: World, character: SimCharacter, room: Room, agent: Agent | undefined,
  goal: (location: Location) => boolean, sameLevelOnly = false): Door | Room | undefined {
  return firstStepToward<Door | Room>({ room, point: agent?.ghost ? undefined : agent }, (location) => {
    const current = location.room;
    const steps: { next: Location; step: Door | Room }[] = [];
    for (const door of current.linkedDoors) {
      const next = doorDestination(world, door, !!agent && !agent.ghost);
      if (next && reachable(location, door.inside, agent) &&
        (agent ? world.canAgentUsePassage(agent, door) : world.canUsePassage(character, door))) {
        steps.push({ next, step: door });
      }
    }
    if (!sameLevelOnly && current.elevator && reachable(location, current.elevator.front, agent)) {
      for (const next of elevatorStops(world, current)) {
        steps.push({ next: { room: next, point: agent && !agent.ghost ? next.elevator!.front : undefined }, step: next });
      }
    }
    return steps.filter(({ next }) => (!sameLevelOnly || next.room.level === room.level) && canVisitLevel(character, next.room.level));
  }, goal);
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
  const start = { room, point: agent?.ghost ? undefined : agent };
  const hasExit = (location: Location) => (!doorsOnly && !!location.room.elevator && reachable(location, location.room.elevator.front, agent)) ||
    location.room.outerDoors.some((door) => reachable(location, door.inside, agent) && canUse(door, location.room));
  if (hasExit(start)) return null;
  return firstStepToward<Door>(start, (location) => location.room.linkedDoors.flatMap((door) => {
    const next = doorDestination(world, door, !!agent && !agent.ghost);
    return next && reachable(location, door.inside, agent) && canUse(door, location.room) ? [{ next, step: door }] : [];
  }), hasExit) ?? null;
}

/** Whether staff have no way out of their room that their own cards allow. */
export function isStranded(world: World, agent: Agent): boolean {
  const { room } = agent;
  return !agent.impostor && !agent.ghost && !(room.elevator && room.canReach(agent, room.elevator.front)) &&
    !room.outerDoors.some((door) => room.canReach(agent, door.inside) && world.canAgentUsePassage(agent, door)) &&
    !doorTowardExit(world, room, false, agent);
}

/** Whether a stranded agent can leave right now through a door someone else has opened. */
export function canSlipOut(world: World, agent: Agent): boolean {
  return agent.room.outerDoors.some((door) => agent.room.canReach(agent, door.inside, agent.ghost) && world.canAgentCross(agent, door)) ||
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
      agent.room.canReach(agent, door.inside, agent.ghost) && world.canAgentCross(agent, door);
  });
}

/** Other floors on camera an agent may choose to ride the elevator to. */
export function wanderFloors(world: World, agent: Agent): Room[] {
  if (!agent.room.elevator || !agent.room.canReach(agent, agent.room.elevator.front, agent.ghost)) return [];
  return elevatorStops(world, agent.room).filter((room) => canAgentVisit(agent, room));
}
