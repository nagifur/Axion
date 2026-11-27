import type { SimCharacter, SimImpostor } from './roster.ts';
import type { Door, Facing, Point, Room, Spot } from './room.ts';
import { CHARACTER_FRAMES, HOLD_ITEM_CYCLE, IDLE_CYCLES, IDLE_FRAME_SECONDS, SIT_CYCLES, TALK_RIGHT_CYCLE, TRIP_CYCLE, USE_ITEM_CYCLE, WALK_CYCLES, WALK_STRIDE, type FrameName } from './sprites.ts';
import type { World } from './world.ts';
import type { Item } from './item.ts';
import { AgentInventory } from './agentInventory.ts';
import { createLiveStats, hasMagic, recoverStamina, spendStamina, type LiveStats } from './stats.ts';
import { isSpeaking, type Conversation } from './conversation.ts';
import { planInterrupt, planNext } from './planning.ts';
import type { RepairTarget } from './repairs.ts';
import { StatusEffects } from './statusEffects.ts';
import type { SecurityDuty } from './security.ts';
import type { StaffEscort } from './trespass.ts';
import { VoreState, insideActivity } from './vore.ts';

// Agent state and the task runner. The tasks themselves live in tasks.ts, itemTasks.ts,
// conversation.ts and transport.ts; choosing what to do next lives in planning.ts.

