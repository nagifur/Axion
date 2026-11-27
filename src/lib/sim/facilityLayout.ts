import { NavMapError, type DoorSide } from './navMap.ts';
import type { ExitLink, RoomData } from './room.ts';

/** An exit as written in room.json; the door on the other side may be left for us to work out. */
export interface DeclaredExit {
  room: string;
  door?: string;
}

export interface LoadedRoom {
  data: RoomData;
  exits: Map<string, DeclaredExit>;
  instances?: { id: string; name: string; camera: string; exits: Map<string, DeclaredExit> }[];
}

export const roomJsonPath = (id: string) => `sim_assets/rooms/${id}/room.json`;

const doorIds = (room: RoomData) => room.nav.exits.filter((exit) => exit.kind === 'door').map((exit) => exit.id);
const listOr = (items: string[], empty: string) => (items.length ? items.join(', ') : empty);
// Only plain side names pair up automatically; numbered doors (west-1, west-2) must say which door they lead to.
const OPPOSITE: Record<string, string> = { west: 'east', east: 'west', north: 'south', south: 'north' };
/** One step on the camera map for each wall a door can be in. North is up. */
const MAP_STEP: Record<DoorSide, { col: number; row: number }> = {
  west: { col: -1, row: 0 }, east: { col: 1, row: 0 }, north: { col: 0, row: -1 }, south: { col: 0, row: 1 },
};
const doorSide = (doorId: string) => doorId.split('-')[0] as DoorSide;

/** Turns every room's "exits" into two-way links between doors, checking that they make sense. */
export function linkRooms(rooms: LoadedRoom[]) {
  const byId = new Map(rooms.map((room) => [room.data.id, room.data]));

  const connect = (from: RoomData, fromDoor: string, to: ExitLink, declaredIn: string) => {
    const existing = from.links[fromDoor];
    if (existing && (existing.room !== to.room || existing.door !== to.door)) {
      throw new NavMapError(
        `${roomJsonPath(declaredIn)}: door "${fromDoor}" of ${from.id} would lead to ${to.room} (${to.door}), ` +
        `but it already leads to ${existing.room} (${existing.door}). Each door can only lead to one place.`,
      );
    }
    from.links[fromDoor] = to;
  };

  for (const { data: room, exits } of rooms) {
    for (const [door, target] of exits) {
      const label = roomJsonPath(room.templateId ?? room.id);
      if (!doorIds(room).includes(door)) {
        throw new NavMapError(`${label}: "exits" mentions door "${door}", but nav_map.png has: ${listOr(doorIds(room), 'no doors')}.`);
      }
      const other = byId.get(target.room);
      if (!other) {
        throw new NavMapError(`${label}: door "${door}" leads to "${target.room}", but there is no such room folder or instance. Rooms: ${[...byId.keys()].join(', ')}.`);
      }
      const otherDoors = doorIds(other);
      const opposite = OPPOSITE[door];
      const otherDoor = target.door
        ?? (opposite && otherDoors.includes(opposite) ? opposite : otherDoors.length === 1 ? otherDoors[0] : undefined);
      if (!otherDoor) {
        throw new NavMapError(
          `${label}: door "${door}" leads to ${other.id}, but it's unclear which of its doors (${listOr(otherDoors, 'none')}) to come out of. ` +
          `Write it as { "room": "${other.id}", "door": "..." }.`,
        );
      }
      if (!otherDoors.includes(otherDoor)) {
        throw new NavMapError(`${label}: door "${door}" leads to door "${otherDoor}" of ${other.id}, which only has: ${listOr(otherDoors, 'no doors')}.`);
      }
      connect(room, door, { room: other.id, door: otherDoor }, room.templateId ?? room.id);
      connect(other, otherDoor, { room: room.id, door }, room.templateId ?? room.id);
    }
  }

  for (const { data: room } of rooms) {
    for (const [door, target] of Object.entries(room.links)) {
      const other = byId.get(target.room)!;
      const local = room.doors?.[door];
      const opposite = other.doors?.[target.door];
      if (local && opposite && local.clearance !== opposite.clearance) {
        throw new NavMapError(
          `${roomJsonPath(room.templateId ?? room.id)}: door "${door}" and ${other.id}'s "${target.door}" need the same clearance.`,
        );
      }
      if (!local && opposite) {
        room.doors ??= {};
        room.doors[door] = { clearance: opposite.clearance, ...(opposite.big !== undefined ? { big: opposite.big } : {}) };
      }
    }
  }
}

/**
 * Places every room on a grid per level (west/east are columns, north/south are rows) by following
 * the doors that connect them, so cameras can be shown as a floor plan. Grouped cameras are listed
 * separately without map positions. Returns rooms level by level, with each group after the map.
 */
export function orderRooms(rooms: RoomData[]): RoomData[] {
  const grouped = rooms.filter((room) => room.cameraGroup);
  const sorted = rooms.filter((room) => !room.cameraGroup).sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  const byId = new Map(sorted.map((room) => [room.id, room]));
  const nextCol = new Map<number, number>();

  for (const start of sorted) {
    if (start.map) continue;
    // Walk outwards from this room through doors on the same level.
    const placed = new Map<RoomData, { col: number; row: number }>([[start, { col: 0, row: 0 }]]);
    const taken = new Set(['0,0']);
    const queue = [start];
    while (queue.length) {
      const room = queue.shift()!;
      const at = placed.get(room)!;
      for (const [door, link] of Object.entries(room.links)) {
        const next = byId.get(link.room);
        if (!next || placed.has(next) || next.map || next.level !== room.level) continue;
        const step = MAP_STEP[doorSide(door)] ?? MAP_STEP.east;
        const spot = { col: at.col + step.col, row: at.row + step.row };
        // Rooms that don't fit on a simple grid (loops, odd layouts) move east to the next free cell.
        while (taken.has(`${spot.col},${spot.row}`)) spot.col++;
        taken.add(`${spot.col},${spot.row}`);
        placed.set(next, spot);
        queue.push(next);
      }
    }

    // Unconnected groups on the same level sit side by side.
    const cells = [...placed.values()];
    const minCol = Math.min(...cells.map((cell) => cell.col));
    const minRow = Math.min(...cells.map((cell) => cell.row));
    const offset = nextCol.get(start.level) ?? 0;
    for (const [room, cell] of placed) room.map = { col: cell.col - minCol + offset, row: cell.row - minRow };
    nextCol.set(start.level, offset + Math.max(...cells.map((cell) => cell.col)) - minCol + 1);
  }

  sorted.sort((a, b) => a.level - b.level || a.map!.row - b.map!.row || a.map!.col - b.map!.col);
  return [...sorted, ...grouped.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))]
    .sort((a, b) => a.level - b.level);
}

/** A shaft can only stop once per level: two of its elevators on the same floor would be two different lifts. */
export function checkShafts(rooms: RoomData[]) {
  const stops = new Map<string, RoomData>();
  for (const room of rooms) {
    const shaft = room.elevator?.shaft;
    if (shaft) {
      const key = `${shaft}@${room.level}`;
      const other = stops.get(key);
      if (other) {
        throw new NavMapError(
          `${roomJsonPath(room.id)}: elevator shaft "${shaft}" already stops on level ${room.level} in ${other.id}. ` +
          'Give one of them a different shaft name.',
        );
      }
      stops.set(key, room);
    }
  }
}
