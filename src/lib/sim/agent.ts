import type { SimCharacter, SimImpostor } from './roster.ts';
import type { Door, Facing, Point, Room, Spot } from './room.ts';
import { CHARACTER_FRAMES, HOLD_ITEM_CYCLE, IDLE_CYCLES, IDLE_FRAME_SECONDS, SIT_CYCLES, TALK_RIGHT_CYCLE, TRIP_CYCLE, USE_ITEM_CYCLE, WALK_CYCLES, WALK_STRIDE, type FrameName } from './sprites.ts';
import type { World } from './world.ts';
import { accessCardLevel, ITEM_REACH, Item, startingItemTypes } from './item.ts';
import { createLiveStats, hasMagic, type LiveStats } from './stats.ts';
import { isSpeaking, type Conversation } from './conversation.ts';
import { planNext } from './planning.ts';
import { planRepair, type RepairTarget } from './repairs.ts';
import { StatusEffects } from './statusEffects.ts';
import type { SecurityDuty } from './security.ts';
import type { StaffEscort } from './trespass.ts';
import { VoreState, insideActivity } from './vore.ts';

// Agent state and the task runner. The tasks themselves live in tasks.ts, itemTasks.ts,
// conversation.ts and transport.ts; choosing what to do next lives in planning.ts.

export type Bubble = 'zZ' | '!' | '…' | '?' | '♥' | 'Meow!' | null;

/** A unit of behaviour. Agents run one task at a time from their plan. */
export interface Task {
  activity: string;
  /** Whether a coworker can pull the agent into a conversation mid-task. */
  interruptible: boolean;
  /** This task takes place while seated at a reserved spot. */
  sitting?: boolean;
  /** Door/elevator transitions cannot be picked up midway. */
  transport?: boolean;
  /** The specific passage this task intentionally opens or crosses. */
  passageDoor?: Door;
  falling?: boolean;
  /** Finish recovering before abandoning a broken seat. */
  tripping?: boolean;
  /** Reserves damaged equipment while walking to it or repairing it. */
  repairTarget?: RepairTarget;
  /** The carried item this task is using, once it has started. */
  readonly usingItem?: Item | null;
  start?(agent: Agent, world: World): void;
  /** Returns true when the task is finished. */
  update(agent: Agent, world: World, dt: number): boolean;
  end?(agent: Agent, world: World): void;
  /** Release resources reserved by a task that was replaced before it started. */
  cancel?(agent: Agent, world: World): void;
}

/** Walking speed in room pixels per second, before the character's own speed multiplier. */
const BASE_SPEED = 28;
let nextUid = 1;

export class Agent {
  readonly statuses = new StatusEffects({ kind: 'agent', entity: this });
  readonly uid = nextUid++;
  readonly character: SimCharacter;
  readonly impostor?: SimImpostor;
  readonly stats: LiveStats;
  /** Swallowing and being swallowed; see vore.ts and voreSystem.ts. */
  readonly vore = new VoreState();
  security?: SecurityDuty;
  staffEscort?: StaffEscort;
  revealed = false;
  /** The room this agent is currently in. */
  room: Room;

  x: number;
  y: number;
  facing: Facing = 'front';
  moving = false;
  walkDistance = 0;
  private idleElapsed = 0;
  private taskElapsed = 0;
  layer: 'room' | 'inside' = 'room';
  alpha = 1;

  bubble: Bubble = null;
  private bubbleTimer = 0;
  private currentActivity = 'Arriving';
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
  private readonly storedItems: Item[] = [];
  private deathHandled = false;

  constructor(character: SimCharacter, room: Room, at: Point, impostor?: SimImpostor) {
    this.character = character;
    this.room = room;
    this.impostor = impostor;
    this.stats = createLiveStats(impostor?.stats ?? character.stats, () => this.statuses.apply('dead'));
    this.x = at.x;
    this.y = at.y;
    for (const type of startingItemTypes(character)) this.storedItems.push(Item.create(type));
  }

  get ghost() {
    return this.character.behavior.ghost && !this.impostor;
  }

  get incapacitated(): boolean {
    return this.statuses.actionBlockRemaining > 0;
  }

  get dead(): boolean {
    return this.statuses.has('dead');
  }

  /** Inside a predator: off the floor and off the feed until spat out or absorbed. */
  get swallowed(): boolean {
    return this.vore.inside !== null;
  }

