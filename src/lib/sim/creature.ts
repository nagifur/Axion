import { chance, maybePick, pick, range } from './random.ts';
import type { SimCreature } from './roster.ts';
import type { Door, Facing, Point, Room } from './room.ts';
import type { World } from './world.ts';
import { distance } from './navMap.ts';
import { IDLE_CYCLES, IDLE_FRAME_SECONDS, WALK_CYCLES, WALK_STRIDE } from './sprites.ts';
import type { Agent } from './agent.ts';

type Plan =
  | { action: 'rest' | 'watch'; remaining: number }
  | { action: 'pace'; path: Point[] }
  /** Dashes to a door, waits briefly if it is too far closed, then slips through it. */
  | { action: 'escape'; door: Door; path: Point[]; waited: number; crossing: boolean }
  /** Fades in from the doorway it arrived through. */
  | { action: 'enter'; door: Door };

const CONTAINED_LABELS = { rest: 'Resting', watch: 'Watching the cell', pace: 'Pacing the cell' };
const LOOSE_LABELS = { rest: 'Lurking', watch: 'Looking around', pace: 'Prowling' };
const PACE_SPEED = 22;
const DASH_SPEED = 60;

/** Chance of making a break for it each time its cell door swings fully open, by containment class. */
export const ESCAPE_CHANCE = { maximum: 0.4, containment: 0.06, safe: 0.03 };
/** Once out, chance of going for each door seen swinging fully open. */
const LOOSE_NOTICE_CHANCE = 0.6;
/** Once out, chance of heading for a passable door whenever it picks something new to do. */
const ROAM_CHANCE = 0.35;
/** A door still at least this open can be squeezed through. */
const SQUEEZE_OPENING = 0.5;
/** Seconds spent at a door that closed in its face before giving up. */
const DOOR_WAIT_SECONDS = 2;

export type ContainmentTier = keyof typeof ESCAPE_CHANCE;

/** Maximum Containment (Class M), Safe (Class S), and everything else as Containment (Class C). */
export function containmentTier(containmentClass: string): ContainmentTier {
  const name = containmentClass.trim().toLowerCase().replace(/^class\s+/, '');
  if (name === 'm' || name.startsWith('maximum')) return 'maximum';
  if (name === 's' || name.startsWith('safe')) return 'safe';
  return 'containment';
}

/** Maximum Containment (Class M) creatures try far more often than Containment (C) or Safe (S) ones. */
export function escapeChance(containmentClass: string): number {
  return ESCAPE_CHANCE[containmentTier(containmentClass)];
}

export class Creature {
  readonly character: SimCreature;
  /** The cell the creature is assigned to; it stays reserved while the creature is out. */
  readonly home: Room;
  /** Where the creature is now: its cell, or wherever it roamed to after a breach. */
  room: Room;
  x: number;
  y: number;
  facing: Facing = 'front';
  alpha = 1;
  /** A disguised resident keeps its cell reservation but is not present on this camera. */
  away = false;
  /** Fled off camera through a way out of the facility; only `World.recontain` brings it back. */
  escaped = false;
  escort?: Agent;
  private plan: Plan = { action: 'watch', remaining: range(1, 5) };
  private elapsed = 0;
  private distance = 0;
  private walking = false;
  private layout: Room['props'];
  /** Doors already seen standing fully open, so each opening is only considered once. */
  private readonly noticed = new Set<Door>();

  constructor(character: SimCreature, room: Room) {
    this.character = character;
    this.home = room;
    this.room = room;
    this.layout = room.props;
    const point = room.randomFloorPoint();
    if (!room.isWalkable(point)) throw new Error(`${room.id}: no walkable floor for ${character.name}.`);
    this.x = point.x;
    this.y = point.y;
  }

  /** In its own cell (possibly on its way out of the door). */
  get contained() {
    return !this.escort && !this.escaped && this.room === this.home;
  }

  /** Physically on some camera: not disguised as staff and not gone from the facility. */
  get onCamera() {
    return !this.away && !this.escaped;
  }

  get loose() {
    return this.onCamera && !this.contained && !this.escort;
  }

  get escaping() {
    return this.plan.action === 'escape' || this.plan.action === 'enter';
  }

  get activity() {
    if (this.away) return 'Away from cell';
    if (this.escaped) return 'Escaped the facility';
    if (this.escort) return `Being escorted to ${this.home.name}`;
    if (this.plan.action === 'escape') return this.contained ? 'Escaping the cell' : 'Slipping through a door';
    if (this.plan.action === 'enter') return 'Slipping through a door';
    return (this.contained ? CONTAINED_LABELS : LOOSE_LABELS)[this.plan.action];
  }

