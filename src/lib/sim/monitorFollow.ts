import { Creature } from './creature.ts';
import type { Room } from './room.ts';
import type { CameraActor, World } from './world.ts';

/** The current camera for an actor or their remains, or null while they are off camera. */
export function followCameraRoom(world: World, actor: CameraActor): Room | null {
  const carrier = actor.vore.inside?.predator;
  if (carrier) return followCameraRoom(world, carrier);
  if (actor instanceof Creature ? actor.consumed : actor.removed) {
    const host = [...world.everyone(), ...world.creatures]
      .find((other) => other.vore.remains.some((remains) => remains.actor === actor));
    if (host) return followCameraRoom(world, host);
    return world.rooms.find((room) => room.remains.some((remains) => remains.actor === actor)) ?? null;
  }
  if (actor instanceof Creature) return actor.onCamera ? actor.room : null;
  return world.isRiding(actor) ? null : actor.room;
}
