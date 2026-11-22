import { Agent } from './agent.ts';
import type { Creature } from './creature.ts';
import { assignCellOccupants } from './cellOccupants.ts';
import { enterThroughDoor, leaveFacility, phaseThroughWall, rideElevatorIn } from './transport.ts';
import { canVisitLevel, type SimCharacter, type SimCreature, type SimImpostor } from './roster.ts';
import { directionTo, type Door, type Room, type Spot } from './room.ts';
import { ParticleSystem } from './particles.ts';
import type { Prop } from './prop.ts';
import { scheduleFor } from './schedule.ts';
import { passagePartBounds, type PassageDoor } from './door.ts';
import type { Rect } from './navMap.ts';
import { Elevator } from './elevator.ts';
import { PassageNetwork } from './passages.ts';
import * as routing from './routing.ts';
import { chance, maybePick, pick, range, weightedPick } from './random.ts';
import { accessCardLevel, startingItemTypes } from './item.ts';
import type { StatusEffects } from './statusEffects.ts';
import { checkElectricalApproach } from './electrical.ts';
import { LevelState, type LevelDefinitions } from './levelState.ts';
import { LEVEL_DEFINITIONS, LEVEL_EVENTS } from './levels.ts';

export type LogTone = 'default' | 'muted' | 'ok' | 'warn' | 'alert';
export type CameraActor = Agent | Creature;

/** Seconds the car takes between floors on camera: a fixed part plus a part per level travelled. */
const RIDE_SECONDS = { base: 2, perLevel: 2 };
const SPARK_PAUSE_SECONDS = { min: 1.2, max: 3 };
/** Seconds before someone who left may come back. */
const RETURN_DELAY_SECONDS = { min: 45, max: 165 };
/** Seconds between attempts to bring someone new in. */
const ARRIVAL_INTERVAL_SECONDS = { min: 4, max: 12 };
/** How far apart, in room pixels, two agents can be to start a chat. */
const CHAT_RANGE = 260;

export interface WorldOptions {
  roster: SimCharacter[];
  creatureRoster?: SimCreature[];
  rooms: Room[];
  now?: () => Date;
  levels?: LevelDefinitions;
}

export interface WorldHooks {
  log?: (text: string, tone: LogTone) => void;
  /** `room` is set for things that only count when seen on that room's camera. */
  achieve?: (id: string, room?: Room) => void;
  removed?: (agent: Agent) => void;
}

/** Average number of staff per room, by the viewer's local time. */
const DENSITY = { night: 1, evening: 2.5, day: 3.5 };

type Entrance =
  | { kind: 'elevator'; room: Room; weight: number }
  | { kind: 'door'; room: Room; door: Door; weight: number };

/** Someone riding the elevator between two floors on camera. They are on no camera meanwhile. */
interface Ride {
  agent: Agent;
  from: Room;
  to: Room;
  arrivesAt: number;
}

export class World {
  time = 0;
  /** People in a room on camera. */
  agents: Agent[] = [];
  readonly creatures: readonly Creature[];
  readonly roster: SimCharacter[];
  readonly rooms: Room[];
  readonly now: () => Date;
  hooks: WorldHooks = {};
  readonly particles = new ParticleSystem();
  private readonly levels = new Map<number, LevelState>();
  private readonly sparkDelays = new WeakMap<object, number>();
  private readonly elevators = new Map<Room, Elevator>();
  private readonly passages: PassageNetwork;
  private rides: Ride[] = [];
  /** Earliest time each off-camera character may come back. */
  private returnAt = new Map<string, number>();
  private nextArrival = 3;

