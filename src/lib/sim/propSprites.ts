import type { Rect } from './navMap.ts';

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
  big_elevator_door: { frames: [{ x: 5, y: 12, w: 87, h: 73 }] },
  elevator_lights: { frames: [{ x: 36, y: 44, w: 24, h: 9 }] },
};

/** The animation for a look, or the normal one if the sheet has no frames for it. */
function propAnimation(sprite: PropSprite, look?: PropLook): PropAnimation {
  return (look && sprite.states?.[look]) || sprite;
}

/** Which cells contain visible pixels, shared by build-time and browser image loading. */
export function propCellOccupancy(image: { width: number; height: number }, rgba: ArrayLike<number>, cellSize = 96): boolean[][] {
  const { width, height } = image;
  if (![width, height, cellSize].every((value) => Number.isSafeInteger(value) && value > 0) || rgba.length !== width * height * 4) {
    throw new Error('Prop sprite pixels must contain RGBA data matching the image size.');
  }
  const w = Math.min(cellSize, width);
  const h = Math.min(cellSize, height);
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
    frames: frames.length ? frames : [{ x: 0, y: 0, w, h }],
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
        ((frame.x + frame.w > image.width || frame.y + frame.h > image.height) &&
          (frames === sprite.frames || (frame.x < image.width && frame.y < image.height)))) {
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

// The elevator is found from the nav map; its sprites are drawn to fit the opening.
export const ELEVATOR_SPRITES = {
  door: 'elevator_door',
  bigDoor: 'big_elevator_door',
  lights: 'elevator_lights',
  /** Gap between the top of the opening and the bottom of the arrow lights. */
  lightsGap: 7,
  /** Arrow lights sprite: up arrow on the left, down arrow on the right. */
  upWidth: 11,
  downX: 13,
};
