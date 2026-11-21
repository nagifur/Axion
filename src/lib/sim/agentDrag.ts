import type { Agent } from './agent.ts';
import { breakPropOnUse, fall, rest, wait } from './tasks.ts';
import { getFromDispenser } from './itemTasks.ts';
import { conversationPoint, startConversation } from './conversation.ts';
import type { Prop } from './prop.ts';
import type { Point, Room, Spot } from './room.ts';
import { scheduleFor } from './schedule.ts';
import type { World } from './world.ts';
import { tryElectricalShock } from './electrical.ts';

export type DropTarget =
  | { kind: 'invalid'; label: string }
  | { kind: 'floor'; room: Room; point: Point; label: string }
  | { kind: 'fall'; room: Room; point: Point; label: string }
  | { kind: 'seat'; room: Room; point: Spot; label: string }
  | { kind: 'agent'; room: Room; point: Point; partner: Agent; label: string }
  | { kind: 'prop'; room: Room; point: Point; prop: Prop; label: string };

/** Resolves a drop without changing the simulation, also used for the live preview. */
export function dropTarget(
  world: World, agent: Agent, point: Point, partner?: Agent | null, prop?: Prop | null, room: Room = agent.room,
): DropTarget {
  if (agent.incapacitated) return { kind: 'invalid', label: 'That agent is incapacitated' };
  if (point.x < 0 || point.y < 0 || point.x >= room.width || point.y >= room.height) {
    return { kind: 'invalid', label: 'Drop inside the camera feed' };
  }
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
  const floor = { x: Math.min(room.width - 1, Math.round(point.x)), y: Math.min(room.height - 1, Math.round(point.y)) };
  if (!room.isFloor(floor.x, floor.y)) {
    return { kind: 'fall', room, point: floor, label: 'Drop agent and fall to the floor' };
  }
  return room.isWalkable(floor)
    ? { kind: 'floor', room, point: floor, label: 'Place agent here' }
    : { kind: 'invalid', label: 'Drop on open floor, a prop, or an agent' };
}

/** Applies a freshly resolved drop; invalid drops leave the original task and position intact. */
export function placeAgent(world: World, agent: Agent, target: DropTarget): boolean {
  if (agent.incapacitated) {
    world.log(`Cannot place ${agent.character.name}: agent is incapacitated.`, 'warn');
    return false;
  }
  if (target.kind === 'invalid') {
    world.log(`Cannot place ${agent.character.name}: ${target.label}.`, 'warn');
    return false;
  }
  const source = agent.room;
  const switchOn = target.kind === 'prop' && !target.prop.on;
  agent.setPlan(world, []);
  if (agent.room !== target.room) {
    agent.room = target.room;
    agent.enteredRoomAt = world.time;
  }
  agent.x = target.point.x;
  agent.y = target.point.y;
  agent.moving = false;
  if (source !== target.room) {
    source.updateLights(world.agentsIn(source).length > 0, 0);
    target.room.updateLights(true, 0);
  }
  if (target.kind === 'fall') {
    agent.setPlan(world, [fall()]);
  } else if (target.kind === 'seat') {
    agent.setPlan(world, [rest(agent, target.point, world, scheduleFor(agent.character, world.now()))]);
    agent.spot = target.point;
    agent.facing = target.point.facing;
  } else if (target.kind === 'agent') {
    const tasks = startConversation(agent, target.partner, world, true);
    if (!tasks) throw new Error('Validated conversation drop has no meeting point');
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