export type Bubble = '!' | '…' | '?' | '♥' | 'Meow!' | null;

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
  /** The phase of voluntary disposal, if this task belongs to one. */
  remainsDisposal?: 'travel' | 'activity';
  /** Urgent behavior that must not give way to disposal. */
  urgent?: boolean;
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
  readonly statuses = new StatusEffects({ kind: 'agent', entity: this }, (id, active) => {
    if (id === 'dead' && !active) this.deathHandled = false;
  });
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
  private ranThisFrame = false;
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
  spot?: Spot;
  /** Loose item this agent is on their way to pick up, so others leave it to them. */
  curiousAbout?: Item;
  conversation?: Conversation;
  shake = 0;
  eyeFlash = 0;
  expiresAt = Infinity;

  private task?: Task;
  private plan: Task[] = [];
  private readonly belongings: AgentInventory;
  private deathHandled = false;

  constructor(character: SimCharacter, room: Room, at: Point, impostor?: SimImpostor) {
    this.character = character;
    this.room = room;
    this.impostor = impostor;
    this.stats = createLiveStats(impostor?.stats ?? character.stats, () => this.statuses.apply('dead'), () => this.dead);
    this.x = at.x;
    this.y = at.y;
    this.belongings = new AgentInventory(this);
    this.updateDarkness();
  }

  get ghost() {
    return this.character.behavior.ghost && !this.impostor;
  }

  get incapacitated(): boolean {
    return this.statuses.incapacitated;
  }

  get dead(): boolean {
    return this.statuses.has('dead');
  }

  get napping(): boolean {
    return this.statuses.has('napping');
  }

  /** Inside a predator: off the floor and off the feed until spat out or absorbed. */
  get swallowed(): boolean {
    return this.vore.inside !== null;
  }

  get activity(): string {
    if (this.vore.inside) return insideActivity(this.vore.inside);
    const status = this.statuses.activity;
    if (status) return status;
    return this.staffEscort?.target === this ? `Being escorted to ${this.staffEscort.destination.label}` : this.currentActivity;
  }

  set activity(activity: string) {
    this.currentActivity = activity;
  }

  get hasMagic() {
    return hasMagic(this.stats);
  }

  get item(): Item | null {
    return this.belongings.item;
  }

  get inventory(): readonly Item[] {
    return this.belongings.inventory;
  }

  /** Room lighting affects this actor, not the room, when a personal light is held. */
  updateDarkness() {
    if (!this.dead && !this.removed && !this.swallowed && this.layer === 'room'
      && this.room.darkness > 0 && !this.item?.light) this.statuses.apply('darkness');
    else this.statuses.remove('darkness');
  }

  hasAccessCard(level: number) { return this.belongings.hasAccessCard(level); }
  receiveStoredItem(item: Item) { this.belongings.receiveStoredItem(item); }
  storeItem() { return this.belongings.storeItem(); }
  retrieveItem(item: Item) { this.belongings.retrieveItem(item); }
  pickUpItem(item: Item) { this.belongings.pickUpItem(item); }
  dropItem() { return this.belongings.dropItem(); }
  receiveItem(item: Item) { this.belongings.receiveItem(item); }
  takeAllItems() { return this.belongings.takeAllItems(); }
  consumeItem() { return this.belongings.consumeItem(); }

  get busy() {
    return this.statuses.blocksActions || this.held || !this.task?.interruptible || !!this.conversation ||
      this.leaving || !!this.staffEscort;
  }

  /** The current or next queued task can be dropped for something more pressing. */
  get interruptible() {
    return (this.task ?? this.plan[0])?.interruptible ?? true;
  }

  get disposingRemains() {
    return !!(this.task ?? this.plan[0])?.remainsDisposal;
  }

  /** Animation time while actually performing a disposal activity. */
  get disposalActivityTime(): number | undefined {
    return this.task?.remainsDisposal === 'activity' && this.exposed && !this.dead && !this.statuses.blocksActions &&
      !this.staffEscort && !this.statuses.has('scared') ? this.taskElapsed : undefined;
  }

  get urgent() {
    return !!(this.task ?? this.plan[0])?.urgent;
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
    if (this.statuses.blocksActions) {
      const cycle = this.sitting ? SIT_CYCLES[this.facing] : IDLE_CYCLES[this.facing];
      const index = this.incapacitated ? 0 : Math.floor(this.idleElapsed / IDLE_FRAME_SECONDS) % cycle.length;
      return { name: cycle[index], flip: this.facing === 'left' };
    }
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
    this.statuses.wake();
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
    return this.step(target, dt, this.runningSpeed(speedMul, dt));
  }

  /** Running (speedMul above 1) costs stamina; an `exhausted` agent drops to walking pace. */
  private runningSpeed(speedMul: number, dt: number): number {
    if (speedMul <= 1 || this.statuses.blocksActions || dt <= 0) return speedMul;
    if (!spendStamina(this, dt)) return 1;
    this.ranThisFrame = true;
    return speedMul;
  }

  private step(target: Point, dt: number, speedMul: number): boolean {
    if (this.statuses.blocksActions) return false;
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
    speedMul = this.runningSpeed(speedMul, dt);
    const speed = this.movementSpeed(speedMul);
    let remaining = Math.max(0, dt);
    while (path.length) {
      const distance = Math.hypot(path[0].x - this.x, path[0].y - this.y);
      if (!this.step(path[0], remaining, speedMul)) return false;
      path.shift();
      if (distance > 0) remaining = Math.max(0, remaining - distance / speed);
      if (remaining === 0) break;
    }
    return path.length === 0;
  }

  update(world: World, dt: number, blockedSeconds = 0) {
    this.updateDarkness();
    this.finishDeath(world);
    this.moving = false;
    if (this.removed || this.swallowed) return;
    // Running happens inside task updates, so recover based on whether the last frame ran.
    if (!this.ranThisFrame && !this.dead) recoverStamina(this.stats, dt);
    this.ranThisFrame = false;
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) this.bubble = null;
    }
    this.shake = Math.max(0, this.shake - dt);
    this.eyeFlash = Math.max(0, this.eyeFlash - dt);

    if (this.statuses.blocksActions || (dt > 0 && blockedSeconds >= dt)) {
      if (!this.incapacitated) this.idleElapsed = (this.idleElapsed + Math.max(0, dt)) % (IDLE_FRAME_SECONDS * 2);
      return;
    }
    dt = Math.max(0, dt - blockedSeconds);

    const interrupt = planInterrupt(this, world, this.task);
    if (interrupt) this.setPlan(world, interrupt);
    if (!this.task) {
      if (!this.plan.length) this.plan = planNext(this, world);
      this.task = this.plan.shift();
      this.taskElapsed = 0;
      this.task?.start?.(this, world);
      if (this.task) this.activity = this.task.activity;
    }
    if (this.statuses.blocksActions) return;
    const task = this.task;
    // Tasks can replace themselves (trips) or remove the agent, so only end the one that ran.
    if (task && task.update(this, world, dt) && this.task === task) {
      task.end?.(this, world);
      this.task = undefined;
    }
    if (task && this.task === task && !this.statuses.blocksActions) this.taskElapsed += Math.max(0, dt);
    this.idleElapsed = this.moving ? 0 : (this.idleElapsed + Math.max(0, dt)) % (IDLE_FRAME_SECONDS * 2);
    this.updateDarkness();
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
