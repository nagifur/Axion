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
  | `${'idleRight' | 'idleFront' | 'idleBack' | 'sitRight' | 'sitFront' | 'talkRight'}${1 | 2}`;

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
const SIT_RIGHT: FrameName[] = ['sitRight1', 'sitRight2'];
export const SIT_CYCLES: Record<Facing, readonly FrameName[]> = {
  front: ['sitFront1', 'sitFront2'],
  back: IDLE_CYCLES.back,
  right: SIT_RIGHT,
  left: SIT_RIGHT,
};
export const TALK_RIGHT_CYCLE: readonly FrameName[] = ['talkRight1', 'talkRight2'];
/** Pixels walked before switching to the next walk frame. */
export const WALK_STRIDE = 8;
/** Seconds before switching to the next idle frame. */
export const IDLE_FRAME_SECONDS = 0.6;

/** Item artwork crops, independent of prop power-state sheets. */
export const ITEM_SPRITES: Record<string, Rect> = {
  can: { x: 45, y: 43, w: 6, h: 10 },
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

/** Temporary hand positions relative to the feet, in unscaled character pixels. */
export const ITEM_HAND_ANCHORS: Record<Facing, { x: number; y: number; behind: boolean }> = {
  right: { x: 12, y: -25, behind: false },
  left: { x: -12, y: -25, behind: false },
  front: { x: -12, y: -25, behind: false },
  back: { x: 12, y: -25, behind: true },
};

export interface PropAnimation {
  /** Matching artwork-sized crops inside the sheet's 96x96 cells. */
  frames: readonly Rect[];
  frameSeconds?: number;
}

/** Looks a prop can have besides its normal one. See Prop.look in prop.ts. */
export type PropLook = 'off' | 'broken';

export interface PropSprite extends PropAnimation {
  /** Frames for other looks, cropped to the same size and alignment as `frames`. */
  states?: Partial<Record<PropLook, PropAnimation>>;
}

export interface PropSheetImage {
  width: number;
  height: number;
  /** Populated cells, indexed by row then column. Required for automatic multi-cell sheets. */
  propCells?: readonly (readonly boolean[])[];
}

export const PROP_FRAME_SECONDS = 0.6;

export const PROP_SPRITES: Record<string, PropSprite> = {
  bench: {
    frames: [{ x: 13, y: 36, w: 71, h: 37 }],
    states: { broken: { frames: [{ x: 13, y: 228, w: 71, h: 37 }] } },
  },
  chair: {
    frames: [{ x: 10, y: 29, w: 59, h: 58 }],
    states: { broken: { frames: [{ x: 10, y: 221, w: 59, h: 58 }] } },
  },
  table: {
    frames: [{ x: 13, y: 44, w: 70, h: 27 }],
    states: { broken: { frames: [{ x: 13, y: 236, w: 70, h: 27 }] } },
  },
  light: {
    frames: [
      { x: 28, y: 39, w: 40, h: 17 },
      { x: 124, y: 39, w: 40, h: 17 },
    ],
    frameSeconds: PROP_FRAME_SECONDS,
    states: {
      off: { frames: [{ x: 28, y: 135, w: 40, h: 17 }] },
      broken: { frames: [{ x: 28, y: 231, w: 40, h: 17 }] },
    },
  },
  elevator_door: { frames: [{ x: 36, y: 15, w: 24, h: 67 }] },
  elevator_door_big: { frames: [{ x: 5, y: 12, w: 87, h: 73 }] },
  elevator_lights: { frames: [{ x: 36, y: 44, w: 24, h: 9 }] },
};

/** The animation for a look, or the normal one if the sheet has no frames for it. */
function propAnimation(sprite: PropSprite, look?: PropLook): PropAnimation {
  return (look && sprite.states?.[look]) || sprite;
}

/** Which cells contain visible pixels, shared by build-time and browser image loading. */
export function propCellOccupancy(image: { width: number; height: number }, rgba: ArrayLike<number>): boolean[][] {
  const { width, height } = image;
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0) || rgba.length !== width * height * 4) {
    throw new Error('Prop sprite pixels must contain RGBA data matching the image size.');
  }
  const w = Math.min(96, width);
  const h = Math.min(96, height);
  const cells = Array.from({ length: Math.ceil(height / h) }, () =>
    Array<boolean>(Math.ceil(width / w)).fill(false));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3]) cells[Math.floor(y / h)][Math.floor(x / w)] = true;
    }
  }
  return cells;
}

export function needsPropCellOccupancy(asset: string, image: { width: number; height: number }): boolean {
  return !PROP_SPRITES[asset] && (image.width > 96 || image.height > 96);
}

export const hasPropLook = (asset: string, look: PropLook, image?: PropSheetImage): boolean =>
  !!(PROP_SPRITES[asset] ?? (image && automaticPropSprite(asset, image)))?.states?.[look];

function automaticPropSprite(asset: string, image: PropSheetImage): PropSprite {
  if (image.width <= 96 && image.height <= 96) {
    return { frames: [{ x: 0, y: 0, w: image.width, h: image.height }] };
  }
  const w = Math.min(96, image.width);
  const h = Math.min(96, image.height);
  const columns = image.width / w;
  const rows = image.height / h;
  if (![columns, rows].every((count) => Number.isInteger(count) && count > 0)) {
    throw new Error(`Prop sprite "${asset}": automatic sheets need complete ${w}x${h} cells; add PROP_SPRITES metadata for a custom layout.`);
  }
  const cells = image.propCells;
  if (!cells || cells.length !== rows || Array.from(cells).some((row) =>
    !row || row.length !== columns || Array.from(row).some((cell) => typeof cell !== 'boolean'))) {
    throw new Error(`Prop sprite "${asset}": populated cell data is required for automatic sheets.`);
  }
  const framesInRow = (row: number): Rect[] => row < rows
    ? cells[row].flatMap((populated, column) => populated ? [{ x: column * w, y: row * h, w, h }] : [])
    : [];
  const frames = framesInRow(0);
  const off = framesInRow(1);
  const broken = framesInRow(2);
  return {
    frames,
    states: {
      ...(off.length ? { off: { frames: [off[0]] } } : {}),
      ...(broken.length ? { broken: { frames: broken } } : {}),
    },
  };
}

