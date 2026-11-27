import { passagePartBounds } from './door.ts';
import type { Rect } from './navMap.ts';
import type { Prop } from './prop.ts';
import { range } from './random.ts';
import type { Room } from './room.ts';
import type { World } from './world.ts';

const SPARK_PAUSE_SECONDS = { min: 1.2, max: 3 };

/** Room lighting and particles emitted by damaged props and door panels. */
export class RoomEffects {
  private readonly sparkDelays = new WeakMap<object, number>();

  update(world: World, dt: number) {
    for (const room of world.rooms) {
      room.updateLights(world.actorsIn(room).length > 0, dt);
      for (const prop of room.props) {
        prop.updateFlicker(dt);
        const breaks = prop.takeBreaks();
        if (breaks) {
          const debris = prop.breakParticles;
          if (debris) {
            for (let i = 0; i < breaks; i++) {
              world.particles.burst(room, debris.set, debris.area, debris.depth, prop, world.time);
            }
          }
        }
        this.updateSparks(world, prop, room, prop.sparkArea, dt, prop.y + prop.h, prop);
      }
      for (const door of room.doors) {
        const art = door.appearance;
        if (!art) continue;
        const bounds = passagePartBounds(door.side, art);
        const state = world.passageDoorFor(door);
        const panel = state?.powered && state.panelBroken ? bounds.panel : null;
        this.updateSparks(world, door, room, panel, dt, bounds.door.y + bounds.door.h);
      }
    }
  }

  private updateSparks(world: World, source: object, room: Room, area: Rect | null, dt: number, depth?: number, emitter?: Prop) {
    if (!area) {
      this.sparkDelays.delete(source);
      return;
    }
    if (!Number.isFinite(dt) || dt < 0) return;
    const remaining = (this.sparkDelays.get(source) ?? 0) - dt;
    if (remaining <= 0) {
      world.particles.burst(room, 'sparks', area, depth, emitter, world.time);
      // Emit at most once per update rather than replaying missed bursts after a long frame.
      this.sparkDelays.set(source, range(SPARK_PAUSE_SECONDS.min, SPARK_PAUSE_SECONDS.max));
    } else {
      this.sparkDelays.set(source, remaining);
    }
  }
}