  constructor(options: WorldOptions) {
    this.roster = options.roster;
    this.rooms = options.rooms;
    this.creatures = assignCellOccupants(options.creatureRoster ?? [], this.rooms);
    this.now = options.now ?? (() => new Date());
    const definitions = options.levels ?? LEVEL_DEFINITIONS;
    const roomsByLevel = new Map<number, Room[]>();
    for (const room of this.rooms) {
      const floorRooms = roomsByLevel.get(room.level);
      if (floorRooms) floorRooms.push(room);
      else roomsByLevel.set(room.level, [room]);
      if (room.elevator) this.elevators.set(room, new Elevator(room.elevator.big ? 10 : 1));
    }
    for (const [number, rooms] of roomsByLevel) {
      const definition = definitions[number];
      this.levels.set(number, new LevelState(this, number, rooms, {
        ...definition, events: { ...LEVEL_EVENTS, ...definition?.events },
      }));
    }
    this.passages = new PassageNetwork(this.rooms, (id) => this.room(id));
  }

  log(text: string, tone: LogTone = 'default') {
    this.hooks.log?.(text, tone);
  }

  achieve(id: string, room?: Room) {
    this.hooks.achieve?.(id, room);
  }

  room(id: string): Room | undefined {
    return this.rooms.find((room) => room.id === id);
  }

  level(number: number): LevelState | undefined {
    return this.levels.get(number);
  }

  elevatorFor(room: Room): Elevator | undefined {
    return this.elevators.get(room);
  }

  passageDoorFor(door: Door): PassageDoor | undefined {
    return this.passages.stateFor(door);
  }

  canUsePassage(character: SimCharacter, door: Door): boolean {
    const state = this.passageDoorFor(door);
    return !state || (!state.blocked && (state.stuckOpen ||
      startingItemTypes(character).some((type) => (accessCardLevel({ type }) ?? -1) >= state.clearance)));
  }

  canAgentUsePassage(agent: Agent, door: Door): boolean {
    const state = this.passageDoorFor(door);
    return !state || (!state.blocked &&
      (state.stuckOpen || !!agent.impostor || agent.hasAccessCard(state.clearance)));
  }

  /** Opening needs a card; anyone may slip through a door that is already fully open. */
  canAgentCross(agent: Agent, door: Door): boolean {
    const state = this.passageDoorFor(door);
    return this.canAgentUsePassage(agent, door) || (!!state && !state.blocked && state.open === 1);
  }

  /** Other rooms on camera that `room`'s elevator stops at, ordered by level. */
  elevatorStops(room: Room): Room[] {
    return routing.elevatorStops(this, room);
  }

  /** Numeric staff work on their highest available floor; Admin has no floor preference. */
  workRooms(character: SimCharacter): Room[] {
    return routing.workRooms(this, character);
  }

  /** First door or elevator stop on a clearance-safe route to a work floor. */
  stepTowardWork(character: SimCharacter, room: Room, agent?: Agent): Door | Room | undefined {
    return routing.stepTowardWork(this, character, room, agent);
  }

  /** Everyone in the facility, including people riding the elevator between floors. */
  everyone(): Agent[] {
    return [...this.agents, ...this.rides.map((ride) => ride.agent)];
  }

  isRiding(agent: Agent) {
    return this.rides.some((ride) => ride.agent === agent);
  }

  isNight() {
    const hour = this.now().getHours();
    return hour < 6;
  }

  /** How many staff should be around in total, following the viewer's local time. */
  targetPopulation() {
    const hour = this.now().getHours();
    const density = hour < 6 ? DENSITY.night : hour < 8 || hour >= 20 ? DENSITY.evening : DENSITY.day;
    return Math.min(Math.max(1, Math.round(density * this.rooms.filter((room) => !room.cell).length)), this.roster.length);
  }

  presentCount() {
    return this.everyone().filter((agent) => !agent.impostor && !agent.leaving).length;
  }

  isPresent(characterId: string) {
    return this.everyone().some((agent) => !agent.impostor && agent.character.id === characterId);
  }

  agentsIn(room: Room) {
    return this.agents.filter((agent) => agent.room === room);
  }

  /** Creatures physically in `room`: a cell's resident, or any that broke out and roamed here. */
  creaturesIn(room: Room) {
    return this.creatures.filter((creature) => creature.onCamera && creature.room === room);
  }

  actorsIn(room: Room): CameraActor[] {
    return [...this.agentsIn(room), ...this.creaturesIn(room)];
  }

