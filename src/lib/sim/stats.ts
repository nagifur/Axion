/** Profile values are capacities, not the agent's mutable live values. */
export interface SimStats {
  hp: number;
  stamina: number;
  magic: number;
  hunger: number;
  thirst: number;
}

export const DEFAULT_STATS: Readonly<SimStats> = Object.freeze({
  hp: 100,
  stamina: 100,
  magic: 0,
  hunger: 100,
  thirst: 100,
});

export function resolveStats(overrides: Partial<SimStats> = {}): SimStats {
  const stats = { ...DEFAULT_STATS, ...overrides };
  for (const key of Object.keys(DEFAULT_STATS) as (keyof SimStats)[]) {
    const value = stats[key];
    if (!Number.isFinite(value) || (key === 'magic' ? value < 0 : value <= 0)) {
      throw new Error(`Invalid stat "${key}": expected a finite ${key === 'magic' ? 'nonnegative' : 'positive'} capacity.`);
    }
  }
  return stats;
}

export interface LiveStat {
  current: number;
  readonly max: number;
}

/** Mutable per-instance pools shared by staff agents and creatures alike. */
export type LiveStats = { [K in keyof SimStats]: LiveStat };

/** Stamina points spent per second of running or dashing. */
export const STAMINA_DRAIN_PER_SECOND = 12;
/** Stamina points regained per second while not running. */
export const STAMINA_RECOVERY_PER_SECOND = 6;

/** Anything with stamina that can become `exhausted` (agents and creatures). */
export interface StaminaUser {
  readonly stats: LiveStats;
  readonly statuses: { has(id: string): boolean; apply(id: string): boolean };
}

/** Spends `dt` seconds of running; false means the actor is exhausted and must walk instead. */
export function spendStamina(actor: StaminaUser, dt: number): boolean {
  if (actor.statuses.has('exhausted')) return false;
  const stamina = actor.stats.stamina;
  stamina.current = Math.max(0, stamina.current - STAMINA_DRAIN_PER_SECOND * Math.max(0, dt));
  if (stamina.current <= 0) actor.statuses.apply('exhausted');
  return true;
}

/** Stamina regenerates whenever the actor isn't running, even while exhausted. */
export function recoverStamina(stats: LiveStats, dt: number) {
  stats.stamina.current = Math.min(stats.stamina.max, stats.stamina.current + STAMINA_RECOVERY_PER_SECOND * Math.max(0, dt));
}

/** Magic capability comes from capacity, so a depleted pool still counts. */
export function hasMagic(stats: LiveStats): boolean {
  return stats.magic.max > 0;
}

export function createLiveStats(overrides?: Partial<SimStats>, onDeath?: () => void): LiveStats {
  const max = resolveStats(overrides);
  let hp = max.hp;
  let dead = false;
  return {
    hp: {
      get current() { return hp; },
      set current(value: number) {
        if (dead) return;
        hp = value;
        if (onDeath && hp <= 0) {
          dead = true;
          hp = 0;
          onDeath();
        }
      },
      max: max.hp,
    },
    stamina: { current: max.stamina, max: max.stamina },
    magic: { current: max.magic, max: max.magic },
    hunger: { current: 0, max: max.hunger },
    thirst: { current: 0, max: max.thirst },
  };
}
