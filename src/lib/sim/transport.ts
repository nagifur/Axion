import type { Agent, Task } from './agent.ts';
import { directionTo, type Door, type Point, type Room } from './room.ts';
import type { World } from './world.ts';
import type { ElevatorRequest } from './elevator.ts';
import { distance } from './navMap.ts';
import { chance, pick, range } from './random.ts';
import { wait, walkTo } from './tasks.ts';

// Tasks that move agents between rooms or in and out of the facility: doors, elevators and walls.

/** Walks to the elevator, waits for the car, and rides it to `destination` (another floor on camera) or off camera. */
export function rideElevatorOut(destination?: Room): Task {
  let path: Point[] = [];
  let request: ElevatorRequest | undefined;
  let unreachable = false;
  return {
    activity: 'Heading to the elevator',
    interruptible: false,
    transport: true,
    start(agent, world) {
      const { front } = agent.room.elevator!;
      const waitSpot = agent.room.nearestWalkable({ x: front.x + Math.round(range(-10, 10)), y: front.y });
      const route = agent.room.route(agent, waitSpot, agent.ghost);
      if (!route) {
        unreachable = true;
        world.log(`${agent.character.name} cannot reach the elevator in ${agent.room.name}.`, 'warn');
        agent.leaving = false;
        agent.setPlan(world, []);
        return;
      }
      path = route;
    },
    update(agent, world, dt) {
      if (unreachable) return true;
      if (path.length) {
        if (agent.moveToward(path[0], dt)) path.shift();
        return false;
      }
      const elevator = agent.room.elevator!;
      if (!request) {
        const direction = destination ? directionTo(agent.room, destination) : undefined;
        request = world.elevatorFor(agent.room)!.request('depart', agent, { destination, direction });
        agent.facing = 'back';
        agent.activity = destination ? `Waiting for the elevator to ${destination.label}` : 'Waiting for the elevator';
      }
      if (request.board && !request.ready) {
        agent.activity = 'Taking the elevator';
        if (agent.y < elevator.thresholdY) agent.layer = 'inside';
        if (agent.moveToward(request.inside ?? elevator.inside, dt)) {
          agent.facing = 'front';
          request.ready = true;
        }
      }
      return false;
    },
    end(agent) {
      // Replacing a departure after boarding must still remove the rider from the car's request.
      if (request) {
        request.cancelled = true;
        agent.layer = 'room';
      }
    },
  };
}

/** Steps out of an elevator car that has arrived on this floor. */
export function rideElevatorIn(request: ElevatorRequest): Task {
  let exit: Point | undefined;
  return {
    activity: 'Arriving by elevator',
    interruptible: false,
    transport: true,
    update(agent, world, dt) {
      if (!request.board) return false;
      const elevator = agent.room.elevator!;
      exit ??= agent.room.nearestWalkable({
        x: elevator.front.x + Math.round(range(-14, 14)),
        y: elevator.front.y + Math.round(range(2, 14)),
      });
      const done = agent.moveToward(exit, dt);
      if (agent.y > elevator.thresholdY) {
        agent.layer = 'room';
        request.ready = true;
      }
      return done;
    },
    end(agent) {
      // Interrupted before stepping out: free the elevator and walk out from where they are.
      if (!request.ready) {
        request.ready = true;
        agent.layer = 'room';
      }
    },
    cancel(agent) {
      request.cancelled = true;
      agent.layer = 'room';
    },
  };
}

/** Walks through a linked door or out of the facility; an unlinked cell cannot be entered. */
export function exitThroughDoor(door: Door, speedMul = 1, activity = 'Heading out'): Task {
  let path: Point[] = [];
  let fading = false;
  let waited = 0;
  let unreachable = false;
  return {
    activity,
    interruptible: false,
    transport: true,
    start(agent, world) {
      if (door.cell && !door.to) {
        unreachable = true;
        world.log(`${agent.character.name} cannot enter the ${door.id} cell in ${agent.room.name}: no cell room is connected.`, 'warn');
        agent.leaving = false;
        agent.setPlan(world, []);
        return;
      }
      const route = agent.room.route(agent, door.inside, agent.ghost);
      if (!route) {
        unreachable = true;
        world.log(`${agent.character.name} cannot reach the ${door.id} door in ${agent.room.name}.`, 'warn');
        agent.leaving = false;
        agent.setPlan(world, []);
        return;
      }
      path = route;
    },
    update(agent, world, dt) {
      if (unreachable) return true;
      if (!fading) {
        if (path.length && agent.moveToward(path[0], dt, speedMul)) path.shift();
        fading = path.length === 0;
        return false;
      }
      const physical = world.passageDoorFor(door);
      if (physical && !world.canAgentCross(agent, door)) {
        giveUpOnDoor(agent, world, door);
        world.log(`Access denied: ${agent.character.name} cannot use the ${door.id} door in ${agent.room.name}.`, 'warn');
        return true;
      }
      if (physical && !physical.passable) {
        // Never stay half-faded in a closing doorway: wait visibly at the threshold instead.
        agent.x = door.inside.x;
        agent.y = door.inside.y;
        agent.alpha = 1;
        waited += Math.max(0, dt);
        if (waited < DOOR_WAIT_LIMIT) return false;
        giveUpOnDoor(agent, world, door);
        world.log(`${agent.character.name} gave up waiting for the ${door.id} door in ${agent.room.name}.`, 'warn');
        return true;
      }
      waited = 0;
      const total = Math.max(1, distance(door.outside, door.inside));
      const reached = agent.moveToward(door.outside, dt, speedMul);
      poseInDoorway(agent, door, 'out');
      agent.alpha = Math.max(0, distance(door.outside, agent) / total);
      if (reached) {
        if (door.to) world.transfer(agent, door);
        else world.remove(agent, door.id);
      }
      return reached;
    },
  };
}

