import type { Agent, Task } from './agent.ts';
import { containmentTier, type Creature } from './creature.ts';
import type { Door, Point } from './room.ts';
import type { World } from './world.ts';
import { chance, range, weightedPick } from './random.ts';
import { wait, walkTo } from './tasks.ts';
import { exitThroughDoor, leaveFacility } from './transport.ts';
import { wanderDoors } from './routing.ts';

// How staff react to a creature that is loose in their room.

/** Relative weights of each reaction to a newly seen loose creature. Mutable so tests can force one. */
export const CREATURE_REACTIONS = { scared: 0.65, look: 0.2, pet: 0.15 };
/** Chance that a curious look ends with the onlooker getting spooked anyway. */
export const LOOK_STARTLE_CHANCE = 0.25;
/** Chance that a petting attempt goes well, by containment class. */
export const PET_CHANCE = { maximum: 0.2, containment: 0.45, safe: 0.7 };

const FLEE_SPEED = 2.2;
const LOOK_DISTANCE = 36;
const PET_REACH = 14;
const APPROACH_GIVE_UP_SECONDS = 20;

/** Loose creatures each agent has already reacted to while they share a room. */
const sightings = new WeakMap<Agent, Set<Creature>>();

function creatureName(creature: Creature) {
  return creature.character.name;
}

function visibleTo(agent: Agent, creature: Creature) {
  return creature.loose && creature.room === agent.room && creature.alpha >= 1;
}

function canReact(agent: Agent) {
  return !agent.impostor && agent.exposed && !agent.napping && !agent.incapacitated && agent.interruptible;
}

/**
 * Staff notice a loose creature in their room once per sighting (it resets when either leaves).
 * Returns true when the agent's plan was replaced by a reaction.
 */
export function reactToCreatures(agent: Agent, world: World): boolean {
  if (agent.security) return false;
  let seen = sightings.get(agent);
  if (seen) for (const creature of seen) if (!visibleTo(agent, creature)) seen.delete(creature);
  if (agent.impostor || !canReact(agent)) return false;
  const creature = world.creaturesIn(agent.room).find((found) => visibleTo(agent, found) && !seen?.has(found));
  if (!creature) return false;
  if (!seen) sightings.set(agent, seen = new Set());
  seen.add(creature);

  const reaction = weightedPick(Object.entries(CREATURE_REACTIONS).map(([kind, weight]) => ({ kind, weight })))?.kind ?? 'scared';
  if (reaction === 'look' || reaction === 'pet') {
    agent.say('?', 1.5);
    world.log(`${agent.character.name} spotted the loose ${creatureName(creature)} and got curious.`, 'muted');
    agent.setPlan(world, reaction === 'look' ? lookAt(creature) : tryToPet(creature));
  } else {
    scare(agent, world, creature, `${agent.character.name} panicked at the sight of the loose ${creatureName(creature)} in the ${agent.room.name}.`);
  }
  return true;
}

