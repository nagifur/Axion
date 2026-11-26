import type { Agent, Task } from './agent.ts';
import { distance } from './navMap.ts';
import { chance } from './random.ts';
import { canVisitLevel } from './roster.ts';
import type { Door, Point, Room } from './room.ts';
import { canAgentVisit, stepTowardRoom } from './routing.ts';
import { wait } from './tasks.ts';
import { exitThroughDoor, rideElevatorOut } from './transport.ts';
import { pickVoreType } from './vore.ts';
import { stalk } from './voreTasks.ts';
import type { World } from './world.ts';

export interface StaffEscort {
  readonly leader: Agent;
  readonly target: Agent;
  readonly fromLevel: number;
  destination: Room;
  waitingForRoute: boolean;
  lift?: { from: Room; to: Room; attempted: Set<Agent> };
}

const ESCORT_REACH = 14;
const APPROACH_SECONDS = 20;

export const trespassResponseFor = (agent: Agent) => !agent.impostor ? agent.character.trespassResponse : undefined;
export const isTrespassing = (agent: Agent) => !canAgentVisit(agent, agent.room);

/** Configured staff and on-duty security respond to visible, reachable staff above their clearance. */
export function reactToTrespassing(agent: Agent, world: World) {
  const security = !!agent.security && !agent.security.relieved;
  const response = trespassResponseFor(agent);
  if ((!response && !security) || agent.dead || agent.incapacitated || agent.napping || !agent.exposed ||
    !agent.interruptible || agent.staffEscort) return;
  const targets = world.agentsIn(agent.room).filter((other) =>
    other !== agent && !other.dead && other.exposed && isTrespassing(other) &&
    agent.room.canReach(agent, other, agent.ghost));
  targets.sort((a, b) => distance(agent, a) - distance(agent, b));
  const target = targets[0];
  if (!target) return;
  const vore = response && response.swallowChance > 0 && agent.vore.cooldown <= 0 &&
    world.vore.eligible(agent, target) && chance(response.swallowChance);
  world.log(`${agent.character.name} spotted ${target.character.name} without clearance in the ${agent.room.name}.`, 'warn');
  agent.say('!');
  agent.setPlan(world, [vore ? stalk(target, pickVoreType(agent.character.vore)) : approachTrespasser(target)]);
}

function approachTrespasser(target: Agent): Task {
  let path: Point[] = [];
  let reroute = 0;
  let elapsed = 0;
  return {
    activity: `Approaching ${target.character.name} for an escort`,
    interruptible: false,
    update(agent, world, dt) {
      if (target.room !== agent.room || target.dead || !target.exposed || !isTrespassing(target)) return true;
      elapsed += dt;
      if (distance(agent, target) <= ESCORT_REACH && agent.room.canReach(agent, target, agent.ghost)) {
        const destination = escortRoute(agent, target, world, agent.room.level);
        if (!destination) {
          world.log(`${agent.character.name} cannot escort ${target.character.name}: no floor is within their clearance.`, 'warn');
          agent.setPlan(world, [{ ...wait(5, 'Waiting for an accessible floor'), interruptible: false }]);
          return false;
        }
        target.setPlan(world, []);
        target.releaseTarget();
        const escort: StaffEscort = {
          leader: agent, target, fromLevel: agent.room.level, destination: destination.room, waitingForRoute: false,
        };
        agent.staffEscort = escort;
        target.staffEscort = escort;
        world.log(`${agent.character.name} is escorting ${target.character.name} to ${destination.room.label}.`, 'warn');
        return true;
      }
      if (elapsed > APPROACH_SECONDS) {
        world.log(`${agent.character.name} could not reach ${target.character.name} for an escort.`, 'warn');
        return true;
      }
      reroute -= dt;
      if (!path.length || reroute <= 0) {
        reroute = 1;
        path = agent.room.route(agent, target, agent.ghost) ?? [];
        if (!path.length) {
          world.log(`${agent.character.name} cannot reach ${target.character.name} for an escort.`, 'warn');
          return true;
        }
      }
      agent.moveAlongPath(path, dt, 1.8);
      return false;
    },
  };
}