  /** Returns a creature that broke out to its cell (the hook for security teams to recapture it). */
  recontain(creature: Creature) {
    if (creature.contained) return;
    const from = creature.escaped ? 'outside the facility' : `the ${creature.room.name}`;
    creature.returnHome();
    this.log(`Containment restored: ${creature.character.name} was returned to ${creature.home.name} from ${from}.`, 'ok');
  }

  freeSpot(room: Room, kind: Spot['kind'], agent?: Agent): Spot | undefined {
    const taken = new Set(this.agents.map((agent) => agent.spot));
    const free = room.spots.filter((spot) => spot.kind === kind && !spot.prop.broken && !taken.has(spot) &&
      (!agent || room.route(agent, spot, agent.ghost) !== null));
    return maybePick(free);
  }

  findChatPartner(agent: Agent): Agent | undefined {
    if (agent.leaving) return undefined;
    const candidates = this.agents.filter((other) =>
      other !== agent && other.room === agent.room && !other.busy && !other.removed && Math.abs(other.x - agent.x) < CHAT_RANGE &&
      agent.room.canReach(agent, other, agent.ghost));
    return maybePick(candidates);
  }

  /** First door toward the nearest room with a way out; null if `room` has one (see routing.ts). */
  doorTowardExit(room: Room, doorsOnly = false, agent?: Agent, tailgate = false): Door | null {
    return routing.doorTowardExit(this, room, doorsOnly, agent, tailgate);
  }

  /** Puts people around the facility immediately so the cameras never start empty. */
  populate() {
    const count = Math.max(1, this.targetPopulation() - 1);
    for (let i = 0; i < count; i++) {
      const character = this.pickArrival();
      if (!character) break;
      const rooms = this.rooms.filter((room) => !room.cell && canVisitLevel(character, room.level));
      if (!rooms.length) {
        this.log(`No rooms within ${character.name}'s clearance are available.`, 'warn');
        break;
      }
      const working = scheduleFor(character, this.now()) === 'work';
      const workRooms = this.workRooms(character);
      const room = pick(working && workRooms.length && chance(0.85) ? workRooms : rooms);
      this.spawn(character, room, room.randomFloorPoint());
    }
  }

  spawn(character: SimCharacter, room: Room, at: { x: number; y: number }, impostor?: SimImpostor) {
    const agent = new Agent(character, room, at, impostor);
    agent.arrivedAt = this.time;
    agent.enteredRoomAt = this.time;
    this.agents.push(agent);
    if (impostor) {
      const resident = this.creatures.find((creature) => creature.character.id === impostor.id);
      if (resident?.contained) resident.away = true;
    }
    return agent;
  }

  pickArrival(): SimCharacter | undefined {
    const candidates = this.roster.filter((character) =>
      !this.isPresent(character.id) && (this.returnAt.get(character.id) ?? 0) <= this.time);
    return weightedPick(candidates);
  }

  arriveByElevator(character: SimCharacter, room: Room, impostor?: SimImpostor) {
    const agent = this.spawn(character, room, room.elevator!.inside, impostor);
    agent.layer = 'inside';
    agent.facing = 'front';
    agent.setPlan(this, [rideElevatorIn(this.elevatorFor(room)!.request('arrive', agent))]);
    this.log(`${character.name} arrived on ${room.label} by elevator.`, 'muted');
    return agent;
  }

  arriveByDoor(character: SimCharacter, room: Room, door: Door, impostor?: SimImpostor) {
    if (door.cell) {
      throw new Error(`${character.name} cannot enter ${room.name} through ${door.id}: containment cells are not facility entrances.`);
    }
    if (this.passageDoorFor(door)?.blocked || (!impostor && !this.canUsePassage(character, door))) {
      throw new Error(`${character.name} cannot enter ${room.name} through ${door.id}: door blocked or insufficient clearance.`);
    }
    const agent = this.spawn(character, room, door.outside, impostor);
    agent.alpha = 0;
    agent.setPlan(this, [enterThroughDoor(door)]);
    this.log(`${character.name} entered the ${room.name} from the ${door.id} corridor.`, 'muted');
    return agent;
  }