  get frame() {
    const cycle = (this.walking ? WALK_CYCLES : IDLE_CYCLES)[this.facing];
    const phase = this.walking ? this.distance / WALK_STRIDE : this.elapsed / IDLE_FRAME_SECONDS;
    return { name: cycle[Math.floor(phase) % cycle.length], flip: this.facing === 'left' };
  }

  /** Puts the creature back in its cell, e.g. when security recaptures it. */
  returnHome(world: World) {
    const delivered = this.escort && this.room === this.home;
    this.releaseEscort();
    this.room = this.home;
    this.layout = this.home.props;
    const point = delivered ? this.home.nearestWalkable(this) : this.home.randomFloorPoint();
    this.x = point.x;
    this.y = point.y;
    this.alpha = 1;
    this.escaped = false;
    this.walking = false;
    this.noticed.clear();
    // The guard's open door is not a new opportunity to escape.
    for (const door of this.home.doors) if (world.passageDoorFor(door)?.open === 1) this.noticed.add(door);
    this.plan = { action: 'watch', remaining: range(2, 6) };
  }

  releaseEscort() {
    if (!this.escort) return;
    if (this.escort.security?.target === this) this.escort.security.target = undefined;
    this.escort = undefined;
    const point = this.room.nearestWalkable(this);
    this.x = point.x;
    this.y = point.y;
    this.alpha = 1;
    this.walking = false;
    this.plan = { action: 'watch', remaining: 2 };
  }

  /** Stops to eye someone up close (e.g. a staff member reaching out to pet it). Never interrupts a dash for a door. */
  hold(seconds: number, toward: Point) {
    if (this.escort || this.escaping) return;
    this.walking = false;
    this.plan = { action: 'watch', remaining: seconds };
    if (Math.abs(toward.x - this.x) >= 2) this.facing = toward.x < this.x ? 'left' : 'right';
  }

  /** Never into a cell (its own included: getting back in is security's job), nor somewhere it can't reach. */
  private canUse(world: World, door: Door) {
    if (door.cell) return false;
    const destination = door.to && world.room(door.to.room);
    if (door.to && (!destination || destination.cell)) return false;
    return this.room.canReach(this, door.inside);
  }

  private passable(world: World, door: Door) {
    const physical = world.passageDoorFor(door);
    return !physical || (!physical.broken && physical.open >= SQUEEZE_OPENING);
  }

  private headFor(door: Door): Plan | undefined {
    const path = this.room.route(this, door.inside);
    return path ? { action: 'escape', door, path, waited: 0, crossing: false } : undefined;
  }

  private nextPlan(world: World): Plan {
    if (!this.contained && chance(ROAM_CHANCE)) {
      const door = maybePick(this.room.doors.filter((door) => this.passable(world, door) && this.canUse(world, door)));
      const plan = door && this.headFor(door);
      if (plan) return plan;
    }
    const action = pick(['rest', 'watch', 'pace'] as const);
    if (action === 'rest') return { action, remaining: range(5, 14) };
    if (action === 'pace') {
      const path = this.room.route(this, this.room.randomFloorPoint(undefined, this));
      if (path?.length) return { action, path };
    }
    this.facing = pick(['left', 'right', 'front', 'back'] as const);
    return { action: 'watch', remaining: range(2, 6) };
  }

  /** Watches the room's doors; a door swinging fully open is a chance to get out. */
  private noticeDoors(world: World) {
    for (const door of this.room.doors) {
      if (world.passageDoorFor(door)?.open !== 1) {
        this.noticed.delete(door);
        continue;
      }
      if (this.noticed.has(door)) continue;
      this.noticed.add(door);
      if (this.escaping || !this.canUse(world, door)) continue;
      if (!chance(this.contained ? escapeChance(this.character.containmentClass) : LOOSE_NOTICE_CHANCE)) continue;
      const plan = this.headFor(door);
      if (!plan) continue;
      this.plan = plan;
      if (this.contained) world.log(`Warning: ${this.character.name} is moving toward the open door of ${this.room.name}.`, 'warn');
    }
  }

