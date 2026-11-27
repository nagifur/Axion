import { Agent } from './agent.ts';
import type { Incident } from './incidents.ts';
import type { Item } from './item.ts';
import { chance, weightedPick } from './random.ts';
import { Remains } from './remains.ts';
import type { Point, Room } from './room.ts';
import { CHARACTER_FRAMES } from './sprites.ts';
import { wait } from './tasks.ts';
import { isTrespassing, trespassResponseFor } from './trespass.ts';
import {
  ABSORPTION_HOOKS, VORE_STAFF_RULES, VORE_TUNING, VORE_TYPES, absorbSeconds, cooldownSeconds, disposalWait, fighterOf, hasVoreTypes,
  heightOf, huntRate, outcomeFor, pickVoreType, rolls, pickRemainsOutcome, startInsideAction, voreTypeLabel,
  type Ingestion, type VoreActor, type VoreOutcome, type VoreType,
} from './vore.ts';
import { stalk } from './voreTasks.ts';
import type { World } from './world.ts';

/**
 * Runs every swallow in the world: who goes after whom, carrying prey inside their predator, the
 * acid and the absorption, and the remains the predator leaves behind. The rules (who may swallow
 * whom, the ways of doing it, what prey do inside) are in vore.ts; each character's own state is
 * its VoreState. The world owns one as `world.vore`.
 *
 * Each stage is also the prey's status (acid → absorbing → a remains form like bones), and the statuses
 * lead: giving anyone a remains status turns them into that pile, swallowed or not.
 */
