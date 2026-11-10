// A room the simulation runs in, built from its folder in src/sim_assets/rooms/:
// the nav map decides where feet can go and where the exits are, room.json places the props.

import type { NavMapData, Point, Rect } from './navMap';
import { NavGrid } from './pathfinding.ts';
import { PROP_TYPES, type Facing } from './sprites.ts';

export type { Point } from './navMap';
export type { Facing } from './sprites';

export interface PlacedProp {
  type: string;
  asset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  flip: boolean;
}

/** Everything the browser needs to rebuild a room. Produced at build time by roomLoader.ts. */
export interface RoomData {
  id: string;
  name: string;
  level: number;
  camera: string;
  width: number;
  height: number;
  nav: NavMapData;
  props: PlacedProp[];
}

export interface Spot extends Point {
  id: string;
  /** Prop type the spot belongs to, e.g. "bench" or "chair". */
  kind: string;
  facing: Facing;
}

export interface Door {
  id: string;
  /** Standing spot just inside the room. */
  inside: Point;
  /** Point inside the doorway where characters fade out. */
  outside: Point;
}

export interface Elevator extends Rect {
  /** Where people wait for, and step out of, the elevator. */
  front: Point;
  /** Feet position of someone standing inside the car. */
  inside: Point;
  /** Characters with feet above this line are drawn behind the room (inside the car). */
  thresholdY: number;
}

/** Pixels kept free between feet and the edge of the floor, so bodies don't clip into walls. */
const EDGE_MARGIN = { x: 8, y: 3 };
const GRID_CELL = 4;
const FLIPPED: Record<Facing, Facing> = { left: 'right', right: 'left', front: 'front', back: 'back' };

const mirror = (rect: Rect, width: number): Rect => ({ ...rect, x: width - rect.x - rect.w });
const contains = (rect: Rect, point: Point) =>
  point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h;

export class Room {
  readonly id: string;
  readonly name: string;
  readonly level: number;
  readonly camera: string;
  readonly width: number;
  readonly height: number;
  readonly props: PlacedProp[];
  readonly spots: Spot[] = [];
  readonly doors: Door[] = [];
  readonly elevator?: Elevator;
  private readonly floor: number[][];
  private readonly blocked: Rect[] = [];
  private readonly grid: NavGrid;
  private readonly openCells: number[];

  constructor(data: RoomData) {
    this.id = data.id;
    this.name = data.name;
    this.level = data.level;
    this.camera = data.camera;
    this.width = data.width;
    this.height = data.height;
    this.props = data.props;
    this.floor = data.nav.floor;

    this.props.forEach((prop, propIndex) => {
      const type = PROP_TYPES[prop.type];
      if (type?.blocks) {
        const rect = prop.flip ? mirror(type.blocks, prop.w) : type.blocks;
        this.blocked.push({ ...rect, x: prop.x + rect.x, y: prop.y + rect.y });
      }
      type?.seats?.forEach((seat, seatIndex) => {
        this.spots.push({
          id: `${prop.type}-${propIndex}-${seatIndex}`,
          kind: prop.type,
          x: prop.x + (prop.flip ? prop.w - 1 - seat.x : seat.x),
          y: prop.y + seat.y,
          facing: prop.flip ? FLIPPED[seat.facing] : seat.facing,
        });
      });
    });

    this.grid = new NavGrid(this.width, this.height, GRID_CELL, (point) => this.isWalkable(point));
    this.openCells = this.grid.openCells();

    for (const exit of data.nav.exits) {
      if (exit.kind === 'door') {
        this.doors.push({ id: exit.id, inside: this.nearestWalkable(exit.threshold), outside: exit.base });
        continue;
      }
      const { x, y, w, h } = exit.bounds;
      const centerX = Math.round(x + w / 2);
      this.elevator = {
        x, y, w, h,
        inside: { x: centerX, y: y + h - 2 },
        thresholdY: y + h + 2,
        front: this.nearestWalkable({ x: centerX, y: y + h + 12 }),
      };
    }
  }

  get label() {
    return `Level ${this.level}`;
  }

  /** Painted green on the nav map. */
  isFloor(x: number, y: number): boolean {
    const spans = this.floor[Math.round(y)];
    if (!spans) return false;
    const px = Math.round(x);
    for (let i = 0; i < spans.length; i += 2) {
      if (px >= spans[i] && px < spans[i + 1]) return true;
    }
    return false;
  }

  /** Floor with some room to spare around the feet, and not under furniture. */
  isWalkable(point: Point): boolean {
    const { x, y } = point;
    const { x: mx, y: my } = EDGE_MARGIN;
    if (!this.isFloor(x, y)) return false;
    if (!this.isFloor(x - mx, y) || !this.isFloor(x + mx, y) || !this.isFloor(x, y - my) || !this.isFloor(x, y + my)) return false;
    return !this.blocked.some((rect) => contains(rect, point));
  }

  nearestWalkable(point: Point): Point {
    if (this.isWalkable(point)) return { x: Math.round(point.x), y: Math.round(point.y) };
    const cell = this.grid.nearest(point);
    return cell >= 0 ? this.grid.center(cell) : { x: Math.round(point.x), y: Math.round(point.y) };
  }

  randomFloorPoint(rand: () => number = Math.random): Point {
    if (!this.openCells.length) return { x: Math.round(this.width / 2), y: Math.round(this.height / 2) };
    const center = this.grid.center(this.openCells[Math.floor(rand() * this.openCells.length)]);
    const jittered = {
      x: center.x + Math.round((rand() - 0.5) * GRID_CELL),
      y: center.y + Math.round((rand() - 0.5) * GRID_CELL),
    };
    return this.isWalkable(jittered) ? jittered : center;
  }

  /** Top edge of the floor in a column: where the back wall meets the floor. */
  topFloorY(x: number): number | null {
    for (let y = 0; y < this.height; y++) {
      if (this.isFloor(x, y)) return y;
    }
    return null;
  }

  private lineClear(from: Point, to: Point): boolean {
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.isWalkable({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })) return false;
    }
    return true;
  }

  /** Waypoints from `from` to `to` around walls and furniture. Ghosts go straight. */
  route(from: Point, to: Point, ghost = false): Point[] {
    if (ghost || this.lineClear(from, to)) return [to];
    const cells = this.grid.findPath(from, to);
    if (!cells) return [to];

    // Skip every waypoint that can be reached in a straight line, so paths don't zigzag.
    const points = [...cells, to];
    const path: Point[] = [];
    let current = from;
    let i = 0;
    while (i < points.length) {
      let j = points.length - 1;
      while (j > i && !this.lineClear(current, points[j])) j--;
      path.push(points[j]);
      current = points[j];
      i = j + 1;
    }
    return path;
  }
}
