import type { Agent, Task } from './agent.ts';
import { passagePartBounds, type PassageDoor, type PassagePart } from './door.ts';
import type { Prop } from './prop.ts';
import type { Door, Point, Room } from './room.ts';
import { walkTo } from './tasks.ts';
import type { World } from './world.ts';
import { tryElectricalShock } from './electrical.ts';

export const REPAIR_SECONDS = 12;

export type RepairTarget =
  | { kind: 'prop'; room: Room; prop: Prop }
  | { kind: 'passage'; room: Room; door: Door; state: PassageDoor; part: PassagePart };

function sameTarget(a: RepairTarget, b: RepairTarget): boolean {
  return a.kind === 'prop' ? b.kind === 'prop' && a.prop === b.prop
    : b.kind === 'passage' && a.state === b.state && a.part === b.part;
}

function needsRepair(target: RepairTarget): boolean {
  return target.kind === 'prop'
    ? target.room.props.includes(target.prop) && target.prop.broken
    : target.room.doors.includes(target.door) && target.state.isBroken(target.part);
}

function standPoint(target: RepairTarget): Point {
  if (target.kind === 'prop') return target.prop.standPoint(target.room);
  if (target.part === 'door') return target.door.inside;
  const { panel } = passagePartBounds(target.door.side, target.door.appearance!);
  return target.room.nearestWalkable({ x: panel.x + panel.w / 2, y: panel.y + panel.h + 4 });
}

function targetName(target: RepairTarget): string {
  return target.kind === 'prop' ? target.prop.type.replaceAll('_', ' ')
    : `${target.door.id} door${target.part === 'panel' ? ' panel' : ''}`;
}

function repair(target: RepairTarget): Task {
  let left = REPAIR_SECONDS;
  let started = false;
  let checkedShock = false;
  return {
    activity: `Repairing the ${targetName(target)}`,
    interruptible: false,
    repairTarget: target,
    update(agent, world, dt) {
      if (agent.room !== target.room || !needsRepair(target)
        || Math.hypot(agent.x - standPoint(target).x, agent.y - standPoint(target).y) > 4) return true;
      if (!started) {
        started = true;
        agent.facing = 'back';
        const point = target.kind === 'prop'
          ? { x: target.prop.x + target.prop.w / 2, y: target.prop.y } : target.door.outside;
        agent.face(point);
        world.log(`${agent.character.name} started repairing the ${targetName(target)} in the ${target.room.name}.`, 'muted');
      }
      if (dt > 0 && !checkedShock) {
        checkedShock = true;
        if (target.kind === 'prop' && tryElectricalShock(agent, world, target.prop)) return false;
      }
      left -= Math.max(0, dt);
      if (left > 0) return false;
      const fixed = target.kind === 'prop' ? target.prop.repair() : target.state.setBroken(target.part, false);
      if (fixed) world.log(`${agent.character.name} repaired the ${targetName(target)} in the ${target.room.name}.`, 'ok');
      return true;
    },
  };
}

/** Maintenance staff notice damage in their current room, including outside their shift. */
export function planRepair(agent: Agent, world: World): Task[] | undefined {
  if (agent.impostor || agent.character.position?.trim().toLowerCase() !== 'maintenance'
    || agent.incapacitated || agent.held || agent.removed || agent.leaving || agent.conversation || agent.napping
    || agent.layer !== 'room' || agent.alpha < 1) return undefined;
  const { room } = agent;
  const targets: RepairTarget[] = room.props.filter((prop) => prop.broken)
    .map((prop) => ({ kind: 'prop', room, prop }));
  for (const door of room.doors) {
    const state = world.passageDoorFor(door);
    if (!state || !door.appearance) continue;
    for (const part of ['door', 'panel'] as const) {
      if (state.isBroken(part)) targets.push({ kind: 'passage', room, door, state, part });
    }
  }
  const claims = world.agents.filter((other) => other !== agent && !other.removed)
    .map((other) => other.repairTarget).filter((target) => target !== undefined);
  const candidates = targets.filter((target) => !claims.some((claim) => sameTarget(target, claim)))
    .map((target) => ({ target, stand: standPoint(target) }))
    .filter(({ stand }) => room.canReach(agent, stand, agent.ghost))
    .sort((a, b) => Math.hypot(a.stand.x - agent.x, a.stand.y - agent.y)
      - Math.hypot(b.stand.x - agent.x, b.stand.y - agent.y));
  const found = candidates[0];
  if (!found) return undefined;
  return [
    { ...walkTo(found.stand, `Going to repair the ${targetName(found.target)}`), repairTarget: found.target },
    repair(found.target),
  ];
}
