import { canVisitLevel, type SimCharacter, type SimImpostor } from './roster.ts';
import { directionTo, type Door, type Facing, type Point, type Room, type Spot } from './room.ts';
import { CHARACTER_FRAMES, IDLE_CYCLES, IDLE_FRAME_SECONDS, SIT_CYCLES, TALK_RIGHT_CYCLE, WALK_CYCLES, WALK_STRIDE, type FrameName } from './sprites.ts';
import type { ElevatorRequest, World } from './world.ts';

export type Bubble = 'zZ' | '!' | '…' | '?' | 'Meow!' | null;

/** A unit of behaviour. Agents run one task at a time from their plan. */
export interface Task {
  activity: string;
  /** Whether a coworker can pull the agent into a conversation mid-task. */
  interruptible: boolean;
  /** This task takes place while seated at a reserved spot. */
  sitting?: boolean;
  start?(agent: Agent, world: World): void;
  /** Returns true when the task is finished. */
  update(agent: Agent, world: World, dt: number): boolean;
  end?(agent: Agent, world: World): void;
}

const BASE_SPEED = 28;
let nextUid = 1;

export class Agent {
  readonly uid = nextUid++;
  readonly character: SimCharacter;
  readonly impostor?: SimImpostor;
  revealed = false;
  /** The room this agent is currently in. */
  room: Room;

  x: number;
  y: number;
  facing: Facing = 'front';
  moving = false;
  walkDistance = 0;
  private idleElapsed = 0;
  layer: 'room' | 'inside' = 'room';
  alpha = 1;

  bubble: Bubble = null;
  private bubbleTimer = 0;
  activity = 'Arriving';
  /** When they entered the facility, and when they entered their current room. */
  arrivedAt = 0;
  enteredRoomAt = 0;
  leaving = false;
  removed = false;
  napping = false;
  spot?: Spot;
  conversation?: Conversation;
  shake = 0;
  eyeFlash = 0;
  expiresAt = Infinity;

  private task?: Task;
  private plan: Task[] = [];

  constructor(character: SimCharacter, room: Room, at: Point, impostor?: SimImpostor) {
    this.character = character;
    this.room = room;
    this.impostor = impostor;
    this.x = at.x;
    this.y = at.y;
  }

  get ghost() {
    return this.character.behavior.ghost && !this.impostor;
  }

  get busy() {
    return !this.task?.interruptible || this.napping || !!this.conversation || this.leaving;
  }

  get sitting() {
    return !!this.task?.sitting && !this.moving;
  }

  get frame(): { name: FrameName; flip: boolean } {
    const speaking = this.conversation && isSpeaking(this.conversation, this);
    const cycle = this.moving ? WALK_CYCLES[this.facing]
      : this.sitting ? SIT_CYCLES[this.facing]
      : speaking && (this.facing === 'left' || this.facing === 'right') ? TALK_RIGHT_CYCLE
      : IDLE_CYCLES[this.facing];
    const phase = this.moving ? this.walkDistance / WALK_STRIDE : this.idleElapsed / IDLE_FRAME_SECONDS;
    return { name: cycle[Math.floor(phase) % cycle.length], flip: this.facing === 'left' };
  }

  get height() {
    return CHARACTER_FRAMES.idleRight1.h * this.character.scale;
  }

  say(bubble: Bubble, seconds = 2) {
    this.bubble = bubble;
    this.bubbleTimer = seconds;
  }

  face(target: Point) {
    if (Math.abs(target.x - this.x) < 2) return;
    this.facing = target.x < this.x ? 'left' : 'right';
  }

  /** Replaces whatever the agent is doing. */
  setPlan(world: World, tasks: Task[]) {
    this.task?.end?.(this, world);
    this.task = undefined;
    this.spot = undefined;
    this.plan = tasks;
  }

  /** Pauses the current task to run another one first, then resumes. */
  interrupt(world: World, task: Task) {
    if (this.task) this.plan.unshift(this.task);
    this.task = task;
    task.start?.(this, world);
    this.activity = task.activity;
  }

