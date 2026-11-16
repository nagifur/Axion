import { canVisitLevel, type SimCharacter, type SimImpostor } from './roster.ts';
import { directionTo, type Door, type Facing, type Point, type Room, type Spot } from './room.ts';
import { CHARACTER_FRAMES, IDLE_CYCLES, IDLE_FRAME_SECONDS, SIT_CYCLES, TALK_RIGHT_CYCLE, WALK_CYCLES, WALK_STRIDE, type FrameName } from './sprites.ts';
import type { ElevatorRequest, World } from './world.ts';
import { scheduleFor, type SchedulePeriod } from './schedule.ts';
import { Item, itemActions, type ItemAction } from './item.ts';
import type { Prop } from './prop.ts';
import { createAgentStats, type AgentStats } from './stats.ts';

export type Bubble = 'zZ' | '!' | '…' | '?' | 'Meow!' | null;

/** A unit of behaviour. Agents run one task at a time from their plan. */
export interface Task {
  activity: string;
  /** Whether a coworker can pull the agent into a conversation mid-task. */
  interruptible: boolean;
  /** This task takes place while seated at a reserved spot. */
  sitting?: boolean;
  /** Door/elevator transitions cannot be picked up midway. */
  transport?: boolean;
  falling?: boolean;
  /** Finish recovering before abandoning a broken seat. */
  tripping?: boolean;
  start?(agent: Agent, world: World): void;
  /** Returns true when the task is finished. */
  update(agent: Agent, world: World, dt: number): boolean;
  end?(agent: Agent, world: World): void;
  /** Release resources reserved by a task that was replaced before it started. */
  cancel?(agent: Agent, world: World): void;
}

const BASE_SPEED = 28;
/** How far from their feet, in room pixels, an agent can pick up a loose item. */
export const ITEM_REACH = 12;
/** Radius around their feet in which a trip can hit a prop. */
export const TRIP_PROP_REACH = 12;
/** Chance that a trip or fall breaks the nearest eligible prop. */
export const TRIP_PROP_BREAK_CHANCE = 0.1;
let nextUid = 1;

export class Agent {
  readonly uid = nextUid++;
  readonly character: SimCharacter;
  readonly impostor?: SimImpostor;
  readonly stats: AgentStats;
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
  held = false;
  napping = false;
  spot?: Spot;
  /** Loose item this agent is on their way to pick up, so others leave it to them. */
  curiousAbout?: Item;
  conversation?: Conversation;
  shake = 0;
  eyeFlash = 0;
  expiresAt = Infinity;

  private task?: Task;
  private plan: Task[] = [];
  private carriedItem: Item | null = null;

  constructor(character: SimCharacter, room: Room, at: Point, impostor?: SimImpostor) {
    this.character = character;
    this.room = room;
    this.impostor = impostor;
    this.stats = createAgentStats(impostor?.stats ?? character.stats);
    this.x = at.x;
    this.y = at.y;
  }

  get ghost() {
    return this.character.behavior.ghost && !this.impostor;
  }

  get hasMagic() {
    return this.stats.magic.max > 0;
  }

  get item(): Item | null {
    return this.carriedItem;
  }

  pickUpItem(item: Item) {
    if (!this.draggable) throw new Error('Agent cannot pick up an item during transport, dragging, or departure.');
    if (this.item) throw new Error('Agent already carries an item.');
    if (!this.room.items.includes(item)) throw new Error('Item is not loose in this agent\'s room.');
    if (Math.hypot(item.x + item.w / 2 - this.x, item.y + item.h - this.y) > ITEM_REACH) {
      throw new Error(`Item is out of pickup reach (${ITEM_REACH} room pixels).`);
    }
    this.room.items = this.room.items.filter((other) => other !== item);
    this.carriedItem = item;
  }

  /** Drops at the nearest open floor position in the current room. */
  dropItem(): Item {
    if (!this.draggable) throw new Error('Agent cannot drop an item during transport, dragging, or departure.');
    const item = this.item;
    if (!item) throw new Error('Agent has no item to drop.');
    const point = this.room.nearestWalkable(this);
    item.x = Math.round(point.x - item.w / 2);
    item.y = Math.round(point.y - item.h);
    this.room.items.push(item);
    this.carriedItem = null;
    return item;
  }