  arriveThroughWall(character: SimCharacter, room: Room) {
    const { x } = room.randomFloorPoint();
    const agent = this.spawn(character, room, { x, y: (room.topFloorY(x) ?? room.height) - 3 });
    agent.alpha = 0;
    agent.setPlan(this, [phaseThroughWall('in')]);
    this.log(`${character.name} drifted into the ${room.name} through the wall.`, 'muted');
    return agent;
  }

  /** Brings a new person (or a disguised impostor) into the facility through one of its ways in. */
  arrive(character = this.pickArrival(), impostor?: SimImpostor) {
    if (!character) return undefined;
    const ghost = character.behavior.ghost && !impostor;
    const rooms = this.rooms.filter((room) => !room.cell && (impostor || canVisitLevel(character, room.level)));
    if (!rooms.length) {
      this.log(`No rooms within ${character.name}'s clearance are available.`, 'warn');
      return undefined;
    }
    const entrances: Entrance[] = [];
    let deniedDoor = false;
    const workRooms = new Set(!impostor && scheduleFor(character, this.now()) === 'work' ? this.workRooms(character) : []);
    for (const room of rooms) {
      const preference = workRooms.has(room) ? 8 : 1;
      // Don't stack arrivals on an elevator that is already busy.
      const elevator = this.elevatorFor(room);
      if (elevator) entrances.push({ kind: 'elevator', room, weight: (elevator.busy ? 0.15 : 1.5) * preference });
      for (const door of room.outerDoors) {
        if (!this.passageDoorFor(door)?.blocked && (impostor || this.canUsePassage(character, door))) {
          entrances.push({ kind: 'door', room, door, weight: preference });
        }
        else deniedDoor = true;
      }
    }

    const entrance = weightedPick(entrances);
    if (!entrance && impostor) {
      this.log(`No entrance available for ${impostor.name}'s disguise.`, 'muted');
      return undefined;
    }
    if (!entrance && deniedDoor && !ghost) {
      this.log(`No entrances within ${character.name}'s clearance are available.`, 'warn');
      return undefined;
    }
    if (!entrance || (ghost && chance(0.4))) {
      const preferred = [...workRooms];
      return this.arriveThroughWall(character, entrance?.room ?? pick(preferred.length ? preferred : rooms));
    }
    if (entrance.kind === 'elevator') return this.arriveByElevator(character, entrance.room, impostor);
    return this.arriveByDoor(character, entrance.room, entrance.door, impostor);
  }

  /** Moves an agent through a door that leads to another room on camera. */
  transfer(agent: Agent, door: Door) {
    const unlinkedCell = door.cell && !door.to;
    if (unlinkedCell || !this.canAgentCross(agent, door)) {
      this.log(unlinkedCell
        ? `${agent.character.name} cannot enter the ${door.id} cell in ${agent.room.name}: no cell room is connected.`
        : `Access denied: ${agent.character.name} cannot use the ${door.id} door in ${agent.room.name}.`, 'warn');
      agent.x = door.inside.x;
      agent.y = door.inside.y;
      agent.alpha = 1;
      agent.leaving = false;
      agent.setPlan(this, []);
      return;
    }
    const room = door.to && this.room(door.to.room);
    const arrival = room?.doors.find((other) => other.id === door.to!.door);
    if (!room || !arrival) {
      this.remove(agent, door.id);
      return;
    }
    agent.room = room;
    agent.x = arrival.outside.x;
    agent.y = arrival.outside.y;
    agent.alpha = 0;
    agent.layer = 'room';
    agent.enteredRoomAt = this.time;
    // People who were on their way out keep heading for the exit.
    const onward = agent.leaving ? leaveFacility(agent, this, agent.revealed) : [];
    agent.setPlan(this, [enterThroughDoor(arrival), ...onward]);
  }