  private face(dx: number, dy: number) {
    this.facing = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'back' : 'front');
  }

  /** Walks along `path` over the floor; false if something now stands in the way. */
  private follow(path: Point[], speed: number, dt: number): boolean {
    let budget = dt * speed;
    while (path.length && budget > 0) {
      const dx = path[0].x - this.x;
      const dy = path[0].y - this.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const step = Math.min(budget, length);
        const next = { x: this.x + dx * step / length, y: this.y + dy * step / length };
        if (!this.room.isWalkable(next)) return false;
        this.face(dx, dy);
        this.x = next.x;
        this.y = next.y;
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
  private stepToward(target: Point, speed: number, dt: number): boolean {
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const length = Math.hypot(dx, dy);
    const step = Math.min(length, speed * dt);
    if (step > 0) {
      this.face(dx, dy);
      this.x += dx * step / length;
      this.y += dy * step / length;
      this.distance += step;
      this.walking = true;
    }
    return step >= length;
  }

  /** Reached the far side of a doorway: into the linked room, or out of the facility altogether. */
  private cross(world: World, door: Door) {
    const from = this.room;
    const { name, nickname } = this.character;
    const room = door.to && world.room(door.to.room);
    const arrival = room?.doors.find((other) => other.id === door.to!.door);
    if (!room || !arrival) {
      this.escaped = true;
      this.walking = false;
      this.plan = { action: 'watch', remaining: 0 };
      world.log(`Containment breach: ${name} "${nickname}" fled the facility through the ${door.id} door in the ${from.name}. Security team notified.`, 'alert');
      return;
    }
    this.room = room;
    this.layout = room.props;
    this.x = arrival.outside.x;
    this.y = arrival.outside.y;
    this.alpha = 0;
    this.noticed.clear();
    this.plan = { action: 'enter', door: arrival };
    if (from === this.home) world.log(`Containment breach: ${name} "${nickname}" escaped ${from.name} into the ${room.name}! Security team notified.`, 'alert');
    else world.log(`${name} "${nickname}" slipped into the ${room.name}.`, 'warn');
  }

  update(world: World, dt: number) {
    if (!this.onCamera || !dt) return;
    this.elapsed += dt;
    this.walking = false;
    if (this.escort) {
      const guard = this.escort;
      this.room = guard.room;
      // Walk alongside on open floor; share the guard's path through narrow thresholds.
      const beside = { x: guard.x - 14, y: guard.y + 2 };
      const point = guard.alpha === 1 && this.room.isWalkable(beside) && this.room.sameFloorArea(guard, beside) ? beside : guard;
      this.x = point.x;
      this.y = point.y;
      this.alpha = guard.alpha;
      this.facing = guard.facing;
      this.walking = guard.moving;
      this.distance = guard.walkDistance;
      return;
    }
    // Live prop edits invalidate both the path and potentially the current standing point.
    if (this.layout !== this.room.props && !this.escaping) {
      this.layout = this.room.props;
      if (!this.room.isWalkable(this)) {
        const point = this.room.nearestWalkable(this);
        this.x = point.x;
        this.y = point.y;
      }
      this.plan = this.nextPlan(world);
    }
    this.noticeDoors(world);
    const plan = this.plan;

    if ('remaining' in plan) {
      plan.remaining -= dt;
      if (plan.remaining <= 0) this.plan = this.nextPlan(world);
      return;
    }

    if (plan.action === 'pace') {
      if (!this.follow(plan.path, PACE_SPEED, dt) || !plan.path.length) this.plan = { action: 'watch', remaining: range(1, 4) };
      return;
    }

    if (plan.action === 'enter') {
      const { door } = plan;
      const total = Math.max(1, distance(door.outside, door.inside));
      const reached = this.stepToward(door.inside, DASH_SPEED, dt);
      this.alpha = Math.min(1, 1 - distance(door.inside, this) / total);
      if (reached) {
        this.alpha = 1;
        this.layout = this.room.props;
        this.plan = { action: 'watch', remaining: range(1, 3) };
      }
      return;
    }

    const { door } = plan;
    if (!plan.crossing) {
      if (plan.path.length) {
        if (!this.follow(plan.path, DASH_SPEED, dt)) this.plan = { action: 'watch', remaining: range(1, 4) };
        return;
      }
      if (!this.passable(world, door)) {
        this.face(door.outside.x - this.x, door.outside.y - this.y);
        plan.waited += dt;
        if (plan.waited >= DOOR_WAIT_SECONDS) {
          this.plan = { action: 'watch', remaining: range(2, 5) };
          if (this.contained) world.log(`${this.character.name}'s cell door in ${this.room.name} closed just in time.`, 'ok');
        }
        return;
      }
      plan.crossing = true;
    }
    const total = Math.max(1, distance(door.outside, door.inside));
    const reached = this.stepToward(door.outside, DASH_SPEED, dt);
    this.alpha = Math.max(0, distance(door.outside, this) / total);
    if (reached) this.cross(world, door);
  }
}
