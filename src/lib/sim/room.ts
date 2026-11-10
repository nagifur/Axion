// Layout and sprite manifest for the Level 1 office camera.
// All coordinates are in room pixels (the size of room_test.png). When new art is drawn,
// this is the only file that should need updating.

export const ROOM = { width: 577, height: 209 };

/** Asset names map to PNG files in src/sim_assets/ (e.g. "bench" -> bench.png). */
export type AssetName = 'room' | 'character' | 'bench' | 'chair' | 'table' | 'light' | 'elevatorDoor' | 'elevatorLights';

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Horizontal pixel inside the frame that sits on the character's position. */
  anchorX: number;
}

export type FrameName = 'walk1' | 'walk2' | 'side' | 'front' | 'back';

// char_spritesheet.png: side-facing frames face right and are flipped for left.
// Anchors line the head up between frames so characters don't wobble while walking.
export const CHARACTER_FRAMES: Record<FrameName, Frame> = {
  walk1: { x: 0, y: 0, w: 44, h: 90, anchorX: 27 },
  walk2: { x: 44, y: 0, w: 49, h: 88, anchorX: 27 },
  side: { x: 94, y: 0, w: 41, h: 89, anchorX: 28 },
  front: { x: 135, y: 0, w: 30, h: 89, anchorX: 15 },
  back: { x: 165, y: 0, w: 29, h: 89, anchorX: 14 },
};
export const WALK_CYCLE: FrameName[] = ['walk1', 'walk2'];
/** Pixels walked before switching to the next walk frame. */
export const WALK_STRIDE = 7;

export interface Prop {
  id: string;
  asset: AssetName;
  x: number;
  y: number;
  flip?: boolean;
}

// Furniture is depth sorted with characters by its bottom edge.
export const PROPS: Prop[] = [
  { id: 'bench', asset: 'bench', x: 62, y: 118 },
  { id: 'table', asset: 'table', x: 347, y: 127 },
  { id: 'chair-left', asset: 'chair', x: 317, y: 122 },
  { id: 'chair-right', asset: 'chair', x: 415, y: 122, flip: true },
];

export const CEILING_LIGHTS = [
  { x: 83, y: 34 },
  { x: 370, y: 34 },
];

export const ELEVATOR = {
  // Transparent opening in room_test.png that the doors and riders are drawn behind.
  x: 177,
  y: 89,
  w: 48,
  h: 67,
  lights: { x: 189, y: 73, upWidth: 11, downX: 13 },
  /** Where people wait for, and step out of, the elevator. */
  front: { x: 201, y: 168 },
  /** Feet position of someone standing inside the car. */
  inside: { x: 201, y: 154 },
  /** Characters with feet above this line are drawn behind the room (inside the car). */
  thresholdY: 158,
};

export interface Point {
  x: number;
  y: number;
}

export type Facing = 'left' | 'right' | 'front' | 'back';

export interface Spot extends Point {
  id: string;
  kind: 'bench' | 'table';
  facing: Facing;
}

export const SPOTS: Spot[] = [
  { id: 'bench-1', kind: 'bench', x: 78, y: 154, facing: 'front' },
  { id: 'bench-2', kind: 'bench', x: 98, y: 154, facing: 'front' },
  { id: 'bench-3', kind: 'bench', x: 118, y: 154, facing: 'front' },
  { id: 'table-left', kind: 'table', x: 327, y: 157, facing: 'right' },
  { id: 'table-right', kind: 'table', x: 431, y: 157, facing: 'left' },
];

export interface Door {
  id: string;
  /** Standing spot just inside the room. */
  inside: Point;
  /** Point inside the doorway where characters fade out. */
  outside: Point;
}

export const DOORS: Door[] = [
  { id: 'west', inside: { x: 52, y: 180 }, outside: { x: 30, y: 180 } },
  { id: 'east', inside: { x: 525, y: 180 }, outside: { x: 547, y: 180 } },
];

// Walkable floor: between the back wall and the bottom edge, inside the slanted side walls,
// and not inside the elevator column that sticks out from the back wall.
const FLOOR = { backY: 151, frontY: 204, backLeftX: 57, backRightX: 519, slope: 57 / 58, margin: 10 };
const PILLAR = { x0: 132, x1: 266, frontY: 162 };

export function floorBounds(y: number) {
  const depth = y - 147;
  return {
    left: FLOOR.backLeftX - depth * FLOOR.slope + FLOOR.margin,
    right: FLOOR.backRightX + depth * FLOOR.slope - FLOOR.margin,
  };
}

export function isBlocked(point: Point, ghost = false): boolean {
  if (point.y < FLOOR.backY || point.y > FLOOR.frontY) return true;
  const { left, right } = floorBounds(point.y);
  if (point.x < left || point.x > right) return true;
  return !ghost && point.x > PILLAR.x0 && point.x < PILLAR.x1 && point.y < PILLAR.frontY;
}

export function randomFloorPoint(rand: () => number = Math.random): Point {
  for (let i = 0; i < 50; i++) {
    const point = {
      x: Math.round(20 + rand() * (ROOM.width - 40)),
      y: Math.round(FLOOR.backY + rand() * (FLOOR.frontY - FLOOR.backY)),
    };
    if (!isBlocked(point)) return point;
  }
  return { ...ELEVATOR.front };
}

function segmentBlocked(from: Point, to: Point): boolean {
  const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isBlocked({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })) return true;
  }
  return false;
}

/** Straight line when possible, otherwise step forward around the elevator column. */
export function route(from: Point, to: Point, ghost = false): Point[] {
  if (ghost || !segmentBlocked(from, to)) return [to];
  const detourY = PILLAR.frontY + 4;
  return [
    { x: from.x, y: Math.max(from.y, detourY) },
    { x: to.x, y: Math.max(to.y, detourY) },
    to,
  ];
}
