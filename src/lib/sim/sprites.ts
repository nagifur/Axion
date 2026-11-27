// Character poses, item crops, and the hand anchors that connect them.
// Coordinates are pixels relative to the sprite's top-left corner, as drawn facing its default way.

import type { Rect } from './navMap.ts';

export * from './propSprites.ts';
export * from './propTypes.ts';

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
  | `${'idleRight' | 'idleFront' | 'idleBack' | 'sitRight' | 'sitFront' | 'talkRight' | 'tripRight' | 'holdRight'}${1 | 2}`
  | `useRight${1 | 2 | 3 | 4 | 5 | 6}`;

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
  sitRight1: gridFrame(0, 6),
  sitRight2: gridFrame(1, 6),
  sitFront1: gridFrame(0, 7),
  sitFront2: gridFrame(1, 7),
  talkRight1: gridFrame(0, 8),
  talkRight2: gridFrame(1, 8),
  tripRight1: gridFrame(0, 9),
  tripRight2: gridFrame(1, 9),
  holdRight1: gridFrame(0, 10),
  holdRight2: gridFrame(1, 10),
  useRight1: gridFrame(0, 11),
  useRight2: gridFrame(1, 11),
  useRight3: gridFrame(2, 11),
  useRight4: gridFrame(3, 11),
  useRight5: gridFrame(4, 11),
  useRight6: gridFrame(5, 11),
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

/** Partial actor sheets keep their facing's idle art until a missing pose is painted. */
export function frameWithIdleFallback(name: FrameName, painted: (frame: Frame) => boolean): Frame {
  const frame = CHARACTER_FRAMES[name];
  if (painted(frame)) return frame;
  const facing = name.includes('Right') ? 'right' : name.includes('Back') ? 'back' : 'front';
  const phase = (frame.x / frame.w) % 2;
  for (const direction of [facing, 'front', 'right'] as const) {
    const cycle = IDLE_CYCLES[direction];
    for (const index of [phase, 1 - phase]) {
      const idle = CHARACTER_FRAMES[cycle[index]];
      if (painted(idle)) return idle;
    }
  }
  throw new Error(`Actor sheet needs an idle pose for "${name}".`);
}

const SIT_RIGHT: FrameName[] = ['sitRight1', 'sitRight2'];
export const SIT_CYCLES: Record<Facing, readonly FrameName[]> = {
  front: ['sitFront1', 'sitFront2'],
  back: IDLE_CYCLES.back,
  right: SIT_RIGHT,
  left: SIT_RIGHT,
};
export const TALK_RIGHT_CYCLE: readonly FrameName[] = ['talkRight1', 'talkRight2'];
export const TRIP_CYCLE: readonly FrameName[] = ['tripRight1', 'tripRight2'];
export const HOLD_ITEM_CYCLE: readonly FrameName[] = ['holdRight1', 'holdRight2'];
export const USE_ITEM_CYCLE: readonly FrameName[] = ['useRight1', 'useRight2', 'useRight3', 'useRight4', 'useRight5', 'useRight6'];
/** Head position relative to the feet and the top of a prone frame. */
export const TRIP_HEAD_OFFSET = { x: 22, y: 56 };
/** Pixels walked before switching to the next walk frame. */
export const WALK_STRIDE = 8;
/** Seconds before switching to the next stationary frame. */
export const IDLE_FRAME_SECONDS = 0.6;

/** Item artwork crops, independent of prop power-state sheets. */
export const ITEM_SPRITES: Record<string, Rect> = {
  can: { x: 45, y: 43, w: 6, h: 10 },
  glowstick: { x: 46, y: 40, w: 4, h: 16 },
  card_level0: { x: 43, y: 44, w: 10, h: 8 },
  card_level1: { x: 43, y: 44, w: 10, h: 8 },
  card_level2: { x: 43, y: 44, w: 10, h: 8 },
  card_level3: { x: 43, y: 44, w: 10, h: 8 },
  card_level4: { x: 43, y: 44, w: 10, h: 8 },
  card_level5: { x: 43, y: 44, w: 10, h: 8 },
  card_admin: { x: 43, y: 44, w: 10, h: 8 },
};

export function itemFrame(type: string, image: { width: number; height: number }): Rect {
  const frame = ITEM_SPRITES[type] ?? { x: 0, y: 0, w: image.width, h: image.height };
  if (![frame.x, frame.y, frame.w, frame.h].every(Number.isInteger) ||
    frame.x < 0 || frame.y < 0 || frame.w <= 0 || frame.h <= 0 ||
    frame.x + frame.w > image.width || frame.y + frame.h > image.height) {
    throw new Error(`Item sprite "${type}": invalid crop for its ${image.width}x${image.height} image.`);
  }
  return frame;
}

/** Hand positions relative to the feet, in unscaled character pixels. */
export const ITEM_HAND_ANCHORS: Record<Facing, { x: number; y: number; behind: boolean }> = {
  right: { x: 12, y: -25, behind: false },
  left: { x: -12, y: -25, behind: false },
  front: { x: -12, y: -25, behind: false },
  back: { x: 12, y: -25, behind: true },
};

const ITEM_POSE_HANDS: Partial<Record<FrameName, { x: number; y: number }>> = {
  tripRight1: { x: 44, y: -9 },
  tripRight2: { x: 44, y: -11 },
  holdRight1: { x: 17, y: -46 },
  holdRight2: { x: 17, y: -47 },
  useRight1: { x: 17, y: -46 },
  useRight2: { x: 23, y: -50 },
  useRight3: { x: 26, y: -53 },
  useRight4: { x: 26, y: -53 },
  useRight5: { x: 23, y: -50 },
  useRight6: { x: 17, y: -46 },
};

/** The item follows the hand in dedicated poses, including when those poses are mirrored. */
export function itemHandAnchor(frame: FrameName, facing: Facing) {
  const hand = ITEM_POSE_HANDS[frame];
  return hand
    ? { x: facing === 'left' ? -hand.x : hand.x, y: hand.y, behind: false }
    : ITEM_HAND_ANCHORS[facing];
}
