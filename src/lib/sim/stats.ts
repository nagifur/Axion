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

export interface AgentStat {
  current: number;
  readonly max: number;
}

export type AgentStats = { [K in keyof SimStats]: AgentStat };

export function createAgentStats(overrides?: Partial<SimStats>): AgentStats {
  const max = resolveStats(overrides);
  return {
    hp: { current: max.hp, max: max.hp },
    stamina: { current: max.stamina, max: max.stamina },
    magic: { current: max.magic, max: max.magic },
    hunger: { current: 0, max: max.hunger },
    thirst: { current: 0, max: max.thirst },
  };
}
