import type { Agent } from './agent.ts';
import { Creature } from './creature.ts';
import { breakPropOnUse, fall, rest, wait } from './tasks.ts';
import { getFromDispenser } from './itemTasks.ts';
import { conversationPoint, startConversation } from './conversation.ts';
import type { Prop } from './prop.ts';
import type { Door, Point, Room, Spot } from './room.ts';
import { scheduleFor } from './schedule.ts';
import type { CameraActor, World } from './world.ts';
import { tryElectricalShock } from './electrical.ts';
import { passagePartBounds } from './door.ts';
import { openPassageDoor } from './transport.ts';

export type DropTarget =
  | { kind: 'invalid'; label: string }
  | { kind: 'floor'; room: Room; point: Point; label: string }
  | { kind: 'fall'; room: Room; point: Point; label: string }
  | { kind: 'seat'; room: Room; point: Spot; label: string }
  | { kind: 'agent'; room: Room; point: Point; partner: Agent; label: string }
  | { kind: 'door'; room: Room; point: Point; door: Door; label: string }
  | { kind: 'prop'; room: Room; point: Point; prop: Prop; label: string };

const TRANSFER_HINTS = {
  escaped: ' (containment breach)', recontained: ' (restore containment)', roamed: '',
};

function creatureTransfer(creature: Creature, destination: Room) {
  if (creature.room === destination) return undefined;
  return destination === creature.home ? 'recontained' : creature.contained ? 'escaped' : 'roamed';
}

/** Cell artwork is a drop target in either camera view, including its panel. */
export function cellDoorAt(world: World, room: Room, point: Point): Door | undefined {
  return room.doors.find((door) => {
    const link = door.to;
    if (!door.appearance || !(door.cell || (link && world.room(link.room)?.doors.some(
      (other) => other.id === link.door && other.cell)))) return false;
    return Object.values(passagePartBounds(door.side, door.appearance)).some((bounds) =>
      point.x >= bounds.x && point.x < bounds.x + bounds.w && point.y >= bounds.y && point.y < bounds.y + bounds.h);
  });
}

/** Resolves a drop without changing the simulation, also used for the live preview. */
export function dropTarget(
  world: World, agent: CameraActor, point: Point, partner?: CameraActor | null, prop?: Prop | null, room: Room = agent.room,
  door: Door | undefined = cellDoorAt(world, room, point),
): DropTarget {
  const creature = agent instanceof Creature;
  const noun = creature ? 'creature' : 'agent';
  if (agent.incapacitated) return { kind: 'invalid', label: `That ${noun} is incapacitated` };
  if (point.x < 0 || point.y < 0 || point.x >= room.width || point.y >= room.height) {
    return { kind: 'invalid', label: 'Drop inside the camera feed' };
  }
  if (!agent.held && !agent.draggable) return { kind: 'invalid', label: `That ${noun} is unavailable` };
  if ((!partner || partner === agent) && !prop && !door) {
    const floor = { x: Math.min(room.width - 1, Math.round(point.x)), y: Math.min(room.height - 1, Math.round(point.y)) };
    const transfer = creature ? creatureTransfer(agent, room) : undefined;
    const effect = transfer ? TRANSFER_HINTS[transfer] : '';
    if (!room.isFloor(floor.x, floor.y)) {
      return { kind: 'fall', room, point: floor, label: `Drop ${noun} and fall to the floor${effect}` };
    }
    return room.isWalkable(floor)
      ? { kind: 'floor', room, point: floor, label: `Place ${noun} here${effect}` }
      : { kind: 'invalid', label: 'Drop on open floor' };
  }
  if (creature) return { kind: 'invalid', label: 'Drop the creature on open floor or in the air' };
  if (partner instanceof Creature) return { kind: 'invalid', label: 'Cannot drop an agent onto a creature' };
  if (partner && partner !== agent) {
    if (!partner.draggable || partner.room !== room) return { kind: 'invalid', label: 'That agent is unavailable' };
    const meet = conversationPoint(point, partner);
    return meet
      ? { kind: 'agent', room, point: meet, partner, label: `Talk to ${partner.character.name}` }
      : { kind: 'invalid', label: 'No room to talk here' };
  }
  if (prop) {
    if (!room.props.includes(prop)) return { kind: 'invalid', label: 'That prop is not in this room' };
    if (!prop.powered) return { kind: 'invalid', label: `The ${prop.type} has no power` };
    if (prop.emergency) return { kind: 'invalid', label: 'Emergency lights cannot be switched manually' };
    if (prop.broken && !prop.electric) return { kind: 'invalid', label: `The ${prop.type} is broken` };
    const seats = prop.broken ? [] : room.spots.filter((spot) => spot.prop === prop);
    if (seats.length) {
      const free = seats.filter((spot) => !world.agentsIn(room).some((other) => other !== agent && other.spot === spot));
      free.sort((a, b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y));
      return free[0]
        ? { kind: 'seat', room, point: free[0], label: `Use ${prop.type}` }
        : { kind: 'invalid', label: `The ${prop.type} is occupied` };
    }
    const stand = prop.standPoint(room);
    if (!room.isWalkable(stand)) {
      return { kind: 'invalid', label: `Cannot reach the ${prop.type}` };
    }
    if (prop.broken) {
      return { kind: 'prop', room, point: stand, prop, label: `Inspect broken ${prop.type} (shock risk)` };
    }
    const dispensed = prop.dispensing;
    if (dispensed) {
      return agent.item
        ? { kind: 'invalid', label: `${agent.character.name}'s hand is already full` }
        : { kind: 'prop', room, point: stand, prop, label: `Get a ${dispensed} from the ${prop.type}` };
    }
    return { kind: 'prop', room, point: stand, prop, label: prop.switchable ? `Switch ${prop.type} ${prop.on ? 'off' : 'on'}` : `Inspect ${prop.type}` };
  }
  if (door) {
    const state = world.passageDoorFor(door);
    if (!room.doors.includes(door) || !state) return { kind: 'invalid', label: 'That door is not in this room' };
    if (!state.powered) return { kind: 'invalid', label: 'The cell door has no power' };
    if (state.broken || state.panelBroken) return { kind: 'invalid', label: 'The cell door or panel is broken' };
    if (!world.canAgentUsePassage(agent, door)) return { kind: 'invalid', label: 'The agent lacks clearance for this cell door' };
    if (!room.isWalkable(door.inside)) return { kind: 'invalid', label: 'Cannot reach the cell door' };
    return { kind: 'door', room, point: door.inside, door, label: `Open ${door.id} cell door` };
  }
  return { kind: 'invalid', label: 'No drop target' };
}