/** Applies the scared status and sends the agent running away from the creature. */
export function scare(agent: Agent, world: World, creature: Creature, message: string) {
  agent.statuses.apply('scared');
  agent.say('!', 2);
  world.log(message, 'warn');
  agent.setPlan(world, flee(agent, world, creature));
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function flee(agent: Agent, world: World, creature: Creature): Task[] {
  const activity = `Fleeing from the ${creatureName(creature)}`;
  const doors = wanderDoors(world, agent).filter((door) => !world.room(door.to!.room)?.cell);
  if (doors.length) {
    const farthest = doors.reduce((best: Door, door) => (distance(door.inside, creature) > distance(best.inside, creature) ? door : best));
    // A creature standing in the doorway blocks that escape route; run out of the facility instead.
    if (distance(farthest.inside, creature) > distance(farthest.inside, agent) || !agent.room.outerDoors.length) {
      return [exitThroughDoor(farthest, FLEE_SPEED, activity)];
    }
  }
  const leaving = leaveFacility(agent, world, true);
  if (agent.leaving) return leaving.map((task) => ({ ...task, activity: task.transport ? activity : task.activity }));
  return cower(agent, creature, activity);
}

/** Nowhere to run: back into the corner farthest from the creature. */
function cower(agent: Agent, creature: Creature, activity: string): Task[] {
  const { room } = agent;
  let best: Point = room.nearestWalkable(agent);
  for (let i = 0; i < 12; i++) {
    const point = room.randomFloorPoint();
    if (distance(point, creature) > distance(best, creature) && room.canReach(agent, point, agent.ghost)) best = point;
  }
  return [
    { ...walkTo(best, activity, FLEE_SPEED), urgent: true },
    { ...watch(creature, range(3, 5), 'Cowering in fear'), urgent: true },
  ];
}

/** Follows a (moving) creature until within `reach`, re-routing as it wanders. */
export function approachCreature(creature: Creature, reach: number, activity: string, speed = 1): Task {
  let path: Point[] = [];
  let reroute = 0;
  let elapsed = 0;
  return {
    activity,
    interruptible: true,
    update(agent, world, dt) {
      if (!visibleTo(agent, creature)) return true;
      elapsed += dt;
      if (distance(agent, creature) <= reach) {
        agent.face(creature);
        return true;
      }
      if (elapsed > APPROACH_GIVE_UP_SECONDS) {
        world.log(`${agent.character.name} could not keep up with the ${creatureName(creature)}.`, 'muted');
        agent.setPlan(world, []);
        return false;
      }
      reroute -= dt;
      if (!path.length || reroute <= 0) {
        reroute = 1;
        const away = distance(agent, creature) || 1;
        const goal = agent.room.nearestWalkable({
          x: creature.x + ((agent.x - creature.x) / away) * reach * 0.8,
          y: creature.y + ((agent.y - creature.y) / away) * reach * 0.8,
        }, agent);
        // Already as close as this floor allows.
        if (distance(agent, goal) < 2) return true;
        path = agent.room.route(agent, goal, agent.ghost) ?? [];
        // Out of reach (e.g. across a barrier): carry on from where they stand.
        if (!path.length) return true;
      }
      if (agent.moveToward(path[0], dt, speed)) path.shift();
      return false;
    },
  };
}

/** Stands still, keeping an eye on the creature while it stays in the room. */
function watch(creature: Creature, seconds: number, activity: string, done?: (agent: Agent, world: World) => void, holdCreature = false): Task {
  let left = seconds;
  return {
    activity,
    interruptible: true,
    start(agent) {
      if (holdCreature && distance(agent, creature) <= PET_REACH * 2) creature.hold(seconds + 0.5, agent);
    },
    update(agent, world, dt) {
      if (!visibleTo(agent, creature)) return true;
      agent.face(creature);
      left -= dt;
      if (left > 0) return false;
      done?.(agent, world);
      return true;
    },
  };
}

function lookAt(creature: Creature): Task[] {
  const name = creatureName(creature);
  return [
    approachCreature(creature, LOOK_DISTANCE, `Creeping closer to the ${name}`),
    watch(creature, range(3, 6), `Watching the ${name}`, (agent, world) => {
      if (chance(LOOK_STARTLE_CHANCE)) scare(agent, world, creature, `The ${name} startled ${agent.character.name}.`);
    }),
  ];
}

function tryToPet(creature: Creature): Task[] {
  const name = creatureName(creature);
  return [
    approachCreature(creature, PET_REACH, `Approaching the ${name}`),
    watch(creature, 2, `Trying to pet the ${name}`, (agent, world) => {
      if (distance(agent, creature) > PET_REACH * 2) {
        world.log(`${agent.character.name} could not get close enough to pet the ${name}.`, 'muted');
      } else if (chance(PET_CHANCE[containmentTier(creature.character.containmentClass)])) {
        agent.say('♥', 2);
        world.log(`${agent.character.name} petted the loose ${name}.`, 'ok');
      } else {
        scare(agent, world, creature, `The ${name} snapped at ${agent.character.name}!`);
      }
    }, true),
  ];
}
