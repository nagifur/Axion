export interface PlacedItem {
  type: string;
  asset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  flip: boolean;
}

/** A loose item lives in Room.items; a carried item lives only in Agent.item. */
export class Item implements PlacedItem {
  readonly type: string;
  readonly asset: string;
  x: number;
  y: number;
  readonly w: number;
  readonly h: number;
  flip: boolean;

  constructor(data: PlacedItem) {
    this.type = data.type;
    this.asset = data.asset;
    this.x = data.x;
    this.y = data.y;
    this.w = data.w;
    this.h = data.h;
    this.flip = data.flip;
  }

  toData(): PlacedItem {
    const { type, asset, x, y, w, h, flip } = this;
    return { type, asset, x, y, w, h, flip };
  }
}
