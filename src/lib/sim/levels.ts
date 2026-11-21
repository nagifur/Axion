import type { LevelDefinitions, LevelEventDefinition, LevelState, LevelPower } from './levelState.ts';

export const BLACKOUT_BACKUP_SECONDS = 10;
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
      world.log(`Level ${level.number}: normal power restored.`, 'ok');
    },
  },
};

/** Floor-specific simulation rules, keyed by the numeric `level` in room.json. */
export const LEVEL_DEFINITIONS: LevelDefinitions = {};
