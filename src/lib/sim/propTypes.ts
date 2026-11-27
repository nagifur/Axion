import type { Rect } from './navMap.ts';
import { isPassageDoorAsset } from './door.ts';
import type { Facing } from './sprites.ts';
import { ELEVATOR_SPRITES, hasPropLook, type PropSheetImage } from './propSprites.ts';

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
  /** Electrical equipment emits sparks while broken, independently of its power switch. */
  electric?: boolean;
  /** Occupancy turns power on when someone enters and off after the room has been empty. */
  automaticPowerOff?: boolean;
  /** Can break. Nobody sits on a broken prop. */
  breakable?: boolean;
  /** Artwork-relative area that can be struck by a tripping agent; defaults to the whole frame. */
  impactArea?: Rect;
  /** Item type (src/sim_assets/items/) agents can get from it while it is working and on. */
  dispenses?: string;
  /** Particles thrown when it breaks at runtime. */
  breakParticles?: BreakParticles;
}

export interface BreakParticles {
  /** One or more names in PARTICLE_SETS (particles.ts); each set emits its own burst. */
  set: string | readonly string[];
  /** Part of the artwork the particles come from, relative to the prop. Defaults to the whole prop. */
  area?: Rect;
}

// Glass panes share one particle set and use their visible pane as the impact area.
const glassPane = (area: Rect): Pick<PropType, 'impactArea' | 'breakParticles'> => ({
  impactArea: area,
  breakParticles: { set: 'glass', area },
});

/** Prop types that rooms can place in their room.json. */
export const PROP_TYPES: Record<string, PropType> = {
  light: { asset: 'light', electric: true, switchable: true, automaticPowerOff: true, breakable: true },
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
    impactArea: { x: 20, y: 0, w: 34, h: 55 },
    seats: [{ x: 30, y: 52, facing: 'right' }],
    blocks: { x: 24, y: 47, w: 21, h: 8 },
  },
  // Its power switch comes from the sheet's off row; it keeps its power state when the room empties.
  vending_machine: {
    asset: 'vending_machine', electric: true, breakable: true, dispenses: 'can',
    impactArea: { x: 14, y: 5, w: 68, h: 90 },
    breakParticles: { set: 'glass' },
  },
  // Breakable through the broken row of their sheets.
  glass: { asset: 'glass', ...glassPane({ x: 3, y: 30, w: 91, h: 37 }) },
  glass_half: { asset: 'glass_half', ...glassPane({ x: 25, y: 30, w: 46, h: 37 }) },
  glass_angle: { asset: 'glass_angle', ...glassPane({ x: 28, y: 12, w: 40, h: 74 }) },
};

/**
 * Prop types that can be placed in a room: the ones listed in PROP_TYPES, plus any other image in
 * src/sim_assets/props/ as plain decoration (no seats, nothing blocked). `files` are the image names
 * without ".png".
 */
export function placeablePropTypes(files: Iterable<string>): string[] {
  const reserved = new Set([ELEVATOR_SPRITES.door, ELEVATOR_SPRITES.bigDoor, ELEVATOR_SPRITES.lights]);
  const types = new Set(Object.keys(PROP_TYPES));
  for (const file of files) if (!reserved.has(file) && !isPassageDoorAsset(file)) types.add(file);
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