  /** The car has left `agent.room` with the agent inside: off camera, or to another floor on camera. */
  elevatorDeparted(agent: Agent, destination?: Room) {
    if (!destination) {
      this.remove(agent, 'elevator');
      return;
    }
    const from = agent.room;
    this.agents = this.agents.filter((other) => other !== agent);
    agent.setPlan(this, []);
    agent.spot = undefined;
    agent.room = destination;
    agent.activity = `Riding the elevator to ${destination.label}`;
    const levels = Math.abs(destination.level - from.level);
    this.rides.push({ agent, from, to: destination, arrivesAt: this.time + RIDE_SECONDS.base + RIDE_SECONDS.perLevel * levels });
  }

  /** The car reaches the rider's floor: they appear inside it and wait for the doors. */
  private deliver(ride: Ride) {
    const { agent, from, to } = ride;
    const elevator = this.elevatorFor(to);
    if (!elevator || !to.elevator) {
      this.remove(agent, 'elevator');
      return;
    }
    agent.x = to.elevator.inside.x;
    agent.y = to.elevator.inside.y;
    agent.layer = 'inside';
    agent.facing = 'front';
    agent.alpha = 1;
    agent.enteredRoomAt = this.time;
    this.agents.push(agent);
    const request = elevator.request('arrive', agent, { direction: directionTo(from, to) });
    const onward = agent.leaving ? leaveFacility(agent, this, agent.revealed) : [];
    agent.setPlan(this, [rideElevatorIn(request), ...onward]);
    this.log(`${agent.character.name} took the elevator from ${from.label} to ${to.label}.`, 'muted');
  }

  remove(agent: Agent, via: string) {
    if (agent.removed) return;
    agent.removed = true;
    agent.setPlan(this, []);
    this.agents = this.agents.filter((other) => other !== agent);
    const name = agent.character.name;
    const { room } = agent;

    if (agent.impostor) {
      const resident = this.creatures.find((creature) => creature.character.id === agent.impostor!.id && creature.away);
      if (resident) {
        resident.away = false;
        this.log(`Containment restored: ${resident.character.name} is back in ${resident.room.name}.`, 'ok');
      } else if (agent.revealed) this.log(`${agent.impostor.name} escaped ${room.label}. Containment team dispatched.`, 'alert');
      else this.log(`Duplicate badge signal for ${name} lost. Subject left ${room.label} unidentified.`, 'warn');
    } else {
      this.returnAt.set(agent.character.id, this.time + range(RETURN_DELAY_SECONDS.min, RETURN_DELAY_SECONDS.max));
      if (via === 'elevator') this.log(`${name} took the elevator.`, 'muted');
      else if (via === 'wall') {
        this.log(`${name} phased through the wall of the ${room.name}.`, 'muted');
        this.achieve('ghost-story', room);
      } else this.log(`${name} left the ${room.name} through the ${via} door.`, 'muted');
    }
    this.hooks.removed?.(agent);
  }

  /** Player clicked someone on the feed. */
  interact(agent: Agent): 'revealed' | 'woke' | 'verified' | null {
    if (agent.impostor && !agent.revealed) {
      agent.revealed = true;
      agent.say('!', 3);
      this.log(`Shapeshifter identified: ${agent.impostor.name} "${agent.impostor.nickname}" was posing as ${agent.character.name}!`, 'alert');
      this.achieve('doppelganger');
      agent.setPlan(this, leaveFacility(agent, this, true));
      return 'revealed';
    }

    if (agent.napping) {
      agent.setPlan(this, []);
      agent.say('!', 1.5);
      this.log(`${agent.character.name} was woken up by a camera ping.`, 'default');
      this.achieve('rude-awakening');
      return 'woke';
    }

    const twin = this.everyone().find((other) => other.impostor && !other.revealed && other.character.id === agent.character.id);
    if (twin && !agent.impostor) {
      this.log(`Badge ${agent.character.employeeID} verified: this ${agent.character.name} is genuine.`, 'ok');
      return 'verified';
    }
    return null;
  }

