// Debug-only tool for placing props and items, then copying them into room.json.

import { drawItemSprite, drawPropSprite, PropPicker, type Assets } from './render.ts';
import { Prop, type PlacedProp } from './prop.ts';
import { Item, type PlacedItem } from './item.ts';
import type { Door, Point, Room } from './room.ts';
import type { Rect } from './navMap.ts';
import { itemFrame, propFrame, propSheetFeatures, propTypeOf } from './sprites.ts';
import { passagePartBounds, type PassageDoor, type PassagePart } from './door.ts';

/** A passage door or its panel. Their damage is live only; room.json can't start them broken. */
export interface DoorSelection {
  door: Door;
  part: PassagePart;
  state: PassageDoor;
}

type Outlined = Rect & { type: string };

interface Drag {
  prop: Prop | Item;
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

export function itemsSnippet(items: PlacedItem[]): string {
  if (!items.length) return '"items": []';
  return `"items": [\n${items.map((item) =>
    `  { "type": ${JSON.stringify(item.type)}, "x": ${item.x}, "y": ${item.y}${item.flip ? ', "flip": true' : ''} }`).join(',\n')}\n]`;
}

export class PropEditor {
  active = false;
  room: Room;
  selected: Prop | Item | null = null;
  selectedDoor: DoorSelection | null = null;
  /** Prop type or item:<type> waiting to be placed with the next click. */
  placing: string | null = null;
  cursor: Point | null = null;
  private drag: Drag | null = null;
  private readonly picker: PropPicker;
  /** Original room layouts, for change detection and reset. */
  private readonly original = new Map<Room, Prop[]>();
  private readonly originalItems = new Map<Room, Item[]>();
  private readonly assets: Assets;
  private readonly onChange: () => void;
  private readonly doorState: (door: Door) => PassageDoor | undefined;

  constructor(assets: Assets, room: Room, onChange: () => void, doorState: (door: Door) => PassageDoor | undefined = () => undefined) {
    this.assets = assets;
    this.picker = new PropPicker(assets);
    this.onChange = onChange;
    this.doorState = doorState;
    this.room = room;
    this.setRoom(room);
  }

  setRoom(room: Room) {
    if (!this.original.has(room)) this.original.set(room, clone(room.props));
    if (!this.originalItems.has(room)) this.originalItems.set(room, room.items.map((item) => new Item(item.toData())));
    this.room = room;
    this.selected = null;
    this.selectedDoor = null;
    this.placing = null;
    this.drag = null;
    this.onChange();
  }

  isEdited(room = this.room) {
    const original = this.original.get(room);
    const items = this.originalItems.get(room);
    return !!original && (propsSnippet(original) !== propsSnippet(room.props) ||
      itemsSnippet(items ?? []) !== itemsSnippet(room.items));
  }

  snippet() {
    return `${propsSnippet(this.room.props)},\n${itemsSnippet(this.room.items)}`;
  }

  /** Puts the room back the way room.json has it. */
  reset() {
    const original = this.original.get(this.room);
    if (!original) return;
    this.room.setProps(clone(original));
    this.room.items = (this.originalItems.get(this.room) ?? []).map((item) => new Item(item.toData()));
    this.selected = null;
    this.selectedDoor = null;
    this.placing = null;
    this.drag = null;
    this.onChange();
  }

  /** Starts placing a new prop: it follows the cursor until the next click. */
  add(type: string) {
    this.placing = this.placing === type ? null : type;
    this.selected = null;
    this.selectedDoor = null;
    this.onChange();
  }

  flip() {
    if (!this.selected) return;
    this.selected.flip = !this.selected.flip;
    this.commit();
  }

  /** Whether the selected prop starts broken, or breaks/repairs the selected door part right away. */
  toggleBroken() {
    if (this.selectedDoor) {
      const { state, part } = this.selectedDoor;
      state.setBroken(part, !state.isBroken(part));
      this.onChange();
      return;
    }
    if (!(this.selected instanceof Prop) || !this.selected.breakable) return;
    this.selected.setStart({ broken: !this.selected.start?.broken });
    this.commit();
  }

  /** Whether the selected prop starts switched off. */
  toggleOff() {
    if (!(this.selected instanceof Prop) || !this.selected.switchable) return;
    this.selected.setStart({ on: this.selected.start?.on === false });
    this.commit();
  }

