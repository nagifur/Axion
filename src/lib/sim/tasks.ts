import type { Agent, Task } from './agent.ts';
import type { Facing, Point, Spot } from './room.ts';
import type { Prop } from './prop.ts';
import type { World } from './world.ts';
import type { SchedulePeriod } from './schedule.ts';
import { GRAVITY } from './particles.ts';
import { chance, range } from './random.ts';

// General-purpose tasks: walking, waiting, resting, napping, falling and tripping.

/** Radius around their feet in which a trip can hit a prop. */
export const TRIP_PROP_REACH = 12;
/** Chance that a trip or fall breaks the nearest eligible prop. */
export const TRIP_PROP_BREAK_CHANCE = 0.1;
/** Base chance per second of tripping for clumsy characters, and extra chance per unit of room darkness. */
const TRIP_CHANCE = { clumsy: 0.006, darkness: 0.012 };
const FALL_LANDING_DEPTH = 24;

export function walkTo(target: Point, activity = 'Walking', speedMul = 1): Task {
  let path: Point[] = [];
  return {
    activity,
    interruptible: true,
    start(agent, world) {
      path = agent.room.route(agent, target, agent.ghost);
    },
    update(agent, world, dt) {
      if (!path.length) return true;
      const tripChance = (agent.character.behavior.clumsy ? TRIP_CHANCE.clumsy : 0) + agent.room.darkness * TRIP_CHANCE.darkness;
      if (tripChance > 0 && !agent.impostor && chance(dt * tripChance)) {
        agent.interrupt(world, trip());
        return false;
      }
      if (agent.moveToward(path[0], dt, speedMul)) path.shift();
      return path.length === 0;
    },
  };
}

export function wait(seconds: number, activity: string, facing?: Facing): Task {
  let left = seconds;
  return {
    activity,
    interruptible: true,
    start(agent) {
      if (facing) agent.facing = facing;
    },
    update(_agent, _world, dt) {
      left -= dt;
      return left <= 0;
    },
  };
}

export function nap(seconds: number, facing: Facing): Task {
  let left = seconds;
  return {
    activity: 'Napping',
    interruptible: false,
    start(agent, world) {
      agent.facing = facing;
      agent.napping = true;
      agent.bubble = 'zZ';
      world.log(`${agent.character.name} dozed off in the ${agent.room.name}.`, 'muted');
    },
    update(_agent, _world, dt) {
      left -= dt;
      return left <= 0;
    },
    end(agent) {
      agent.napping = false;
      agent.bubble = null;
    },
  };
}

export function fall(): Task {
  let velocity = 0;
  let landingY: number | undefined;
  return {
    activity: 'Falling',
    interruptible: false,
    falling: true,
    start(agent) {
      agent.say('!', 1.3);
    },
    update(agent, world, dt) {
      const seconds = Math.max(0, dt);
      const nextY = agent.y + velocity * seconds + 0.5 * GRAVITY * seconds * seconds;
      velocity += GRAVITY * seconds;
      // Sweep every crossed pixel so even a long frame cannot skip a thin green floor.
      for (let y = Math.round(agent.y); y <= Math.min(Math.round(nextY), agent.room.height - 1); y++) {
        if (!agent.room.isFloor(agent.x, y)) continue;
        if (landingY === undefined) {
          let bottom = y;
          while (bottom < Math.min(y + FALL_LANDING_DEPTH, agent.room.height - 1)
            && agent.room.isFloor(agent.x, bottom + 1)) bottom++;
          landingY = Math.floor(range(y, bottom + 1));
        }
        if (y < landingY) continue;
        agent.y = y;
        agent.setPlan(world, []);
        agent.interrupt(world, trip('fall'));
        return false;
      }
      agent.y = nextY;
      if (agent.y - agent.height > agent.room.height) {
        const point = agent.room.nearestWalkable({ x: agent.x, y: agent.room.height - 1 });
        agent.x = point.x;
        agent.y = point.y;
        world.log(`${agent.character.name} fell out of view and returned to nearby floor in the ${agent.room.name}.`, 'muted');
        agent.setPlan(world, []);
        agent.interrupt(world, trip('fall'));
      }
      return false;
    },
  };
}