/** Longest an agent waits at a closed passage before abandoning the crossing. */
const DOOR_WAIT_LIMIT = 5;

/** Puts the agent back at the threshold, visible and pickable, and drops the failed trip. */
function giveUpOnDoor(agent: Agent, world: World, door: Door) {
  agent.x = door.inside.x;
  agent.y = door.inside.y;
  agent.alpha = 1;
  agent.leaving = false;
  agent.setPlan(world, []);
  agent.say('?', 1.5);
}

/** Walks through a door into the neighbouring room on camera. */
export function headToNextRoom(world: World, door: Door, speedMul = 1): Task {
  return exitThroughDoor(door, speedMul, `Heading to the ${world.room(door.to!.room)?.name ?? 'next room'}`);
}

export function enterThroughDoor(door: Door): Task {
  return {
    activity: 'Arriving',
    interruptible: false,
    transport: true,
    update(agent, world, dt) {
      const physical = door.appearance || door.to ? world.passageDoorFor(door) : undefined;
      if (physical && !world.canAgentCross(agent, door)) {
        world.log(`Access denied: ${agent.character.name} cannot enter through the ${door.id} door in ${agent.room.name}.`, 'warn');
        if (agent.alpha < 1) world.remove(agent, door.id);
        return true;
      }
      if (physical && !physical.passable) return false;
      const total = Math.max(1, distance(door.outside, door.inside));
      const reached = agent.moveToward(door.inside, dt);
      poseInDoorway(agent, door, 'in');
      agent.alpha = Math.min(1, 1 - distance(door.inside, agent) / total);
      return reached;
    },
  };
}

/** Keep north/south doorway movement facing along the door, even when the entry path is diagonal. */
function poseInDoorway(agent: Agent, door: Door, direction: 'in' | 'out') {
  if (door.side !== 'north' && door.side !== 'south') return;
  const awayFromCamera = (door.side === 'north') === (direction === 'out');
  agent.facing = awayFromCamera ? 'back' : 'front';
}

/** Ghosts don't need doors: they fade in or out through the back wall. */
export function phaseThroughWall(direction: 'in' | 'out'): Task {
  let wallY = 0;
  let floorY = 0;
  let path: Point[] = [];
  return {
    activity: direction === 'in' ? 'Phasing in' : 'Phasing through the wall',
    interruptible: false,
    transport: true,
    start(agent, world) {
      const top = agent.room.topFloorY(agent.x) ?? agent.y;
      wallY = top - 3;
      floorY = top + 7;
      path = direction === 'out' ? [{ x: agent.x, y: floorY }, { x: agent.x, y: wallY }] : [{ x: agent.x, y: floorY }];
    },
    update(agent, world, dt) {
      if (!path.length) return true;
      if (agent.moveToward(path[0], dt, 0.6)) path.shift();
      if (direction === 'out' && path.length <= 1) {
        agent.alpha = Math.max(0, (agent.y - wallY) / (floorY - wallY));
        if (!path.length) world.remove(agent, 'wall');
      }
      if (direction === 'in') agent.alpha = Math.min(1, (agent.y - wallY) / (floorY - wallY));
      return path.length === 0;
    },
  };
}

/** Tasks that take the agent out of the facility: through this room's way out, or towards the nearest room with one. */
export function leaveFacility(agent: Agent, world: World, hurry = false): Task[] {
  const { room } = agent;
  const doors = room.outerDoors.filter((door) => room.canReach(agent, door.inside, agent.ghost) && world.canAgentCross(agent, door));
  const elevator = room.elevator && room.canReach(agent, room.elevator.front, agent.ghost);
  const hasExit = !!elevator || doors.length > 0;
  const speed = hurry ? 2.2 : 1;
  agent.leaving = true;


  if (agent.ghost && (chance(0.5) || !hasExit)) {
    return [walkTo(room.randomFloorPoint()), phaseThroughWall('out')];
  }
  if (hurry) {
    // Running away: never stop to wait for the elevator if a door can be reached.
    if (doors.length) {
      const nearest = doors.reduce((best, door) => (distance(door.inside, agent) < distance(best.inside, agent) ? door : best));
      return [exitThroughDoor(nearest, speed)];
    }
    const step = world.doorTowardExit(room, true, agent, true);
    if (step) return [headToNextRoom(world, step, speed)];
  }
  if (!hasExit) {
    const step = world.doorTowardExit(room, false, agent, true);
    if (step) return [headToNextRoom(world, step, speed)];
    agent.leaving = false;
    return [wait(2, 'Waiting for an exit')];
  }
  if (elevator && (!doors.length || chance(0.65))) return [rideElevatorOut()];
  return [exitThroughDoor(pick(doors), speed)];
}
