import { ITEM_SPRITES } from './sprites.ts';
import { clearanceLevel, type SimCharacter } from './roster.ts';
import { StatusEffects } from './statusEffects.ts';

/** How far from their feet, in room pixels, an agent can pick up a loose item. */
export const ITEM_REACH = 12;

// Level 0 retains its own permissions while reusing level-1 artwork.
export const itemAssetType = (type: string): string => type === 'card_lvl0' ? 'card_lvl1' : type;

export function startingItemTypes(character: SimCharacter): readonly string[] {
  const level = clearanceLevel(character.accessLevel ?? '1');
  return [level === Infinity ? 'card_admin' : `card_lvl${level}`, ...(character.startingItems ?? [])];
}

export function accessCardLevel(item: { type: string }): number | undefined {
  if (item.type === 'card_admin') return Infinity;
  const match = /^card_lvl(\d+)$/.exec(item.type);
  return match ? Number(match[1]) : undefined;
}

/** Something an agent can do with the item in their hand. */
export interface ItemAction {
  id: string;
  /** Shown as the agent's activity while doing it. */
  activity: string;
  seconds: number;
  /** How likely the planner picks it, compared with other options (looking around is 1–3). */
  weight: number;
  /** The item is used up and destroyed when the action finishes. */
  consumes?: boolean;
  /** Log line ending, after the agent's name, e.g. "finished a can". */
  done?: string;
}

/** Actions each item type unlocks while carried. Types not listed are only carried around. */
export const ITEM_ACTIONS: Record<string, readonly ItemAction[]> = {
  can: [{ id: 'drink', activity: 'Drinking a can', seconds: 4, weight: 2, consumes: true, done: 'finished a can' }],
};

export const itemActions = (item: { type: string } | null | undefined): readonly ItemAction[] =>
  (item && ITEM_ACTIONS[item.type]) || [];

export interface PlacedItem {
  type: string;
  asset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  flip: boolean;
}

/** Items live on the floor, in an agent's hand, or in their personal storage, never more than one. */
export class Item implements PlacedItem {
  readonly statuses = new StatusEffects({ kind: 'item', entity: this });
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

  /** A brand-new item (e.g. from a vending machine); needs an ITEM_SPRITES crop for its size. */
  static create(type: string): Item {
    const frame = ITEM_SPRITES[type];
    if (!frame) throw new Error(`Item "${type}" needs an ITEM_SPRITES entry before it can be created.`);
    return new Item({ type, asset: `item:${itemAssetType(type)}`, x: 0, y: 0, w: frame.w, h: frame.h, flip: false });
  }
}
