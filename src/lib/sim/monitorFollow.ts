import { Creature } from './creature.ts';
import type { Room } from './room.ts';
import type { CameraActor, World } from './world.ts';

/** The current camera for an actor, or null while they are off camera. */
export function followCameraRoom(world: World, actor: CameraActor): Room | null {
  if (actor instanceof Creature) return actor.onCamera ? actor.room : null;
  return actor.removed || world.isRiding(actor) ? null : actor.room;
}
