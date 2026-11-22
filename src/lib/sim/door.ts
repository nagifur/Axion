import type { DoorSide, Point, Rect } from './navMap.ts';
import { PROP_BREAK_CHANCE } from './prop.ts';
import { chance } from './random.ts';
import type { PropSheetImage } from './sprites.ts';
import { StatusEffects } from './statusEffects.ts';

/** An optional physical door attached to a painted passage. */
export interface DoorConfig {
  clearance: number;
  big?: boolean;
  style?: DoorStyle;
  cell?: boolean;
  offset?: Point;
  panelOffset?: Point;
}

export type DoorStyle = 'heavy_containment';

export interface DoorAppearance {
  clearance: number;
  big: boolean;
  style?: DoorStyle;
  asset: string;
  panelAsset: string;
  x: number;
  y: number;
  panel: Point;
  panelFlip: boolean;
}

export const PASSAGE_DOOR_SECONDS = 0.7;
export const BIG_PASSAGE_DOOR_SECONDS = 2;
export const PASSAGE_DOOR_HOLD_SECONDS = 1.5;
export const PASSAGE_DOOR_RANGE = 40;
export const DOOR_PANEL_FRAME_SECONDS = 0.6;

const angled = (side: DoorSide) => side === 'west' || side === 'east';

const DOOR_LAYOUTS = {
  normal: {
    cellSize: 96,
    straight: { x: 26, y: 14, w: 46, h: 69 },
    angled: { x: 35, y: 0, w: 26, h: 96 },
  },
  big: {
    cellSize: 192,
    straight: { x: 52, y: 28, w: 92, h: 138 },
    angled: { x: 53, y: 22, w: 86, h: 160 },
  },
  heavyContainment: {
    cellSize: 96,
    straight: { x: 18, y: 20, w: 60, h: 61 },
  },
} as const;

export function passageDoorLayout(side: DoorSide, big = false, style?: DoorStyle): { cellSize: number; crop: Rect } {
  if (style === 'heavy_containment') return { cellSize: DOOR_LAYOUTS.heavyContainment.cellSize, crop: DOOR_LAYOUTS.heavyContainment.straight };
  const layout = big ? DOOR_LAYOUTS.big : DOOR_LAYOUTS.normal;
  return { cellSize: layout.cellSize, crop: angled(side) ? layout.angled : layout.straight };
}

export const passageDoorAsset = (clearance: number, side: DoorSide, big = false, style?: DoorStyle) =>
  style === 'heavy_containment' ? 'door_heavy_containment'
    : `${big ? 'big_' : ''}door_${angled(side) ? 'angle_' : ''}level${clearance}${side === 'east' ? '_east' : ''}`;
export const passagePanelAsset = (side: DoorSide, style?: DoorStyle) =>
  style === 'heavy_containment' ? 'door_panel_small' : `door_panel${angled(side) ? '_angle' : ''}`;

export function passageDoorFrame(side: DoorSide, broken = false, big = false, style?: DoorStyle): Rect {
  const { cellSize, crop } = passageDoorLayout(side, big, style);
  return { ...crop, y: crop.y + (broken ? 2 * cellSize : 0) };
}

export function passagePanelFrame(side: DoorSide, unlocked: boolean, time: number, broken = false, image?: PropSheetImage, style?: DoorStyle): Rect {
  const columns = broken ? image?.propCells?.[2]?.flatMap((populated, column) => populated ? [column] : []) ?? [0] : [0, 1];
  if (!columns.length) throw new Error('Passage panel is missing broken artwork.');
  const column = columns[Math.floor(time / DOOR_PANEL_FRAME_SECONDS) % columns.length];
  const row = broken ? 2 : unlocked ? 3 : 0;
  if (style === 'heavy_containment') {
    return { x: 43 + column * 96, y: row * 96 + (row === 3 ? 38 : 36), w: 11, h: 17 };
  }
  return angled(side)
    ? { x: 39 + column * 96, y: row * 96, w: 17, h: 84 }
    : { x: 39 + column * 96, y: row * 96 + 14, w: 20, h: 69 };
}

export function isPassageDoorAsset(asset: string): boolean {
  return /^(?:big_)?door_(?:level\d+|angle_level\d+(?:_east)?)$/.test(asset) ||
    asset === 'door_heavy_containment' || asset === 'door_panel' || asset === 'door_panel_angle' || asset === 'door_panel_small';
}

/** Align the door with the nav opening and put its panel alongside it on the wall. */
export function doorAppearance(side: DoorSide, bounds: Rect, config: DoorConfig): DoorAppearance {
  const door = passageDoorFrame(side, false, config.big, config.style);
  const panel = passagePanelFrame(side, false, 0, false, undefined, config.style);
  const x = Math.round(bounds.x + (bounds.w - door.w) / 2) + (config.offset?.x ?? 0);
  const y = bounds.y + bounds.h - door.h + (config.offset?.y ?? 0);
  const gap = 3;
  const panelX = side === 'south' ? x - panel.w - gap : x + door.w + gap;
  // The side walls slope in opposite directions, one pixel per horizontal pixel.
  const wallOffsetY = side === 'west' ? -door.w - gap - 1 : side === 'east' ? panel.w + gap - 1 : 0;
  const panelY = config.style === 'heavy_containment'
    ? y + Math.round((door.h - panel.h) / 2)
    : y + door.h - panel.h + wallOffsetY;
  return {
    clearance: config.clearance,
    big: config.big ?? false,
    ...(config.style ? { style: config.style } : {}),
    asset: passageDoorAsset(config.clearance, side, config.big, config.style),
    panelAsset: passagePanelAsset(side, config.style),
    x, y,
    panel: { x: panelX + (config.panelOffset?.x ?? 0), y: panelY + (config.panelOffset?.y ?? 0) },
    panelFlip: side === 'east',
  };
}