export class VoreSystem {
  private readonly world: World;
  private readonly ingestions: Ingestion[] = [];
  private readonly predatorIncidents = new WeakMap<Ingestion, Incident>();
  private readonly remainsOwners = new WeakMap<Remains, { room: Room } | { host: VoreActor }>();
  /** Characters currently reduced to remains; they don't arrive again while in that form. */
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
      predator.vore.contents.length >= (predator.character.vore?.capacity ?? 0) ||
      !hasVoreTypes(predator.character.vore) || !this.catchable(prey)) return false;
    const hunter = fighterOf(predator);
    const target = fighterOf(prey);
    if (predator instanceof Agent && prey instanceof Agent) {
      const response = trespassResponseFor(predator);
      if (response && isTrespassing(prey)) {
        return response.swallowChance > 0 && heightOf(hunter) >= heightOf(target) * response.sizeRatio;
      }
      const requiredHeight = heightOf(target) * VORE_TUNING.staffSizeRatio;
      return VORE_STAFF_RULES.predatorRoles.includes(hunter.vore?.role ?? 'none') &&
        VORE_STAFF_RULES.preyRoles.includes(target.vore?.role ?? 'none') &&
        heightOf(hunter) >= requiredHeight - Number.EPSILON * Math.abs(requiredHeight) &&
        (!VORE_STAFF_RULES.requirePrivacy ||
          !this.world.agentsIn(predator.room).some((other) => other !== predator && other !== prey)) &&
        huntRate(hunter, target) > 0;
    }
    return huntRate(hunter, target) > 0;
  }

  /** Swallows `prey` whole. Returns false, changing nothing, when the rules don't allow it right now. */
  swallow(predator: VoreActor, prey: VoreActor, type?: VoreType): boolean {
    if (!this.eligible(predator, prey)) return false;
    const selectedType = type ?? pickVoreType(predator.character.vore);
    if (!Object.hasOwn(VORE_TYPES, selectedType)) throw new Error(`Unknown vore type "${selectedType}".`);
    const { world } = this;
    const ingestion: Ingestion = { predator, prey, type: selectedType, phase: { kind: 'digesting', action: startInsideAction() } };
    if (prey instanceof Agent) {
      prey.releaseStaffEscort(world);
      world.agents = world.agents.filter((other) => other !== prey);
      prey.setPlan(world, []);
      prey.moving = false;
      prey.bubble = null;
      prey.releaseTarget();
    }
    prey.vore.inside = ingestion;
    predator.vore.contents.push(ingestion);
    this.ingestions.push(ingestion);
    prey.statuses.apply('acid');
    predator.vore.cooldown = cooldownSeconds();
    this.carry(ingestion);
    world.log(`${predator.character.name} swallowed ${prey.character.name} whole (${voreTypeLabel(selectedType).toLowerCase()}) in the ${predator.room.name}!`, 'alert');
    this.recordIngestion('swallowed', ingestion);
    // The post is staffed again; the swallowed guard counts as absent from here on.
    if (prey instanceof Agent && prey.security && world.elevatorFor(prey.security.post)) world.staffSecurityPost(prey.security.post);
    return true;
  }

  /** The predator lets live prey out. False when they aren't inside, or have already been digested. */
  spitOut(prey: VoreActor): boolean {
    const ingestion = prey.vore.inside;
    if (ingestion?.phase.kind !== 'digesting') return false;
    this.eject(ingestion);
    return true;
  }

  /** Lets go of everything inside (spits out the living, finishes absorbing the digested) and drops any remains. */
  release(predator: VoreActor) {
    for (const ingestion of [...predator.vore.contents]) {
      if (ingestion.phase.kind === 'absorbing') this.finish(ingestion, ingestion.phase.outcome);
      else this.eject(ingestion);
    }
    for (const remains of [...predator.vore.remains]) this.drop(predator, remains);
  }

  update(dt: number) {
    this.tickTimers(dt);
    this.settleRemainsStatuses();
    for (const ingestion of [...this.ingestions]) {
      if (this.ingestions.includes(ingestion)) this.advance(ingestion, dt);
    }
    this.ageRemains(dt);
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
      return actor.exposed && !actor.statuses.blocksActions && actor.interruptible && !actor.disposingRemains && !actor.conversation &&
        !actor.security && !actor.staffEscort && !actor.impostor;
    }
    return actor.idle && !actor.disposingRemains;
  }

  private hunt(dt: number) {
    for (const swallower of [...this.world.agents, ...this.world.creatures]) {
      const role = swallower.character.vore?.role ?? 'none';
      if (role === 'none' || swallower.vore.cooldown > 0 || !this.ready(swallower)) continue;
      const targets = this.world.actorsIn(swallower.room)
        .filter((other) => !(swallower instanceof Agent && trespassResponseFor(swallower) && other instanceof Agent && isTrespassing(other)) &&
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
    const { predator, prey, phase } = ingestion;
    if (this.gone(predator)) {
      this.release(predator);
      return;
    }
    if (phase.kind === 'absorbing') {
      this.absorb(ingestion, phase);
      return;
    }
    if (prey.dead || prey.statuses.has('absorbing')) {
      this.convert(ingestion);
      return;
    }
    phase.action.remaining -= dt;
    if (phase.action.remaining > 0) return;
    const odds = phase.action.escapeChance * VORE_TYPES[ingestion.type].escape;
    if (odds > 0 && this.grounded(predator) && chance(odds)) this.eject(ingestion);
    else phase.action = startInsideAction();
  }

  /**
   * The acid has finished (or someone applied `absorbing`): the way of swallowing picks what the prey will
   * become, and absorption begins, timed by the prey's `absorbing` status.
   */
  private convert(ingestion: Ingestion) {
    const { predator, prey, type } = ingestion;
    const total = absorbSeconds(type);
    ingestion.phase = { kind: 'absorbing', total, left: total, outcome: pickRemainsOutcome(type) };
    prey.statuses.apply('dead');
    prey.statuses.apply('absorbing', total);
    this.world.log(`${prey.character.name} was digested by ${predator.character.name}.`, 'warn');
  }

  /**
   * Hands the predator the prey's worth of health as their `absorbing` status runs down; once it has run out
   * (or been removed) the prey is gone. A permanent `absorbing` pauses the stage.
   */
  private absorb(ingestion: Ingestion, phase: Extract<Ingestion['phase'], { kind: 'absorbing' }>) {
    const { predator, prey } = ingestion;
    const status = prey.statuses.get('absorbing');
    const left = status ? status.remaining ?? phase.left : 0;
    const amount = (prey.stats.hp.max * VORE_TUNING.healFraction * Math.max(0, phase.left - left)) / phase.total;
    phase.left = left;
    if (amount > 0 && !predator.dead) {
      const { hp } = predator.stats;
      hp.current = Math.min(hp.max, hp.current + amount);
    }
    if (left <= 0) this.finish(ingestion, phase.outcome);
  }

  /** Nothing but remains is left: the prey takes the outcome's remains status and the predator holds the pile. */
  private finish(ingestion: Ingestion, outcome: VoreOutcome) {
    const { predator, prey, type } = ingestion;
    const { world } = this;
    this.detach(ingestion);
    prey.statuses.apply(outcome.remains);
    const items = prey instanceof Agent ? prey.takeAllItems() : [];
    const remains = new Remains({ actor: prey, type, form: outcome.remains, disposal: outcome.disposal, items, wait: disposalWait() });
    this.retire(prey, remains);
    predator.vore.remains.push(remains);
    this.remainsOwners.set(remains, { host: predator });
    if (prey instanceof Agent) world.hooks.removed?.(prey);
    for (const hook of ABSORPTION_HOOKS) hook({ predator, prey, type });
    world.log(`${prey.character.name} was absorbed by ${predator.character.name}.`, 'warn');
    this.recordIngestion('absorbed', ingestion);
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

  /**
   * Remains statuses lead: anyone who has one but isn't a pile yet becomes it. Prey finish inside their predator,
   * as the way they were swallowed would leave them; anyone else collapses where they stand. People riding an
   * elevator or creatures off the premises turn once they're back on a floor.
   */
  private settleRemainsStatuses() {
    for (const actor of [...this.world.everyone(), ...this.world.creatures]) {
      const form = actor.statuses.remainsForm;
      if (!form || actor.vore.ownRemains) continue;
      const ingestion = actor.vore.inside;
      if (ingestion) this.finish(ingestion, outcomeFor(ingestion.type, form));
      else if (this.onCamera(actor)) this.collapse(actor, form);
    }
  }

  /** Turns someone on the floor into a pile of `form` at their feet, with their belongings beside it. */
  private collapse(actor: VoreActor, form: string) {
    const { world } = this;
    const { room } = actor;
    this.release(actor);
    if (actor instanceof Agent) {
      actor.finishDeath(world);
      world.agents = world.agents.filter((other) => other !== actor);
      if (actor.security && world.elevatorFor(actor.security.post)) world.staffSecurityPost(actor.security.post);
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

  private recordIngestion(step: 'swallowed' | 'absorbed', ingestion: Ingestion) {
    const { predator, prey } = ingestion;
    const { room } = predator;
    const { incidents } = this.world;
    const preyIncident = prey instanceof Agent ? undefined : incidents.record(step, { creature: prey, other: predator, room });
    if (predator instanceof Agent) return;
    const incident = this.predatorIncidents.get(ingestion) ?? incidents.pendingFor(predator);
    if (!incident) return;
    if (step === 'swallowed') this.predatorIncidents.set(ingestion, incident);
    if (incident !== preyIncident) {
      incidents.record(`${step}-someone`, { creature: predator, other: prey, room }, incident);
    }
  }

  /** Spits live prey back out beside the predator, shaken and safe from being swallowed again for a while. */
  private eject(ingestion: Ingestion) {
    const { predator, prey } = ingestion;
    const { world } = this;
    const { room } = predator;
    this.detach(ingestion);
    prey.statuses.remove('acid');
    prey.vore.safeFor = VORE_TUNING.safeAfterSpit;
    const { spitOffset, dazedSeconds } = VORE_TUNING;
    const point = room.nearestWalkable({
      x: predator.x + (predator.facing === 'left' ? -spitOffset.x : spitOffset.x), y: predator.y + spitOffset.y,
    }, predator);
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
        prey.say('!', dazedSeconds);
        prey.setPlan(world, [{ ...wait(dazedSeconds, activity), interruptible: false }]);
        prey.activity = activity;
      }
    } else prey.emerge(room, point);
    world.log(`${predator.character.name} spat ${prey.character.name} back out in the ${room.name}.`, 'ok');
    if (!(prey instanceof Agent)) world.incidents.record('spat-out', { creature: prey, other: predator, room });
  }

  private detach(ingestion: Ingestion) {
    const { predator, prey } = ingestion;
    this.ingestions.splice(this.ingestions.indexOf(ingestion), 1);
    predator.vore.contents.splice(predator.vore.contents.indexOf(ingestion), 1);
    prey.vore.inside = null;
  }

  /** Aging creates an urge to dispose; only gone predators drop remains without an activity. */
  private ageRemains(dt: number) {
    for (const host of [...this.world.everyone(), ...this.world.creatures]) {
      if (!host.vore.remains.length) continue;
      for (const remains of host.vore.remains) remains.wait -= dt;
      if (this.gone(host)) for (const remains of [...host.vore.remains]) this.drop(host, remains);
    }
  }

  /** Completes a planned activity; interrupted activities must not call this. */
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

  finishDisposal(host: VoreActor, remains: Remains) {
    if (!host.vore.remains.includes(remains) || !this.grounded(host) || host.dead) {
      throw new Error('Cannot dispose of remains the predator is not holding on the floor.');
    }
    this.drop(host, remains, true);
  }

  /** The pile lands at the host's feet (or is tossed from its release point), with everything the prey was holding scattered beside it. */
  private drop(host: VoreActor, remains: Remains, tossed = false) {
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
