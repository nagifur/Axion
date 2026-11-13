// What is inside each shared sprite in src/sim_assets/characters and src/sim_assets/props.
// Coordinates are pixels relative to the sprite's top-left corner, as drawn facing its default way.

import type { Rect } from './navMap.ts';

export type Facing = 'left' | 'right' | 'front' | 'back';

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Horizontal pixel inside the frame that sits on the character's position. */
  anchorX: number;
}

export type FrameName =
  | `${'walkFront' | 'walkBack' | 'walkRight'}${1 | 2 | 3 | 4}`
  | `${'idleRight' | 'idleFront' | 'idleBack'}${1 | 2}`;

const gridFrame = (column: number, row: number): Frame => ({
  x: column * 96, y: row * 96, w: 96, h: 96, anchorX: 48,
});

// Untrimmed 96x96 cells, anchored at bottom center. Right-facing poses are mirrored for left.
export const CHARACTER_FRAMES: Record<FrameName, Frame> = {
  walkFront1: gridFrame(0, 0),
  walkFront2: gridFrame(1, 0),
  walkFront3: gridFrame(2, 0),
  walkFront4: gridFrame(3, 0),
  walkBack1: gridFrame(0, 1),
  walkBack2: gridFrame(1, 1),
  walkBack3: gridFrame(2, 1),
  walkBack4: gridFrame(3, 1),
  walkRight1: gridFrame(0, 2),
  walkRight2: gridFrame(1, 2),
  walkRight3: gridFrame(2, 2),
  walkRight4: gridFrame(3, 2),
  idleRight1: gridFrame(0, 3),
  idleRight2: gridFrame(1, 3),
  idleFront1: gridFrame(0, 4),
  idleFront2: gridFrame(1, 4),
  idleBack1: gridFrame(0, 5),
  idleBack2: gridFrame(1, 5),
};
const WALK_RIGHT: FrameName[] = ['walkRight1', 'walkRight2', 'walkRight3', 'walkRight4'];
const IDLE_RIGHT: FrameName[] = ['idleRight1', 'idleRight2'];
export const WALK_CYCLES: Record<Facing, readonly FrameName[]> = {
  front: ['walkFront1', 'walkFront2', 'walkFront3', 'walkFront4'],
  back: ['walkBack1', 'walkBack2', 'walkBack3', 'walkBack4'],
  right: WALK_RIGHT,
  left: WALK_RIGHT,
};
export const IDLE_CYCLES: Record<Facing, readonly FrameName[]> = {
  front: ['idleFront1', 'idleFront2'],
  back: ['idleBack1', 'idleBack2'],
  right: IDLE_RIGHT,
  left: IDLE_RIGHT,
};
/** Pixels walked before switching to the next walk frame. */
export const WALK_STRIDE = 8;
/** Seconds before switching to the next idle frame. */
export const IDLE_FRAME_SECONDS = 0.6;

export interface Seat {
  /** Where the feet go. */
  x: number;
  y: number;
  facing: Facing;
}

export interface PropType {
  /** File name in src/sim_assets/props/ without ".png". */
  asset: string;
  /** Places someone can go to and rest. */
  seats?: Seat[];
  /** Floor area under the prop that people walk around. */
  blocks?: Rect;
}

/** Prop types that rooms can place in their room.json. */
export const PROP_TYPES: Record<string, PropType> = {
  light: { asset: 'light' },
  bench: {
    asset: 'bench',
    seats: [
      { x: 16, y: 36, facing: 'front' },
      { x: 36, y: 36, facing: 'front' },
      { x: 56, y: 36, facing: 'front' },
    ],
  },
  table: { asset: 'table', blocks: { x: 22, y: 20, w: 24, h: 7 } },
  chair: {
    asset: 'chair',
    seats: [{ x: 10, y: 35, facing: 'right' }],
    blocks: { x: 4, y: 30, w: 21, h: 8 },
  },
};

// The elevator is found from the nav map; its sprites are drawn to fit the opening.
export const ELEVATOR_SPRITES = {
  door: 'elevator_door',
  lights: 'elevator_lights',
  /** Gap between the top of the opening and the bottom of the arrow lights. */
  lightsGap: 7,
  /** Arrow lights sprite: up arrow on the left, down arrow on the right. */
  upWidth: 11,
  downX: 13,
};

/**
 * Prop types that can be placed in a room: the ones listed in PROP_TYPES, plus any other image in
 * src/sim_assets/props/ as plain decoration (no seats, nothing blocked). `files` are the image names
 * without ".png".
 */
export function placeablePropTypes(files: Iterable<string>): string[] {
  const reserved = new Set([ELEVATOR_SPRITES.door, ELEVATOR_SPRITES.lights]);
  const types = new Set(Object.keys(PROP_TYPES));
  for (const file of files) if (!reserved.has(file)) types.add(file);
  return [...types].sort();
}

/** The type's details, or plain decoration using the image of the same name. */
export const propTypeOf = (type: string): PropType => PROP_TYPES[type] ?? { asset: type };
