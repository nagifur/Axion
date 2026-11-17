import type { DoorSide, Point, Rect } from './navMap.ts';
import { PROP_BREAK_CHANCE } from './prop.ts';
import { chance } from './random.ts';
import type { PropSheetImage } from './sprites.ts';

/** An optional physical door attached to a painted passage. */
export interface DoorConfig {
  clearance: number;
  offset?: Point;
  panelOffset?: Point;
}

export interface DoorAppearance {
  clearance: number;
  asset: string;
  panelAsset: string;
  x: number;
  y: number;
  panel: Point;
  panelFlip: boolean;
}

export const PASSAGE_DOOR_SECONDS = 0.7;
export const PASSAGE_DOOR_HOLD_SECONDS = 1.5;
export const PASSAGE_DOOR_RANGE = 40;
export const DOOR_PANEL_FRAME_SECONDS = 0.6;

const angled = (side: DoorSide) => side === 'west' || side === 'east';

export const passageDoorAsset = (clearance: number, side: DoorSide) =>
  `door_${angled(side) ? 'angle_' : ''}level${clearance}${side === 'east' ? '_east' : ''}`;
export const passagePanelAsset = (side: DoorSide) => `door_panel${angled(side) ? '_angle' : ''}`;

/** These sheets use 96px cells; the crops keep the same alignment across their states. */
export const passageDoorFrame = (side: DoorSide, broken = false): Rect => angled(side)
  ? { x: 35, y: broken ? 192 : 0, w: 26, h: 96 }
  : { x: 26, y: (broken ? 192 : 0) + 14, w: 46, h: 69 };

export function passagePanelFrame(side: DoorSide, unlocked: boolean, time: number, broken = false, image?: PropSheetImage): Rect {
  const columns = broken ? image?.propCells?.[2]?.flatMap((populated, column) => populated ? [column] : []) ?? [0] : [0, 1];
  if (!columns.length) throw new Error('Passage panel is missing broken artwork.');
  const column = columns[Math.floor(time / DOOR_PANEL_FRAME_SECONDS) % columns.length];
  const row = broken ? 2 : unlocked ? 3 : 0;
  return angled(side)
    ? { x: 39 + column * 96, y: row * 96, w: 17, h: 84 }
    : { x: 39 + column * 96, y: row * 96 + 14, w: 20, h: 69 };
}

export function isPassageDoorAsset(asset: string): boolean {
  return /^door_(?:level\d+|angle_level\d+(?:_east)?)$/.test(asset) || asset === 'door_panel' || asset === 'door_panel_angle';
}

/** Align the door with the nav opening and put its panel alongside it on the wall. */
export function doorAppearance(side: DoorSide, bounds: Rect, config: DoorConfig): DoorAppearance {
  const door = passageDoorFrame(side);
  const panel = passagePanelFrame(side, false, 0);
  const x = Math.round(bounds.x + (bounds.w - door.w) / 2) + (config.offset?.x ?? 0);
  const y = bounds.y + bounds.h - door.h + (config.offset?.y ?? 0);
  const gap = 3;
  const panelX = side === 'east' ? x - panel.w - gap : x + door.w + gap;
  const panelY = angled(side) ? y + door.h - panel.h - door.w - gap - 1 : y + door.h - panel.h;
  return {
    clearance: config.clearance,
    asset: passageDoorAsset(config.clearance, side),
    panelAsset: passagePanelAsset(side),
    x, y,
    panel: { x: panelX + (config.panelOffset?.x ?? 0), y: panelY + (config.panelOffset?.y ?? 0) },
    panelFlip: side === 'east',
  };
}

export type PassagePart = 'door' | 'panel';

/** Room-pixel boxes of a passage's door and panel artwork. */
export function passagePartBounds(side: DoorSide, art: DoorAppearance): Record<PassagePart, Rect> {
  const door = passageDoorFrame(side);
  const panel = passagePanelFrame(side, false, 0);
  return {
    door: { x: art.x, y: art.y, w: door.w, h: door.h },
    panel: { x: art.panel.x, y: art.panel.y, w: panel.w, h: panel.h },
  };
}

/** Shared by both camera views of the same physical door. */
export class PassageDoor {
  readonly clearance: number;
  /** 0 = closed, 1 = fully open. */
  open = 0;
  unlocked = false;
  broken = false;
  panelBroken = false;
  private hold = 0;

  constructor(clearance: number) {
    this.clearance = clearance;
  }

  get blocked(): boolean {
    return this.broken || (this.panelBroken && this.open < 1);
  }

  get stuckOpen(): boolean {
    return !this.broken && this.panelBroken && this.open === 1;
  }

  break(): boolean {
    if (this.broken) return false;
    this.broken = true;
    this.open = 0;
    this.unlocked = false;
    this.hold = 0;
    return true;
  }

  breakPanel(): boolean {
    if (this.panelBroken) return false;
    this.panelBroken = true;
    this.unlocked = false;
    return true;
  }

  repair(): boolean {
    if (!this.broken) return false;
    this.broken = false;
    return true;
  }

  repairPanel(): boolean {
    if (!this.panelBroken) return false;
    this.panelBroken = false;
    this.hold = 0;
    return true;
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
    if (this.broken || this.panelBroken) return [];
    const broken: ('door' | 'panel')[] = [];
    if (chance(PROP_BREAK_CHANCE) && this.breakPanel()) broken.push('panel');
    if (chance(PROP_BREAK_CHANCE) && this.break()) broken.push('door');
    return broken;
  }

  update(authorizedNearby: boolean, dt: number) {
    if (this.broken || this.panelBroken) return;
    const elapsed = Math.max(0, dt);
    if (authorizedNearby) {
      this.hold = PASSAGE_DOOR_HOLD_SECONDS;
      this.unlocked = true;
      this.open = Math.min(1, this.open + elapsed / PASSAGE_DOOR_SECONDS);
      return;
    }
    const held = Math.min(this.hold, elapsed);
    this.hold -= held;
    this.open = Math.min(1, this.open + held / PASSAGE_DOOR_SECONDS);
    this.unlocked = this.hold > 0;
    this.open = Math.max(0, this.open - (elapsed - held) / PASSAGE_DOOR_SECONDS);
  }
}
