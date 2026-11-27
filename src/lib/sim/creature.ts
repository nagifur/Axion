import { chance, pick, range } from './random.ts';
import type { SimCreature } from './roster.ts';
import type { Door, Facing, Point, Room } from './room.ts';
import type { World } from './world.ts';
import { distance } from './navMap.ts';
import { CHARACTER_FRAMES } from './sprites.ts';
import { CreatureMotion } from './creatureMotion.ts';
import type { Agent } from './agent.ts';
import { fallMotion, wait } from './tasks.ts';
import { createLiveStats, hasMagic, recoverStamina, spendStamina, type LiveStats } from './stats.ts';
import { StatusEffects } from './statusEffects.ts';
import { VORE_TUNING, VoreState, insideActivity, type VoreActor, type VoreType } from './vore.ts';
import { canContinueDisposal, DISPOSAL_TRAVEL_ACTIVITY } from './remainsDisposal.ts';
import { canUseDoor, headFor, planCreatureDisposal, planFlight, planIdle, type CreaturePlan as Plan } from './creaturePlanning.ts';

const CONTAINED_LABELS = { rest: 'Resting', watch: 'Watching the cell', pace: 'Pacing the cell' };
const LOOSE_LABELS = { rest: 'Lurking', watch: 'Looking around', pace: 'Prowling' };
/** Chance of making a break for it each time its cell door swings fully open, by containment class. */
export const ESCAPE_CHANCE = { maximum: 0.4, containment: 0.06, safe: 0.03 };
/** Probability of breaking an escort's grasp over one second on open floor. */
export const RESIST_CHANCE = { maximum: 0.04, containment: 0.015, safe: 0.005 };
/** Probability of starting an attack over one second with an eligible target in the room. */
export const ATTACK_CHANCE = { maximum: 0.08, containment: 0.025, safe: 0.005 };
export const CREATURE_TUNING = {
  paceSpeed: 22,
  dashSpeed: 60,
  attack: { damage: 10, reach: 14, cooldown: 5, pursuitSeconds: 10, rerouteSeconds: 0.5, recoverySeconds: 3 },
  /** Chance of going for each door seen swinging fully open while loose. */
  looseNoticeChance: 0.6,
  /** Chance of heading for a passable door when choosing a new plan while loose. */
  roamChance: 0.35,
  squeezeOpening: 0.5,
  doorWaitSeconds: 2,
};

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
  readonly statuses = new StatusEffects({ kind: 'creature', entity: this });
  readonly character: SimCreature;
  readonly stats: LiveStats;
  /** Swallowing and being swallowed; see vore.ts and voreSystem.ts. */
  readonly vore = new VoreState();
  /** The cell the creature is assigned to; it stays reserved while the creature is out. */
  readonly home: Room;
  /** Where the creature is now: its cell, or wherever it roamed to after a breach. */
  room: Room;
  x: number;
  y: number;
  facing: Facing = 'front';
  alpha = 1;
  held = false;
  private falling?: ReturnType<typeof fallMotion>;
  /** A disguised resident keeps its cell reservation but is not present on this camera. */
  away = false;
  /** Fled off camera through a way out of the facility; only `World.recontain` brings it back. */
  escaped = false;
  /** Fully absorbed by a predator, until the remains form is removed. */
  consumed = false;
  escort?: Agent;
  private riding = false;
  private plan: Plan = { action: 'watch', remaining: range(1, 5) };
  private readonly motion = new CreatureMotion();
  private dashed = false;
  private attackCooldown = 0;
  private layout: Room['props'];
  /** Doors already seen standing fully open, so each opening is only considered once. */
  private readonly noticed = new Set<Door>();

  constructor(character: SimCreature, room: Room) {
    this.character = character;
    this.stats = createLiveStats(character.stats, () => this.statuses.apply('dead'), () => this.dead);
    this.home = room;
    this.room = room;
    this.layout = room.props;
    const point = room.randomFloorPoint();
    if (!room.isWalkable(point)) throw new Error(`${room.id}: no walkable floor for ${character.name}.`);
    this.x = point.x;
    this.y = point.y;
  }

  /** Inside a predator, off the floor until spat out or absorbed. */
  get swallowed() {
    return this.vore.inside !== null;
  }

  /** In its own cell (possibly on its way out of the door). */
  get contained() {
    return !this.escort && !this.escaped && !this.swallowed && !this.consumed && this.room === this.home;
  }

  /** Physically on some camera: not disguised, swallowed, riding an elevator, or gone from the facility. */
  get onCamera() {
    return !this.riding && !this.away && !this.escaped && !this.swallowed && !this.consumed;
  }

  /** An escorted creature shares its guard's elevator position and rendering layer. */
  get layer() {
    return this.escort?.layer ?? 'room';
  }

  /** On the floor where others can get at it: not dead, escorted, slipping through a doorway or fading in. */
  get exposed() {
    return !this.held && !this.falling && !this.dead && this.onCamera && !this.escort && !this.escaping && this.alpha >= 1;
  }

  get draggable() {
    return this.exposed && !this.incapacitated;
  }

  get height() {
    return CHARACTER_FRAMES.idleRight1.h * this.character.scale;
  }

  /** Free to start something new (a hunt): exposed, and neither fleeing, attacking nor already hunting. */
  get idle() {
    return this.exposed && !this.statuses.blocksActions &&
      this.plan.action !== 'flee' && this.plan.action !== 'attack' && this.plan.action !== 'swallow';
  }

  get hasMagic() {
    return hasMagic(this.stats);
  }

  get dead(): boolean {
    return this.statuses.has('dead');
  }

  get incapacitated(): boolean {
    return this.statuses.incapacitated;
  }

  get loose() {
    return !this.held && !this.falling && !this.dead && this.onCamera && !this.contained && !this.escort;
  }

  get escaping() {
    return !this.dead && (this.plan.action === 'escape' || this.plan.action === 'enter' ||
      (this.plan.action === 'disposalDoor' && this.plan.crossing));
  }

  get disposingRemains() {
    return this.plan.action === 'dispose' || this.plan.action === 'disposalDoor';
  }

  /** Animation time while actually performing a disposal activity. */
  get disposalActivityTime(): number | undefined {
    return this.plan.action === 'dispose' && !this.plan.path.length && !this.motion.walking && this.exposed && !this.statuses.blocksActions
      ? this.plan.remaining : undefined;
  }

  get activity() {
    if (this.vore.inside) return insideActivity(this.vore.inside);
    if (this.consumed) return 'Consumed';
    const status = this.statuses.activity;
    if (status) return status;
    if (this.away) return 'Away from cell';
    if (this.escaped) return 'Escaped the facility';
    if (this.falling) return 'Falling';
    if (this.escort) return `Being escorted to ${this.home.name}`;
    if (this.plan.action === 'attack') return `Attacking ${this.plan.target.character.name}`;
    if (this.plan.action === 'swallow') return `Hunting ${this.plan.target.character.name}`;
    if (this.plan.action === 'flee') return 'Running away from security';
    if (this.plan.action === 'dispose') return this.plan.path.length
      ? DISPOSAL_TRAVEL_ACTIVITY : this.plan.site.remains.disposal.activity;
    if (this.plan.action === 'disposalDoor') return DISPOSAL_TRAVEL_ACTIVITY;
    if (this.plan.action === 'escape') return this.contained ? 'Escaping the cell' : 'Slipping through a door';
    if (this.plan.action === 'enter') return 'Slipping through a door';
    return (this.contained ? CONTAINED_LABELS : LOOSE_LABELS)[this.plan.action];
  }

  get frame() {
    return this.motion.frame(this, !!this.falling);
  }

  /** Puts the creature back in its cell, e.g. when security recaptures it. */
  returnHome(world: World, at?: Point) {
    if (this.dead) return;
    const delivered = this.escort && this.room === this.home;
    this.releaseEscort();
    this.reposition(this.home, at ?? (delivered ? this.home.nearestWalkable(this) : this.home.randomFloorPoint()), range(2, 6));
    this.escaped = false;
    // The guard's open door is not a new opportunity to escape.
    for (const door of this.home.doors) if (world.passageDoorFor(door)?.open === 1) this.noticed.add(door);
  }

  reposition(room: Room, point: Point, watchSeconds = 2) {
    if (room !== this.room) this.noticed.clear();
    this.room = room;
    this.layout = room.props;
    this.x = point.x;
    this.y = point.y;
    this.alpha = 1;
    this.motion.walking = false;
    this.falling = room.isFloor(point.x, point.y) ? undefined : fallMotion();
    this.plan = { action: 'watch', remaining: watchSeconds };
  }

  releaseEscort() {
    if (!this.escort) return;
    if (this.escort.security?.target === this) this.escort.security.target = undefined;
    this.escort = undefined;
    this.riding = false;
    const point = this.room.nearestWalkable(this);
    this.x = point.x;
    this.y = point.y;
    this.alpha = 1;
    this.motion.walking = false;
    this.plan = { action: 'watch', remaining: 2 };
  }

  private breakFree(world: World, guard: Agent) {
    this.releaseEscort();
    this.layout = this.room.props;
    this.noticed.clear();
    this.injure(world, guard);
    world.log(`${this.character.name} broke free from ${guard.character.name}'s grasp in the ${this.room.name}, injuring the guard!`, 'alert');
    world.incidents.record('broke-free', { creature: this, other: guard, room: this.room });

    const plan = planFlight(this, world, guard);
    if (plan) this.plan = plan;
  }

  private injure(world: World, target: Agent) {
    const { damage, cooldown, recoverySeconds } = CREATURE_TUNING.attack;
    this.attackCooldown = cooldown;
    const hp = target.stats.hp;
    const before = hp.current;
    hp.current = Math.max(0, before - damage);
    if (hp.current < before) {
      const { x, y, height } = target;
      const size = height * 0.1;
      world.particles.burst(target.room, 'blood', {
        x: x - size / 2, y: y - height * 0.45, w: size, h: size, floorY: y,
      }, y + 0.5);
    }
    target.finishDeath(world);
    target.moving = false;
    if (!target.dead) {
      const activity = `Recovering from ${this.character.name}'s attack`;
      target.shake = 0.6;
      target.say('!', recoverySeconds);
      target.setPlan(world, [{ ...wait(recoverySeconds, activity), interruptible: false }]);
      target.activity = activity;
    }
  }

  /** Shared eligibility for selection and pursuit; future attack triggers can build on this. */
  private canAttack(target: Agent) {
    return !target.dead && target.exposed && !target.impostor && !target.ghost && target.room === this.room &&
      this.room.isWalkable(target) && this.room.canReach(this, target);
  }

  private noticeAgents(world: World, dt: number) {
    if (dt <= 0 || this.alpha < 1 || this.escaping || !this.idle) return;
    const probability = ATTACK_CHANCE[containmentTier(this.character.containmentClass)];
    if (probability <= 0) return;
    const targets = world.agentsIn(this.room).filter((target) => this.canAttack(target));
    if (!targets.length || !chance(1 - (1 - probability) ** dt)) return;
    const target = pick(targets);
    this.plan = { action: 'attack', target, path: [], reroute: 0, remaining: CREATURE_TUNING.attack.pursuitSeconds };
    world.log(`${this.character.name} is attacking ${target.character.name} in the ${this.room.name}!`, 'alert');
  }

  private pursueAttack(world: World, plan: Extract<Plan, { action: 'attack' }>, dt: number) {
    plan.remaining -= dt;
    if (!this.canAttack(plan.target) || plan.remaining <= 0) {
      this.attackCooldown = CREATURE_TUNING.attack.cooldown;
      this.plan = { action: 'watch', remaining: 2 };
      return;
    }
    if (distance(this, plan.target) > CREATURE_TUNING.attack.reach) {
      plan.reroute -= dt;
      if (!plan.path.length || plan.reroute <= 0) {
        plan.path = this.room.route(this, plan.target) ?? [];
        plan.reroute = CREATURE_TUNING.attack.rerouteSeconds;
      }
      if (!this.motion.follow(this, plan.path, this.dashSpeed(dt), dt)) plan.path = [];
    }
    if (distance(this, plan.target) <= CREATURE_TUNING.attack.reach) {
      this.motion.face(this, plan.target.x - this.x, plan.target.y - this.y);
      this.motion.walking = false;
      this.injure(world, plan.target);
      world.log(`${this.character.name} attacked ${plan.target.character.name} in the ${this.room.name}, causing ${CREATURE_TUNING.attack.damage} HP damage!`, 'alert');
      world.incidents.record('attacked', { creature: this, other: plan.target, room: this.room });
      this.plan = { action: 'watch', remaining: 2 };
    }
  }

  /** Goes after `target`; the swallowing itself happens in VoreSystem once it is within reach. */
  startHunt(target: VoreActor, type: VoreType) {
    this.motion.walking = false;
    this.plan = { action: 'swallow', target, type, path: [], reroute: 0, remaining: VORE_TUNING.huntTimeout };
  }

  private pursueSwallow(world: World, plan: Extract<Plan, { action: 'swallow' }>, dt: number) {
    const { target } = plan;
    plan.remaining -= dt;
    if (!world.vore.eligible(this, target) || plan.remaining <= 0) {
      this.plan = { action: 'watch', remaining: 2 };
      return;
    }
    if (distance(this, target) > VORE_TUNING.reach) {
      plan.reroute -= dt;
      if (!plan.path.length || plan.reroute <= 0) {
        plan.path = this.room.route(this, { x: target.x, y: target.y }) ?? [];
        plan.reroute = VORE_TUNING.rerouteSeconds.creature;
        if (!plan.path.length) {
          this.plan = { action: 'watch', remaining: 2 };
          return;
        }
      }
      if (!this.motion.follow(this, plan.path, this.dashSpeed(dt), dt)) plan.path = [];
    }
    if (distance(this, target) <= VORE_TUNING.reach) {
      this.motion.face(this, target.x - this.x, target.y - this.y);
      this.motion.walking = false;
      world.vore.swallow(this, target, plan.type);
      this.plan = { action: 'watch', remaining: 2 };
    }
  }

  /** Spat back out into `room` at `point` (VoreSystem clears the swallowed state first). */
  emerge(room: Room, point: Point) {
    this.reposition(room, point);
  }

  /** Stops to eye someone up close (e.g. a staff member reaching out to pet it). Never interrupts a dash. */
  hold(seconds: number, toward: Point) {
    if (!this.exposed || this.statuses.blocksActions ||
      this.plan.action === 'flee' || this.plan.action === 'attack' || this.plan.action === 'swallow') return;
    this.motion.walking = false;
    this.plan = { action: 'watch', remaining: seconds };
    if (Math.abs(toward.x - this.x) >= 2) this.facing = toward.x < this.x ? 'left' : 'right';
  }

  canSqueezeThrough(world: World, door: Door): boolean {
    return world.passageDoorFor(door)?.passableAt(CREATURE_TUNING.squeezeOpening) ?? true;
  }

  private disposeRemains(world: World, plan: Extract<Plan, { action: 'dispose' }>, dt: number) {
    if (canContinueDisposal(this, world, plan.site)) {
      if (plan.path.length) {
        if (this.motion.follow(this, plan.path, CREATURE_TUNING.paceSpeed, dt)) return;
      } else {
        const { remains } = plan.site;
        const from = remains.disposal.seconds - plan.remaining;
        plan.remaining -= dt;
        world.vore.disposalProgress(this, remains, from, remains.disposal.seconds - plan.remaining);
        if (plan.remaining > 0) return;
        world.vore.finishDisposal(this, remains);
      }
    }
    this.plan = { action: 'watch', remaining: 1 };
  }

  /** Watches the room's doors; a door swinging fully open is a chance to get out. */
  private noticeDoors(world: World) {
    for (const door of this.room.doors) {
      if (world.passageDoorFor(door)?.open !== 1) {
        this.noticed.delete(door);
        continue;
      }
      const failure = this.contained && world.passageDoorFor(door)?.forcedOpen;
      if (this.noticed.has(door) && !failure) continue;
      this.noticed.add(door);
      if (this.escaping || this.plan.action === 'attack' || this.plan.action === 'swallow' || !canUseDoor(this, world, door)) continue;
      if (!failure && !chance(this.contained ? escapeChance(this.character.containmentClass) : CREATURE_TUNING.looseNoticeChance)) continue;
      const plan = headFor(this, door);
      if (!plan) continue;
      this.plan = plan;
      if (this.contained) world.log(`Warning: ${this.character.name} is moving toward the open door of ${this.room.name}.`, 'warn');
    }
  }

  /** Reached the far side of a doorway: into the linked room, or out of the facility altogether. */
  private cross(world: World, door: Door) {
    const from = this.room;
    const { name, nickname } = this.character;
    const room = door.to && world.room(door.to.room);
    const arrival = room?.doors.find((other) => other.id === door.to!.door);
    if (!room || !arrival) {
      this.escaped = true;
      this.motion.walking = false;
      this.plan = { action: 'watch', remaining: 0 };
      world.log(`Containment breach: ${name} "${nickname}" fled the facility through the ${door.id} door in the ${from.name}. Security team notified.`, 'alert');
      world.incidents.record('fled', { creature: this, room: from });
      return;
    }
    this.room = room;
    this.layout = room.props;
    this.x = arrival.outside.x;
    this.y = arrival.outside.y;
    this.alpha = 0;
    this.noticed.clear();
    this.plan = { action: 'enter', door: arrival };
    if (from === this.home) {
      world.log(`Containment breach: ${name} "${nickname}" escaped ${from.name} into the ${room.name}! Security team notified.`, 'alert');
      world.incidents.record('escaped', { creature: this, room });
    } else {
      world.log(`${name} "${nickname}" slipped into the ${room.name}.`, 'warn');
      world.incidents.record('roamed', { creature: this, room });
    }
  }

  /** Dashing costs stamina; an `exhausted` creature can only manage its pacing speed. */
  private dashSpeed(dt: number): number {
    if (!spendStamina(this, dt)) return CREATURE_TUNING.paceSpeed;
    this.dashed = true;
    return CREATURE_TUNING.dashSpeed;
  }

  private syncEscort(world: World) {
    const guard = this.escort;
    this.riding = !!guard && world.isRiding(guard);
    if (!guard) return;
    this.room = guard.room;
    if (this.riding) {
      this.motion.walking = false;
      return;
    }
    // Walk alongside on open floor; share the guard's position in thresholds and elevator cars.
    const beside = { x: guard.x - 14, y: guard.y + 2 };
    const point = guard.layer === 'room' && guard.alpha === 1 && this.room.isWalkable(beside) &&
      this.room.sameFloorArea(guard, beside) ? beside : guard;
    this.x = point.x;
    this.y = point.y;
    this.alpha = guard.alpha;
    this.facing = guard.facing;
    this.motion.walking = guard.moving;
    this.motion.distance = guard.walkDistance;
  }

  update(world: World, dt: number, blockedSeconds = 0) {
    if (this.held) return;
    this.syncEscort(world);
    if (!dt) return;
    if (this.statuses.blocksActions || !this.onCamera) {
      this.motion.walking = false;
      if (this.onCamera && !this.incapacitated) {
        this.motion.elapsed += dt;
        recoverStamina(this.stats, dt);
      }
      return;
    }
    dt = Math.max(0, dt - blockedSeconds);
    if (dt === 0) {
      this.motion.walking = false;
      return;
    }
    this.dashed = false;
    if (this.falling) {
      if (this.falling(this, world, dt)) {
        this.falling = undefined;
        if (!this.room.isWalkable(this)) Object.assign(this, this.room.nearestWalkable(this));
      }
      return;
    }
    this.act(world, dt);
    if (!this.dashed) recoverStamina(this.stats, dt);
  }

  private act(world: World, dt: number) {
    this.motion.elapsed += dt;
    if (!this.escort) this.motion.walking = false;
    const attackDt = Math.max(0, dt - this.attackCooldown);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (this.escort) {
      const guard = this.escort;
      // Keep doorway fades and completed deliveries atomic.
      if (this.room !== this.home && guard.alpha === 1 && guard.layer === 'room' && this.room.isWalkable(guard) &&
        chance(1 - (1 - RESIST_CHANCE[containmentTier(this.character.containmentClass)]) ** dt)) {
        this.breakFree(world, guard);
      }
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
      this.plan = planIdle(this, world, CREATURE_TUNING.roamChance);
    }
    if (this.plan.action !== 'flee') this.noticeDoors(world);
    this.noticeAgents(world, attackDt);
    const plan = this.plan;

    if (plan.action === 'attack') {
      this.pursueAttack(world, plan, dt);
      return;
    }

    if (plan.action === 'swallow') {
      this.pursueSwallow(world, plan, dt);
      return;
    }

    if (!this.disposingRemains) {
      const disposal = planCreatureDisposal(this, world);
      if (disposal) {
        this.plan = disposal;
        return;
      }
    }

    if (plan.action === 'dispose') {
      this.disposeRemains(world, plan, dt);
      return;
    }

    if ('remaining' in plan) {
      plan.remaining -= dt;
      if (plan.remaining <= 0) this.plan = planIdle(this, world, CREATURE_TUNING.roamChance);
      return;
    }

    if (plan.action === 'pace' || plan.action === 'flee') {
      if (!this.motion.follow(this, plan.path, plan.action === 'flee' ? this.dashSpeed(dt) : CREATURE_TUNING.paceSpeed, dt) || !plan.path.length) {
        this.plan = { action: 'watch', remaining: range(1, 4) };
      }
      return;
    }

    if (plan.action === 'enter') {
      const { door } = plan;
      const total = Math.max(1, distance(door.outside, door.inside));
      const reached = this.motion.stepToward(this, door.inside, this.dashSpeed(dt), dt);
      this.alpha = Math.min(1, 1 - distance(door.inside, this) / total);
      if (reached) {
        this.alpha = 1;
        this.layout = this.room.props;
        this.plan = { action: 'watch', remaining: range(1, 3) };
      }
      return;
    }

    const { door } = plan;
    if (!plan.crossing && !plan.path.length) {
      if (!this.canSqueezeThrough(world, door)) {
        this.motion.face(this, door.outside.x - this.x, door.outside.y - this.y);
        plan.waited += dt;
        if (plan.waited >= CREATURE_TUNING.doorWaitSeconds) {
          this.plan = { action: 'watch', remaining: range(2, 5) };
          if (plan.action === 'escape' && this.contained) {
            world.log(`${this.character.name}'s cell door in ${this.room.name} closed just in time.`, 'ok');
          }
        }
        return;
      }
      plan.crossing = true;
    }
    const speed = plan.action === 'disposalDoor' ? CREATURE_TUNING.paceSpeed : this.dashSpeed(dt);
    if (!plan.crossing) {
      if (!this.motion.follow(this, plan.path, speed, dt)) this.plan = { action: 'watch', remaining: range(1, 4) };
      return;
    }
    const total = Math.max(1, distance(door.outside, door.inside));
    const reached = this.motion.stepToward(this, door.outside, speed, dt);
    this.alpha = Math.max(0, distance(door.outside, this) / total);
    if (reached) this.cross(world, door);
  }
}