export function trip(cause: 'trip' | 'fall' = 'trip'): Task {
  let left = 1.3;
  let attemptedBreak = false;
  return {
    activity: 'Picking themselves up',
    interruptible: false,
    tripping: true,
    start(agent, world) {
      agent.shake = 0.5;
      agent.say('!', 1.3);
      world.log(`${agent.character.name} ${cause === 'fall' ? 'fell and hit the floor' : 'tripped over their own feet'} in the ${agent.room.name}.`, 'muted');
      world.achieve('watch-your-step', agent.room);
      if (!attemptedBreak) {
        attemptedBreak = true;
        breakNearbyProp(agent, world, cause);
      }
    },
    update(_agent, _world, dt) {
      left -= dt;
      return left <= 0;
    },
  };
}

function breakNearbyProp(agent: Agent, world: World, cause: 'trip' | 'fall') {
  let nearest: Prop | undefined;
  let nearestDistance = Infinity;
  for (const prop of agent.room.props) {
    if (!prop.breakable || prop.broken) continue;
    const { x, y, w, h } = prop.impactBounds;
    const dx = Math.max(x - agent.x, 0, agent.x - (x + w));
    const dy = Math.max(y - agent.y, 0, agent.y - (y + h));
    const distance = Math.hypot(dx, dy);
    if (distance <= TRIP_PROP_REACH && distance < nearestDistance) {
      nearest = prop;
      nearestDistance = distance;
    }
  }
  if (nearest && chance(TRIP_PROP_BREAK_CHANCE) && nearest.break()) {
    reportPropBreak(agent, world, nearest, cause);
  }
}

export function rest(agent: Agent, spot: Spot, world: World, period: SchedulePeriod): Task {
  const nightOwl = world.isNight() ? 1.4 : 1;
  const sleeping = chance(agent.character.behavior.napChance * nightOwl * (period === 'work' ? 0.15 : 1));
  const onChair = spot.kind === 'chair';
  const activity = period === 'lunch' ? 'Having lunch'
    : period === 'work' && onChair ? 'Working at the table'
    : period === 'free' && onChair ? 'Relaxing at the table' : 'Taking a break';
  const task = sleeping ? nap(range(25, 50), spot.facing)
    : wait(period === 'work' ? range(30, 60) : range(8, 18), activity, spot.facing);
  let attempted = false;
  let started = false;
  return {
    ...task,
    sitting: true,
    start(agent, world) {
      if (!attempted) {
        attempted = true;
        if (!spot.prop.broken) breakPropOnUse(agent, world, spot.prop);
      }
      if (!spot.prop.broken) {
        started = true;
        task.start?.(agent, world);
      }
    },
    update(agent, world, dt) {
      return spot.prop.broken || task.update(agent, world, dt);
    },
    end(agent, world) {
      if (started) task.end?.(agent, world);
      if (spot.prop.broken && agent.spot === spot) agent.spot = undefined;
    },
  };
}

export function breakPropOnUse(agent: Agent, world: World, prop: Prop): boolean {
  if (!prop.breakOnUse()) return false;
  reportPropBreak(agent, world, prop);
  return true;
}

function reportPropBreak(agent: Agent, world: World, prop: Prop, cause?: 'trip' | 'fall') {
  agent.say('!', 1.5);
  const name = prop.type.replaceAll('_', ' ');
  const message = cause
    ? `${agent.character.name} broke the ${name} when they ${cause === 'fall' ? 'fell' : 'tripped'} in the ${agent.room.name}.`
    : `${agent.character.name}'s ${name} broke in the ${agent.room.name}.`;
  world.log(message, 'warn');
}
