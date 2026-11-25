import { Agent } from './agent.ts';
import type { Item } from './item.ts';
import { chance, weightedPick } from './random.ts';
import { Remains } from './remains.ts';
import type { Point, Room } from './room.ts';
import { STATUS_EFFECTS } from './statusEffects.ts';
import { wait } from './tasks.ts';
import { isReef, isTrespassing } from './trespass.ts';
import {
  ABSORPTION_HOOKS, VORE_TUNING, VORE_TYPES, cooldownSeconds, disposalWait, fighterOf, heightOf, huntRate, pickVoreType, rolls,
  pickRemainsLook, startInsideAction, voreTypeLabel, type Ingestion, type VoreActor, type VoreType,
} from './vore.ts';
import { stalk } from './voreTasks.ts';
import type { World } from './world.ts';

/** Room pixels beside the predator where spat-out prey land. */
const SPIT_DISTANCE = 10;
/** Where a pile's items land: the first pair this far to either side, then further out every step. */
const ITEM_SPREAD = { first: 12, step: 10, depth: 2 };
/** Seconds prey stay dazed after being spat out. */
const DAZED_SECONDS = 3;

/**
 * Runs every swallow in the world: who goes after whom, carrying prey inside their predator, the
 * acid and the absorption, and the remains the predator leaves behind. The rules (who may swallow
 * whom, the ways of doing it, what prey do inside) are in vore.ts; each character's own state is
 * its VoreState. The world owns one as `world.vore`.
 */
export class VoreSystem {
  private readonly world: World;
  private readonly ingestions: Ingestion[] = [];
  /** Characters that were absorbed for good; they don't arrive again. */
  readonly consumed = new Set<string>();

  constructor(world: World) {
    this.world = world;
  }

  /** Everyone currently inside someone else. */
  get active(): readonly Ingestion[] {
    return this.ingestions;
  }

  /** Swallowed agents are in no room's list, but are still in the facility. */
  swallowedAgents(): Agent[] {
    return this.ingestions.flatMap(({ prey }) => (prey instanceof Agent ? [prey] : []));
  }

  /** Prey inside predators that are on `room`'s camera, so their status popups can follow the predator. */
  swallowedIn(room: Room): VoreActor[] {
    return this.ingestions.filter(({ predator }) => predator.room === room && this.onCamera(predator)).map(({ prey }) => prey);
  }

  /**
   * Whether `predator` could swallow `prey` right now: roles, sizes, staff rules, both standing in
   * the same room and free to be caught, and room inside. Distance doesn't matter.
   */
  eligible(predator: VoreActor, prey: VoreActor): boolean {
    if (predator === prey || predator.room !== prey.room || predator.dead || !this.grounded(predator) ||
      predator.vore.contents.length >= (predator.character.vore?.capacity ?? 0) || !this.catchable(prey)) return false;
    const hunter = fighterOf(predator);
    const target = fighterOf(prey);
    if (predator instanceof Agent && prey instanceof Agent) {
      if (isReef(predator) && isTrespassing(prey)) return heightOf(hunter) >= heightOf(target);
      const requiredHeight = heightOf(target) * VORE_TUNING.staffSizeRatio;
      return hunter.vore?.role === 'predator' && target.vore?.role === 'prey' &&
        heightOf(hunter) >= requiredHeight - Number.EPSILON * Math.abs(requiredHeight) &&
        !this.world.agentsIn(predator.room).some((other) => other !== predator && other !== prey) &&
        huntRate(hunter, target) > 0;
    }
    return huntRate(hunter, target) > 0;
  }

