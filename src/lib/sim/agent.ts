import type { SimCharacter, SimImpostor } from './roster';
import {
  CHARACTER_FRAMES, DOORS, ELEVATOR, WALK_CYCLE, WALK_STRIDE,
  isBlocked, randomFloorPoint, route,
  type Door, type Facing, type FrameName, type Point, type Spot,
} from './room';
import type { ElevatorRequest, World } from './world';

export type Bubble = 'zZ' | '!' | '…' | '?' | null;

/** A unit of behaviour. Agents run one task at a time from their plan. */
export interface Task {
  activity: string;
  /** Whether a coworker can pull the agent into a conversation mid-task. */
  interruptible: boolean;
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

  x: number;
  y: number;
  facing: Facing = 'front';
  /** Last horizontal direction, used for walk frames. */
  side: 'left' | 'right' = 'right';
  moving = false;
  walkDistance = 0;
  layer: 'room' | 'inside' = 'room';
  alpha = 1;

  bubble: Bubble = null;
  private bubbleTimer = 0;
  activity = 'Arriving';
  arrivedAt = 0;
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

  constructor(character: SimCharacter, at: Point, impostor?: SimImpostor) {
    this.character = character;
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

  get frame(): { name: FrameName; flip: boolean } {
    if (this.moving) {
      const name = WALK_CYCLE[Math.floor(this.walkDistance / WALK_STRIDE) % WALK_CYCLE.length];
      return { name, flip: this.side === 'left' };
    }
    if (this.facing === 'front' || this.facing === 'back') return { name: this.facing, flip: false };
    return { name: 'side', flip: this.facing === 'left' };
  }

  get height() {
    return CHARACTER_FRAMES.side.h * this.character.scale;
  }

  say(bubble: Bubble, seconds = 2) {
    this.bubble = bubble;
    this.bubbleTimer = seconds;
  }

  face(target: Point) {
    if (Math.abs(target.x - this.x) < 2) return;
    this.facing = target.x < this.x ? 'left' : 'right';
    this.side = this.facing;
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
    if (distance <= step) {
      this.x = target.x;
      this.y = target.y;
      return true;
    }
    this.x += (dx / distance) * step;
    this.y += (dy / distance) * step;
    this.walkDistance += step;
    this.moving = true;
    if (Math.abs(dx) > 0.5) {
      this.side = dx < 0 ? 'left' : 'right';
      this.facing = this.side;
    }
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
  }
}

// ---------------------------------------------------------------------------
// Tasks

const range = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

export function walkTo(target: Point, activity = 'Walking', speedMul = 1): Task {
  let path: Point[] = [];
  return {
    activity,
    interruptible: true,
    start(agent) {
      path = route(agent, target, agent.ghost);
    },
    update(agent, world, dt) {
      if (!path.length) return true;
      if (agent.character.behavior.clumsy && !agent.impostor && Math.random() < dt * 0.006) {
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
      world.log(`${agent.character.name} dozed off.`, 'muted');
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
      world.log(`${agent.character.name} tripped over their own feet.`, 'muted');
      world.achieve('watch-your-step');
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

function chatBubble(conversation: Conversation, agent: Agent) {
  const turn = Math.floor(conversation.elapsed / 1.6) % 2;
  const speaking = (turn === 0) === (agent === conversation.initiator);
  agent.bubble = conversation.started && speaking ? '…' : null;
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
  const meet = spots.find((spot) => !isBlocked(spot));
  if (!meet) return null;

  const conversation: Conversation = { initiator: agent, partner, started: false, ended: false, elapsed: 0 };
  agent.conversation = conversation;
  partner.setPlan(world, [listen(conversation)]);
  partner.conversation = conversation;
  return [walkTo(meet, `Going to talk to ${partner.character.name}`), talk(conversation, range(6, 12))];
}

/** Walks to the elevator, waits for the car, and rides it off the floor. */
export function rideElevatorOut(): Task {
  const waitSpot = { x: ELEVATOR.front.x + Math.round(range(-10, 10)), y: ELEVATOR.front.y };
  let path: Point[] = [];
  let request: ElevatorRequest | undefined;
  return {
    activity: 'Heading to the elevator',
    interruptible: false,
    start(agent) {
      path = route(agent, waitSpot, agent.ghost);
    },
    update(agent, world, dt) {
      if (path.length) {
        if (agent.moveToward(path[0], dt)) path.shift();
        return false;
      }
      if (!request) {
        request = world.elevator.request('depart', agent);
        agent.facing = 'back';
        agent.activity = 'Waiting for the elevator';
      }
      if (request.board && !request.ready) {
        agent.activity = 'Taking the elevator';
        if (agent.y < ELEVATOR.thresholdY) agent.layer = 'inside';
        if (agent.moveToward(ELEVATOR.inside, dt)) {
          agent.facing = 'front';
          request.ready = true;
        }
      }
      return false;
    },
  };
}

/** Steps out of an elevator car that has arrived on this floor. */
export function rideElevatorIn(request: ElevatorRequest): Task {
  const exit = { x: ELEVATOR.front.x + Math.round(range(-14, 14)), y: Math.round(range(170, 182)) };
  return {
    activity: 'Arriving by elevator',
    interruptible: false,
    update(agent, _world, dt) {
      if (!request.board) return false;
      const done = agent.moveToward(exit, dt);
      if (agent.y > ELEVATOR.thresholdY) {
        agent.layer = 'room';
        request.ready = true;
      }
      return done;
    },
  };
}

export function exitThroughDoor(door: Door, speedMul = 1): Task {
  let path: Point[] = [];
  let fading = false;
  return {
    activity: 'Leaving the office',
    interruptible: false,
    start(agent) {
      path = route(agent, door.inside, agent.ghost);
    },
    update(agent, world, dt) {
      if (!fading) {
        if (agent.moveToward(path[0], dt, speedMul)) path.shift();
        fading = path.length === 0;
        return false;
      }
      const total = Math.abs(door.outside.x - door.inside.x);
      const reached = agent.moveToward(door.outside, dt, speedMul);
      agent.alpha = Math.max(0, Math.abs(door.outside.x - agent.x) / total);
      if (reached) world.remove(agent, door.id);
      return reached;
    },
  };
}

export function enterThroughDoor(door: Door): Task {
  return {
    activity: 'Arriving',
    interruptible: false,
    update(agent, _world, dt) {
      const total = Math.abs(door.outside.x - door.inside.x);
      const reached = agent.moveToward(door.inside, dt);
      agent.alpha = Math.min(1, 1 - Math.abs(door.inside.x - agent.x) / total);
      return reached;
    },
  };
}

/** Ghosts don't need doors: they fade in or out through the back wall. */
export function phaseThroughWall(direction: 'in' | 'out'): Task {
  const wallY = 146;
  const floorY = 156;
  let path: Point[] = [];
  return {
    activity: direction === 'in' ? 'Phasing in' : 'Phasing through the wall',
    interruptible: false,
    start(agent) {
      if (direction === 'out') path = [{ x: agent.x, y: floorY }, { x: agent.x, y: wallY }];
      else path = [{ x: agent.x, y: floorY }];
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
  if (Math.random() < agent.character.behavior.napChance * nightOwl) return nap(range(25, 50), spot.facing);
  const hour = world.now().getHours();
  const atTable = spot.kind === 'table';
  const activity = atTable ? (hour >= 11 && hour < 14 ? 'Having lunch' : 'Working at the table') : 'Taking a break';
  return wait(range(8, 18), activity, spot.facing);
}

/** Picks the next thing an agent does once their plan runs out. */
export function planNext(agent: Agent, world: World): Task[] {
  agent.spot = undefined;
  const { behavior } = agent.character;
  const stayed = world.time - agent.arrivedAt;
  const crowded = world.presentCount() - world.targetPopulation();

  const benchSpot = world.freeSpot('bench');
  const tableSpot = world.freeSpot('table');
  const partner = world.findChatPartner(agent);

  const options: Option[] = [
    {
      weight: 3,
      build: () => [
        walkTo(randomFloorPoint()),
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
      weight: tableSpot ? 2 : 0,
      build: () => {
        agent.spot = tableSpot!;
        return [walkTo(tableSpot!, 'Heading to the table'), rest(agent, tableSpot!, world)];
      },
    },
    {
      weight: partner ? behavior.social * 3 : 0,
      build: () => (partner ? startConversation(agent, partner, world) : null),
    },
    {
      // Impostors stay until the event director sends them off.
      weight: !agent.impostor && stayed > 35 ? 0.5 + Math.max(0, crowded) * 2 : 0,
      build: () => {
        agent.leaving = true;
        if (agent.ghost && Math.random() < 0.5) return [walkTo(randomFloorPoint()), phaseThroughWall('out')];
        return Math.random() < 0.65 ? [rideElevatorOut()] : [exitThroughDoor(pick(DOORS))];
      },
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
