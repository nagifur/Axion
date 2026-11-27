import { generateNpc } from './npc.ts';
import { chance, pick, range, weightedPick } from './random.ts';
import type { Door, Room } from './room.ts';
import { canVisitLevel, type SimCharacter, type SimImpostor } from './roster.ts';
import { scheduleFor, securitySchedule } from './schedule.ts';
import { postPoint } from './security.ts';
import type { World } from './world.ts';

const RETURN_DELAY_SECONDS = { min: 45, max: 165 };
const ARRIVAL_INTERVAL_SECONDS = { min: 4, max: 12 };
/** Average number of staff per room, by the viewer's local time. */
const DENSITY = { night: 1, evening: 2.5, day: 3.5 };

type Entrance =
  | { kind: 'elevator'; room: Room; weight: number }
  | { kind: 'door'; room: Room; door: Door; weight: number };

/** Staff availability, guard assignments and arrival decisions. World performs the actual transfers. */
export class WorldPopulation {
  private readonly returnAt = new Map<string, number>();
  private nextArrival = 3;
  private nextNpcBadge = 1;

  target(world: World) {
    const hour = world.now().getHours();
    const density = hour < 6 ? DENSITY.night : hour < 8 || hour >= 20 ? DENSITY.evening : DENSITY.day;
    return Math.min(Math.max(1, Math.round(density * world.rooms.filter((room) => !room.cell).length)), world.roster.length);
  }

  pickArrival(world: World): SimCharacter | undefined {
    const candidates = world.roster.filter((character) =>
      !world.isPresent(character.id) && !world.vore.consumed.has(character.id) && (this.returnAt.get(character.id) ?? 0) <= world.time);
    return weightedPick(candidates);
  }

  departed(character: SimCharacter, time: number) {
    this.returnAt.set(character.id, time + range(RETURN_DELAY_SECONDS.min, RETURN_DELAY_SECONDS.max));
  }

  update(world: World, dt: number) {
    this.nextArrival -= dt;
    if (this.nextArrival <= 0) {
      this.nextArrival = range(ARRIVAL_INTERVAL_SECONDS.min, ARRIVAL_INTERVAL_SECONDS.max);
      if (world.presentCount() < world.targetPopulation()) world.arrive();
    }
  }

  populate(world: World, posts: Iterable<Room>) {
    const count = Math.max(1, world.targetPopulation() - 1);
    for (let i = 0; i < count; i++) {
      const character = world.pickArrival();
      if (!character) break;
      const rooms = world.rooms.filter((room) => !room.cell && canVisitLevel(character, room.level));
      if (!rooms.length) {
        world.log(`No rooms within ${character.name}'s clearance are available.`, 'warn');
        break;
      }
      const working = scheduleFor(character, world.now()) === 'work';
      const workRooms = world.workRooms(character);
      const room = pick(working && workRooms.length && chance(0.85) ? workRooms : rooms);
      world.spawn(character, room, room.randomFloorPoint());
    }
    for (const room of posts) if (!room.cell) world.staffSecurityPost(room, true);
  }

  staffSecurityPost(world: World, post: Room, initial: boolean) {
    const guards = world.everyone().filter((agent) =>
      !agent.removed && agent.security?.post === post && !agent.security.relieved);
    const assigned = guards.find((agent) => !agent.dead && !agent.swallowed);
    for (const guard of guards) {
      if (guard.security && (guard.dead || guard.swallowed)) guard.security.relieved = true;
    }
    if (assigned) return assigned;
    const character = generateNpc(this.nextNpcBadge++, {
      position: 'Security guard', accessLevel: String(post.level), schedule: securitySchedule(world.now()),
    });
    const guard = initial ? world.spawn(character, post, postPoint(post)) : world.arriveByElevator(character, post);
    guard.security = { post, relieved: false };
    guard.activity = initial ? 'Guarding the elevator' : 'Arriving by elevator';
    return guard;
  }

  arrive(world: World, character: SimCharacter, impostor?: SimImpostor) {
    const ghost = character.behavior.ghost && !impostor;
    const rooms = world.rooms.filter((room) => !room.cell && (impostor || canVisitLevel(character, room.level)));
    if (!rooms.length) {
      world.log(`No rooms within ${character.name}'s clearance are available.`, 'warn');
      return undefined;
    }
    const entrances: Entrance[] = [];
    let deniedDoor = false;
    const workRooms = new Set(!impostor && scheduleFor(character, world.now()) === 'work' ? world.workRooms(character) : []);
    for (const room of rooms) {
      const preference = workRooms.has(room) ? 8 : 1;
      // Don't stack arrivals on an elevator that is already busy.
      const elevator = world.elevatorFor(room);
      if (elevator) entrances.push({ kind: 'elevator', room, weight: (elevator.busy ? 0.15 : 1.5) * preference });
      for (const door of room.outerDoors) {
        if (!world.passageDoorFor(door)?.blocked && (impostor || world.canUsePassage(character, door))) {
          entrances.push({ kind: 'door', room, door, weight: preference });
        }
        else deniedDoor = true;
      }
    }

    const entrance = weightedPick(entrances);
    if (!entrance && impostor) {
      world.log(`No entrance available for ${impostor.name}'s disguise.`, 'muted');
      return undefined;
    }
    if (!entrance && deniedDoor && !ghost) {
      world.log(`No entrances within ${character.name}'s clearance are available.`, 'warn');
      return undefined;
    }
    if (!entrance || (ghost && chance(0.4))) {
      const preferred = [...workRooms];
      return world.arriveThroughWall(character, entrance?.room ?? pick(preferred.length ? preferred : rooms));
    }
    if (entrance.kind === 'elevator') return world.arriveByElevator(character, entrance.room, impostor);
    return world.arriveByDoor(character, entrance.room, entrance.door, impostor);
  }
}
