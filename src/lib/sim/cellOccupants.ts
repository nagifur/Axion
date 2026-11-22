import { Creature } from './creature.ts';
import { random } from './random.ts';
import type { Room } from './room.ts';
import type { SimCreature } from './roster.ts';

function shuffled<T>(items: readonly T[]) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function assignCellOccupants(roster: readonly SimCreature[], rooms: readonly Room[]): Creature[] {
  if (!roster.length) return [];
  const cells = shuffled(rooms.filter((room) => room.cell?.creatureId === null));
  return shuffled(roster).slice(0, cells.length).map((profile, i) => {
    const room = cells[i];
    const occupant = new Creature(profile, room);
    room.cell!.creatureId = profile.id;
    return occupant;
  });
}