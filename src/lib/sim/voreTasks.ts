import type { Task } from './agent.ts';
import { distance } from './navMap.ts';
import type { Point } from './room.ts';
import { wait } from './tasks.ts';
import { VORE_TUNING, type VoreActor, type VoreType } from './vore.ts';

// What an agent does once VoreSystem has picked someone for it to swallow.

/** Walking speed multiplier while closing in. */
const STALK_SPEED = 1.8;
/** Seconds between fresh routes, as the target keeps moving. */
const REROUTE_SECONDS = 1;
/** Seconds the predator spends gulping before it goes back to its day. */
const GULP_SECONDS = 2;

/** Follows `prey` until within reach, then swallows them. Gives up after a while or once they can't be had. */
export function stalk(prey: VoreActor, type: VoreType): Task {
  let path: Point[] = [];
  let reroute = 0;
  let elapsed = 0;
  return {
    activity: `Stalking ${prey.character.name}`,
    interruptible: false,
    update(agent, world, dt) {
      elapsed += dt;
      if (elapsed > VORE_TUNING.huntTimeout || !world.vore.eligible(agent, prey)) return true;
      if (distance(agent, prey) <= VORE_TUNING.reach) {
        agent.face(prey);
        if (world.vore.swallow(agent, prey, type)) {
          agent.setPlan(world, [{ ...wait(GULP_SECONDS, `Swallowing ${prey.character.name}`), interruptible: false }]);
          return false;
        }
        return true;
      }
      reroute -= dt;
      if (!path.length || reroute <= 0) {
        reroute = REROUTE_SECONDS;
        path = agent.room.route(agent, { x: prey.x, y: prey.y }, agent.ghost) ?? [];
        if (!path.length) return true;
      }
      agent.moveAlongPath(path, dt, STALK_SPEED);
      return false;
    },
  };
}
