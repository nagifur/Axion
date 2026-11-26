import { Agent, type Task } from './agent.ts';
import type { Remains } from './remains.ts';
import type { Door, Point, Room } from './room.ts';
import { stepTowardCreatureRoom, stepTowardRoom } from './routing.ts';
import { walkTo } from './tasks.ts';
import { exitThroughDoor, rideElevatorOut } from './transport.ts';
import { VORE_TYPES, type VoreActor } from './vore.ts';
import type { World } from './world.ts';

type Destination =
  | { kind: 'travel'; step: Door | Room }
  | { kind: 'place'; point: Point; private: boolean };

/** Visible, living occupants count as witnesses, including creatures. */
export function hasDisposalWitness(world: World, actor: VoreActor, room = actor.room): boolean {
  return world.actorsIn(room).some((other) => other !== actor && !other.dead);
}

/** An urgent activity or an immediate threat always wins over disposal. */
export function calmForDisposal(actor: VoreActor, world: World): boolean {
  if (actor.dead || actor.incapacitated || !actor.exposed) return false;
  if (actor instanceof Agent) {
    return !actor.napping && !actor.conversation && !actor.staffEscort && !actor.security?.target && !actor.urgent &&
      !actor.statuses.has('scared') && !world.creaturesIn(actor.room).some((creature) => creature.loose);
  }
  return actor.idle;
}

export function readyRemains(actor: VoreActor): Remains | undefined {
  return actor.vore.remains.find((remains) => remains.wait <= 0);
}

function corner(room: Room, actor: VoreActor): Point {
  const points = [
    { x: 0, y: 0 }, { x: room.width - 1, y: 0 },
    { x: 0, y: room.height - 1 }, { x: room.width - 1, y: room.height - 1 },
  ].map((point) => room.nearestWalkable(point, actor))
    .filter((point) => room.canReach(actor, point, actor instanceof Agent && actor.ghost));
  points.sort((a, b) => Math.hypot(a.x - actor.x, a.y - actor.y) - Math.hypot(b.x - actor.x, b.y - actor.y));
  return points[0] ?? room.nearestWalkable(actor);
}

/** Prefer an accessible empty restroom, then any empty room, then a corner of the current room. */
export function disposalDestination(actor: VoreActor, world: World): Destination {
  const rooms = [...world.rooms].sort((a, b) => Number(b === actor.room) - Number(a === actor.room));
  for (const restroomOnly of [true, false]) {
    for (const room of rooms) {
      if ((restroomOnly && !room.restroom) || (room.cell && room !== actor.room) ||
        hasDisposalWitness(world, actor, room)) continue;
      if (room === actor.room) return { kind: 'place', point: room.nearestWalkable(actor), private: true };
      const step = actor instanceof Agent
        ? stepTowardRoom(world, actor, room)
        : stepTowardCreatureRoom(world, actor, room);
      if (step) return { kind: 'travel', step };
    }
  }
  return { kind: 'place', point: corner(actor.room, actor), private: false };
}

/** Staff replan after each room or elevator transition, just like work trips. */
export function planRemainsDisposal(agent: Agent, world: World): Task[] | undefined {
  const remains = readyRemains(agent);
  if (!remains || !calmForDisposal(agent, world)) return undefined;
  const destination = disposalDestination(agent, world);
  if (destination.kind === 'travel') {
    const task = 'inside' in destination.step
      ? exitThroughDoor(destination.step, 1, 'Finding a place to dispose of remains')
      : rideElevatorOut(destination.step);
    return [{ ...task, remainsDisposal: true }];
  }
  const { point } = destination;
  const room = agent.room;
  const action = VORE_TYPES[remains.type].disposal;
  let remaining = action.seconds;
  const walk = walkTo(point, 'Finding a place to dispose of remains');
  return [
    {
      ...walk,
      remainsDisposal: true,
      update(actor, world, dt) {
        if (!calmForDisposal(actor, world) || !actor.vore.remains.includes(remains) ||
          (destination.private && hasDisposalWitness(world, actor))) {
          actor.setPlan(world, []);
          return false;
        }
        return walk.update(actor, world, dt);
      },
    },
    {
      activity: action.activity,
      interruptible: true,
      remainsDisposal: true,
      update(actor, world, dt) {
        if (actor.room !== room || !actor.vore.remains.includes(remains) ||
          !calmForDisposal(actor, world) || (destination.private && hasDisposalWitness(world, actor))) {
          actor.setPlan(world, []);
          return false;
        }
        remaining -= dt;
        if (remaining > 0) return false;
        world.vore.finishDisposal(actor, remains);
        return true;
      },
    },
  ];
}
