import { pick, range } from './random.ts';
import { behaviorFromTraits, type SimCharacter } from './roster.ts';
import { resolveStats } from './stats.ts';

const GIVEN_NAMES = ['Alex', 'Cleo', 'Ellis', 'Iris', 'Jules', 'Kai', 'Mika', 'Morgan', 'Ren', 'Sam', 'Tess', 'Vale'];
const SURNAMES = ['Aster', 'Bell', 'Chen', 'Diaz', 'Finch', 'Hart', 'Imai', 'Lane', 'Moss', 'Reed', 'Shaw', 'Voss'];

/** Session-local personnel. The caller supplies a unique badge number and the job, not a database entry. */
export function generateNpc(badge: number, job: Pick<SimCharacter, 'position' | 'accessLevel' | 'schedule'>): SimCharacter {
  const traits = [pick(['Observant', 'Quick on their feet', 'Friendly', 'Patient']),
    pick(['Reserved', 'Shy', 'Always tired', 'Stubborn'])];
  return {
    ...job,
    id: `npc:${badge}`, employeeID: `NPC-${String(badge).padStart(4, '0')}`,
    name: `${pick(GIVEN_NAMES)} ${pick(SURNAMES)}`,
    species: 'Human', tint: pick(['#9bc4ff', '#a7dbdb', '#c4b7ee']), scale: 1, weight: 1,
    traits, behavior: behaviorFromTraits(traits, 'Human'),
    stats: resolveStats({
      hp: Math.round(range(85, 120)), stamina: Math.round(range(85, 125)),
      hunger: Math.round(range(85, 115)), thirst: Math.round(range(85, 115)),
    }),
  };
}
