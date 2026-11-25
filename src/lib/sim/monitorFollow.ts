import { Creature } from './creature.ts';
import type { Room } from './room.ts';
import type { CameraActor, World } from './world.ts';

/** The current camera for an actor, or null while they are off camera. Swallowed prey stay with whoever carries them. */
export function followCameraRoom(world: World, actor: CameraActor): Room | null {
  const carrier = actor.vore.inside?.predator;
  if (carrier) return followCameraRoom(world, carrier);
  if (actor instanceof Creature) return actor.onCamera ? actor.room : null;
  return actor.removed || world.isRiding(actor) ? null : actor.room;
}