  get activity(): string {
    if (this.vore.inside) return insideActivity(this.vore.inside);
    if (this.dead) return 'Dead';
    if (this.statuses.has('shocked')) return 'Shocked';
    return this.staffEscort?.target === this ? `Being escorted to ${this.staffEscort.destination.label}` : this.currentActivity;
  }

  set activity(activity: string) {
    this.currentActivity = activity;
  }

  get hasMagic() {
    return hasMagic(this.stats);
  }

  get item(): Item | null {
    return this.carriedItem;
  }

  get inventory(): readonly Item[] {
    return this.storedItems;
  }

  hasAccessCard(level: number): boolean {
    return [...this.storedItems, ...(this.item ? [this.item] : [])]
      .some((item) => (accessCardLevel(item) ?? -1) >= level);
  }

  /** Stores a brand-new item without occupying the hand. */
  receiveStoredItem(item: Item) {
    if (item === this.item || this.storedItems.includes(item) || this.room.items.includes(item)) {
      throw new Error('Item is already held, stored, or loose in this agent\'s room.');
    }
    this.storedItems.push(item);
  }

  storeItem(): Item {
    if (!this.draggable) throw new Error('Agent cannot store an item during transport, dragging, departure, or incapacitation.');
    const item = this.item;
    if (!item) throw new Error('Agent has no item to store.');
    this.storedItems.push(item);
    this.carriedItem = null;
    return item;
  }

  retrieveItem(item: Item) {
    if (!this.draggable) throw new Error('Agent cannot retrieve an item during transport, dragging, departure, or incapacitation.');
    if (this.item) throw new Error('Agent already carries an item.');
    const index = this.storedItems.indexOf(item);
    if (index < 0) throw new Error('Item is not in this agent\'s inventory.');
    this.storedItems.splice(index, 1);
    this.carriedItem = item;
  }

  pickUpItem(item: Item) {
    if (!this.draggable) throw new Error('Agent cannot pick up an item during transport, dragging, departure, or incapacitation.');
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
    if (!this.draggable) throw new Error('Agent cannot drop an item during transport, dragging, departure, or incapacitation.');
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
    if (this.storedItems.includes(item)) throw new Error('Stored items are retrieved with retrieveItem.');
    if (this.room.items.includes(item)) throw new Error('Loose items are picked up with pickUpItem.');
    this.carriedItem = item;
  }

  /** Hands over everything carried or stored, e.g. when this agent is absorbed. */
  takeAllItems(): Item[] {
    const items = [...(this.carriedItem ? [this.carriedItem] : []), ...this.storedItems];
    this.carriedItem = null;
    this.storedItems.length = 0;
    return items;
  }

  /** Destroys the carried item (used up); it does not go back on the floor. */
  consumeItem(): Item {
    const item = this.item;
    if (!item) throw new Error('Agent has no item to use up.');
    this.carriedItem = null;
    return item;
  }

  get busy() {
    return this.incapacitated || this.held || !this.task?.interruptible || this.napping || !!this.conversation ||
      this.leaving || !!this.staffEscort;
  }

  /** The current or next queued task can be dropped for something more pressing. */
  get interruptible() {
    return (this.task ?? this.plan[0])?.interruptible ?? true;
  }

  get transporting() {
    return !!this.task?.transport || !!this.plan[0]?.transport;
  }

  /** Standing on a room's floor where others can get at them, not in transit, held, escorted, leaving or swallowed. */
  get exposed() {
    return !this.removed && !this.leaving && !this.held && !this.swallowed && this.layer === 'room' && this.alpha >= 1 &&
      this.staffEscort?.target !== this && !this.task?.transport && !this.task?.falling && !this.plan[0]?.falling;
  }

  get draggable() {
    return !this.incapacitated && !this.security?.target && !this.staffEscort && this.exposed;
  }

  get sitting() {
    return !this.held && !!this.task?.sitting && !this.moving;
  }

  get tripping() {
    return !!this.task?.tripping;
  }

  get repairTarget(): RepairTarget | undefined {
    return this.task?.repairTarget ?? this.plan.find((task) => task.repairTarget)?.repairTarget;
  }

  get passageDoor(): Door | undefined {
    return this.task?.passageDoor;
  }

