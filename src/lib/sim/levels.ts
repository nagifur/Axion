import type { LevelDefinitions, LevelEventDefinition, LevelState, LevelPower } from './levelState.ts';
import { range } from './random.ts';

export const BLACKOUT_BACKUP_SECONDS = 10;
/** Window after a blackout ends during which equipment comes back to life one piece at a time. */
export const BLACKOUT_RESTORE_SECONDS = 5;
const backupAt = new WeakMap<LevelState, number>();

function setPower(level: LevelState, power: LevelPower) {
  for (const room of level.rooms) room.power = power;
}

/** Events available on every loaded floor. Nothing triggers them automatically. */
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
};

/** Floor-specific simulation rules, keyed by the numeric `level` in room.json. */
export const LEVEL_DEFINITIONS: LevelDefinitions = {};
