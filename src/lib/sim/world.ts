import { Agent, enterThroughDoor, exitThroughDoor, phaseThroughWall, rideElevatorIn } from './agent';
import type { SimCharacter, SimImpostor } from './roster';
import { DOORS, ELEVATOR, SPOTS, randomFloorPoint, type Door, type Spot } from './room';

export type LogTone = 'default' | 'muted' | 'ok' | 'warn' | 'alert';

export interface ElevatorRequest {
  type: 'depart' | 'arrive';
  agent: Agent;
  /** Doors are open and the rider can move. */
  board: boolean;
  /** Rider is fully in (depart) or out (arrive); doors may close. */
  ready: boolean;
}

const DOOR_SECONDS = 0.7;

export class Elevator {
  /** 0 = closed, 1 = fully open. */
  open = 0;
  phase: 'idle' | 'arriving' | 'opening' | 'holding' | 'closing' | 'leaving' = 'idle';
  light: 'up' | 'down' | null = null;
  private timer = 0;
  private queue: ElevatorRequest[] = [];
  private current?: ElevatorRequest;

  request(type: ElevatorRequest['type'], agent: Agent): ElevatorRequest {
    const request: ElevatorRequest = { type, agent, board: false, ready: false };
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
        this.light = 'up';
        return;
      }
      case 'arriving':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.light = null;
          this.phase = current && !current.agent.removed ? 'opening' : 'idle';
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
      case 'holding':
        this.timer -= dt;
        if (!current || current.ready || current.agent.removed || this.timer <= 0) this.phase = 'closing';
        return;
      case 'closing':
        this.open = Math.max(0, this.open - dt / DOOR_SECONDS);
        if (this.open > 0) return;
        if (current?.type === 'depart' && !current.agent.removed) {
          this.phase = 'leaving';
          this.timer = 1.2;
          this.light = 'down';
        } else {
          this.finish();
        }
        return;
      case 'leaving':
        this.timer -= dt;
        if (this.timer <= 0) {
          if (current && !current.agent.removed) world.remove(current.agent, 'elevator');
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
  now?: () => Date;
}

export interface WorldHooks {
  log?: (text: string, tone: LogTone) => void;
  achieve?: (id: string) => void;
  removed?: (agent: Agent) => void;
}

const weightedPick = <T extends { weight: number }>(items: T[]): T | undefined => {
  let roll = Math.random() * items.reduce((sum, item) => sum + item.weight, 0);
  return items.find((item) => (roll -= item.weight) <= 0) ?? items.at(-1);
};

export class World {
  time = 0;
  agents: Agent[] = [];
  readonly elevator = new Elevator();
  readonly roster: SimCharacter[];
  readonly now: () => Date;
  hooks: WorldHooks = {};
  /** Earliest time each off-camera character may come back. */
  private returnAt = new Map<string, number>();
  private nextArrival = 3;

  constructor(options: WorldOptions) {
    this.roster = options.roster;
    this.now = options.now ?? (() => new Date());
  }

  log(text: string, tone: LogTone = 'default') {
    this.hooks.log?.(text, tone);
  }

  achieve(id: string) {
    this.hooks.achieve?.(id);
  }

  isNight() {
    const hour = this.now().getHours();
    return hour < 6;
  }

  /** How many staff should be on camera, following the viewer's local time. */
  targetPopulation() {
    const hour = this.now().getHours();
    const target = hour < 6 ? 2 : hour < 8 || hour >= 20 ? 4 : 6;
    return Math.min(target, this.roster.length);
  }

  presentCount() {
    return this.agents.filter((agent) => !agent.impostor && !agent.leaving).length;
  }

  isPresent(characterId: string) {
    return this.agents.some((agent) => !agent.impostor && agent.character.id === characterId);
  }

  freeSpot(kind: Spot['kind']): Spot | undefined {
    const taken = new Set(this.agents.map((agent) => agent.spot?.id));
    const free = SPOTS.filter((spot) => spot.kind === kind && !taken.has(spot.id));
    return free[Math.floor(Math.random() * free.length)];
  }

