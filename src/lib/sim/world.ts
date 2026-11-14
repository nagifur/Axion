import { Agent, enterThroughDoor, leaveFacility, phaseThroughWall, rideElevatorIn } from './agent.ts';
import type { SimCharacter, SimImpostor } from './roster.ts';
import { directionTo, type Direction, type Door, type Room, type Spot } from './room.ts';

export type LogTone = 'default' | 'muted' | 'ok' | 'warn' | 'alert';

export interface ElevatorRequest {
  type: 'depart' | 'arrive';
  agent: Agent;
  /** Which way the car is travelling, shown on the arrow lights. */
  direction: Direction;
  /** Floor on camera the rider is going to; unset means off camera. */
  destination?: Room;
  /** Doors are open and the rider can move. */
  board: boolean;
  /** Rider is fully in (depart) or out (arrive); doors may close. */
  ready: boolean;
  /** The rider changed plans before boarding; the car leaves without them. */
  cancelled: boolean;
}

const DOOR_SECONDS = 0.7;
/** Seconds the car takes between floors on camera: a fixed part plus a part per level travelled. */
const RIDE_SECONDS = { base: 2, perLevel: 2 };

const randomDirection = (): Direction => (Math.random() < 0.5 ? 'up' : 'down');

/** The doors, lights and queue of one elevator stop. */
export class Elevator {
  /** 0 = closed, 1 = fully open. */
  open = 0;
  phase: 'idle' | 'arriving' | 'opening' | 'holding' | 'closing' | 'leaving' = 'idle';
  light: Direction | null = null;
  private timer = 0;
  private queue: ElevatorRequest[] = [];
  private current?: ElevatorRequest;

  request(type: ElevatorRequest['type'], agent: Agent, options: { direction?: Direction; destination?: Room } = {}): ElevatorRequest {
    const request: ElevatorRequest = {
      type, agent, board: false, ready: false, cancelled: false,
      destination: options.destination,
      direction: options.direction ?? randomDirection(),
    };
    this.queue.push(request);
    return request;
  }

  get busy() {
    return this.phase !== 'idle' || this.queue.length > 0;
  }

  update(world: World, dt: number) {
    const current = this.current;
    switch (this.phase) {
      case 'idle': {
        this.light = null;
        const next = this.queue.shift();
        if (!next) return;
        this.current = next;
        this.phase = 'arriving';
        this.timer = 1.4;
        this.light = next.direction;
        return;
      }
      case 'arriving':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.light = null;
          this.phase = current && !current.agent.removed && !current.cancelled ? 'opening' : 'idle';
        }
        return;
      case 'opening':
        this.open = Math.min(1, this.open + dt / DOOR_SECONDS);
        if (this.open >= 1) {
          this.phase = 'holding';
          this.timer = 12;
          if (current) current.board = true;
        }
        return;
      case 'holding': {
        this.timer -= dt;
        // Departing riders are always waited for (unless they change plans); arrivals have a safety timeout.
        const timedOut = this.timer <= 0 && current?.type === 'arrive';
        if (!current || current.ready || current.cancelled || current.agent.removed || timedOut) this.phase = 'closing';
        return;
      }
      case 'closing':
        this.open = Math.max(0, this.open - dt / DOOR_SECONDS);
        if (this.open > 0) return;
        if (current?.type === 'depart' && current.ready && !current.agent.removed) {
          this.phase = 'leaving';
          this.timer = 1.2;
          this.light = current.direction;
        } else {
          this.finish();
        }
        return;
      case 'leaving':
        this.timer -= dt;
        if (this.timer <= 0) {
          if (current && !current.agent.removed) world.elevatorDeparted(current.agent, current.destination);
          this.finish();
        }
        return;
    }
  }

  private finish() {
    this.current = undefined;
    this.phase = 'idle';
    this.light = null;
  }
}

export interface WorldOptions {
  roster: SimCharacter[];
  rooms: Room[];
  now?: () => Date;
}

export interface WorldHooks {
  log?: (text: string, tone: LogTone) => void;
  /** `room` is set for things that only count when seen on that room's camera. */
  achieve?: (id: string, room?: Room) => void;
  removed?: (agent: Agent) => void;
}

