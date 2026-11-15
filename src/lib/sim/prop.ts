// A prop placed in a room, with state that can change while the simulation runs
// (lights switching on and off, furniture breaking). room.json only stores how it starts.

import { hasPropLook, propTypeOf, type PropLook, type PropType } from './sprites.ts';
import type { Point, Room } from './room.ts';
import type { Rect } from './navMap.ts';

export interface PropState {
  /** Switched on. Only used by switchable props. */
  on: boolean;
  broken: boolean;
}

/** How a prop starts unless room.json says otherwise. */
export const DEFAULT_PROP_STATE: Readonly<PropState> = { on: true, broken: false };
export const PROP_BREAK_CHANCE = 0.01;

/** A prop as room.json places it. */
export interface PlacedProp {
  type: string;
  asset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  flip: boolean;
  /** Asset-derived power switch for sheets with an off row. Not written to room.json. */
  switchable?: boolean;
  /** Asset-derived broken artwork, including for types without their own entry. */
  brokenLook?: boolean;
  /** Starting state, only where it differs from DEFAULT_PROP_STATE. */
  start?: Partial<PropState>;
}

export class Prop implements PlacedProp {
  readonly type: string;
  readonly asset: string;
  x: number;
  y: number;
  readonly w: number;
  readonly h: number;
  flip: boolean;
  start?: Partial<PropState>;
  on: boolean;
  broken: boolean;
  readonly brokenLook?: boolean;
  private readonly sheetSwitchable: boolean;
  private pendingBreaks = 0;

  constructor(data: PlacedProp) {
    this.type = data.type;
    this.asset = data.asset;
    this.x = data.x;
    this.y = data.y;
    this.w = data.w;
    this.h = data.h;
    this.flip = data.flip;
    this.sheetSwitchable = data.switchable === true && !propTypeOf(data.type).switchable;
    if (data.brokenLook === true) this.brokenLook = true;
    if (data.start && Object.keys(data.start).length) this.start = { ...data.start };
    this.on = this.switchable ? data.start?.on ?? DEFAULT_PROP_STATE.on : DEFAULT_PROP_STATE.on;
    this.broken = this.breakable ? data.start?.broken ?? DEFAULT_PROP_STATE.broken : DEFAULT_PROP_STATE.broken;
  }

  get kind(): PropType {
    return propTypeOf(this.type);
  }

  get switchable() {
    return !!this.kind.switchable || this.sheetSwitchable;
  }

  get automaticPowerOff() {
    return this.switchable && this.kind.automaticPowerOff === true;
  }

  get breakable() {
    return !!this.kind.breakable || this.brokenLook === true;
  }

  /** Switched on and working. */
  get lit() {
    return this.switchable && this.on && !this.broken;
  }

  /** Item type this prop hands out right now, or null when it has none or is broken or switched off. */
  get dispensing(): string | null {
    const type = this.kind.dispenses;
    return type && !this.broken && (!this.switchable || this.on) ? type : null;
  }

  /** Particle set thrown when it breaks, and the room area it comes from (null if none). */
  get breakParticles(): { set: string; area: Rect; depth: number } | null {
    const debris = this.kind.breakParticles;
    if (!debris) return null;
    const area = debris.area ?? { x: 0, y: 0, w: this.w, h: this.h };
    const x = this.flip ? this.w - area.x - area.w : area.x;
    return { set: debris.set, area: { x: this.x + x, y: this.y + area.y, w: area.w, h: area.h }, depth: this.y + this.h };
  }

  /** Where someone stands to use the prop from the front. */
  standPoint(room: Room): Point {
    return room.nearestWalkable({ x: this.x + this.w / 2, y: this.y + this.h + 4 });
  }

  /** Returns whether anything changed. */
  setOn(on: boolean): boolean {
    if (!this.switchable || this.on === on) return false;
    this.on = on;
    return true;
  }

  /** Returns whether anything changed. Anyone using a broken prop gets up (see World.update). */
  break(): boolean {
    if (!this.breakable || this.broken) return false;
    this.broken = true;
    this.pendingBreaks++;
    return true;
  }

  /** Runtime break events since the last simulation update. */
  takeBreaks(): number {
    const count = this.pendingBreaks;
    this.pendingBreaks = 0;
    return count;
  }

  breakOnUse(): boolean {
    return this.breakable && !this.broken && Math.random() < PROP_BREAK_CHANCE && this.break();
  }

  /** Returns whether anything changed. */
  repair(): boolean {
    if (!this.broken) return false;
    this.broken = false;
    return true;
  }

  /**
   * Which frames to draw. Broken props without broken artwork yet still show as broken where
   * they can: a broken light goes dark, anything else keeps its normal look.
   */
  get look(): PropLook | undefined {
    if (this.broken && (this.brokenLook || hasPropLook(this.asset, 'broken'))) return 'broken';
    if (this.switchable && !this.lit) return 'off';
    return undefined;
  }

  /** Changes how the prop starts (used by the editor) and applies it straight away. */
  setStart(state: Partial<PropState>) {
    const start = { ...this.start, ...state };
    for (const key of Object.keys(start) as (keyof PropState)[]) {
      if (start[key] === DEFAULT_PROP_STATE[key]) delete start[key];
    }
    this.start = Object.keys(start).length ? start : undefined;
    if (state.on !== undefined) this.setOn(state.on);
    if (state.broken === true && this.breakable) this.broken = true;
    if (state.broken === false) this.repair();
  }

  /** Placement and starting state, as room.json stores it. */
  toData(): PlacedProp {
    const { type, asset, x, y, w, h, flip } = this;
    return {
      type, asset, x, y, w, h, flip,
      ...(this.sheetSwitchable ? { switchable: true } : {}),
      ...(this.brokenLook ? { brokenLook: true } : {}),
      ...(this.start ? { start: { ...this.start } } : {}),
    };
  }
}
