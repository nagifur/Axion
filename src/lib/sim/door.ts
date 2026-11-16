import type { DoorSide, Point, Rect } from './navMap.ts';

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
  flip: boolean;
}

export const PASSAGE_DOOR_SECONDS = 0.7;
export const PASSAGE_DOOR_HOLD_SECONDS = 1.5;
export const PASSAGE_DOOR_RANGE = 40;
export const DOOR_PANEL_FRAME_SECONDS = 0.6;

const angled = (side: DoorSide) => side === 'west' || side === 'east';

export const passageDoorAsset = (clearance: number, side: DoorSide) =>
  `door_${angled(side) ? 'angle_' : ''}level${clearance}`;
export const passagePanelAsset = (side: DoorSide) => `door_panel${angled(side) ? '_angle' : ''}`;

/** These sheets use 96px cells; the crops keep the same alignment across their states. */
export const passageDoorFrame = (side: DoorSide): Rect => angled(side)
  ? { x: 35, y: 0, w: 26, h: 96 }
  : { x: 26, y: 14, w: 46, h: 69 };

export function passagePanelFrame(side: DoorSide, unlocked: boolean, time: number): Rect {
  const column = Math.floor(time / DOOR_PANEL_FRAME_SECONDS) % 2;
  return angled(side)
    ? { x: 39 + column * 96, y: unlocked ? 288 : 0, w: 17, h: 84 }
    : { x: 39 + column * 96, y: (unlocked ? 288 : 0) + 14, w: 20, h: 69 };
}

export function isPassageDoorAsset(asset: string): boolean {
  return /^door_(?:angle_)?level\d+$/.test(asset) || asset === 'door_panel' || asset === 'door_panel_angle';
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
    flip: side === 'east',
  };
}

/** Shared by both camera views of the same physical door. */
export class PassageDoor {
  readonly clearance: number;
  /** 0 = closed, 1 = fully open. */
  open = 0;
  unlocked = false;
  private hold = 0;

  constructor(clearance: number) {
    this.clearance = clearance;
  }

  update(authorizedNearby: boolean, dt: number) {
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