  moveToward(target: Point, dt: number, speedMul = 1): boolean {
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const distance = Math.hypot(dx, dy);
    const step = BASE_SPEED * this.character.behavior.speed * speedMul * Math.max(0, dt);
    const travelled = Math.min(step, distance);
    if (travelled > 0) {
      this.walkDistance += travelled;
      this.moving = true;
      this.facing = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'back' : 'front');
    }
    if (distance <= step) {
      this.x = target.x;
      this.y = target.y;
      return true;
    }
    this.x += (dx / distance) * step;
    this.y += (dy / distance) * step;
    return false;
  }

  update(world: World, dt: number) {
    this.moving = false;
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0 && !this.napping) this.bubble = null;
    }
    this.shake = Math.max(0, this.shake - dt);
    this.eyeFlash = Math.max(0, this.eyeFlash - dt);

    if (!this.task) {
      if (!this.plan.length) this.plan = planNext(this, world);
      this.task = this.plan.shift();
      this.task?.start?.(this, world);
      if (this.task) this.activity = this.task.activity;
    }
    const task = this.task;
    // Tasks can replace themselves (trips) or remove the agent, so only end the one that ran.
    if (task && task.update(this, world, dt) && this.task === task) {
      task.end?.(this, world);
      this.task = undefined;
    }
    this.idleElapsed = this.moving ? 0 : (this.idleElapsed + Math.max(0, dt)) % (IDLE_FRAME_SECONDS * 2);
  }
}

// ---------------------------------------------------------------------------
// Tasks

const range = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function walkTo(target: Point, activity = 'Walking', speedMul = 1): Task {
  let path: Point[] = [];
  return {
    activity,
    interruptible: true,
    start(agent, world) {
      path = agent.room.route(agent, target, agent.ghost);
    },
    update(agent, world, dt) {
      if (!path.length) return true;
      const tripChance = (agent.character.behavior.clumsy ? 0.006 : 0) + agent.room.darkness * 0.012;
      if (tripChance > 0 && !agent.impostor && Math.random() < dt * tripChance) {
        agent.interrupt(world, trip());
        return false;
      }
      if (agent.moveToward(path[0], dt, speedMul)) path.shift();
      return path.length === 0;
    },
  };
}

export function wait(seconds: number, activity: string, facing?: Facing): Task {
  let left = seconds;
  return {
    activity,
    interruptible: true,
    start(agent) {
      if (facing) agent.facing = facing;
    },
    update(_agent, _world, dt) {
      left -= dt;
      return left <= 0;
    },
  };
}

export function nap(seconds: number, facing: Facing): Task {
  let left = seconds;
  return {
    activity: 'Napping',
    interruptible: false,
    start(agent, world) {
      agent.facing = facing;
      agent.napping = true;
      agent.bubble = 'zZ';
      world.log(`${agent.character.name} dozed off in the ${agent.room.name}.`, 'muted');
    },
    update(_agent, _world, dt) {
      left -= dt;
      return left <= 0;
    },
    end(agent) {
      agent.napping = false;
      agent.bubble = null;
    },
  };
}

export function trip(): Task {
  let left = 1.3;
  return {
    activity: 'Picking themselves up',
    interruptible: false,
    start(agent, world) {
      agent.shake = 0.5;
      agent.say('!', 1.3);
      world.log(`${agent.character.name} tripped over their own feet in the ${agent.room.name}.`, 'muted');
      world.achieve('watch-your-step', agent.room);
    },
    update(_agent, _world, dt) {
      left -= dt;
      return left <= 0;
    },
  };
}

export interface Conversation {
  initiator: Agent;
  partner: Agent;
  started: boolean;
  ended: boolean;
  elapsed: number;
}

function isSpeaking(conversation: Conversation, agent: Agent) {
  const turn = Math.floor(conversation.elapsed / 1.6) % 2;
  return conversation.started && !conversation.ended && ((turn === 0) === (agent === conversation.initiator));
}

function chatBubble(conversation: Conversation, agent: Agent) {
  agent.bubble = isSpeaking(conversation, agent) ? '…' : null;
}

function meow(agent: Agent, world: World) {
  agent.say('Meow!', 1.3);
  world.log(`${agent.character.name} meowed in the ${agent.room.name}.`, 'muted');
}