  /** Puts a brand-new item (not one lying in the room) into the empty hand. */
  receiveItem(item: Item) {
    if (this.item) throw new Error('Agent already carries an item.');
    if (this.room.items.includes(item)) throw new Error('Loose items are picked up with pickUpItem.');
    this.carriedItem = item;
  }

  /** Destroys the carried item (used up); it does not go back on the floor. */
  consumeItem(): Item {
    const item = this.item;
    if (!item) throw new Error('Agent has no item to use up.');
    this.carriedItem = null;
    return item;
  }

  get busy() {
    return this.held || !this.task?.interruptible || this.napping || !!this.conversation || this.leaving;
  }

  get draggable() {
    return !this.removed && !this.leaving && !this.held && this.layer === 'room' && this.alpha >= 1 &&
      !this.task?.transport && !this.task?.falling && !this.plan[0]?.falling;
  }

  get sitting() {
    return !this.held && !!this.task?.sitting && !this.moving;
  }

  get tripping() {
    return !!this.task?.tripping;
  }

  get frame(): { name: FrameName; flip: boolean } {
    const speaking = !this.held && this.conversation && isSpeaking(this.conversation, this);
    const cycle = this.moving && !this.held ? WALK_CYCLES[this.facing]
      : this.sitting ? SIT_CYCLES[this.facing]
      : speaking && (this.facing === 'left' || this.facing === 'right') ? TALK_RIGHT_CYCLE
      : IDLE_CYCLES[this.facing];
    const phase = this.moving && !this.held ? this.walkDistance / WALK_STRIDE : this.idleElapsed / IDLE_FRAME_SECONDS;
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
    const conversation = this.conversation;
    if (conversation) {
      conversation.ended = true;
      this.conversation = undefined;
      this.bubble = null;
      const other = conversation.initiator === this ? conversation.partner : conversation.initiator;
      if (other.conversation === conversation) {
        other.conversation = undefined;
        other.bubble = null;
        other.setPlan(world, []);
      }
    }
    this.task?.end?.(this, world);
    for (const queued of this.plan) queued.cancel?.(this, world);
    this.task = undefined;
    this.spot = undefined;
    this.curiousAbout = undefined;
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

export function fall(): Task {
  let velocity = 0;
  return {
    activity: 'Falling',
    interruptible: false,
    falling: true,
    start(agent) {
      agent.say('!', 1.3);
    },
    update(agent, world, dt) {
      const seconds = Math.max(0, dt);
      const nextY = agent.y + velocity * seconds + 0.5 * 420 * seconds * seconds;
      velocity += 420 * seconds;
      // Sweep every crossed pixel so even a long frame cannot skip a thin green floor.
      for (let y = Math.round(agent.y); y <= Math.min(Math.round(nextY), agent.room.height - 1); y++) {
        if (!agent.room.isFloor(agent.x, y)) continue;
        agent.y = y;
        agent.setPlan(world, []);
        agent.interrupt(world, trip('fall'));
        return false;
      }
      agent.y = nextY;
      if (agent.y - agent.height > agent.room.height) {
        const point = agent.room.nearestWalkable({ x: agent.x, y: agent.room.height - 1 });
        agent.x = point.x;
        agent.y = point.y;
        world.log(`${agent.character.name} fell out of view and returned to nearby floor in the ${agent.room.name}.`, 'muted');
        agent.setPlan(world, []);
        agent.interrupt(world, trip('fall'));
      }
      return false;
    },
  };
}

export function trip(cause: 'trip' | 'fall' = 'trip'): Task {
  let left = 1.3;
  let attemptedBreak = false;
  return {
    activity: 'Picking themselves up',
    interruptible: false,
    tripping: true,
    start(agent, world) {
      agent.shake = 0.5;
      agent.say('!', 1.3);
      world.log(`${agent.character.name} ${cause === 'fall' ? 'fell and hit the floor' : 'tripped over their own feet'} in the ${agent.room.name}.`, 'muted');
      world.achieve('watch-your-step', agent.room);
      if (!attemptedBreak) {
        attemptedBreak = true;
        breakNearbyProp(agent, world, cause);
      }
    },
    update(_agent, _world, dt) {
      left -= dt;
      return left <= 0;
    },
  };
}

function breakNearbyProp(agent: Agent, world: World, cause: 'trip' | 'fall') {
  let nearest: Prop | undefined;
  let nearestDistance = Infinity;
  for (const prop of agent.room.props) {
    if (!prop.breakable || prop.broken) continue;
    const { x, y, w, h } = prop.impactBounds;
    const dx = Math.max(x - agent.x, 0, agent.x - (x + w));
    const dy = Math.max(y - agent.y, 0, agent.y - (y + h));
    const distance = Math.hypot(dx, dy);
    if (distance <= TRIP_PROP_REACH && distance < nearestDistance) {
      nearest = prop;
      nearestDistance = distance;
    }
  }
  if (nearest && Math.random() < TRIP_PROP_BREAK_CHANCE && nearest.break()) {
    reportPropBreak(agent, world, nearest, cause);
  }
}

/** Does one of the carried item's actions; consuming actions destroy the item once finished. */
export function useItem(action: ItemAction): Task {
  let left = action.seconds;
  let item: Item | null = null;
  return {
    activity: action.activity,
    interruptible: false,
    start(agent) {
      item = agent.item;
      if (!itemActions(item).includes(action)) throw new Error(`Agent cannot "${action.id}" without a matching item.`);
      agent.facing = 'front';
    },
    update(agent, world, dt) {
      // The item may have been dropped meanwhile; then there is nothing left to do.
      if (agent.item !== item) return true;
      left -= dt;
      if (left > 0) return false;
      if (action.consumes) agent.consumeItem();
      if (action.done) world.log(`${agent.character.name} ${action.done} in the ${agent.room.name}.`, 'muted');
      return true;
    },
  };
}

/** Where the agent stands to pick up a loose item, or undefined if it can't be reached from open floor. */
export function itemPickupPoint(room: Room, item: Item): Point | undefined {
  const foot = { x: item.x + item.w / 2, y: item.y + item.h };
  const stand = room.nearestWalkable(foot);
  return room.isWalkable(stand) && distance(stand, foot) <= ITEM_REACH ? stand : undefined;
}

/**
 * Bends down for a loose item next to the agent and takes it. Nothing happens if their hand
 * filled up or someone else took the item first.
 */
export function pickUp(item: Item, seconds = 1): Task {
  let left = seconds;
  const name = item.type.replaceAll('_', ' ');
  return {
    activity: `Picking up a ${name}`,
    interruptible: false,
    start(agent) {
      agent.facing = 'front';
      agent.face({ x: item.x + item.w / 2, y: item.y + item.h });
    },
    update(agent, world, dt) {
      left -= dt;
      if (left > 0) return false;
      agent.curiousAbout = undefined;
      const reachable = Math.hypot(item.x + item.w / 2 - agent.x, item.y + item.h - agent.y) <= ITEM_REACH;
      if (agent.item || !agent.room.items.includes(item) || !reachable) {
        agent.say('?', 2);
        return true;
      }
      agent.pickUpItem(item);
      world.log(`${agent.character.name} picked up a ${name} in the ${agent.room.name}.`, 'muted');
      return true;
    },
  };
}

/** Sets the carried item down at the agent's current position. */
export function setDownItem(item: Item): Task {
  const name = item.type.replaceAll('_', ' ');
  return {
    activity: `Putting down a ${name}`,
    interruptible: false,
    update(agent, world) {
      if (agent.item !== item) return true;
      agent.dropItem();
      world.log(`${agent.character.name} set down a ${name} in the ${agent.room.name}.`, 'muted');
      return true;
    },
  };
}

/**
 * Uses a dispenser prop (e.g. a vending machine) the agent stands in front of, and puts the new
 * item in their hand. Nothing comes out if the hand is full or the prop broke or went off meanwhile.
 */
export function getFromDispenser(prop: Prop, seconds = 2.5): Task {
  let left = seconds;
  const type = prop.kind.dispenses;
  if (!type) throw new Error(`The ${prop.type} does not dispense anything.`);
  return {
    activity: `Using the ${prop.type.replaceAll('_', ' ')}`,
    interruptible: false,
    start(agent) {
      agent.facing = 'back';
    },
    update(agent, world, dt) {
      left -= dt;
      if (left > 0) return false;
      const name = prop.type.replaceAll('_', ' ');
      if (agent.item || prop.dispensing !== type || !agent.room.props.includes(prop)) {
        agent.say('?', 2);
        world.log(`${agent.character.name} couldn't get a ${type} from the ${name} in the ${agent.room.name}.`, 'muted');
        return true;
      }
      if (breakPropOnUse(agent, world, prop)) return true;
      agent.receiveItem(Item.create(type));
      world.log(`${agent.character.name} got a ${type} from the ${name} in the ${agent.room.name}.`, 'muted');
      return true;
    },
  };
}

export function breakPropOnUse(agent: Agent, world: World, prop: Prop): boolean {
  if (!prop.breakOnUse()) return false;
  reportPropBreak(agent, world, prop);
  return true;
}

function reportPropBreak(agent: Agent, world: World, prop: Prop, cause?: 'trip' | 'fall') {
  agent.say('!', 1.5);
  const name = prop.type.replaceAll('_', ' ');
  const message = cause
    ? `${agent.character.name} broke the ${name} when they ${cause === 'fall' ? 'fell' : 'tripped'} in the ${agent.room.name}.`
    : `${agent.character.name}'s ${name} broke in the ${agent.room.name}.`;
  world.log(message, 'warn');
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

export function conversationPoint(agent: Point, partner: Agent): Point | undefined {
  const offset = agent.x < partner.x ? -24 : 24;
  const spots = [{ x: partner.x + offset, y: partner.y }, { x: partner.x - offset, y: partner.y }];
  return spots.find((spot) => partner.room.isWalkable(spot));
}

export function startConversation(agent: Agent, partner: Agent, world: World, immediate = false): Task[] | null {
  const meet = conversationPoint(agent, partner);
  if (!meet) return null;

  const conversation: Conversation = { initiator: agent, partner, started: false, ended: false, elapsed: 0 };
  partner.setPlan(world, [listen(conversation)]);
  const tasks = immediate
    ? [talk(conversation, range(6, 12))]
    : [walkTo(meet, `Going to talk to ${partner.character.name}`), talk(conversation, range(6, 12))];
  if (immediate) agent.setPlan(world, tasks);
  agent.conversation = conversation;
  partner.conversation = conversation;
  return tasks;
}

/** Walks to the elevator, waits for the car, and rides it to `destination` (another floor on camera) or off camera. */
export function rideElevatorOut(destination?: Room): Task {
  let path: Point[] = [];
  let request: ElevatorRequest | undefined;
  return {
    activity: 'Heading to the elevator',
    interruptible: false,
    transport: true,
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
        if (agent.moveToward(request.inside ?? elevator.inside, dt)) {
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
    transport: true,
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
    cancel(agent) {
      request.cancelled = true;
      agent.layer = 'room';
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
    transport: true,
    start(agent) {
      path = agent.room.route(agent, door.inside, agent.ghost);
    },
    update(agent, world, dt) {
      if (!fading) {
        if (path.length && agent.moveToward(path[0], dt, speedMul)) path.shift();
        fading = path.length === 0;
        return false;
      }
      const physical = world.passageDoorFor(door);
      if (physical && !world.canAgentUsePassage(agent, door)) {
        agent.x = door.inside.x;
        agent.y = door.inside.y;
        agent.alpha = 1;
        agent.say('?', 1.5);
        world.log(`Access denied: ${agent.character.name} cannot use the ${door.id} door in ${agent.room.name}.`, 'warn');
        return true;
      }
      if (physical && physical.open < 1) return false;
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
    transport: true,
    update(agent, world, dt) {
      const physical = door.appearance || door.to ? world.passageDoorFor(door) : undefined;
      if (physical && !world.canAgentUsePassage(agent, door)) {
        world.log(`Access denied: ${agent.character.name} cannot enter through the ${door.id} door in ${agent.room.name}.`, 'warn');
        if (agent.alpha < 1) world.remove(agent, door.id);
        return true;
      }
      if (physical && physical.open < 1) return false;
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
    transport: true,
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

export function rest(agent: Agent, spot: Spot, world: World, period: SchedulePeriod): Task {
  const nightOwl = world.isNight() ? 1.4 : 1;
  const sleeping = Math.random() < agent.character.behavior.napChance * nightOwl * (period === 'work' ? 0.15 : 1);
  const onChair = spot.kind === 'chair';
  const activity = period === 'lunch' ? 'Having lunch'
    : period === 'work' && onChair ? 'Working at the table'
    : period === 'free' && onChair ? 'Relaxing at the table' : 'Taking a break';
  const task = sleeping ? nap(range(25, 50), spot.facing)
    : wait(period === 'work' ? range(30, 60) : range(8, 18), activity, spot.facing);
  let attempted = false;
  let started = false;
  return {
    ...task,
    sitting: true,
    start(agent, world) {
      if (!attempted) {
        attempted = true;
        if (!spot.prop.broken) breakPropOnUse(agent, world, spot.prop);
      }
      if (!spot.prop.broken) {
        started = true;
        task.start?.(agent, world);
      }
    },
    update(agent, world, dt) {
      return spot.prop.broken || task.update(agent, world, dt);
    },
    end(agent, world) {
      if (started) task.end?.(agent, world);
      if (spot.prop.broken && agent.spot === spot) agent.spot = undefined;
    },
  };
}

/** Tasks that take the agent out of the facility: through this room's way out, or towards the nearest room with one. */
export function leaveFacility(agent: Agent, world: World, hurry = false): Task[] {
  const { room } = agent;
  const doors = room.outerDoors.filter((door) => !world.passageDoorFor(door)?.blocked);
  const hasExit = !!room.elevator || doors.length > 0;
  const speed = hurry ? 2.2 : 1;
  agent.leaving = true;

  const towards = (door: Door) => exitThroughDoor(door, speed, `Heading to the ${world.room(door.to!.room)?.name ?? 'next room'}`);

  if (agent.ghost && (Math.random() < 0.5 || !hasExit)) {
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
  if (!hasExit) {
    const step = world.doorTowardExit(room);
    return step ? [towards(step)] : [wait(2, 'Waiting for an exit')];
  }
  if (room.elevator && (!doors.length || Math.random() < 0.65)) return [rideElevatorOut()];
  return [exitThroughDoor(pick(doors), speed)];
}

/** Picks the next thing an agent does once their plan runs out. */
export function planNext(agent: Agent, world: World): Task[] {
  agent.spot = undefined;
  agent.curiousAbout = undefined;
  const { behavior } = agent.character;
  const { room } = agent;
  const { darkness } = room;
  const stayed = world.time - agent.arrivedAt;
  const inRoom = world.time - agent.enteredRoomAt;
  const crowded = world.presentCount() - world.targetPopulation();
  const period = scheduleFor(agent.character, world.now());
  const working = period === 'work' && !agent.impostor;
  const workRooms = working ? new Set(world.workRooms(agent.character)) : new Set<Room>();
  const workStep = working ? world.stepTowardWork(agent.character, room) : undefined;
  const wandering = working ? 0.15 : period === 'free' ? 2 : 1;

  const benchSpot = world.freeSpot(room, 'bench');
  const chairSpot = world.freeSpot(room, 'chair');
  const partner = world.findChatPartner(agent);
  const canVisit = (destination: Room) => !!agent.impostor || canVisitLevel(agent.character, destination.level);
  const linked = room.linkedDoors.filter((door) => {
    const destination = world.room(door.to!.room);
    return destination && (canVisit(destination) || world.passageDoorFor(door)?.stuckOpen) &&
      world.canAgentUsePassage(agent, door);
  });
  const floors = world.elevatorStops(room).filter(canVisit);
  const dispensers = agent.item ? [] : room.props
    .filter((prop) => prop.dispensing)
    .map((prop) => ({ prop, stand: prop.standPoint(room) }))
    .filter(({ stand }) => room.isWalkable(stand));
  // Loose items nobody else is already heading for.
  const claimed = new Set(room.items.length ? world.agentsIn(room).map((other) => other.curiousAbout) : []);
  const looseItems = agent.item || agent.impostor ? [] : room.items
    .filter((item) => !claimed.has(item))
    .map((item) => ({ item, stand: itemPickupPoint(room, item) }))
    .filter((found): found is { item: Item; stand: Point } => !!found.stand);

  const options: Option[] = [
    {
      weight: workStep && !darkness ? 12 : 0,
      build: () => {
        if (!workStep) return null;
        return 'inside' in workStep
          ? [exitThroughDoor(workStep, 1, `Heading to the ${world.room(workStep.to!.room)?.name ?? 'next room'}`)]
          : [rideElevatorOut(workStep)];
      },
    },
    {
      weight: working ? 1 : 3,
      build: () => [
        walkTo(room.randomFloorPoint(), working ? 'Checking the work area' : 'Walking'),
        wait(range(2, 6), working ? 'Checking the work area' : 'Looking around', pick<Facing>(['front', 'left', 'right'])),
      ],
    },
    {
      weight: working ? (workStep ? 1 : 10) : 1,
      build: () => [wait(working ? range(30, 60) : range(3, 6),
        working ? 'Working' : period === 'break' ? 'Taking a break' : period === 'lunch' ? 'Having lunch' : 'Standing around', 'front')],
    },
    {
      weight: benchSpot ? (working ? 0.5 : 2) : 0,
      build: () => {
        agent.spot = benchSpot!;
        return [walkTo(benchSpot!, 'Heading to the bench'), rest(agent, benchSpot!, world, period)];
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
      weight: chairSpot ? (working ? (workStep ? 1 : 8) : 2) : 0,
      build: () => {
        agent.spot = chairSpot!;
        return [walkTo(chairSpot!, 'Grabbing a chair'), rest(agent, chairSpot!, world, period)];
      },
    },
    {
      weight: partner ? behavior.social * (working ? 0.6 : 3) : 0,
      build: () => (partner ? startConversation(agent, partner, world) : null),
    },
    {
      // Wander over to a neighbouring room on camera.
      weight: linked.length && (inRoom > 25 || darkness > 0) ? 1.2 * wandering + darkness * 4 : 0,
      build: () => {
        const door = pick(linked);
        return [exitThroughDoor(door, 1, `Heading to the ${world.room(door.to!.room)?.name ?? 'next room'}`)];
      },
    },
    {
      // Take the elevator to another floor on camera.
      weight: floors.length && (inRoom > 25 || darkness > 0) ? 0.8 * wandering + darkness * 3 : 0,
      build: () => {
        const preferred = floors.filter((floor) => workRooms.has(floor));
        return [rideElevatorOut(pick(working && preferred.length && !darkness ? preferred : floors))];
      },
    },
    ...itemActions(agent.item).map((action): Option => ({
      weight: action.weight,
      build: () => [useItem(action)],
    })),
    {
      // Occasionally set down a carried item somewhere on the room's open floor.
      weight: agent.item && !agent.leaving ? 0.25 : 0,
      build: () => {
        const item = agent.item!;
        return [
          walkTo(room.randomFloorPoint(), `Finding a place for the ${item.type.replaceAll('_', ' ')}`),
          setDownItem(item),
        ];
      },
    },
    {
      // Curious about something lying on the floor: go over and pick it up.
      weight: looseItems.length ? (working ? 1.5 : 4) : 0,
      build: () => {
        const { item, stand } = pick(looseItems);
        agent.curiousAbout = item;
        agent.say('?', 1.5);
        return [walkTo(stand, `Checking out a ${item.type.replaceAll('_', ' ')}`), pickUp(item)];
      },
    },
    {
      // Grab something from a vending machine; drinking it is then one of the item's actions.
      weight: dispensers.length ? (working ? 0.2 : 1.2) : 0,
      build: () => {
        const { prop, stand } = pick(dispensers);
        return [walkTo(stand, `Heading to the ${prop.type.replaceAll('_', ' ')}`), getFromDispenser(prop)];
      },
    },
    {
      // Impostors stay until the event director sends them off.
      weight: !agent.impostor && (stayed > 35 || darkness > 0)
        ? (working ? 0.05 : 0.5) + Math.max(0, crowded) * 2 + darkness * 2 : 0,
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
