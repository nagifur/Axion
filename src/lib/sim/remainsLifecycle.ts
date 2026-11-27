import { Agent } from './agent.ts';
import type { Item } from './item.ts';
import { Remains } from './remains.ts';
import type { Point, Room } from './room.ts';
import { CHARACTER_FRAMES } from './sprites.ts';
import { VORE_TUNING, disposalWait, outcomeFor, type Ingestion, type VoreActor, type VoreOutcome } from './vore.ts';
import type { World } from './world.ts';

/** Owns each pile from creation to restoration, whether it's carried or on a room's floor. */
export class RemainsLifecycle {
  private readonly world: World;
  private readonly remainsOwners = new WeakMap<Remains, { room: Room } | { host: VoreActor }>();
  /** Characters currently reduced to remains; they don't arrive again while in that form. */
  readonly consumed = new Set<string>();

  constructor(world: World) {
    this.world = world;
  }

  afterAbsorption({ prey, predator, type }: Ingestion, outcome: VoreOutcome) {
    const items = prey instanceof Agent ? prey.takeAllItems() : [];
    const remains = new Remains({ actor: prey, type, form: outcome.remains, disposal: outcome.disposal, items, wait: disposalWait() });
    this.retire(prey, remains);
    predator.vore.remains.push(remains);
    this.remainsOwners.set(remains, { host: predator });
  }

  /** The character becomes remains until its form status is removed. */
  private retire(actor: VoreActor, remains: Remains) {
    if (actor instanceof Agent) actor.removed = true;
    else actor.consumed = true;
    this.consumed.add(actor.character.id);
    actor.vore.ownRemains = remains;
    remains.restore = () => this.restore(remains);
  }

  /** Find the pile's current floor, including when its carrier is inside another actor. */
  private remainsPosition(remains: Remains): { room: Room; point: Point } {
    const owner = this.remainsOwners.get(remains);
    if (!owner) throw new Error(`Cannot restore ${remains.name}: remains have no location.`);
    if ('room' in owner) return { room: owner.room, point: owner.room.nearestWalkable(remains) };
    let host = owner.host;
    if (host.vore.ownRemains) return this.remainsPosition(host.vore.ownRemains);
    while (host.vore.inside) host = host.vore.inside.predator;
    return { room: host.room, point: host.room.nearestWalkable(host) };
  }

  private restore(remains: Remains) {
    const { actor } = remains;
    const owner = this.remainsOwners.get(remains);
    if (!owner || actor.vore.ownRemains !== remains) throw new Error(`Cannot restore ${remains.name}: remains are not owned by the actor.`);
    const { room, point } = this.remainsPosition(remains);
    const collection = 'room' in owner ? owner.room.remains : owner.host.vore.remains;
    const index = collection.indexOf(remains);
    if (index < 0) throw new Error(`Cannot restore ${remains.name}: remains are missing from their location.`);
    collection.splice(index, 1);
    this.remainsOwners.delete(remains);
    actor.vore.ownRemains = null;
    this.consumed.delete(actor.character.id);
    if (actor instanceof Agent) {
      actor.removed = false;
      actor.held = false;
      actor.leaving = false;
      actor.room = room;
      actor.x = point.x;
      actor.y = point.y;
      actor.layer = 'room';
      actor.alpha = 1;
      actor.enteredRoomAt = this.world.time;
      for (const item of remains.items.splice(0)) actor.receiveStoredItem(item);
      this.world.agents.push(actor);
    } else {
      actor.consumed = false;
      actor.reposition(room, point);
    }
    this.world.log(`${actor.character.name} returned to their normal form in the ${room.name}.`, 'ok');
  }