export type PassagePart = 'door' | 'panel';

/** Room-pixel boxes of a passage's door and panel artwork. */
export function passagePartBounds(side: DoorSide, art: DoorAppearance): Record<PassagePart, Rect> {
  const door = passageDoorFrame(side, false, art.big, art.style);
  const panel = passagePanelFrame(side, false, 0, false, undefined, art.style);
  return {
    door: { x: art.x, y: art.y, w: door.w, h: door.h },
    panel: { x: art.panel.x, y: art.panel.y, w: panel.w, h: panel.h },
  };
}

/** Shared by both camera views of the same physical door. */
export class PassageDoor {
  readonly clearance: number;
  readonly motionSeconds: number;
  /** 0 = closed, 1 = fully open. */
  open = 0;
  unlocked = false;
  readonly statuses = new StatusEffects({ kind: 'door', entity: this }, (id, active) => {
    if (id !== 'broken' || !active) return;
    this.open = 0;
    this.unlocked = false;
    this.hold = 0;
  });
  readonly panelStatuses = new StatusEffects({ kind: 'panel', entity: this }, (id, active) => {
    if (id !== 'broken') return;
    if (active) this.unlocked = false;
    else this.hold = 0;
  });
  private hold = 0;
  private powerSource: () => boolean = () => true;
  private readonly openOverrides = new Set<object>();

  get forcedOpen(): boolean {
    return this.openOverrides.size > 0;
  }

  forceOpen(owner: object) {
    this.openOverrides.add(owner);
    this.open = 1;
    this.unlocked = true;
  }

  releaseOpen(owner: object) {
    this.openOverrides.delete(owner);
    if (this.forcedOpen) return;
    this.hold = 0;
    this.unlocked = false;
    if (this.broken) this.open = 0;
  }

  setPowerSource(source: () => boolean) {
    this.powerSource = source;
  }

  get powered(): boolean {
    return this.powerSource();
  }

  constructor(clearance: number, big = false) {
    this.clearance = clearance;
    this.motionSeconds = big ? BIG_PASSAGE_DOOR_SECONDS : PASSAGE_DOOR_SECONDS;
  }

  get broken(): boolean {
    return this.statuses.has('broken');
  }

  set broken(broken: boolean) {
    if (broken) this.break();
    else this.repair();
  }

  get panelBroken(): boolean {
    return this.panelStatuses.has('broken');
  }

  set panelBroken(broken: boolean) {
    if (broken) this.breakPanel();
    else this.repairPanel();
  }

  get passable(): boolean {
    return (!this.broken || this.forcedOpen) && this.open >= 0.5;
  }

  get blocked(): boolean {
    return (this.broken && !this.forcedOpen) || ((this.panelBroken || !this.powered) && !this.passable);
  }

  get stuckOpen(): boolean {
    return (this.forcedOpen || this.panelBroken || !this.powered) && this.passable;
  }

  break(): boolean {
    return !this.broken && this.statuses.apply('broken');
  }

  breakPanel(): boolean {
    return !this.panelBroken && this.panelStatuses.apply('broken');
  }

  repair(): boolean {
    return this.statuses.remove('broken');
  }

  repairPanel(): boolean {
    return this.panelStatuses.remove('broken');
  }

  isBroken(part: PassagePart): boolean {
    return part === 'door' ? this.broken : this.panelBroken;
  }

  /** Breaks or repairs one component, e.g. from the debug editor. */
  setBroken(part: PassagePart, broken: boolean): boolean {
    if (part === 'door') return broken ? this.break() : this.repair();
    return broken ? this.breakPanel() : this.repairPanel();
  }

  /** One roll per working component when an authorized agent approaches. */
  breakOnUse(): ('door' | 'panel')[] {
    if (this.forcedOpen || !this.powered || this.broken || this.panelBroken) return [];
    const broken: ('door' | 'panel')[] = [];
    if (chance(PROP_BREAK_CHANCE) && this.breakPanel()) broken.push('panel');
    if (chance(PROP_BREAK_CHANCE) && this.break()) broken.push('door');
    return broken;
  }

  /** `occupied`: someone is in the doorway, so it must not close on them (but they don't open it). */
  update(authorizedNearby: boolean, dt: number, occupied = false) {
    // Overrides hold even damaged doors open; the damage remains once released.
    if (this.forcedOpen) {
      this.open = 1;
      this.unlocked = true;
      return;
    }
    if (!this.powered) {
      this.unlocked = false;
      this.hold = 0;
      return;
    }
    if (this.broken || this.panelBroken) return;
    const elapsed = Math.max(0, dt);
    if (authorizedNearby) {
      this.hold = PASSAGE_DOOR_HOLD_SECONDS;
      this.unlocked = true;
      this.open = Math.min(1, this.open + elapsed / this.motionSeconds);
      return;
    }
    const held = Math.min(this.hold, elapsed);
    this.hold -= held;
    this.open = Math.min(1, this.open + held / this.motionSeconds);
    this.unlocked = this.hold > 0;
    if (!occupied) this.open = Math.max(0, this.open - (elapsed - held) / this.motionSeconds);
  }
}
