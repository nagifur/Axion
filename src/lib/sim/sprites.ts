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

export type FrameName = 'walk1' | 'walk2' | 'side' | 'front' | 'back';

// characters/char_spritesheet.png: side-facing frames face right and are flipped for left.
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