  /** Turns someone on the floor into a pile of `form` at their feet, with their belongings beside it. */
  collapse(actor: VoreActor, form: string) {
    const { world } = this;
    const { room } = actor;
    if (actor instanceof Agent) {
      actor.finishDeath(world);
      if (actor.security && world.elevatorFor(actor.security.post)) world.staffSecurityPost(actor.security.post);
      world.agents = world.agents.filter((other) => other !== actor);
    }
    const items = actor instanceof Agent ? actor.takeAllItems() : [];
    const remains = new Remains({ actor, type: null, form, disposal: outcomeFor(null, form).disposal, items, wait: 0 });
    this.retire(actor, remains);
    const point = room.nearestWalkable(actor);
    remains.x = point.x;
    remains.y = point.y;
    room.remains.push(remains);
    this.remainsOwners.set(remains, { room });
    this.scatter(room, point, remains.items.splice(0));
    if (actor instanceof Agent) world.hooks.removed?.(actor);
    world.log(`${actor.character.name} turned into ${remains.label.toLowerCase()} in the ${room.name}.`, 'warn');
  }

  /**
   * Shoots the outcome's release particles forward from the host for any spurt that falls between
   * `from` and `to` seconds into its disposal activity. Long frames emit at most one spurt.
   */
  disposalProgress(host: VoreActor, remains: Remains, from: number, to: number) {
    const { release, seconds } = remains.disposal;
    if (!release || release.every <= 0) return;
    const start = seconds - release.seconds;
    const spurts = Math.max(1, Math.ceil(release.seconds / release.every));
    const done = (t: number) => t < start ? 0 : Math.min(spurts, Math.floor((t - start) / release.every) + 1);
    if (done(to) <= done(from)) return;
    const { origin, direction, depth, height } = this.releasePoint(host, release);
    const size = Math.max(1, height * 0.06);
    this.world.particles.burst(host.room, release.set, {
      x: origin.x - size / 2, y: origin.y - size / 2, w: size, h: size, floorY: host.y, direction,
    }, depth);
  }

  /** Where on the host's body a release comes out, which way it heads, and its draw depth. */
  private releasePoint(host: VoreActor, release: Pick<NonNullable<VoreOutcome['disposal']['release']>, 'from' | 'height'> = {}) {
    const { x, y } = host;
    const height = CHARACTER_FRAMES.idleRight1.h * host.character.scale;
    const back = release.from === 'back';
    const forward = host.facing === 'left' ? -1 : host.facing === 'right' ? 1 : 0;
    const direction = (back ? -forward : forward) as -1 | 0 | 1;
    const origin = { x: x + direction * height * 0.12, y: y - height * (release.height ?? 0.4) };
    // Sideways sprites show both sides; otherwise the emitting side is drawn behind unless it faces the camera.
    const visible = direction !== 0 || (host.facing === 'back') === back;
    return { origin, direction, depth: y + (visible ? 0.5 : -0.5), height };
  }

  /** The pile lands at the host's feet (or is tossed from its release point), with everything the prey was holding scattered beside it. */
  drop(host: VoreActor, remains: Remains, tossed = false) {
    const { room } = host;
    const point = room.nearestWalkable(host);
    host.vore.remains.splice(host.vore.remains.indexOf(remains), 1);
    remains.x = point.x;
    remains.y = point.y;
    const { release, toss } = remains.disposal;
    if (tossed && toss) {
      const { origin, direction, depth } = this.releasePoint(host, release);
      const start = { x: origin.x, y: point.y };
      if (room.isWalkable(start)) remains.x = start.x;
      remains.toss(point.y - origin.y, direction * toss.speed, toss.up, toss.bounce, depth);
    }
    room.remains.push(remains);
    this.remainsOwners.set(remains, { room });
    this.scatter(room, point, remains.items.splice(0));
    this.world.log(`${host.character.name} got rid of ${remains.name}'s remains in the ${room.name}.`, 'muted');
  }

  private scatter(room: Room, pile: Point, items: Item[]) {
    const spread = VORE_TUNING.itemSpread;
    items.forEach((item, index) => {
      const side = index % 2 === 0 ? 1 : -1;
      const wanted = { x: pile.x + side * (spread.first + Math.floor(index / 2) * spread.step), y: pile.y + spread.depth };
      const spot = room.nearestWalkable(wanted, pile);
      item.x = Math.round(spot.x - item.w / 2);
      item.y = Math.round(spot.y - item.h);
      room.items.push(item);
    });
  }
}
