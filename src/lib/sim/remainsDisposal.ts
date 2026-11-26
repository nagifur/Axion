import { Agent, type Task } from './agent.ts';
import { distance } from './navMap.ts';
import type { Remains } from './remains.ts';
import type { Door, Point, Room } from './room.ts';
import { stepTowardRoom } from './routing.ts';
import { wait, walkTo } from './tasks.ts';
import { exitThroughDoor, rideElevatorOut } from './transport.ts';
import type { VoreActor } from './vore.ts';
import type { World } from './world.ts';

export const DISPOSAL_TRAVEL_ACTIVITY = 'Finding a place to dispose of remains';

export interface DisposalSite {
  kind: 'place';
  room: Room;
  point: Point;
  remains: Remains;
  requiresPrivacy: boolean;
}

/** Visible, living occupants count as witnesses, including creatures. */
function hasWitness(world: World, actor: VoreActor, room: Room): boolean {
  return world.actorsIn(room).some((other) => other !== actor && !other.dead);
}

/** An urgent activity or an immediate threat always wins over disposal. */
function calmForDisposal(actor: VoreActor, world: World): boolean {
  if (!(actor instanceof Agent)) return actor.idle;
  return actor.exposed && !actor.dead && !actor.incapacitated &&
    !actor.napping && !actor.conversation && !actor.staffEscort && !actor.security?.target && !actor.urgent &&
    !actor.statuses.has('scared') && !world.creaturesIn(actor.room).some((creature) => creature.loose);
}

export function canContinueDisposal(actor: VoreActor, world: World, site: DisposalSite): boolean {
  return actor.room === site.room && actor.vore.remains.includes(site.remains) && calmForDisposal(actor, world) &&
    (!site.requiresPrivacy || !hasWitness(world, actor, site.room));
}

function corner(room: Room, actor: VoreActor): Point {
  const points = [
    { x: 0, y: 0 }, { x: room.width - 1, y: 0 },
    { x: 0, y: room.height - 1 }, { x: room.width - 1, y: room.height - 1 },
  ].map((point) => room.nearestWalkable(point, actor))
    .filter((point) => room.canReach(actor, point, actor instanceof Agent && actor.ghost));
  points.sort((a, b) => distance(a, actor) - distance(b, actor));
  return points[0] ?? room.nearestWalkable(actor);
}

/** Prefer an accessible empty restroom, then any empty room, then a corner of the current room. */
export function planDisposal<Step extends Door | Room>(
  actor: VoreActor, world: World, routeTo: (room: Room) => Step | undefined,
): DisposalSite | { kind: 'travel'; step: Step } | undefined {
  const remains = actor.vore.remains.find((pile) => pile.wait <= 0);
  if (!remains || !calmForDisposal(actor, world)) return undefined;
  const { room } = actor;
  const rooms = world.rooms.filter((candidate) => candidate === room || !candidate.cell)
    .sort((a, b) => Number(b.restroom) - Number(a.restroom) || Number(b === room) - Number(a === room));
  for (const candidate of rooms) {
    if (hasWitness(world, actor, candidate)) continue;
    if (candidate === room) {
      return { kind: 'place', room, point: room.nearestWalkable(actor), remains, requiresPrivacy: true };
    }
    const step = routeTo(candidate);
    if (step) return { kind: 'travel', step };
  }
  return { kind: 'place', room, point: corner(room, actor), remains, requiresPrivacy: false };
}

/** Staff replan after each room or elevator transition, just like work trips. */
export function planRemainsDisposal(agent: Agent, world: World): Task[] | undefined {
  const destination = planDisposal(agent, world, (room) => stepTowardRoom(world, agent, room));
  if (!destination) return undefined;
  if (destination.kind === 'travel') {
    const task = 'inside' in destination.step
      ? exitThroughDoor(destination.step, 1, DISPOSAL_TRAVEL_ACTIVITY)
      : rideElevatorOut(destination.step);
    return [{ ...task, remainsDisposal: 'travel' }];
  }

  const { point, remains } = destination;
  const { activity, seconds } = remains.disposal;
  const timedActivity = wait(seconds, activity);
  const atSite = (task: Task, phase: NonNullable<Task['remainsDisposal']>): Task => ({
    ...task,
    remainsDisposal: phase,
    update(actor, world, dt) {
      if (canContinueDisposal(actor, world, destination)) return task.update(actor, world, dt);
      actor.setPlan(world, []);
      return false;
    },
  });
  return [
    atSite(walkTo(point, DISPOSAL_TRAVEL_ACTIVITY), 'travel'),
    atSite({
      ...timedActivity,
      update(actor, world, dt) {
        if (!timedActivity.update(actor, world, dt)) return false;
        world.vore.finishDisposal(actor, remains);
        return true;
      },
    }, 'activity'),
  ];
}