const weightedPick = <T extends { weight: number }>(items: T[]): T | undefined => {
  let roll = Math.random() * items.reduce((sum, item) => sum + item.weight, 0);
  return items.find((item) => (roll -= item.weight) <= 0) ?? items.at(-1);
};
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

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
  readonly roster: SimCharacter[];
  readonly rooms: Room[];
  readonly now: () => Date;
  hooks: WorldHooks = {};
  private readonly elevators = new Map<Room, Elevator>();
  private rides: Ride[] = [];
  /** Earliest time each off-camera character may come back. */
  private returnAt = new Map<string, number>();
  private nextArrival = 3;

  constructor(options: WorldOptions) {
    this.roster = options.roster;
    this.rooms = options.rooms;
    this.now = options.now ?? (() => new Date());
    for (const room of this.rooms) {
      if (room.elevator) this.elevators.set(room, new Elevator());
    }
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

  elevatorFor(room: Room): Elevator | undefined {
    return this.elevators.get(room);
  }

  /** Other rooms on camera that `room`'s elevator stops at, ordered by level. */
  elevatorStops(room: Room): Room[] {
    const shaft = room.elevator?.shaft;
    if (!shaft) return [];
    return this.rooms.filter((other) => other !== room && other.elevator?.shaft === shaft).sort((a, b) => a.level - b.level);
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
    return Math.min(Math.max(1, Math.round(density * this.rooms.length)), this.roster.length);
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

  freeSpot(room: Room, kind: Spot['kind']): Spot | undefined {
    const taken = new Set(this.agents.map((agent) => agent.spot?.id));
    const free = room.spots.filter((spot) => spot.kind === kind && !spot.prop.broken && !taken.has(spot.id));
    return free[Math.floor(Math.random() * free.length)];
  }

  findChatPartner(agent: Agent): Agent | undefined {
    if (agent.leaving) return undefined;
    const candidates = this.agents.filter((other) =>
      other !== agent && other.room === agent.room && !other.busy && !other.removed && Math.abs(other.x - agent.x) < 260);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /**
   * First door to take from `room` to reach the nearest room with a way out of the facility.
   * Null if `room` already has one. With `doorsOnly`, elevators don't count as a way out.
   */
  doorTowardExit(room: Room, doorsOnly = false): Door | null {
    const hasExit = (candidate: Room) => (doorsOnly ? candidate.outerDoors.length > 0 : candidate.hasOuterExit);
    if (hasExit(room)) return null;
    const firstDoor = new Map<Room, Door>();
    const queue: Room[] = [room];
    const seen = new Set([room]);
    while (queue.length) {
      const current = queue.shift()!;
      for (const door of current.linkedDoors) {
        const next = this.room(door.to!.room);
        if (!next || seen.has(next)) continue;
        seen.add(next);
        firstDoor.set(next, firstDoor.get(current) ?? door);
        if (hasExit(next)) return firstDoor.get(next)!;
        queue.push(next);
      }
    }
    return null;
  }

  /** Puts people around the facility immediately so the cameras never start empty. */
  populate() {
    const count = Math.max(1, this.targetPopulation() - 1);
    for (let i = 0; i < count; i++) {
      const character = this.pickArrival();
      if (!character) break;
      const room = pick(this.rooms);
      this.spawn(character, room, room.randomFloorPoint());
    }
  }

  spawn(character: SimCharacter, room: Room, at: { x: number; y: number }, impostor?: SimImpostor) {
    const agent = new Agent(character, room, at, impostor);
    agent.arrivedAt = this.time;
    agent.enteredRoomAt = this.time;
    this.agents.push(agent);
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
    const entrances: Entrance[] = [];
    for (const room of this.rooms) {
      // Don't stack arrivals on an elevator that is already busy.
      const elevator = this.elevatorFor(room);
      if (elevator) entrances.push({ kind: 'elevator', room, weight: elevator.busy ? 0.15 : 1.5 });
      for (const door of room.outerDoors) entrances.push({ kind: 'door', room, door, weight: 1 });
    }

    const entrance = weightedPick(entrances);
    if (!entrance || (ghost && Math.random() < 0.4)) return this.arriveThroughWall(character, entrance?.room ?? pick(this.rooms));
    if (entrance.kind === 'elevator') return this.arriveByElevator(character, entrance.room, impostor);
    return this.arriveByDoor(character, entrance.room, entrance.door, impostor);
  }

  /** Moves an agent through a door that leads to another room on camera. */
  transfer(agent: Agent, door: Door) {
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
      if (agent.revealed) this.log(`${agent.impostor.name} escaped ${room.label}. Containment team dispatched.`, 'alert');
      else this.log(`Duplicate badge signal for ${name} lost. Subject left ${room.label} unidentified.`, 'warn');
    } else {
      this.returnAt.set(agent.character.id, this.time + 45 + Math.random() * 120);
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

  update(dt: number) {
    this.time += dt;
    for (const elevator of this.elevators.values()) elevator.update(this, dt);

    const arrived = this.rides.filter((ride) => ride.arrivesAt <= this.time);
    if (arrived.length) {
      this.rides = this.rides.filter((ride) => ride.arrivesAt > this.time);
      for (const ride of arrived) this.deliver(ride);
    }

    this.nextArrival -= dt;
    if (this.nextArrival <= 0) {
      this.nextArrival = 4 + Math.random() * 8;
      if (this.presentCount() < this.targetPopulation()) this.arrive();
    }

    for (const agent of [...this.agents]) {
      if (agent.removed) continue;
      // Whoever is sitting on, or heading for, a prop that broke gives up on it.
      const seat = agent.spot?.prop;
      if (seat?.broken) {
        if (agent.sitting) {
          agent.say('!', 1.5);
          this.log(`${agent.character.name}'s ${seat.type} broke in the ${agent.room.name}.`, 'warn');
        }
        agent.setPlan(this, []);
      }
      agent.update(this, dt);
    }

    for (const room of this.rooms) room.updateLights(this.agentsIn(room).length > 0, dt);
  }
}
