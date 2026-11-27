import type { Agent } from './agent.ts';
import { accessCardLevel, ITEM_REACH, Item, startingItemTypes } from './item.ts';

type Holder = Pick<Agent, 'character' | 'room' | 'draggable' | 'x' | 'y' | 'updateDarkness'>;

/** Moves items between the hand, personal storage, and the holder's current room. */
export class AgentInventory {
  private readonly holder: Holder;
  private carriedItem: Item | null = null;
  private readonly storedItems: Item[] = [];

  constructor(holder: Holder) {
    this.holder = holder;
    for (const type of startingItemTypes(holder.character)) this.storedItems.push(Item.create(type));
  }

  get item(): Item | null {
    return this.carriedItem;
  }

  get inventory(): readonly Item[] {
    return this.storedItems;
  }

  hasAccessCard(level: number): boolean {
    return [...this.storedItems, ...(this.item ? [this.item] : [])]
      .some((item) => (accessCardLevel(item) ?? -1) >= level);
  }

  /** Stores a brand-new item without occupying the hand. */
  receiveStoredItem(item: Item) {
    if (item === this.item || this.storedItems.includes(item) || this.holder.room.items.includes(item)) {
      throw new Error('Item is already held, stored, or loose in this agent\'s room.');
    }
    this.storedItems.push(item);
  }

  storeItem(): Item {
    if (!this.holder.draggable) throw new Error('Agent cannot store an item during transport, dragging, departure, or incapacitation.');
    const item = this.item;
    if (!item) throw new Error('Agent has no item to store.');
    this.storedItems.push(item);
    this.carriedItem = null;
    this.holder.updateDarkness();
    return item;
  }

  retrieveItem(item: Item) {
    if (!this.holder.draggable) throw new Error('Agent cannot retrieve an item during transport, dragging, departure, or incapacitation.');
    if (this.item) throw new Error('Agent already carries an item.');
    const index = this.storedItems.indexOf(item);
    if (index < 0) throw new Error('Item is not in this agent\'s inventory.');
    this.storedItems.splice(index, 1);
    this.carriedItem = item;
    this.holder.updateDarkness();
  }

  pickUpItem(item: Item) {
    if (!this.holder.draggable) throw new Error('Agent cannot pick up an item during transport, dragging, departure, or incapacitation.');
    if (this.item) throw new Error('Agent already carries an item.');
    if (!this.holder.room.items.includes(item)) throw new Error('Item is not loose in this agent\'s room.');
    if (Math.hypot(item.x + item.w / 2 - this.holder.x, item.y + item.h - this.holder.y) > ITEM_REACH) {
      throw new Error(`Item is out of pickup reach (${ITEM_REACH} room pixels).`);
    }
    this.holder.room.items = this.holder.room.items.filter((other) => other !== item);
    this.carriedItem = item;
    this.holder.updateDarkness();
  }

  /** Drops at the nearest open floor position in the current room. */
  dropItem(): Item {
    if (!this.holder.draggable) throw new Error('Agent cannot drop an item during transport, dragging, departure, or incapacitation.');
    const item = this.item;
    if (!item) throw new Error('Agent has no item to drop.');
    const point = this.holder.room.nearestWalkable(this.holder);
    item.x = Math.round(point.x - item.w / 2);
    item.y = Math.round(point.y - item.h);
    this.holder.room.items.push(item);
    this.carriedItem = null;
    this.holder.updateDarkness();
    return item;
  }

  /** Puts a brand-new item (not one lying in the room) into the empty hand. */
  receiveItem(item: Item) {
    if (this.item) throw new Error('Agent already carries an item.');
    if (this.storedItems.includes(item)) throw new Error('Stored items are retrieved with retrieveItem.');
    if (this.holder.room.items.includes(item)) throw new Error('Loose items are picked up with pickUpItem.');
    this.carriedItem = item;
    this.holder.updateDarkness();
  }

  /** Hands over everything carried or stored, e.g. when this agent is absorbed. */
  takeAllItems(): Item[] {
    const items = [...(this.carriedItem ? [this.carriedItem] : []), ...this.storedItems];
    this.carriedItem = null;
    this.storedItems.length = 0;
    this.holder.updateDarkness();
    return items;
  }

  /** Destroys the carried item (used up); it does not go back on the floor. */
  consumeItem(): Item {
    const item = this.item;
    if (!item) throw new Error('Agent has no item to use up.');
    this.carriedItem = null;
    this.holder.updateDarkness();
    return item;
  }
}
