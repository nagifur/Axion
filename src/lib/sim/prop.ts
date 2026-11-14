// A prop placed in a room, with state that can change while the simulation runs
// (lights switching on and off, furniture breaking). room.json only stores how it starts.

import { hasPropLook, propTypeOf, type PropLook, type PropType } from './sprites.ts';

export interface PropState {
  /** Switched on. Only used by switchable props. */
  on: boolean;
  broken: boolean;
}

/** How a prop starts unless room.json says otherwise. */
export const DEFAULT_PROP_STATE: Readonly<PropState> = { on: true, broken: false };

/** A prop as room.json places it. */
export interface PlacedProp {
  type: string;
  asset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  flip: boolean;
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

  constructor(data: PlacedProp) {
    this.type = data.type;
    this.asset = data.asset;
    this.x = data.x;
    this.y = data.y;
    this.w = data.w;
    this.h = data.h;
    this.flip = data.flip;
    if (data.start && Object.keys(data.start).length) this.start = { ...data.start };
    this.on = this.switchable ? data.start?.on ?? DEFAULT_PROP_STATE.on : DEFAULT_PROP_STATE.on;
    this.broken = this.breakable ? data.start?.broken ?? DEFAULT_PROP_STATE.broken : DEFAULT_PROP_STATE.broken;
  }

  get kind(): PropType {
    return propTypeOf(this.type);
  }

  get switchable() {
    return !!this.kind.switchable;
  }

  get breakable() {
    return !!this.kind.breakable;
  }

  /** Switched on and working. */
  get lit() {
    return this.switchable && this.on && !this.broken;
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
    return true;
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
    if (this.broken && hasPropLook(this.asset, 'broken')) return 'broken';
    if (this.switchable && !this.lit && hasPropLook(this.asset, 'off')) return 'off';
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
    if (state.broken === true) this.break();
    if (state.broken === false) this.repair();
  }

  /** Placement and starting state, as room.json stores it. */
  toData(): PlacedProp {
    const { type, asset, x, y, w, h, flip } = this;
    return this.start ? { type, asset, x, y, w, h, flip, start: { ...this.start } } : { type, asset, x, y, w, h, flip };
  }
}
