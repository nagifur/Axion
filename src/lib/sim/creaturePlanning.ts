import type { Agent } from './agent.ts';
import type { Creature } from './creature.ts';
import { distance } from './navMap.ts';
import { chance, maybePick, pick, range } from './random.ts';
import { planDisposal, type DisposalSite } from './remainsDisposal.ts';
import type { Door, Point } from './room.ts';
import { creatureMayUseDoor, stepTowardCreatureRoom } from './routing.ts';
import type { VoreActor, VoreType } from './vore.ts';
import type { World } from './world.ts';

/** Heads to a door, waits briefly if it is too far closed, then slips through it. */
type DoorPlan = { action: 'escape' | 'disposalDoor'; door: Door; path: Point[]; waited: number; crossing: boolean };

export type CreaturePlan =
  | { action: 'rest' | 'watch'; remaining: number }
  | { action: 'pace'; path: Point[] }
  | { action: 'flee'; path: Point[] }
  | { action: 'dispose'; site: DisposalSite; path: Point[]; remaining: number }
  | { action: 'attack'; target: Agent; path: Point[]; reroute: number; remaining: number }
  /** Chases someone it means to swallow; VoreSystem does the swallowing once it is within reach. */
  | { action: 'swallow'; target: VoreActor; type: VoreType; path: Point[]; reroute: number; remaining: number }
  | DoorPlan
  /** Fades in from the doorway it arrived through. */
  | { action: 'enter'; door: Door };

/** Never into a cell (its own included: getting back in is security's job), nor somewhere it can't reach. */
export function canUseDoor(creature: Creature, world: World, door: Door) {
  return creatureMayUseDoor(door, door.to && world.room(door.to.room)) && creature.room.canReach(creature, door.inside);
}

export function headFor(creature: Creature, door: Door, action: DoorPlan['action'] = 'escape'): DoorPlan | undefined {
  const path = creature.room.route(creature, door.inside);
  return path ? { action, door, path, waited: 0, crossing: false } : undefined;
}

export function planFlight(creature: Creature, world: World, guard: Agent): CreaturePlan | undefined {
  const { room } = creature;
  const doors = room.doors.filter((door) => canUseDoor(creature, world, door) && creature.canSqueezeThrough(world, door));
  doors.sort((a, b) => distance(guard, b.inside) - distance(guard, a.inside));
  for (const door of doors) {
    const plan = headFor(creature, door);
    if (plan) return plan;
  }
  let farthest: Point = { x: creature.x, y: creature.y };
  for (let i = 0; i < 12; i++) {
    const point = room.randomFloorPoint(undefined, creature);
    if (distance(guard, point) > distance(guard, farthest) && room.canReach(creature, point)) farthest = point;
  }
  const path = room.route(creature, farthest);
  return path?.length ? { action: 'flee', path } : undefined;
}

export function planCreatureDisposal(creature: Creature, world: World): CreaturePlan | undefined {
  const destination = planDisposal(creature, world, (room) => stepTowardCreatureRoom(world, creature, room));
  if (!destination) return undefined;
  if (destination.kind === 'travel') return headFor(creature, destination.step, 'disposalDoor');
  const path = creature.room.route(creature, destination.point);
  return path ? { action: 'dispose', site: destination, path, remaining: destination.remains.disposal.seconds } : undefined;
}

export function planIdle(creature: Creature, world: World, roamChance: number): CreaturePlan {
  const { room } = creature;
  if (!creature.contained && chance(roamChance)) {
    const door = maybePick(room.doors.filter((door) => creature.canSqueezeThrough(world, door) && canUseDoor(creature, world, door)));
    const plan = door && headFor(creature, door);
    if (plan) return plan;
  }
  const action = pick(['rest', 'watch', 'pace'] as const);
  if (action === 'rest') return { action, remaining: range(5, 14) };
  if (action === 'pace') {
    const path = room.route(creature, room.randomFloorPoint(undefined, creature));
    if (path?.length) return { action, path };
  }
  creature.facing = pick(['left', 'right', 'front', 'back'] as const);
  return { action: 'watch', remaining: range(2, 6) };
}