  /** Swallows `prey` whole. Returns false, changing nothing, when the rules don't allow it right now. */
  swallow(predator: VoreActor, prey: VoreActor, type: VoreType = pickVoreType(predator.character.vore)): boolean {
    if (!this.eligible(predator, prey)) return false;
    const { world } = this;
    const ingestion: Ingestion = { predator, prey, type, stage: 'digesting', elapsed: 0, action: startInsideAction(), absorbed: 0 };
    if (prey instanceof Agent) {
      prey.releaseStaffEscort(world);
      world.agents = world.agents.filter((other) => other !== prey);
      prey.setPlan(world, []);
      prey.moving = false;
      prey.napping = false;
      prey.bubble = null;
      prey.releaseTarget();
    }
    prey.vore.inside = ingestion;
    predator.vore.contents.push(ingestion);
    this.ingestions.push(ingestion);
    prey.statuses.apply('acid');
    predator.vore.cooldown = cooldownSeconds();
    this.carry(ingestion);
    world.log(`${predator.character.name} swallowed ${prey.character.name} whole (${voreTypeLabel(type).toLowerCase()}) in the ${predator.room.name}!`, 'alert');
    // The post is staffed again; the swallowed guard counts as absent from here on.
    if (prey instanceof Agent && prey.security && world.elevatorFor(prey.security.post)) world.staffSecurityPost(prey.security.post);
    return true;
  }

  /** The predator lets live prey out. False when they aren't inside, or have already been digested. */
  spitOut(prey: VoreActor): boolean {
    const ingestion = prey.vore.inside;
    if (!ingestion || ingestion.stage !== 'digesting') return false;
    this.eject(ingestion);
    return true;
  }

  /** Lets go of everything inside (spits out the living, finishes absorbing the digested) and drops any remains. */
  release(predator: VoreActor) {
    for (const ingestion of [...predator.vore.contents]) {
      if (ingestion.stage === 'absorbing') this.finish(ingestion);
      else this.eject(ingestion);
    }
    for (const remains of [...predator.vore.remains]) this.drop(predator, remains);
  }

  update(dt: number) {
    this.tickTimers(dt);
    for (const ingestion of [...this.ingestions]) {
      if (this.ingestions.includes(ingestion)) this.advance(ingestion, dt);
    }
    this.dispose(dt);
    this.hunt(dt);
  }

  /** Keeps prey in the same place as their predator; the world calls it once everyone has moved. */
  sync() {
    for (const ingestion of this.ingestions) this.carry(ingestion);
  }

  private tickTimers(dt: number) {
    for (const actor of [...this.world.everyone(), ...this.world.creatures]) {
      const { vore } = actor;
      vore.cooldown = Math.max(0, vore.cooldown - dt);
      vore.safeFor = Math.max(0, vore.safeFor - dt);
    }
  }

  private onCamera(actor: VoreActor): boolean {
    return actor instanceof Agent ? this.world.agents.includes(actor) : actor.onCamera;
  }

  /** Standing on a room's floor, free to act there. */
  private grounded(actor: VoreActor): boolean {
    return actor instanceof Agent ? actor.exposed && this.world.agents.includes(actor) : actor.exposed;
  }

  /** Can be picked up and swallowed. Shapeshifters in disguise and ghosts can't; nor can anyone already inside or holding someone. */
  private catchable(prey: VoreActor): boolean {
    const { vore } = prey;
    if (prey.dead || vore.inside || vore.full || vore.safeFor > 0) return false;
    return prey instanceof Agent ? prey.exposed && !prey.impostor && !prey.ghost : prey.exposed;
  }

  /** Whoever won't be around to look after prey: gone from the facility or dead. */
  private gone(actor: VoreActor): boolean {
    return actor instanceof Agent ? actor.removed || actor.dead : actor.dead || actor.escaped || actor.consumed;
  }

  /** A predator with nothing else on its mind. */
  private ready(actor: VoreActor): boolean {
    if (actor instanceof Agent) {
      return actor.exposed && !actor.incapacitated && actor.interruptible && !actor.napping && !actor.conversation &&
        !actor.security && !actor.staffEscort && !actor.impostor;
    }
    return actor.idle;
  }

