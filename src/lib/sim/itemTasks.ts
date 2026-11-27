import type { Task } from './agent.ts';
import type { Point, Room } from './room.ts';
import type { Prop } from './prop.ts';
import { distance } from './navMap.ts';
import { Item, ITEM_REACH, itemActions, type ItemAction } from './item.ts';
import { breakPropOnUse } from './tasks.ts';
import { tryElectricalShock } from './electrical.ts';

// Tasks for picking up, using, setting down and dispensing items.

/** Does one of the carried item's actions; consuming actions destroy the item once finished. */
export function useItem(action: ItemAction): Task {
  let left = action.seconds;
  let item: Item | null = null;
  return {
    activity: action.activity,
    interruptible: false,
    get usingItem() { return item; },
    start(agent) {
      item = agent.item;
      if (!itemActions(item).includes(action)) throw new Error(`Agent cannot "${action.id}" without a matching item.`);
      agent.facing = agent.facing === 'left' ? 'left' : 'right';
    },
    update(agent, world, dt) {
      // The item may have been dropped meanwhile; then there is nothing left to do.
      if (agent.item !== item) return true;
      left -= dt;
      if (left > 0) return false;
      if (action.activates) {
        if (!item?.canActivate) return true;
        item.activate();
        agent.updateDarkness();
      }
      if (action.consumes) agent.consumeItem();
      if (action.done) world.log(`${agent.character.name} ${action.done} in the ${agent.room.name}.`, 'muted');
      return true;
    },
  };
}

/** Where the agent stands to pick up a loose item, or undefined if it can't be reached from open floor. */
export function itemPickupPoint(room: Room, item: Item): Point | undefined {
  const foot = { x: item.x + item.w / 2, y: item.y + item.h };
  const stand = room.nearestWalkable(foot);
  return room.isWalkable(stand) && distance(stand, foot) <= ITEM_REACH ? stand : undefined;
}

/**
 * Bends down for a loose item next to the agent and takes it. Nothing happens if their hand
 * filled up or someone else took the item first.
 */
export function pickUp(item: Item, seconds = 1): Task {
  let left = seconds;
  const name = item.type.replaceAll('_', ' ');
  return {
    activity: `Picking up a ${name}`,
    interruptible: false,
    start(agent) {
      agent.facing = 'front';
      agent.face({ x: item.x + item.w / 2, y: item.y + item.h });
    },
    update(agent, world, dt) {
      left -= dt;
      if (left > 0) return false;
      agent.curiousAbout = undefined;
      const reachable = Math.hypot(item.x + item.w / 2 - agent.x, item.y + item.h - agent.y) <= ITEM_REACH;
      if (agent.item || !agent.room.items.includes(item) || !reachable) {
        agent.say('?', 2);
        return true;
      }
      agent.pickUpItem(item);
      world.log(`${agent.character.name} picked up a ${name} in the ${agent.room.name}.`, 'muted');
      return true;
    },
  };
}

/** Sets the carried item down at the agent's current position. */
export function setDownItem(item: Item): Task {
  const name = item.type.replaceAll('_', ' ');
  return {
    activity: `Putting down a ${name}`,
    interruptible: false,
    update(agent, world) {
      if (agent.item !== item) return true;
      agent.dropItem();
      world.log(`${agent.character.name} set down a ${name} in the ${agent.room.name}.`, 'muted');
      return true;
    },
  };
}

/** Moves an item between personal storage and the hand. */
export function storeItem(item: Item): Task {
  const name = item.type.replaceAll('_', ' ');
  return {
    activity: `Storing a ${name}`,
    interruptible: false,
    update(agent, world) {
      if (agent.item !== item || !agent.draggable) {
        agent.say('?', 2);
        return true;
      }
      agent.storeItem();
      world.log(`${agent.character.name} stored a ${name}.`, 'muted');
      return true;
    },
  };
}

export function retrieveItem(item: Item): Task {
  const name = item.type.replaceAll('_', ' ');
  return {
    activity: `Retrieving a ${name}`,
    interruptible: false,
    update(agent, world) {
      if (agent.item || !agent.inventory.includes(item) || !agent.draggable) {
        agent.say('?', 2);
        return true;
      }
      agent.retrieveItem(item);
      world.log(`${agent.character.name} retrieved a ${name}.`, 'muted');
      return true;
    },
  };
}

/**
 * Uses a dispenser prop (e.g. a vending machine) the agent stands in front of, and puts the new
 * item in their hand. Nothing comes out if the hand is full or the prop broke or went off meanwhile.
 */
export function getFromDispenser(prop: Prop, seconds = 2.5): Task {
  let left = seconds;
  let checkedShock = false;
  const type = prop.kind.dispenses;
  if (!type) throw new Error(`The ${prop.type} does not dispense anything.`);
  return {
    activity: `Using the ${prop.type.replaceAll('_', ' ')}`,
    interruptible: false,
    start(agent) {
      agent.facing = 'back';
    },
    update(agent, world, dt) {
      if (dt > 0 && prop.broken && !checkedShock) {
        checkedShock = true;
        if (tryElectricalShock(agent, world, prop)) return false;
      }
      left -= dt;
      if (left > 0) return false;
      const name = prop.type.replaceAll('_', ' ');
      if (agent.item || prop.dispensing !== type || !agent.room.props.includes(prop)) {
        agent.say('?', 2);
        world.log(`${agent.character.name} couldn't get a ${type} from the ${name} in the ${agent.room.name}.`, 'muted');
        return true;
      }
      if (breakPropOnUse(agent, world, prop)) return true;
      agent.receiveItem(Item.create(type));
      world.log(`${agent.character.name} got a ${type} from the ${name} in the ${agent.room.name}.`, 'muted');
      return true;
    },
  };
}