  private updateSparks(source: object, room: Room, area: Rect | null, dt: number, depth?: number, emitter?: Prop) {
    if (!area) {
      this.sparkDelays.delete(source);
      return;
    }
    if (!Number.isFinite(dt) || dt < 0) return;
    const remaining = (this.sparkDelays.get(source) ?? 0) - dt;
    if (remaining <= 0) {
      this.particles.burst(room, 'sparks', area, depth, emitter, this.time);
      // Emit at most once per update rather than replaying missed bursts after a long frame.
      this.sparkDelays.set(source,
        range(SPARK_PAUSE_SECONDS.min, SPARK_PAUSE_SECONDS.max));
    } else {
      this.sparkDelays.set(source, remaining);
    }
  }

  update(dt: number) {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('World update needs a finite, non-negative timestep.');
    this.particles.update(dt);
    const frameStart = this.time;
    this.time += dt;
    for (const level of this.levels.values()) level.update(frameStart, dt);
    const statuses = new Set<StatusEffects>();
    const blockedSeconds = new Map<Agent, number>();
    for (const agent of this.everyone()) {
      if (agent.removed) continue;
      blockedSeconds.set(agent, Math.min(dt, agent.statuses.actionBlockRemaining));
      statuses.add(agent.statuses);
      if (agent.item) statuses.add(agent.item.statuses);
      for (const item of agent.inventory) statuses.add(item.statuses);
    }
    for (const room of this.rooms) {
      for (const prop of room.props) statuses.add(prop.statuses);
      for (const item of room.items) statuses.add(item.statuses);
      for (const door of room.doors) {
        const state = this.passageDoorFor(door);
        if (!state) continue;
        statuses.add(state.statuses);
        statuses.add(state.panelStatuses);
      }
    }
    for (const effects of statuses) effects.update(this, dt);
    for (const elevator of this.elevators.values()) elevator.update(this, dt);
    this.passages.update(this, dt);

    const arrived = this.rides.filter((ride) => ride.arrivesAt <= this.time);
    if (arrived.length) {
      this.rides = this.rides.filter((ride) => ride.arrivesAt > this.time);
      for (const ride of arrived) this.deliver(ride);
    }

    this.nextArrival -= dt;
    if (this.nextArrival <= 0) {
      this.nextArrival = range(ARRIVAL_INTERVAL_SECONDS.min, ARRIVAL_INTERVAL_SECONDS.max);
      if (this.presentCount() < this.targetPopulation()) this.arrive();
    }

    for (const agent of [...this.agents]) {
      if (agent.removed || agent.held) continue;
      // Whoever is sitting on, or heading for, a prop that broke gives up on it.
      const seat = agent.spot?.prop;
      if (seat?.broken && !agent.tripping) {
        if (agent.sitting) {
          agent.say('!', 1.5);
          this.log(`${agent.character.name}'s ${seat.type} broke in the ${agent.room.name}.`, 'warn');
        }
        agent.setPlan(this, []);
      }
      const from = { x: agent.x, y: agent.y };
      const room = agent.room;
      agent.update(this, dt, blockedSeconds.get(agent) ?? 0);
      if (dt > 0 && agent.moving && agent.room === room) checkElectricalApproach(agent, this, from);
    }

    for (const creature of this.creatures) creature.update(this, dt);
    for (const room of this.rooms) {
      room.updateLights(this.actorsIn(room).length > 0, dt);
      for (const prop of room.props) {
        prop.updateFlicker(dt);
        const breaks = prop.takeBreaks();
        if (breaks) {
          const debris = prop.breakParticles;
          if (debris) {
            for (let i = 0; i < breaks; i++) {
              this.particles.burst(room, debris.set, debris.area, debris.depth, prop, this.time);
            }
          }
        }
        this.updateSparks(prop, room, prop.sparkArea, dt, prop.y + prop.h, prop);
      }
      for (const door of room.doors) {
        const art = door.appearance;
        if (!art) continue;
        const bounds = passagePartBounds(door.side, art);
        const state = this.passageDoorFor(door);
        const panel = state?.powered && state.panelBroken ? bounds.panel : null;
        this.updateSparks(door, room, panel, dt, bounds.door.y + bounds.door.h);
      }
    }
  }
}