  private hunt(dt: number) {
    for (const swallower of [...this.world.agents, ...this.world.creatures]) {
      const role = swallower.character.vore?.role ?? 'none';
      if (role === 'none' || swallower.vore.cooldown > 0 || !this.ready(swallower)) continue;
      const targets = this.world.actorsIn(swallower.room)
        .filter((other) => !(swallower instanceof Agent && isReef(swallower) && other instanceof Agent && isTrespassing(other)) &&
          this.eligible(swallower, other))
        .map((target) => ({ target, weight: huntRate(fighterOf(swallower), fighterOf(target)) }));
      const total = targets.reduce((sum, { weight }) => sum + weight, 0);
      if (!rolls(total, dt)) continue;
      const prey = weightedPick(targets)?.target;
      // Pathfinding is the costly check, so it only happens once someone has decided to go.
      if (prey && swallower.room.canReach(swallower, prey, swallower instanceof Agent && swallower.ghost)) this.startHunt(swallower, prey);
    }
  }

  private startHunt(swallower: VoreActor, prey: VoreActor) {
    const type = pickVoreType(swallower.character.vore);
    if (swallower instanceof Agent) swallower.setPlan(this.world, [stalk(prey, type)]);
    else swallower.startHunt(prey, type);
    this.world.log(`${swallower.character.name} is stalking ${prey.character.name} in the ${swallower.room.name}.`, 'warn');
  }

  /** Puts the prey where its predator is, so they move, change rooms and fade through doorways together. */
  private carry({ predator, prey }: Ingestion) {
    prey.room = predator.room;
    prey.x = predator.x;
    prey.y = predator.y;
    prey.facing = predator.facing;
    prey.alpha = predator.alpha;
    if (prey instanceof Agent) prey.layer = predator instanceof Agent ? predator.layer : 'room';
  }

  private advance(ingestion: Ingestion, dt: number) {
    const { predator, prey } = ingestion;
    if (this.gone(predator)) {
      this.release(predator);
      return;
    }
    if (ingestion.stage === 'absorbing') {
      this.absorb(ingestion, dt);
      return;
    }
    ingestion.elapsed += dt;
    if (prey.dead) {
      this.convert(ingestion);
      return;
    }
    ingestion.action.remaining -= dt;
    if (ingestion.action.remaining > 0) return;
    const odds = ingestion.action.escapeChance * VORE_TYPES[ingestion.type].escape;
    if (odds > 0 && this.grounded(predator) && chance(odds)) this.eject(ingestion);
    else ingestion.action = startInsideAction();
  }

  /** The acid has finished: the prey changes into whatever this way of swallowing makes of them, and absorption begins. */
  private convert(ingestion: Ingestion) {
    const { predator, prey, type } = ingestion;
    const status = VORE_TYPES[type].converted;
    ingestion.stage = 'absorbing';
    ingestion.elapsed = 0;
    prey.statuses.remove('acid');
    prey.statuses.apply(status);
    this.world.log(`${prey.character.name} was ${STATUS_EFFECTS[status].label.toLowerCase()} by ${predator.character.name}.`, 'warn');
  }

  /** Hands the predator the prey's worth of health bit by bit; when the stage runs out, the prey is gone. */
  private absorb(ingestion: Ingestion, dt: number) {
    const { predator, prey, type } = ingestion;
    const total = Math.max(0.001, VORE_TUNING.absorbSeconds / VORE_TYPES[type].absorption);
    const step = Math.max(0, Math.min(dt, total - ingestion.elapsed));
    ingestion.elapsed += step;
    const amount = (prey.stats.hp.max * VORE_TUNING.healFraction * step) / total;
    if (amount > 0 && !predator.dead) {
      const { hp } = predator.stats;
      hp.current = Math.min(hp.max, hp.current + amount);
      ingestion.absorbed += amount;
    }
    if (ingestion.elapsed >= total) this.finish(ingestion);
  }