function talk(conversation: Conversation, seconds: number): Task {
  const { partner } = conversation;
  return {
    activity: `Chatting with ${partner.character.name}`,
    interruptible: false,
    start(agent) {
      conversation.started = true;
      agent.face(partner);
    },
    update(agent, _world, dt) {
      conversation.elapsed += dt;
      chatBubble(conversation, agent);
      return conversation.elapsed >= seconds || partner.removed || conversation.ended;
    },
    end(agent) {
      conversation.ended = true;
      agent.conversation = undefined;
      agent.bubble = null;
    },
  };
}

function listen(conversation: Conversation): Task {
  const { initiator } = conversation;
  let waited = 0;
  return {
    activity: `Chatting with ${initiator.character.name}`,
    interruptible: false,
    update(agent, _world, dt) {
      waited += dt;
      agent.face(initiator);
      chatBubble(conversation, agent);
      return conversation.ended || initiator.removed || (!conversation.started && waited > 20);
    },
    end(agent) {
      conversation.ended = true;
      agent.conversation = undefined;
      agent.bubble = null;
    },
  };
}

function startConversation(agent: Agent, partner: Agent, world: World): Task[] | null {
  const offset = agent.x < partner.x ? -24 : 24;
  const spots = [{ x: partner.x + offset, y: partner.y }, { x: partner.x - offset, y: partner.y }];
  const meet = spots.find((spot) => agent.room.isWalkable(spot));
  if (!meet) return null;

  const conversation: Conversation = { initiator: agent, partner, started: false, ended: false, elapsed: 0 };
  agent.conversation = conversation;
  partner.setPlan(world, [listen(conversation)]);
  partner.conversation = conversation;
  return [walkTo(meet, `Going to talk to ${partner.character.name}`), talk(conversation, range(6, 12))];
}

/** Walks to the elevator, waits for the car, and rides it to `destination` (another floor on camera) or off camera. */
export function rideElevatorOut(destination?: Room): Task {
  let path: Point[] = [];
  let request: ElevatorRequest | undefined;
  return {
    activity: 'Heading to the elevator',
    interruptible: false,
    start(agent) {
      const { front } = agent.room.elevator!;
      const waitSpot = agent.room.nearestWalkable({ x: front.x + Math.round(range(-10, 10)), y: front.y });
      path = agent.room.route(agent, waitSpot, agent.ghost);
    },
    update(agent, world, dt) {
      if (path.length) {
        if (agent.moveToward(path[0], dt)) path.shift();
        return false;
      }
      const elevator = agent.room.elevator!;
      if (!request) {
        const direction = destination ? directionTo(agent.room, destination) : undefined;
        request = world.elevatorFor(agent.room)!.request('depart', agent, { destination, direction });
        agent.facing = 'back';
        agent.activity = destination ? `Waiting for the elevator to ${destination.label}` : 'Waiting for the elevator';
      }
      if (request.board && !request.ready) {
        agent.activity = 'Taking the elevator';
        if (agent.y < elevator.thresholdY) agent.layer = 'inside';
        if (agent.moveToward(elevator.inside, dt)) {
          agent.facing = 'front';
          request.ready = true;
        }
      }
      return false;
    },
    end(agent) {
      // Plans changed before boarding (e.g. an impostor was unmasked): let the car go without them.
      if (request && !request.ready) {
        request.cancelled = true;
        agent.layer = 'room';
      }
    },
  };
}

/** Steps out of an elevator car that has arrived on this floor. */
export function rideElevatorIn(request: ElevatorRequest): Task {
  let exit: Point | undefined;
  return {
    activity: 'Arriving by elevator',
    interruptible: false,
    update(agent, world, dt) {
      if (!request.board) return false;
      const elevator = agent.room.elevator!;
      exit ??= agent.room.nearestWalkable({
        x: elevator.front.x + Math.round(range(-14, 14)),
        y: elevator.front.y + Math.round(range(2, 14)),
      });
      const done = agent.moveToward(exit, dt);
      if (agent.y > elevator.thresholdY) {
        agent.layer = 'room';
        request.ready = true;
      }
      return done;
    },
    end(agent) {
      // Interrupted before stepping out: free the elevator and walk out from where they are.
      if (!request.ready) {
        request.ready = true;
        agent.layer = 'room';
      }
    },
  };
}

