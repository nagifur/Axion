import { pick, range } from './random.ts';
import type { SimCreature } from './roster.ts';
import type { Facing, Point, Room } from './room.ts';
import { IDLE_CYCLES, IDLE_FRAME_SECONDS, WALK_CYCLES, WALK_STRIDE } from './sprites.ts';

type Plan =
  | { action: 'rest' | 'watch'; remaining: number }
  | { action: 'pace'; path: Point[] };

const LABELS = { rest: 'Resting', watch: 'Watching the cell', pace: 'Pacing the cell' };
const PACE_SPEED = 22;

export class Creature {
  readonly character: SimCreature;
  readonly room: Room;
  x: number;
  y: number;
  facing: Facing = 'front';
  /** A disguised resident keeps its cell reservation but is not present on this camera. */
  away = false;
  private plan: Plan = { action: 'watch', remaining: range(1, 5) };
  private elapsed = 0;
  private distance = 0;
  private layout: Room['props'];

  constructor(character: SimCreature, room: Room) {
    this.character = character;
    this.room = room;
    this.layout = room.props;
    const point = room.randomFloorPoint();
    if (!room.isWalkable(point)) throw new Error(`${room.id}: no walkable floor for ${character.name}.`);
    this.x = point.x;
    this.y = point.y;
  }

  get activity() {
    return this.away ? 'Away from cell' : LABELS[this.plan.action];
  }

  get frame() {
    const pacing = this.plan.action === 'pace';
    const cycle = (pacing ? WALK_CYCLES : IDLE_CYCLES)[this.facing];
    const phase = pacing ? this.distance / WALK_STRIDE : this.elapsed / IDLE_FRAME_SECONDS;
    return { name: cycle[Math.floor(phase) % cycle.length], flip: this.facing === 'left' };
  }

  private nextPlan(): Plan {
    const action = pick(['rest', 'watch', 'pace'] as const);
    if (action === 'rest') return { action, remaining: range(5, 14) };
    if (action === 'pace') {
      const path = this.room.route(this, this.room.randomFloorPoint(undefined, this));
      if (path?.length) return { action, path };
    }
    this.facing = pick(['left', 'right', 'front', 'back'] as const);
    return { action: 'watch', remaining: range(2, 6) };
  }

  update(dt: number) {
    if (this.away || !dt) return;
    this.elapsed += dt;
    // Live prop edits invalidate both the path and potentially the current standing point.
    if (this.layout !== this.room.props) {
      this.layout = this.room.props;
      if (!this.room.isWalkable(this)) {
        const point = this.room.nearestWalkable(this);
        this.x = point.x;
        this.y = point.y;
      }
      this.plan = this.nextPlan();
    }
    if (this.plan.action !== 'pace') {
      this.plan.remaining -= dt;
      if (this.plan.remaining <= 0) this.plan = this.nextPlan();
      return;
    }

    const path = this.plan.path;
    let budget = dt * PACE_SPEED;
    while (path.length && budget > 0) {
      const dx = path[0].x - this.x;
      const dy = path[0].y - this.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const step = Math.min(budget, length);
        const next = { x: this.x + dx * step / length, y: this.y + dy * step / length };
        if (!this.room.isWalkable(next)) {
          this.plan = { action: 'watch', remaining: range(1, 4) };
          return;
        }
        this.facing = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'back' : 'front');
        this.x = next.x;
        this.y = next.y;
        this.distance += step;
        budget -= step;
        if (step < length) return;
      }
      path.shift();
    }
    if (!path.length) this.plan = { action: 'watch', remaining: range(1, 4) };
  }
}
