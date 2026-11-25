import type { LevelDefinitions, LevelEventDefinition, LevelState, LevelPower } from './levelState.ts';
import { range } from './random.ts';
import type { Creature } from './creature.ts';
import type { PassageDoor } from './door.ts';
import type { World } from './world.ts';

export const BLACKOUT_BACKUP_SECONDS = 10;
/** Window after a blackout ends during which equipment comes back to life one piece at a time. */
export const BLACKOUT_RESTORE_SECONDS = 5;
const backupAt = new WeakMap<LevelState, number>();
const containmentFailures = new WeakMap<LevelState, {
  pending: Set<Creature>;
  held: Set<PassageDoor>;
  waiting: Set<PassageDoor>;
  opening?: PassageDoor;
}>();

function finishContainmentFailure(level: LevelState) {
  const failure = containmentFailures.get(level);
  if (failure && failure.pending.size === 0) level.stopEvent('containment-failure');
}

function openNextCellDoor(level: LevelState) {
  const failure = containmentFailures.get(level);
  if (!failure || (failure.opening && failure.opening.open < 1)) return;
  failure.opening = undefined;
  for (const door of failure.waiting) {
    failure.waiting.delete(door);
    failure.held.add(door);
    door.forceOpen(level);
    if (door.open < 1) {
      failure.opening = door;
      return;
    }
  }
}

/** A captured creature must be delivered home before its cell can stop being held open. */
export function restoreCellContainment(world: World, creature: Creature) {
  const level = world.level(creature.home.level);
  if (!level) return;
  const failure = containmentFailures.get(level);
  if (!failure) return;
  failure.pending.delete(creature);
  for (const door of creature.home.doors) {
    const state = world.passageDoorFor(door);
    if (!state) continue;
    failure.waiting.delete(state);
    if (failure.held.delete(state)) state.releaseOpen(level);
    if (failure.opening === state) failure.opening = undefined;
  }
  finishContainmentFailure(level);
  openNextCellDoor(level);
}

function setPower(level: LevelState, power: LevelPower) {
  for (const room of level.rooms) room.power = power;
}

/** Shared floor events; nothing triggers them automatically. */
export const LEVEL_EVENTS: Readonly<Record<string, LevelEventDefinition>> = {
  blackout: {
    label: 'Blackout',
    onStart(level, world) {
      backupAt.set(level, world.time + BLACKOUT_BACKUP_SECONDS);
      setPower(level, 'off');
      world.log(`Level ${level.number}: blackout. Backup generator starting.`, 'alert');
    },
    onUpdate(level, world) {
      const at = backupAt.get(level);
      if (at === undefined || world.time < at) return;
      backupAt.delete(level);
      setPower(level, 'backup');
      world.log(`Level ${level.number}: backup power online. Emergency lights and door panels restored.`, 'warn');
    },
    onEnd(level, world) {
      backupAt.delete(level);
      setPower(level, 'normal');
      // Each electric prop comes back to life at its own random moment instead of all at once.
      // The wrapped source is evaluated lazily, so no per-frame bookkeeping is needed; once the
      // moment passes it behaves exactly like the room's own power again.
      for (const room of level.rooms) {
        for (const prop of room.props) {
          if (!prop.electric) continue;
          const at = world.time + range(0, BLACKOUT_RESTORE_SECONDS);
          prop.setPowerSource(() => (world.time >= at ? room.power : 'off'));
        }
      }
      world.log(`Level ${level.number}: normal power restored. Equipment coming back online.`, 'ok');
    },
  },
  'containment-failure': {
    label: 'Containment failure',
    onStart(level, world) {
      const pending = new Set(world.creatures.filter((creature) =>
        creature.home.level === level.number && !creature.escaped && !creature.consumed));
      const waiting = new Set<PassageDoor>();
      for (const room of level.rooms) {
        for (const door of room.doors) {
          if (!room.cell && !door.cell) continue;
          const state = world.passageDoorFor(door);
          if (!state) continue;
          waiting.add(state);
        }
      }
      containmentFailures.set(level, { pending, held: new Set(), waiting });
      world.log(`Level ${level.number}: containment failure. Cell doors opening one by one. Security team notified.`, 'alert');
      world.incidents.record('failure-started', { level: level.number });
      finishContainmentFailure(level);
      openNextCellDoor(level);
    },
    onUpdate(level) {
      const failure = containmentFailures.get(level);
      if (!failure) return;
      for (const creature of failure.pending) {
        // Nobody can bring back a creature that has fled the facility or been absorbed.
        if (creature.escaped || creature.consumed) failure.pending.delete(creature);
      }
      finishContainmentFailure(level);
      openNextCellDoor(level);
    },
    onEnd(level, world) {
      const failure = containmentFailures.get(level);
      if (failure) {
        for (const door of failure.held) door.releaseOpen(level);
        containmentFailures.delete(level);
      }
      world.log(`Level ${level.number}: containment failure ended. Cell door controls restored.`, 'ok');
      world.incidents.record('failure-ended', { level: level.number });
    },
  },
};

/** Floor-specific simulation rules, keyed by the numeric `level` in room.json. */
export const LEVEL_DEFINITIONS: LevelDefinitions = {};