/**
 * Frames for `look` (the normal look if unset or not drawn yet), after checking the whole sheet.
 * Undeclared sheets animate populated cells in rows one and three; row two is a still off look.
 */
export function propFrames(asset: string, image: PropSheetImage, look?: PropLook): readonly Rect[] {
  const sprite = PROP_SPRITES[asset] ?? automaticPropSprite(asset, image);
  const animations: PropAnimation[] = [sprite, ...Object.values(sprite.states ?? {})];
  const size = animations[0].frames[0];
  for (const { frames, frameSeconds } of animations) {
    if (!frames.length) throw new Error(`Prop sprite "${asset}": at least one frame is required.`);
    if (frameSeconds !== undefined && (!Number.isFinite(frameSeconds) || frameSeconds <= 0)) {
      throw new Error(`Prop sprite "${asset}": frameSeconds must be a positive number.`);
    }
    for (const frame of frames) {
      if (![frame.x, frame.y, frame.w, frame.h].every(Number.isInteger) ||
        frame.x < 0 || frame.y < 0 || frame.w <= 0 || frame.h <= 0 ||
        frame.x + frame.w > image.width || frame.y + frame.h > image.height) {
        throw new Error(`Prop sprite "${asset}": frame (${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}) is outside its ${image.width}x${image.height} sheet.`);
      }
      if (frame.w !== size.w || frame.h !== size.h) {
        throw new Error(`Prop sprite "${asset}": animation frames must have matching sizes.`);
      }
    }
  }
  return propAnimation(sprite, look).frames;
}

export function propFrame(asset: string, image: PropSheetImage, time = 0, look?: PropLook): Rect {
  if (!Number.isFinite(time) || time < 0) throw new Error(`Prop sprite "${asset}": animation time must be finite and non-negative.`);
  const frames = propFrames(asset, image, look);
  const sprite = PROP_SPRITES[asset];
  const seconds = (sprite && propAnimation(sprite, look).frameSeconds) ?? PROP_FRAME_SECONDS;
  return frames[Math.floor(time / seconds) % frames.length];
}

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
  /** Can be switched on and off. */
  switchable?: boolean;
  /** Occupancy turns power on when someone enters and off after the room has been empty. */
  automaticPowerOff?: boolean;
  /** Can break. Nobody sits on a broken prop. */
  breakable?: boolean;
  /** Item type (src/sim_assets/items/) agents can get from it while it is working and on. */
  dispenses?: string;
}

/** Prop types that rooms can place in their room.json. */
export const PROP_TYPES: Record<string, PropType> = {
  light: { asset: 'light', switchable: true, automaticPowerOff: true, breakable: true },
  bench: {
    asset: 'bench',
    breakable: true,
    seats: [
      { x: 16, y: 40, facing: 'front' },
      { x: 36, y: 40, facing: 'front' },
      { x: 56, y: 40, facing: 'front' },
    ],
  },
  table: { asset: 'table', breakable: true, blocks: { x: 22, y: 20, w: 24, h: 7 } },
  chair: {
    asset: 'chair',
    breakable: true,
    seats: [{ x: 30, y: 52, facing: 'right' }],
    blocks: { x: 24, y: 47, w: 21, h: 8 },
  },
  // Its power switch comes from the sheet's off row; it keeps its power state when the room empties.
  vending_machine: { asset: 'vending_machine', breakable: true, dispenses: 'can' },
};

// The elevator is found from the nav map; its sprites are drawn to fit the opening.
export const ELEVATOR_SPRITES = {
  door: 'elevator_door',
  bigDoor: 'elevator_door_big',
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
  const reserved = new Set([ELEVATOR_SPRITES.door, ELEVATOR_SPRITES.bigDoor, ELEVATOR_SPRITES.lights]);
  const types = new Set(Object.keys(PROP_TYPES));
  for (const file of files) if (!reserved.has(file)) types.add(file);
  return [...types].sort();
}

/** The type's details, including capabilities provided by its sprite sheet. */
export function propTypeOf(type: string, image?: PropSheetImage): PropType {
  const kind = PROP_TYPES[type] ?? { asset: type };
  const switchable = hasPropLook(kind.asset, 'off', image);
  const breakable = hasPropLook(kind.asset, 'broken', image);
  return (switchable && !kind.switchable) || (breakable && !kind.breakable)
    ? { ...kind, ...(switchable ? { switchable: true } : {}), ...(breakable ? { breakable: true } : {}) }
    : kind;
}

/** Sheet-derived details that placed props need after the image is no longer available. */
export function propSheetFeatures(type: string, image: PropSheetImage): { switchable?: boolean; brokenLook?: boolean } {
  const kind = propTypeOf(type);
  return {
    ...(hasPropLook(kind.asset, 'off', image) && !kind.switchable ? { switchable: true } : {}),
    ...(hasPropLook(kind.asset, 'broken', image) && !hasPropLook(kind.asset, 'broken') ? { brokenLook: true } : {}),
  };
}