  /** Nothing but remains is left: the profile stays as it was, but is no longer an agent or creature. */
  private finish(ingestion: Ingestion) {
    const { predator, prey, type } = ingestion;
    const { world } = this;
    this.detach(ingestion);
    const kind = prey instanceof Agent ? 'agent' : 'creature';
    const items = prey instanceof Agent ? prey.takeAllItems() : [];
    if (prey instanceof Agent) prey.removed = true;
    else prey.consumed = true;
    this.consumed.add(prey.character.id);
    const remains = new Remains({ actor: prey, kind, type, look: pickRemainsLook(type), items, wait: disposalWait() });
    prey.vore.ownRemains = remains;
    predator.vore.remains.push(remains);
    if (prey instanceof Agent) world.hooks.removed?.(prey);
    for (const hook of ABSORPTION_HOOKS) hook({ predator, prey, type });
    world.log(`${prey.character.name} was absorbed by ${predator.character.name}.`, 'warn');
  }

  /** Spits live prey back out beside the predator, shaken and safe from being swallowed again for a while. */
  private eject(ingestion: Ingestion) {
    const { predator, prey } = ingestion;
    const { world } = this;
    const { room } = predator;
    this.detach(ingestion);
    prey.statuses.remove('acid');
    prey.vore.safeFor = VORE_TUNING.safeAfterSpit;
    const point = room.nearestWalkable({ x: predator.x + (predator.facing === 'left' ? -SPIT_DISTANCE : SPIT_DISTANCE), y: predator.y + 3 }, predator);
    if (prey instanceof Agent) {
      prey.room = room;
      prey.x = point.x;
      prey.y = point.y;
      prey.layer = 'room';
      prey.alpha = 1;
      prey.enteredRoomAt = world.time;
      world.agents.push(prey);
      if (!prey.dead) {
        const activity = `Recovering from ${predator.character.name}`;
        prey.statuses.apply('scared');
        prey.say('!', DAZED_SECONDS);
        prey.setPlan(world, [{ ...wait(DAZED_SECONDS, activity), interruptible: false }]);
        prey.activity = activity;
      }
    } else prey.emerge(room, point);
    world.log(`${predator.character.name} spat ${prey.character.name} back out in the ${room.name}.`, 'ok');
  }

  private detach(ingestion: Ingestion) {
    const { predator, prey } = ingestion;
    this.ingestions.splice(this.ingestions.indexOf(ingestion), 1);
    predator.vore.contents.splice(predator.vore.contents.indexOf(ingestion), 1);
    prey.vore.inside = null;
  }

  /** Predators get rid of remains once their wait is over and they are standing somewhere; gone ones drop them where they were. */
  private dispose(dt: number) {
    for (const host of [...this.world.everyone(), ...this.world.creatures]) {
      if (!host.vore.remains.length) continue;
      const gone = this.gone(host);
      for (const remains of [...host.vore.remains]) {
        remains.wait -= dt;
        if (gone || (remains.wait <= 0 && this.grounded(host))) this.drop(host, remains);
      }
    }
  }

  /** The pile lands at the host's feet, with everything the prey was holding scattered beside it. */
  private drop(host: VoreActor, remains: Remains) {
    const { room } = host;
    const point = room.nearestWalkable(host);
    host.vore.remains.splice(host.vore.remains.indexOf(remains), 1);
    remains.x = point.x;
    remains.y = point.y;
    room.remains.push(remains);
    this.scatter(room, point, remains.items.splice(0));
    this.world.log(`${host.character.name} got rid of ${remains.name}'s remains in the ${room.name}.`, 'muted');
  }

  private scatter(room: Room, pile: Point, items: Item[]) {
    items.forEach((item, index) => {
      const side = index % 2 === 0 ? 1 : -1;
      const wanted = { x: pile.x + side * (ITEM_SPREAD.first + Math.floor(index / 2) * ITEM_SPREAD.step), y: pile.y + ITEM_SPREAD.depth };
      const spot = room.nearestWalkable(wanted, pile);
      item.x = Math.round(spot.x - item.w / 2);
      item.y = Math.round(spot.y - item.h);
      room.items.push(item);
    });
  }
}
