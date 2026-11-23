import type { Agent, Task } from './agent.ts';
import type { Creature } from './creature.ts';
import { approachCreature } from './creatureReactions.ts';
import { distance } from './navMap.ts';
import type { Door, Room } from './room.ts';
import { stepTowardRoom } from './routing.ts';
import { scheduleFor } from './schedule.ts';
import { wait, walkTo } from './tasks.ts';
import { exitThroughDoor, rideElevatorOut } from './transport.ts';
import type { World } from './world.ts';

export interface SecurityDuty {
  readonly post: Room;
  target?: Creature;
  relieved: boolean;
}

const CAPTURE_REACH = 14;
const PURSUIT_SPEED = 2.4;

export function postPoint(room: Room) {
  const lift = room.elevator;
  if (!lift) throw new Error(`Cannot post elevator security in ${room.id}: no elevator.`);
  const beside = room.nearestWalkable({ x: lift.front.x + lift.w / 2 + 8, y: lift.front.y }, lift.front);
  return room.canReach(lift.front, beside) ? beside : lift.front;
}

function travel(step: Door | Room, activity: string, speed = 1): Task {
  return 'inside' in step ? exitThroughDoor(step, speed, activity) : rideElevatorOut(step);
}

function pursue(agent: Agent, world: World, creature: Creature): Task | undefined {
  const activity = `Pursuing ${creature.character.name}`;
  if (agent.room === creature.room && agent.room.canReach(agent, creature)) {
    return approachCreature(creature, CAPTURE_REACH, activity, PURSUIT_SPEED);
  }
  const step = stepTowardRoom(world, agent, creature.room, creature, true);
  return step && travel(step, activity, PURSUIT_SPEED);
}

function escortHome(agent: Agent, world: World, creature: Creature): Task {
  const step = stepTowardRoom(world, agent, creature.home, undefined, true);
  return step ? travel(step, `Escorting ${creature.character.name} to ${creature.home.name}`)
    : wait(2, `Waiting for a passage to ${creature.home.name}`);
}

/** Pick up calls at the post. Keep the claim through door transitions and finish a call before changing shift. */
export function planSecurity(agent: Agent, world: World, duty: SecurityDuty): Task[] {
  const { post, target } = duty;
  if (duty.relieved) return [rideElevatorOut()];

  if (target?.escort === agent) {
    if (agent.room !== target.home) return [escortHome(agent, world, target)];
    world.recontain(target);
    duty.target = undefined;
  } else if (target) {
    if (target.loose && target.room.level === post.level) {
      if (target.alpha < 1) return [wait(0.5, `Tracking ${target.character.name}`)];
      if (target.room === agent.room && distance(agent, target) <= CAPTURE_REACH && agent.room.canReach(agent, target)) {
        target.escort = agent;
        world.log(`${agent.character.name} caught ${target.character.name} in the ${agent.room.name}.`, 'ok');
        return [escortHome(agent, world, target)];
      }
      const chase = pursue(agent, world, target);
      if (chase) return [chase];
    }
    duty.target = undefined;
  }

  // Open calls outrank the walk back and the shift change: guards take the next loose creature wherever they are.
  const call = dispatch(agent, world, duty);
  if (call) return [call];

  const at = postPoint(post);
  if (agent.room !== post || !post.canReach(agent, at)) {
    const step = stepTowardRoom(world, agent, post, at);
    return [step ? travel(step, 'Returning to the elevator post') : wait(2, 'Waiting for a route to the elevator post')];
  }
  if (distance(agent, at) > 1) return [walkTo(at, 'Returning to the elevator post')];
  if (scheduleFor(agent.character, world.now()) !== 'work') {
    duty.relieved = true;
    agent.leaving = true;
    world.staffSecurityPost(post);
    world.log(`${agent.character.name} was relieved at the ${post.name} elevator.`, 'muted');
    return [rideElevatorOut()];
  }
  return [wait(1, 'Guarding the elevator', 'front')];
}

function dispatch(agent: Agent, world: World, duty: SecurityDuty): Task | undefined {
  for (const creature of world.creatures) {
    if (!creature.loose || creature.alpha < 1 || creature.room.level !== duty.post.level ||
        world.agents.some((other) => other.security?.target === creature)) continue;
    const chase = pursue(agent, world, creature);
    if (!chase) continue;
    duty.target = creature;
    agent.say('!');
    world.log(`${agent.character.name} dispatched to the ${creature.room.name} for ${creature.character.name}.`, 'warn');
    return chase;
  }
}
