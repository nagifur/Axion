import type { Creature } from './creature.ts';
import type { Point } from './room.ts';
import { IDLE_CYCLES, IDLE_FRAME_SECONDS, WALK_CYCLES, WALK_STRIDE } from './sprites.ts';

/** Floor movement and the animation phase accumulated while moving or idling. */
export class CreatureMotion {
  elapsed = 0;
  distance = 0;
  walking = false;

  frame(creature: Creature, falling: boolean) {
    const { facing } = creature;
    if (creature.held || falling || creature.statuses.blocksActions) {
      const cycle = IDLE_CYCLES[facing];
      const index = creature.held || falling || creature.incapacitated ? 0 : Math.floor(this.elapsed / IDLE_FRAME_SECONDS) % cycle.length;
      return { name: cycle[index], flip: facing === 'left' };
    }
    const cycle = (this.walking ? WALK_CYCLES : IDLE_CYCLES)[facing];
    const phase = this.walking ? this.distance / WALK_STRIDE : this.elapsed / IDLE_FRAME_SECONDS;
    return { name: cycle[Math.floor(phase) % cycle.length], flip: facing === 'left' };
  }

  face(creature: Creature, dx: number, dy: number) {
    creature.facing = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'back' : 'front');
  }

  /** Walks along `path` over the floor; false if something now stands in the way. */
  follow(creature: Creature, path: Point[], speed: number, dt: number): boolean {
    let budget = dt * speed;
    while (path.length && budget > 0) {
      const dx = path[0].x - creature.x;
      const dy = path[0].y - creature.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const step = Math.min(budget, length);
        const next = { x: creature.x + dx * step / length, y: creature.y + dy * step / length };
        if (!creature.room.isWalkable(next)) return false;
        this.face(creature, dx, dy);
        creature.x = next.x;
        creature.y = next.y;
        this.distance += step;
        this.walking = true;
        budget -= step;
        if (step < length) return true;
      }
      path.shift();
    }
    return true;
  }

  /** Moves straight toward a doorway point, which may lie off the walkable floor. */
  stepToward(creature: Creature, target: Point, speed: number, dt: number): boolean {
    const dx = target.x - creature.x;
    const dy = target.y - creature.y;
    const length = Math.hypot(dx, dy);
    const step = Math.min(length, speed * dt);
    if (step > 0) {
      this.face(creature, dx, dy);
      creature.x += dx * step / length;
      creature.y += dy * step / length;
      this.distance += step;
      this.walking = true;
    }
    return step >= length;
  }
}