/** Applies a freshly resolved drop; invalid drops leave the original task and position intact. */
export function placeActor(world: World, agent: CameraActor, target: DropTarget): boolean {
  if (!agent.draggable) {
    world.log(`Cannot place ${agent.character.name}: ${agent.incapacitated ? 'incapacitated' : 'unavailable'}.`, 'warn');
    return false;
  }
  if (target.kind === 'invalid') {
    world.log(`Cannot place ${agent.character.name}: ${target.label}.`, 'warn');
    return false;
  }
  const source = agent.room;
  if (agent instanceof Creature) {
    if (target.kind !== 'floor' && target.kind !== 'fall') {
      world.log(`Cannot place ${agent.character.name}: creatures cannot use this target.`, 'warn');
      return false;
    }
    const transfer = creatureTransfer(agent, target.room);
    if (transfer === 'recontained') world.recontain(agent, target.point);
    else {
      agent.reposition(target.room, target.point);
      if (transfer) world.incidents.record(transfer, { creature: agent, room: target.room });
    }
    updateDropLights(world, source, target.room);
    world.log(`${agent.character.name}: ${target.label} in the ${target.room.name}.`, transfer === 'escaped' ? 'alert' : 'default');
    return true;
  }
  const switchOn = target.kind === 'prop' && !target.prop.on;
  agent.setPlan(world, []);
  if (agent.room !== target.room) {
    agent.room = target.room;
    agent.enteredRoomAt = world.time;
  }
  agent.x = target.point.x;
  agent.y = target.point.y;
  agent.moving = false;
  updateDropLights(world, source, target.room);
  if (target.kind === 'fall') {
    agent.setPlan(world, [fall()]);
  } else if (target.kind === 'seat') {
    agent.setPlan(world, [rest(agent, target.point, world, scheduleFor(agent.character, world.now()))]);
    agent.spot = target.point;
    agent.facing = target.point.facing;
  } else if (target.kind === 'agent') {
    const tasks = startConversation(agent, target.partner, world, true);
    if (!tasks) throw new Error('Validated conversation drop has no meeting point');
  } else if (target.kind === 'door') {
    agent.setPlan(world, [openPassageDoor(target.door)]);
  } else if (target.kind === 'prop' && target.prop.dispensing) {
    agent.setPlan(world, [getFromDispenser(target.prop)]);
  } else if (target.kind === 'prop') {
    let attempted = false;
    let checkedShock = false;
    const task = wait(3, target.label);
    agent.facing = 'back';
    agent.face({ x: target.prop.x + target.prop.w / 2, y: target.prop.y });
    agent.setPlan(world, [{
      ...task,
      start() {
        if (attempted) return;
        attempted = true;
        if (!target.prop.powered || target.prop.emergency || target.prop.broken || breakPropOnUse(agent, world, target.prop)) return;
        if (target.prop.switchable) target.prop.setOn(switchOn);
        else agent.say('?', 2);
      },
      update(agent, world, dt) {
        if (dt > 0 && target.prop.broken && !checkedShock) {
          checkedShock = true;
          if (tryElectricalShock(agent, world, target.prop)) return false;
        }

        return task.update(agent, world, dt);
      },
    }]);
  } else {
    agent.setPlan(world, [wait(3, 'Repositioned', 'front')]);
  }
  world.log(`${agent.character.name}: ${target.label} in the ${agent.room.name}.`, 'default');
  return true;
}

function updateDropLights(world: World, source: Room, destination: Room) {
  if (source === destination) return;
  source.updateLights(world.actorsIn(source).length > 0, 0);
  destination.updateLights(true, 0);
}

export { placeActor as placeAgent };
