import type { Task } from './agent.ts';
import { distance } from './navMap.ts';
import type { Point } from './room.ts';
import { wait } from './tasks.ts';
import { VORE_TUNING, type VoreActor, type VoreType } from './vore.ts';

// What an agent does once VoreSystem has picked someone for it to swallow.

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
          agent.setPlan(world, [{ ...wait(VORE_TUNING.gulpSeconds, `Swallowing ${prey.character.name}`), interruptible: false }]);
          return false;
        }
        return true;
      }
      reroute -= dt;
      if (!path.length || reroute <= 0) {
        reroute = VORE_TUNING.rerouteSeconds.agent;
        path = agent.room.route(agent, { x: prey.x, y: prey.y }, agent.ghost) ?? [];
        if (!path.length) return true;
      }
      agent.moveAlongPath(path, dt, VORE_TUNING.stalkSpeed);
      return false;
    },
  };
}
