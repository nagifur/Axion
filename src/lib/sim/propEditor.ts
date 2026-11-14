// Debug-only tool for placing props in a room by hand and copying the result into room.json.

import { drawPropSprite, type Assets } from './render.ts';
import { Prop, type PlacedProp } from './prop.ts';
import type { Point, Room } from './room.ts';
import { propFrame, propTypeOf, type PropLook } from './sprites.ts';

interface Mask {
  alpha: Uint8ClampedArray;
  w: number;
  h: number;
}

interface Drag {
  prop: Prop;
  offset: Point;
  moved: boolean;
}

const COLORS = {
  floor: 'rgba(5, 255, 0, 0.12)',
  blocked: 'rgba(255, 60, 60, 0.4)',
  seat: '#7ef5ff',
  outline: 'rgba(255, 255, 255, 0.45)',
  selected: '#f5d970',
  ghost: '#33ff99',
};

/** Fresh copies in their starting state. */
const clone = (props: PlacedProp[]) => props.map((prop) => new Prop(prop));

/** Same layout as the existing room.json files: one prop per line. */
export function propsSnippet(props: PlacedProp[]): string {
  if (!props.length) return '"props": []';
  const lines = props.map((prop) =>
    `  { "type": ${JSON.stringify(prop.type)}, "x": ${prop.x}, "y": ${prop.y}${prop.flip ? ', "flip": true' : ''}` +
    `${prop.start?.on === false ? ', "on": false' : ''}${prop.start?.broken ? ', "broken": true' : ''} }`);
  return `"props": [\n${lines.join(',\n')}\n]`;
}

export class PropEditor {
  active = false;
  room: Room;
  selected: Prop | null = null;
  /** Prop type waiting to be placed with the next click. */
  placing: string | null = null;
  cursor: Point | null = null;
  private drag: Drag | null = null;
  private readonly masks = new Map<string, Mask>();
  /** Props each room had when the page loaded, to show what changed and to reset. */
  private readonly original = new Map<Room, Prop[]>();
  private readonly assets: Assets;
  private readonly onChange: () => void;

  constructor(assets: Assets, room: Room, onChange: () => void) {
    this.assets = assets;
    this.onChange = onChange;
    this.room = room;
    this.setRoom(room);
  }

  setRoom(room: Room) {
    if (!this.original.has(room)) this.original.set(room, clone(room.props));
    this.room = room;
    this.selected = null;
    this.placing = null;
    this.drag = null;
    this.onChange();
  }

  isEdited(room = this.room) {
    const original = this.original.get(room);
    return !!original && propsSnippet(original) !== propsSnippet(room.props);
  }

  snippet() {
    return propsSnippet(this.room.props);
  }

  /** Puts the room back the way room.json has it. */
  reset() {
    const original = this.original.get(this.room);
    if (!original) return;
    this.room.setProps(clone(original));
    this.selected = null;
    this.onChange();
  }

  /** Starts placing a new prop: it follows the cursor until the next click. */
  add(type: string) {
    this.placing = this.placing === type ? null : type;
    this.selected = null;
    this.onChange();
  }

  flip() {
    if (!this.selected) return;
    this.selected.flip = !this.selected.flip;
    this.commit();
  }

  /** Whether the selected prop starts broken. */
  toggleBroken() {
    if (!this.selected?.breakable) return;
    this.selected.setStart({ broken: !this.selected.start?.broken });
    this.commit();
  }

  /** Whether the selected light starts switched off. It still comes on when someone walks in. */
  toggleOff() {
    if (!this.selected?.switchable) return;
    this.selected.setStart({ on: this.selected.start?.on === false });
    this.commit();
  }

  remove() {
    if (!this.selected) return;
    this.room.props = this.room.props.filter((prop) => prop !== this.selected);
    this.selected = null;
    this.commit();
  }

  nudge(dx: number, dy: number) {
    if (!this.selected) return;
    this.selected.x += dx;
    this.selected.y += dy;
    this.commit();
  }

  pointerDown(point: Point, time = 0) {
    if (this.placing) {
      // Same whole-pixel position as the preview that followed the cursor.
      const prop = new Prop(this.ghost(this.placing, { x: Math.floor(point.x), y: Math.floor(point.y) }));
      this.room.props = [...this.room.props, prop];
      this.selected = prop;
      this.placing = null;
      this.commit();
      return;
    }
    const prop = this.propAt(point, time);
    this.selected = prop;
    this.drag = prop ? { prop, offset: { x: point.x - prop.x, y: point.y - prop.y }, moved: false } : null;
    this.onChange();
  }

  pointerMove(point: Point) {
    this.cursor = { x: Math.floor(point.x), y: Math.floor(point.y) };
    if (!this.drag) return;
    const x = Math.round(point.x - this.drag.offset.x);
    const y = Math.round(point.y - this.drag.offset.y);
    if (x === this.drag.prop.x && y === this.drag.prop.y) return;
    this.drag.prop.x = x;
    this.drag.prop.y = y;
    this.drag.moved = true;
    this.onChange();
  }

  pointerUp() {
    // Seats and blocked floor are only worked out again once the prop is dropped.
    if (this.drag?.moved) this.commit();
    this.drag = null;
  }

  pointerLeave() {
    this.cursor = null;
  }