/** Walks out through a door: into the next room if it leads to one, otherwise off camera. */
export function exitThroughDoor(door: Door, speedMul = 1, activity = 'Heading out'): Task {
  let path: Point[] = [];
  let fading = false;
  return {
    activity,
    interruptible: false,
    start(agent) {
      path = agent.room.route(agent, door.inside, agent.ghost);
    },
    update(agent, world, dt) {
      if (!fading) {
        if (agent.moveToward(path[0], dt, speedMul)) path.shift();
        fading = path.length === 0;
        return false;
      }
      const total = Math.max(1, distance(door.outside, door.inside));
      const reached = agent.moveToward(door.outside, dt, speedMul);
      poseInDoorway(agent, door, 'out');
      agent.alpha = Math.max(0, distance(door.outside, agent) / total);
      if (reached) {
        if (door.to) world.transfer(agent, door);
        else world.remove(agent, door.id);
      }
      return reached;
    },
  };
}

export function enterThroughDoor(door: Door): Task {
  return {
    activity: 'Arriving',
    interruptible: false,
    update(agent, _world, dt) {
      const total = Math.max(1, distance(door.outside, door.inside));
      const reached = agent.moveToward(door.inside, dt);
      poseInDoorway(agent, door, 'in');
      agent.alpha = Math.min(1, 1 - distance(door.inside, agent) / total);
      return reached;
    },
  };
}

/** Keep north/south doorway movement facing along the door, even when the entry path is diagonal. */
function poseInDoorway(agent: Agent, door: Door, direction: 'in' | 'out') {
  if (door.side !== 'north' && door.side !== 'south') return;
  const awayFromCamera = (door.side === 'north') === (direction === 'out');
  agent.facing = awayFromCamera ? 'back' : 'front';
}