  remove() {
    if (!this.selected) return;
    if (this.selected instanceof Item) this.room.items = this.room.items.filter((item) => item !== this.selected);
    else this.room.props = this.room.props.filter((prop) => prop !== this.selected);
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
      const data = this.ghost(this.placing, { x: Math.floor(point.x), y: Math.floor(point.y) });
      const prop = this.placing.startsWith('item:') ? new Item(data) : new Prop(data);
      if (prop instanceof Item) this.room.items.push(prop);
      else this.room.props = [...this.room.props, prop];
      this.selected = prop;
      this.selectedDoor = null;
      this.placing = null;
      this.commit();
      return;
    }
    const prop = this.picker.atLayout(this.room, point, time);
    this.selected = prop;
    // Passage doors are drawn behind every prop.
    this.selectedDoor = prop ? null : this.doorAt(point);
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
      case 'b': case 'B': this.toggleBroken(); return !!this.selected || !!this.selectedDoor;
      case 'o': case 'O': this.toggleOff(); return !!this.selected;
      case 'Delete': case 'Backspace': this.remove(); return true;
      case 'Escape':
        this.placing = null;
        this.selected = null;
        this.selectedDoor = null;
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
  private ghost(type: string, at: Point): PlacedProp | PlacedItem {
    if (type.startsWith('item:')) {
      const image = this.assets[type];
      if (!image) throw new Error(`Missing item asset "${type}".`);
      const frame = itemFrame(type.slice(5), image);
      return {
        type: type.slice(5), asset: type, w: frame.w, h: frame.h, flip: false,
        x: Math.round(at.x - frame.w / 2), y: Math.round(at.y - frame.h),
      };
    }
    const { asset } = propTypeOf(type);
    const image = this.assets[asset];
    if (!image) throw new Error(`Missing prop asset "${asset}".`);
    const frame = propFrame(asset, image);
    return {
      type, asset, flip: false, w: frame.w, h: frame.h,
      x: Math.round(at.x - frame.w / 2), y: Math.round(at.y - frame.h),
      ...propSheetFeatures(type, image),
    };
  }

  /** Every passage door and panel in the room, with their room-pixel boxes. */
  doorParts(): (DoorSelection & { bounds: Rect })[] {
    return this.room.doors.flatMap((door) => {
      const state = door.appearance && this.doorState(door);
      if (!door.appearance || !state) return [];
      const bounds = passagePartBounds(door.side, door.appearance);
      return (['panel', 'door'] as const).map((part) => ({ door, part, state, bounds: bounds[part] }));
    });
  }

  /** The door or panel under the point; panels win where they overlap their door. */
  doorAt(point: Point): DoorSelection | null {
    const hit = this.doorParts().find(({ bounds: b }) =>
      point.x >= b.x && point.x < b.x + b.w && point.y >= b.y && point.y < b.y + b.h);
    return hit ? { door: hit.door, part: hit.part, state: hit.state } : null;
  }

  /** The frontmost prop under the point, preferring its visible pixels over its box. */
  propAt(point: Point, time = 0): Prop | null {
    return this.picker.at(this.room, point, time);
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
    for (const prop of [...room.props, ...room.items]) {
      if (prop !== this.selected) ctx.strokeRect(prop.x + line / 2, prop.y + line / 2, prop.w - line, prop.h - line);
    }
    let door: Outlined | null = null;
    for (const { door: passage, part, bounds } of this.doorParts()) {
      if (passage === this.selectedDoor?.door && part === this.selectedDoor.part) {
        door = { ...bounds, type: `${passage.id} ${part}` };
      } else {
        ctx.strokeRect(bounds.x + line / 2, bounds.y + line / 2, bounds.w - line, bounds.h - line);
      }
    }
    ctx.setLineDash([]);

    if (this.selected) this.outline(ctx, this.selected, COLORS.selected, scale);
    if (door) this.outline(ctx, door, COLORS.selected, scale, door.type);

    const ghost = this.placing && this.cursor ? this.ghost(this.placing, this.cursor) : null;
    if (ghost) {
      ctx.globalAlpha = 0.65;
      if (ghost.asset.startsWith('item:')) drawItemSprite(ctx, this.assets[ghost.asset], ghost);
      else drawPropSprite(ctx, this.assets[ghost.asset], ghost.asset, ghost.x, ghost.y, ghost.flip, time, undefined, this.assets['missing-texture']);
      ctx.globalAlpha = 1;
      this.outline(ctx, ghost, COLORS.ghost, scale);
    }
    ctx.restore();
  }

  private outline(ctx: CanvasRenderingContext2D, prop: Outlined, color: string, scale: number, label = `${prop.type} ${prop.x}, ${prop.y}`) {
    const line = 1 / scale;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * line;
    ctx.strokeRect(prop.x - line, prop.y - line, prop.w + 2 * line, prop.h + 2 * line);

    // Label just above the prop, at a fixed on-screen size.
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
