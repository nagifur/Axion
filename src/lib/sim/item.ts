import { ITEM_SPRITES } from './sprites.ts';
import { clearanceLevel, type SimCharacter } from './roster.ts';
import { StatusEffects } from './statusEffects.ts';

/** How far from their feet, in room pixels, an agent can pick up a loose item. */
export const ITEM_REACH = 12;

// Level 0 retains its own permissions while reusing level-1 artwork.
export const itemAssetType = (type: string): string => type === 'card_level0' ? 'card_level1' : type;

export function startingItemTypes(character: SimCharacter): readonly string[] {
  const level = clearanceLevel(character.accessLevel ?? '1');
  return [level === Infinity ? 'card_admin' : `card_level${level}`, ...(character.startingItems ?? [])];
}

export function accessCardLevel(item: { type: string }): number | undefined {
  if (item.type === 'card_admin') return Infinity;
  const match = /^card_level(\d+)$/.exec(item.type);
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
  /** Activates this item's light once; unavailable while lit or after burnout. */
  activates?: boolean;
  /** Log line ending, after the agent's name, e.g. "finished a can". */
  done?: string;
}

export interface ItemLight {
  color: string;
  /** Halo radius in room pixels, before character scaling. */
  radius: number;
  requiresActivation?: boolean;
  /** Simulation seconds from activation; omitted means unlimited. */
  lifetime?: number;
}

export interface ItemType {
  actions?: readonly ItemAction[];
  /** Only an active light in the hand protects its holder from darkness. */
  light?: ItemLight;
}

/** Item behavior belongs here, not in character, planner or renderer type checks. */
export const ITEM_TYPES: Record<string, ItemType> = {
  can: {
    actions: [{ id: 'drink', activity: 'Drinking a can', seconds: 4, weight: 2, consumes: true, done: 'finished a can' }],
  },
  glowstick: {
    actions: [{
      id: 'activate', activity: 'Cracking a glowstick', seconds: 1, weight: 2,
      activates: true, done: 'activated a glowstick',
    }],
    light: { color: '#73ff8a', radius: 32, requiresActivation: true, lifetime: 180 },
  },
};

export const itemActions = (item: Item | null | undefined): readonly ItemAction[] =>
  item ? (item.kind.actions ?? []).filter((action) => !action.activates || item.canActivate) : [];

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
  private activated = false;
  private spent = false;
  private lightRemaining: number | null = null;

  constructor(data: PlacedItem) {
    this.type = data.type;
    this.asset = data.asset;
    this.x = data.x;
    this.y = data.y;
    this.w = data.w;
    this.h = data.h;
    this.flip = data.flip;
    const light = this.kind.light;
    if (light?.lifetime !== undefined && (!Number.isFinite(light.lifetime) || light.lifetime <= 0)) {
      throw new Error(`Item "${this.type}" light lifetime must be a positive, finite number of simulation seconds.`);
    }
    if (light && (!Number.isFinite(light.radius) || light.radius <= 0)) {
      throw new Error(`Item "${this.type}" light radius must be positive and finite.`);
    }
    if (light && !light.requiresActivation) {
      this.activated = true;
      this.lightRemaining = light.lifetime ?? null;
    }
  }

  get kind(): ItemType {
    return Object.hasOwn(ITEM_TYPES, this.type) ? ITEM_TYPES[this.type] : {};
  }

  get light(): ItemLight | null {
    return this.activated && !this.spent ? this.kind.light ?? null : null;
  }

  get canActivate(): boolean {
    return !!this.kind.light && !this.activated && !this.spent;
  }

  get remainingLightSeconds(): number | null {
    return this.lightRemaining;
  }

  activate() {
    const light = this.kind.light;
    if (!light || !this.canActivate) throw new Error(`Item "${this.type}" cannot be activated.`);
    this.activated = true;
    this.lightRemaining = light.lifetime ?? null;
  }

  /** World ticks every owned item once, including stored and dropped lights. */
  update(dt: number) {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('Item update needs a finite, non-negative timestep.');
    if (!this.light || this.lightRemaining === null) return;
    this.lightRemaining = Math.max(0, this.lightRemaining - dt);
    if (this.lightRemaining === 0) this.spent = true;
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