function escortRoute(agent: Agent, target: Agent, world: World, fromLevel: number):
  { room: Room; step: Door | Room | null | undefined } | undefined {
  const rooms = world.rooms.filter((room) => !room.cell && canVisitLevel(target.character, room.level))
    .sort((a, b) => Math.abs(a.level - fromLevel) - Math.abs(b.level - fromLevel));
  for (const room of rooms) {
    if (room.level === agent.room.level && !agent.room.cell) return { room: agent.room, step: null };
    const step = stepTowardRoom(world, agent, room);
    if (step) return { room, step };
  }
  return rooms[0] ? { room: rooms[0], step: undefined } : undefined;
}

/** Continue an escort across real passages and elevator rides, waiting if the route closes. */
export function planStaffEscort(agent: Agent, world: World, escort: StaffEscort): Task[] {
  const { target } = escort;
  if (escort.lift) return planEscortedStaff(agent, escort);
  const route = escortRoute(agent, target, world, escort.fromLevel);
  if (!route) {
    world.log(`${agent.character.name} cannot escort ${target.character.name}: no floor is within their clearance.`, 'warn');
    agent.releaseStaffEscort(world);
    return [wait(2, 'Waiting for an accessible floor')];
  }
  escort.destination = route.room;
  if (route.step === null) {
    agent.releaseStaffEscort(world);
    world.log(`${agent.character.name} escorted ${target.character.name} to ${agent.room.label}.`, 'ok');
    return [wait(1, 'Finished escorting')];
  }
  if (!route.step) {
    if (!escort.waitingForRoute) {
      world.log(`${agent.character.name} is waiting for a route to escort ${target.character.name} to ${route.room.label}.`, 'warn');
      escort.waitingForRoute = true;
    }
    return [{ ...wait(2, `Waiting for a route to ${route.room.label}`), interruptible: false }];
  }
  escort.waitingForRoute = false;
  const activity = `Escorting ${target.character.name} to ${route.room.label}`;
  if ('inside' in route.step) return [exitThroughDoor(route.step, 1, activity)];
  escort.lift = { from: agent.room, to: route.step, attempted: new Set([agent]) };
  return [{ ...rideElevatorOut(route.step), activity }];
}

/** Each person requests their own elevator place and waits for the other at the destination. */
export function planEscortedStaff(agent: Agent, escort: StaffEscort): Task[] {
  const { lift } = escort;
  if (lift && agent.room === lift.from) {
    if (lift.attempted.delete(agent)) {
      return [{ ...wait(2, 'Waiting to retry the elevator'), interruptible: false }];
    }
    lift.attempted.add(agent);
    return [rideElevatorOut(lift.to)];
  }
  return [{ ...wait(1, 'Waiting for the escort'), interruptible: false }];
}

/** Keep the escorted person beside Reef, except while they take their separate elevator places. */
export function syncStaffEscorts(world: World) {
  for (const leader of world.agents) {
    const escort = leader.staffEscort;
    if (!escort || escort.leader !== leader) continue;
    const { target } = escort;
    if (escort.lift) {
      if (leader.room !== escort.lift.to || target.room !== escort.lift.to || !world.agents.includes(target) ||
        leader.layer !== 'room' || target.layer !== 'room' || leader.transporting || target.transporting) continue;
      escort.lift = undefined;
    }
    if (!world.agents.includes(target)) {
      world.log(`${leader.character.name} lost contact with ${target.character.name} during the escort.`, 'warn');
      leader.releaseStaffEscort(world);
      continue;
    }
    if (target.room !== leader.room) target.enteredRoomAt = world.time;
    target.room = leader.room;
    const beside = { x: leader.x - 14, y: leader.y + 2 };
    const point = leader.alpha === 1 && leader.layer === 'room' && leader.room.isWalkable(beside) &&
      leader.room.sameFloorArea(leader, beside) ? beside : leader;
    target.x = point.x;
    target.y = point.y;
    target.alpha = leader.alpha;
    target.layer = leader.layer;
    target.facing = leader.facing;
    target.moving = leader.moving;
    target.walkDistance = leader.walkDistance;
  }
}