  get frame(): { name: FrameName; flip: boolean } {
    if (this.incapacitated) return { name: IDLE_CYCLES[this.facing][0], flip: this.facing === 'left' };
    const speaking = !this.held && this.conversation && isSpeaking(this.conversation, this);
    const walking = this.moving && !this.held;
    const tripping = !this.held && this.tripping;
    const usingItem = !this.held && this.item !== null && this.task?.usingItem === this.item;
    const cycle = tripping ? TRIP_CYCLE
      : usingItem ? USE_ITEM_CYCLE
      : walking ? WALK_CYCLES[this.facing]
      : this.sitting ? SIT_CYCLES[this.facing]
      : speaking && (this.facing === 'left' || this.facing === 'right') ? TALK_RIGHT_CYCLE
      : this.item ? HOLD_ITEM_CYCLE
      : IDLE_CYCLES[this.facing];
    const phase = tripping || usingItem ? this.taskElapsed / IDLE_FRAME_SECONDS
      : walking ? this.walkDistance / WALK_STRIDE : this.idleElapsed / IDLE_FRAME_SECONDS;
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
    this.taskElapsed = 0;
    this.spot = undefined;
    this.curiousAbout = undefined;
    this.plan = tasks;
  }

  /** Pauses the current task to run another one first, then resumes. */
  interrupt(world: World, task: Task) {
    if (this.dead) return;
    if (this.task) this.plan.unshift(this.task);
    this.task = task;
    this.taskElapsed = 0;
    task.start?.(this, world);
    this.activity = task.activity;
  }

  moveToward(target: Point, dt: number, speedMul = 1): boolean {
    if (this.incapacitated) return false;
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const distance = Math.hypot(dx, dy);
    const step = this.movementSpeed(speedMul) * Math.max(0, dt);
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

  movementSpeed(speedMul = 1): number {
    return BASE_SPEED * this.character.behavior.speed * speedMul;
  }

  /** Consumes reached waypoints, carrying unused frame time into the next segment. */
  moveAlongPath(path: Point[], dt: number, speedMul = 1): boolean {
    const speed = this.movementSpeed(speedMul);
    let remaining = Math.max(0, dt);
    while (path.length) {
      const distance = Math.hypot(path[0].x - this.x, path[0].y - this.y);
      if (!this.moveToward(path[0], remaining, speedMul)) return false;
      path.shift();
      if (distance > 0) remaining = Math.max(0, remaining - distance / speed);
      if (remaining === 0) break;
    }
    return path.length === 0;
  }

  update(world: World, dt: number, blockedSeconds = 0) {
    this.finishDeath(world);
    this.moving = false;
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0 && !this.napping) this.bubble = null;
    }
    this.shake = Math.max(0, this.shake - dt);
    this.eyeFlash = Math.max(0, this.eyeFlash - dt);

    if (this.incapacitated || (dt > 0 && blockedSeconds >= dt)) return;
    dt = Math.max(0, dt - blockedSeconds);

    if (this.task?.interruptible && !this.repairTarget) {
      const repairs = planRepair(this, world);
      if (repairs) this.setPlan(world, repairs);
    }
    if (!this.task) {
      if (!this.plan.length) this.plan = planNext(this, world);
      this.task = this.plan.shift();
      this.taskElapsed = 0;
      this.task?.start?.(this, world);
      if (this.task) this.activity = this.task.activity;
    }
    if (this.incapacitated) return;
    const task = this.task;
    // Tasks can replace themselves (trips) or remove the agent, so only end the one that ran.
    if (task && task.update(this, world, dt) && this.task === task) {
      task.end?.(this, world);
      this.task = undefined;
    }
    if (task && this.task === task && !this.incapacitated) this.taskElapsed += Math.max(0, dt);
    this.idleElapsed = this.moving ? 0 : (this.idleElapsed + Math.max(0, dt)) % (IDLE_FRAME_SECONDS * 2);
  }

  /** World also calls this for held agents and off-camera riders. */
  finishDeath(world: World) {
    if (!this.dead || this.deathHandled) return;
    this.deathHandled = true;
    this.releaseStaffEscort(world);
    this.setPlan(world, []);
    this.releaseTarget();
  }

  /** End a staff escort without leaving either person tied to the other. */
  releaseStaffEscort(world: World) {
    const escort = this.staffEscort;
    if (!escort) return;
    const { leader, target } = escort;
    leader.staffEscort = undefined;
    target.staffEscort = undefined;
    target.moving = false;
    if (!world.isRiding(target) && world.agents.includes(target)) {
      const point = target.room.nearestWalkable(target);
      target.x = point.x;
      target.y = point.y;
      target.alpha = 1;
      target.layer = 'room';
    }
    target.setPlan(world, []);
  }

  /** A guard lets go of the creature it is chasing or escorting. */
  releaseTarget() {
    const duty = this.security;
    if (!duty) return;
    if (duty.target?.escort === this) duty.target.releaseEscort();
    duty.target = undefined;
  }
}