  findChatPartner(agent: Agent): Agent | undefined {
    if (agent.leaving) return undefined;
    const candidates = this.agents.filter((other) =>
      other !== agent && !other.busy && !other.removed && Math.abs(other.x - agent.x) < 260);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** Puts the first few people on camera immediately so the feed never starts empty. */
  populate() {
    const count = Math.max(1, this.targetPopulation() - 1);
    for (let i = 0; i < count; i++) {
      const character = this.pickArrival();
      if (!character) break;
      this.spawn(character, randomFloorPoint());
    }
  }

  spawn(character: SimCharacter, at: { x: number; y: number }, impostor?: SimImpostor) {
    const agent = new Agent(character, at, impostor);
    agent.arrivedAt = this.time;
    this.agents.push(agent);
    return agent;
  }

  pickArrival(): SimCharacter | undefined {
    const candidates = this.roster.filter((character) =>
      !this.isPresent(character.id) && (this.returnAt.get(character.id) ?? 0) <= this.time);
    return weightedPick(candidates);
  }

  arriveByElevator(character: SimCharacter) {
    const agent = this.spawn(character, ELEVATOR.inside);
    agent.layer = 'inside';
    agent.facing = 'front';
    agent.setPlan(this, [rideElevatorIn(this.elevator.request('arrive', agent))]);
    this.log(`${character.name} arrived on Level 1 by elevator.`, 'muted');
    return agent;
  }

  arriveByDoor(character: SimCharacter, door: Door = DOORS[Math.floor(Math.random() * DOORS.length)], impostor?: SimImpostor) {
    const agent = this.spawn(character, door.outside, impostor);
    agent.alpha = 0;
    agent.setPlan(this, [enterThroughDoor(door)]);
    this.log(`${character.name} entered from the ${door.id} corridor.`, 'muted');
    return agent;
  }

  arriveThroughWall(character: SimCharacter) {
    const agent = this.spawn(character, { x: Math.round(300 + Math.random() * 180), y: 146 });
    agent.alpha = 0;
    agent.setPlan(this, [phaseThroughWall('in')]);
    this.log(`${character.name} drifted in through the wall.`, 'muted');
    return agent;
  }

  /** Brings a new person onto the floor. */
  arrive(character = this.pickArrival()) {
    if (!character) return undefined;
    if (character.behavior.ghost && Math.random() < 0.4) return this.arriveThroughWall(character);
    return Math.random() < 0.6 ? this.arriveByElevator(character) : this.arriveByDoor(character);
  }

  remove(agent: Agent, via: string) {
    if (agent.removed) return;
    agent.removed = true;
    agent.setPlan(this, []);
    this.agents = this.agents.filter((other) => other !== agent);
    const name = agent.character.name;

    if (agent.impostor) {
      if (agent.revealed) this.log(`${agent.impostor.name} escaped Level 1. Containment team dispatched.`, 'alert');
      else this.log(`Duplicate badge signal for ${name} lost. Subject left Level 1 unidentified.`, 'warn');
    } else {
      this.returnAt.set(agent.character.id, this.time + 45 + Math.random() * 120);
      if (via === 'elevator') this.log(`${name} took the elevator.`, 'muted');
      else if (via === 'wall') {
        this.log(`${name} phased through the wall.`, 'muted');
        this.achieve('ghost-story');
      } else this.log(`${name} left through the ${via} door.`, 'muted');
    }
    this.hooks.removed?.(agent);
  }

  /** Player clicked someone on the feed. */
  interact(agent: Agent): 'revealed' | 'woke' | 'verified' | null {
    if (agent.impostor && !agent.revealed) {
      agent.revealed = true;
      agent.leaving = true;
      agent.say('!', 3);
      this.log(`Shapeshifter identified: ${agent.impostor.name} "${agent.impostor.nickname}" was posing as ${agent.character.name}!`, 'alert');
      this.achieve('doppelganger');
      const door = DOORS.reduce((best, door) =>
        Math.abs(door.inside.x - agent.x) < Math.abs(best.inside.x - agent.x) ? door : best);
      agent.setPlan(this, [exitThroughDoor(door, 2.2)]);
      return 'revealed';
    }

    if (agent.napping) {
      agent.setPlan(this, []);
      agent.say('!', 1.5);
      this.log(`${agent.character.name} was woken up by a camera ping.`, 'default');
      this.achieve('rude-awakening');
      return 'woke';
    }

    const twin = this.agents.find((other) => other.impostor && !other.revealed && other.character.id === agent.character.id);
    if (twin && !agent.impostor) {
      this.log(`Badge ${agent.character.employeeID} verified: this ${agent.character.name} is genuine.`, 'ok');
      return 'verified';
    }
    return null;
  }

  update(dt: number) {
    this.time += dt;
    this.elevator.update(this, dt);

    this.nextArrival -= dt;
    if (this.nextArrival <= 0) {
      this.nextArrival = 6 + Math.random() * 10;
      // Don't stack arrivals on a busy elevator; walking in through a door is fine.
      if (this.presentCount() < this.targetPopulation()) {
        const character = this.pickArrival();
        if (character && this.elevator.busy && !character.behavior.ghost) this.arriveByDoor(character);
        else this.arrive(character);
      }
    }

    for (const agent of [...this.agents]) {
      if (!agent.removed) agent.update(this, dt);
    }
  }
}