/** Ghosts don't need doors: they fade in or out through the back wall. */
export function phaseThroughWall(direction: 'in' | 'out'): Task {
  let wallY = 0;
  let floorY = 0;
  let path: Point[] = [];
  return {
    activity: direction === 'in' ? 'Phasing in' : 'Phasing through the wall',
    interruptible: false,
    start(agent, world) {
      const top = agent.room.topFloorY(agent.x) ?? agent.y;
      wallY = top - 3;
      floorY = top + 7;
      path = direction === 'out' ? [{ x: agent.x, y: floorY }, { x: agent.x, y: wallY }] : [{ x: agent.x, y: floorY }];
    },
    update(agent, world, dt) {
      if (!path.length) return true;
      if (agent.moveToward(path[0], dt, 0.6)) path.shift();
      if (direction === 'out' && path.length <= 1) {
        agent.alpha = Math.max(0, (agent.y - wallY) / (floorY - wallY));
        if (!path.length) world.remove(agent, 'wall');
      }
      if (direction === 'in') agent.alpha = Math.min(1, (agent.y - wallY) / (floorY - wallY));
      return path.length === 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Decision making

interface Option {
  weight: number;
  build: () => Task[] | null;
}

function rest(agent: Agent, spot: Spot, world: World): Task {
  const nightOwl = world.isNight() ? 1.4 : 1;
  if (Math.random() < agent.character.behavior.napChance * nightOwl) return { ...nap(range(25, 50), spot.facing), sitting: true };
  const hour = world.now().getHours();
  const onChair = spot.kind === 'chair';
  const activity = onChair ? (hour >= 11 && hour < 14 ? 'Having lunch' : 'Working at the table') : 'Taking a break';
  return { ...wait(range(8, 18), activity, spot.facing), sitting: true };
}

/** Tasks that take the agent out of the facility: through this room's way out, or towards the nearest room with one. */
export function leaveFacility(agent: Agent, world: World, hurry = false): Task[] {
  const { room } = agent;
  const doors = room.outerDoors;
  const speed = hurry ? 2.2 : 1;
  agent.leaving = true;

  const towards = (door: Door) => exitThroughDoor(door, speed, `Heading to the ${world.room(door.to!.room)?.name ?? 'next room'}`);

  if (agent.ghost && (Math.random() < 0.5 || !room.hasOuterExit)) {
    return [walkTo(room.randomFloorPoint()), phaseThroughWall('out')];
  }
  if (hurry) {
    // Running away: never stop to wait for the elevator if a door can be reached.
    if (doors.length) {
      const nearest = doors.reduce((best, door) => (distance(door.inside, agent) < distance(best.inside, agent) ? door : best));
      return [exitThroughDoor(nearest, speed)];
    }
    const step = world.doorTowardExit(room, true);
    if (step) return [towards(step)];
  }
  if (!room.hasOuterExit) {
    const step = world.doorTowardExit(room);
    return step ? [towards(step)] : [phaseThroughWall('out')];
  }
  if (room.elevator && (!doors.length || Math.random() < 0.65)) return [rideElevatorOut()];
  return [exitThroughDoor(pick(doors), speed)];
}

/** Picks the next thing an agent does once their plan runs out. */
export function planNext(agent: Agent, world: World): Task[] {
  agent.spot = undefined;
  const { behavior } = agent.character;
  const { room } = agent;
  const { darkness } = room;
  const stayed = world.time - agent.arrivedAt;
  const inRoom = world.time - agent.enteredRoomAt;
  const crowded = world.presentCount() - world.targetPopulation();

  const benchSpot = world.freeSpot(room, 'bench');
  const chairSpot = world.freeSpot(room, 'chair');
  const partner = world.findChatPartner(agent);
  const canVisit = (destination: Room) => !!agent.impostor || canVisitLevel(agent.character, destination.level);
  const linked = room.linkedDoors.filter((door) => {
    const destination = world.room(door.to!.room);
    return destination && canVisit(destination);
  });
  const floors = world.elevatorStops(room).filter(canVisit);

  const options: Option[] = [
    {
      weight: 3,
      build: () => [
        walkTo(room.randomFloorPoint()),
        wait(range(2, 6), 'Looking around', pick<Facing>(['front', 'left', 'right'])),
      ],
    },
    { weight: 1, build: () => [wait(range(3, 6), 'Standing around', 'front')] },
    {
      weight: benchSpot ? 2 : 0,
      build: () => {
        agent.spot = benchSpot!;
        return [walkTo(benchSpot!, 'Heading to the bench'), rest(agent, benchSpot!, world)];
      },
    },
    {
      weight: ['feline', 'cat'].includes(agent.character.species.trim().toLowerCase()) ? 1 : 0.1,
      build: () => {
        meow(agent, world);
        return [wait(range(1, 3), 'Meowing', 'front')];
      },
    },
    {
      weight: chairSpot ? 2 : 0,
      build: () => {
        agent.spot = chairSpot!;
        return [walkTo(chairSpot!, 'Grabbing a chair'), rest(agent, chairSpot!, world)];
      },
    },
    {
      weight: partner ? behavior.social * 3 : 0,
      build: () => (partner ? startConversation(agent, partner, world) : null),
    },
    {
      // Wander over to a neighbouring room on camera.
      weight: linked.length && (inRoom > 25 || darkness > 0) ? 1.2 + darkness * 4 : 0,
      build: () => {
        const door = pick(linked);
        return [exitThroughDoor(door, 1, `Heading to the ${world.room(door.to!.room)?.name ?? 'next room'}`)];
      },
    },
    {
      // Take the elevator to another floor on camera.
      weight: floors.length && (inRoom > 25 || darkness > 0) ? 0.8 + darkness * 3 : 0,
      build: () => [rideElevatorOut(pick(floors))],
    },
    {
      // Impostors stay until the event director sends them off.
      weight: !agent.impostor && (stayed > 35 || darkness > 0)
        ? 0.5 + Math.max(0, crowded) * 2 + darkness * 2 : 0,
      build: () => leaveFacility(agent, world),
    },
  ];

  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = Math.random() * total;
  for (const option of options) {
    roll -= option.weight;
    if (option.weight > 0 && roll <= 0) {
      const tasks = option.build();
      if (tasks) return tasks;
      break;
    }
  }
  return [wait(2, 'Standing around')];
}