  /** Handles editor shortcuts. Returns true if the key was used. */
  key(event: KeyboardEvent): boolean {
    const step = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case 'ArrowLeft': this.nudge(-step, 0); return !!this.selected;
      case 'ArrowRight': this.nudge(step, 0); return !!this.selected;
      case 'ArrowUp': this.nudge(0, -step); return !!this.selected;
      case 'ArrowDown': this.nudge(0, step); return !!this.selected;
      case 'f': case 'F': this.flip(); return !!this.selected;
      case 'b': case 'B': this.toggleBroken(); return !!this.selected;
      case 'o': case 'O': this.toggleOff(); return !!this.selected;
      case 'Delete': case 'Backspace': this.remove(); return true;
      case 'Escape':
        this.placing = null;
        this.selected = null;
        this.onChange();
        return true;
      default: return false;
    }
  }

  private commit() {
    this.room.setProps(this.room.props);
    this.onChange();
  }

  /** A new prop of `type` centred on the cursor, standing on it. */
  private ghost(type: string, at: Point): PlacedProp {
    const { asset } = propTypeOf(type);
    const image = this.assets[asset];
    if (!image) throw new Error(`Missing prop asset "${asset}".`);
    const frame = propFrame(asset, image);
    return {
      type, asset, flip: false, w: frame.w, h: frame.h,
      x: Math.round(at.x - frame.w / 2), y: Math.round(at.y - frame.h),
    };
  }

  private mask(asset: string, time: number, look?: PropLook): Mask {
    const image = this.assets[asset];
    if (!image) throw new Error(`Missing prop asset "${asset}".`);
    const frame = propFrame(asset, image, time, look);
    const key = `${asset}:${frame.x}:${frame.y}`;
    const cached = this.masks.get(key);
    if (cached) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = frame.w;
    canvas.height = frame.h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
    const mask = { alpha: ctx.getImageData(0, 0, frame.w, frame.h).data, w: frame.w, h: frame.h };
    this.masks.set(key, mask);
    return mask;
  }

  /** The frontmost prop under the point, preferring its visible pixels over its box. */
  propAt(point: Point, time = 0): Prop | null {
    const front = [...this.room.props].reverse().sort((a, b) => b.y + b.h - (a.y + a.h));
    const inBox = front.filter((prop) =>
      point.x >= prop.x && point.x < prop.x + prop.w && point.y >= prop.y && point.y < prop.y + prop.h);
    const solid = inBox.find((prop) => {
      const mask = this.mask(prop.asset, time, prop.look);
      let lx = Math.floor(point.x - prop.x);
      const ly = Math.floor(point.y - prop.y);
      if (prop.flip) lx = prop.w - 1 - lx;
      return mask.alpha[(ly * mask.w + lx) * 4 + 3] > 0;
    });
    return solid ?? inBox[0] ?? null;
  }

  /** Floor, blocked areas, seats and prop outlines, drawn over the room in room pixels. */
  draw(ctx: CanvasRenderingContext2D, scale: number, time = 0) {
    const { room } = this;
    const line = 1 / scale;
    ctx.save();

    ctx.fillStyle = COLORS.floor;
    room.floorSpans.forEach((spans, y) => {
      for (let i = 0; i < spans.length; i += 2) ctx.fillRect(spans[i], y, spans[i + 1] - spans[i], 1);
    });
    ctx.fillStyle = COLORS.blocked;
    for (const rect of room.blockedAreas) ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = COLORS.seat;
    for (const spot of room.spots) ctx.fillRect(spot.x - 1, spot.y - 1, 3, 3);

    ctx.lineWidth = line;
    ctx.setLineDash([3 * line, 2 * line]);
    ctx.strokeStyle = COLORS.outline;
    for (const prop of room.props) {
      if (prop !== this.selected) ctx.strokeRect(prop.x + line / 2, prop.y + line / 2, prop.w - line, prop.h - line);
    }
    ctx.setLineDash([]);

    if (this.selected) this.outline(ctx, this.selected, COLORS.selected, scale);

    const ghost = this.placing && this.cursor ? this.ghost(this.placing, this.cursor) : null;
    if (ghost) {
      ctx.globalAlpha = 0.65;
      drawPropSprite(ctx, this.assets[ghost.asset], ghost.asset, ghost.x, ghost.y, ghost.flip, time);
      ctx.globalAlpha = 1;
      this.outline(ctx, ghost, COLORS.ghost, scale);
    }
    ctx.restore();
  }

  private outline(ctx: CanvasRenderingContext2D, prop: PlacedProp, color: string, scale: number) {
    const line = 1 / scale;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * line;
    ctx.strokeRect(prop.x - line, prop.y - line, prop.w + 2 * line, prop.h + 2 * line);

    // Coordinates label just above the prop, at a fixed on-screen size.
    const label = `${prop.type} ${prop.x}, ${prop.y}`;
    ctx.font = `${11 * line}px ui-monospace, monospace`;
    const width = ctx.measureText(label).width + 6 * line;
    const height = 14 * line;
    const x = Math.min(Math.max(0, prop.x), this.room.width - width);
    const y = prop.y - height - 2 * line < 0 ? prop.y + prop.h + 2 * line : prop.y - height - 2 * line;
    ctx.fillStyle = 'rgba(5, 8, 13, 0.85)';
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 3 * line, y + height / 2);
  }
}
