// A room the simulation runs in, built from its folder in src/sim_assets/rooms/:
// the nav map decides where feet can go and where the exits are, room.json places the props.

import type { DoorSide, NavMapData, Point, Rect } from './navMap.ts';
import { NavGrid } from './pathfinding.ts';
import { Prop, type PlacedProp } from './prop.ts';
import { PROP_TYPES, type Facing } from './sprites.ts';

export type { DoorSide, Point } from './navMap.ts';
export type { PlacedProp } from './prop.ts';
export type { Facing } from './sprites.ts';

/** Where a door leads: a door in another room. */
export interface ExitLink {
  room: string;
  door: string;
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
  /** Doors that lead to another room, by door id. Doors not listed lead off camera. */
  links: Record<string, ExitLink>;
  /** Elevator shaft each elevator belongs to, by elevator id. Rooms on the same shaft are its stops. */
  shafts: Record<string, string>;
  /** Position on its level's camera map (north is row 0). Set when the whole facility is loaded. */
  map?: { col: number; row: number };
}

export interface Spot extends Point {
  id: string;
  /** Prop type the spot belongs to, e.g. "bench" or "chair". */
  kind: string;
  /** The prop the spot is on. Nobody uses spots on broken props. */
  prop: Prop;
  facing: Facing;
  /** Bottom edge of the seat's prop, used to draw an occupant in front of it. */
  propDepth: number;
}

export interface Door {
  id: string;
  /** Wall the door is in. */
  side: DoorSide;
  /** Standing spot just inside the room. */
  inside: Point;
  /** Point inside the doorway where characters fade out. */
  outside: Point;
  /** Set when the door leads to another room on camera; otherwise it leads off camera. */
  to?: ExitLink;
}

export interface Elevator extends Rect {
  /** Name shared by every stop of the same lift, if it is connected to other rooms on camera. */
  shaft?: string;
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

export type Direction = 'up' | 'down';
/** Deeper levels have higher numbers, so going to a higher level number is going down. */
export const directionTo = (from: Room, to: Room): Direction => (to.level > from.level ? 'down' : 'up');

const mirror = (rect: Rect, width: number): Rect => ({ ...rect, x: width - rect.x - rect.w });

/** Seconds a room has to be empty before its lights switch off. */
export const LIGHTS_OFF_SECONDS = 20;

/** How far people walk past a back-wall or front-edge door's threshold while fading in or out. */
const DOORWAY_DEPTH = { north: 14, south: 30 };

/**
 * Where people disappear when going through a door. Side doors use the bottom of the doorway;
 * back-wall doors are walked into a little way; front-edge doors are walked out of the picture.
 */
function doorwayPoint(side: DoorSide, inside: Point, base: Point): Point {
  if (side === 'north') return { x: inside.x, y: inside.y - DOORWAY_DEPTH.north };
  if (side === 'south') return { x: inside.x, y: Math.max(base.y, inside.y) + DOORWAY_DEPTH.south };
  return base;
}
const contains = (rect: Rect, point: Point) =>
  point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h;

export class Room {
  readonly id: string;
  readonly name: string;
  readonly level: number;
  readonly camera: string;
  readonly width: number;
  readonly height: number;
  props: Prop[] = [];
  readonly spots: Spot[] = [];
  readonly doors: Door[] = [];
  readonly elevator?: Elevator;
  private readonly floor: number[][];
  private readonly blocked: Rect[] = [];
  private grid!: NavGrid;
  private openCells: number[] = [];
  private occupied = false;
  /** Seconds since the last person left the room. */
  private emptyFor = 0;

  constructor(data: RoomData) {
    this.id = data.id;
    this.name = data.name;
    this.level = data.level;
    this.camera = data.camera;
    this.width = data.width;
    this.height = data.height;
    this.floor = data.nav.floor;
    this.setProps(data.props);

    for (const exit of data.nav.exits) {
      if (exit.kind === 'door') {
        const side = exit.side ?? 'west';
        const inside = this.nearestWalkable(exit.threshold);
        this.doors.push({ id: exit.id, side, inside, outside: doorwayPoint(side, inside, exit.base), to: data.links?.[exit.id] });
        continue;
      }
      const { x, y, w, h } = exit.bounds;
      const centerX = Math.round(x + w / 2);
      this.elevator = {
        x, y, w, h,
        shaft: data.shafts?.[exit.id],
        inside: { x: centerX, y: y + h - 2 },
        thresholdY: y + h + 2,
        front: this.nearestWalkable({ x: centerX, y: y + h + 12 }),
      };
    }
  }

  get label() {
    return `Level ${this.level}`;
  }

  /**
   * Places the room's props and works out their seats and the floor they block.
   * Also used by the debug prop editor to apply changes live; props that are already
   * Prop objects keep their current state.
   */
  setProps(props: PlacedProp[]) {
    this.props = props.map((prop) => (prop instanceof Prop ? prop : new Prop(prop)));
    this.spots.length = 0;
    this.blocked.length = 0;
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
          prop,
          x: prop.x + (prop.flip ? prop.w - 1 - seat.x : seat.x),
          y: prop.y + seat.y,
          facing: prop.flip ? FLIPPED[seat.facing] : seat.facing,
          propDepth: prop.y + prop.h,
        });
      });
    });
    this.grid = new NavGrid(this.width, this.height, GRID_CELL, (point) => this.isWalkable(point));
    this.openCells = this.grid.openCells();
  }

  /** Floor areas under props that people walk around. */
  get blockedAreas(): readonly Rect[] {
    return this.blocked;
  }

  /** Props that can be switched on and off, like lights. */
  get switchables(): Prop[] {
    return this.props.filter((prop) => prop.switchable);
  }

  /** 0 in daylight or with a working light; 1 in an unlit underground room. */
  get darkness(): number {
    return this.level === 0 || this.props.some((prop) => prop.type === 'light' && prop.lit) ? 0 : 1;
  }

  /**
   * Motion-sensor lighting, called every tick: the lights come on as soon as someone is in
   * the room, and switch off once it has been empty for LIGHTS_OFF_SECONDS.
   */
  updateLights(occupied: boolean, dt: number) {
    const entered = occupied && !this.occupied;
    this.occupied = occupied;
    if (occupied) {
      this.emptyFor = 0;
      if (entered) for (const prop of this.switchables) prop.setOn(true);
      return;
    }
    const before = this.emptyFor;
    this.emptyFor += Math.max(0, dt);
    if (before < LIGHTS_OFF_SECONDS && this.emptyFor >= LIGHTS_OFF_SECONDS) {
      for (const prop of this.switchables) prop.setOn(false);
    }
  }

  /** Painted floor per row, as [start, end) pairs (see NavMapData.floor). */
  get floorSpans(): readonly number[][] {
    return this.floor;
  }

  /** Doors that lead off camera (to the rest of the facility). */
  get outerDoors() {
    return this.doors.filter((door) => !door.to);
  }

  /** Doors that lead to another room on camera. */
  get linkedDoors() {
    return this.doors.filter((door) => door.to);
  }

  /** Whether people can enter or leave the facility from this room. */
  get hasOuterExit() {
    return !!this.elevator || this.outerDoors.length > 0;
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
