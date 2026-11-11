// Build-time only: reads room folders from src/sim_assets/rooms/<id>/ and checks them.
// A room folder holds room.png (the art), navMap.png (where feet can go) and room.json
// (name, props, and which room each door leads to).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NavMapError, parseNavMap, type DoorSide } from './navMap.ts';
import type { ExitLink, PlacedProp, RoomData } from './room.ts';
import { PROP_TYPES } from './sprites.ts';

export const SIM_ASSETS_DIR = path.resolve('src/sim_assets');

interface RoomJson {
  name?: unknown;
  level?: unknown;
  camera?: unknown;
  props?: unknown;
  exits?: unknown;
  elevators?: unknown;
}

/** An exit as written in room.json; the door on the other side may be left for us to work out. */
interface DeclaredExit {
  room: string;
  door?: string;
}

export interface LoadedRoom {
  data: RoomData;
  exits: Map<string, DeclaredExit>;
}

const jsonLabel = (id: string) => `sim_assets/rooms/${id}/room.json`;

async function imageSize(file: string) {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new NavMapError(`${file}: could not read image size.`);
  return { width, height };
}

function readExits(raw: unknown, id: string): Map<string, DeclaredExit> {
  const exits = new Map<string, DeclaredExit>();
  if (raw === undefined) return exits;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NavMapError(`${jsonLabel(id)}: "exits" should look like { "west": "other-room-folder" }.`);
  }
  for (const [door, value] of Object.entries(raw)) {
    if (typeof value === 'string') exits.set(door, { room: value });
    else if (value && typeof value === 'object' && typeof value.room === 'string' && (value.door === undefined || typeof value.door === 'string')) {
      exits.set(door, { room: value.room, door: value.door });
    } else {
      throw new NavMapError(`${jsonLabel(id)}: exit "${door}" should be a room folder name, or { "room": "...", "door": "..." }.`);
    }
  }
  return exits;
}

/** "elevators": { "<elevator name>": "<shaft name>" }. Elevators sharing a shaft name are stops of one lift. */
function readShafts(raw: unknown, id: string, nav: RoomData['nav']): Record<string, string> {
  if (raw === undefined) return {};
  const elevators = nav.exits.filter((exit) => exit.kind === 'elevator').map((exit) => exit.id);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NavMapError(`${jsonLabel(id)}: "elevators" should look like { "elevator": "main" }.`);
  }
  for (const [elevator, shaft] of Object.entries(raw)) {
    if (!elevators.includes(elevator)) {
      throw new NavMapError(`${jsonLabel(id)}: "elevators" mentions "${elevator}", but navMap.png has: ${listOr(elevators, 'no elevator')}.`);
    }
    if (typeof shaft !== 'string' || !shaft) {
      throw new NavMapError(`${jsonLabel(id)}: elevator "${elevator}" needs a shaft name, e.g. "main".`);
    }
  }
  return raw as Record<string, string>;
}

async function readRoom(id: string, assetsDir: string): Promise<LoadedRoom> {
  const folder = path.join(assetsDir, 'rooms', id);
  const label = `sim_assets/rooms/${id}`;
  const json = JSON.parse(await readFile(path.join(folder, 'room.json'), 'utf8')) as RoomJson;

  if (typeof json.name !== 'string' || typeof json.level !== 'number' || typeof json.camera !== 'string') {
    throw new NavMapError(`${label}/room.json: needs "name" (text), "level" (number) and "camera" (text).`);
  }

  const room = await imageSize(path.join(folder, 'room.png'));
  const { data, info } = await sharp(path.join(folder, 'navMap.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== room.width || info.height !== room.height) {
    throw new NavMapError(
      `${label}/navMap.png is ${info.width}×${info.height} but room.png is ${room.width}×${room.height}. They must match pixel for pixel.`,
    );
  }
  const nav = parseNavMap(data, info.width, info.height, `${label}/navMap.png`);

  const props: PlacedProp[] = [];
  const entries = Array.isArray(json.props) ? json.props : [];
  for (const [index, entry] of entries.entries()) {
    const { type, x, y, flip } = entry ?? {};
    const propType = PROP_TYPES[type];
    if (!propType) {
      throw new NavMapError(`${label}/room.json: prop ${index + 1} has unknown type "${type}". Known: ${Object.keys(PROP_TYPES).join(', ')}.`);
    }
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new NavMapError(`${label}/room.json: prop ${index + 1} (${type}) needs whole-number "x" and "y".`);
    }
    const size = await imageSize(path.join(assetsDir, 'props', `${propType.asset}.png`));
    props.push({ type, asset: propType.asset, x, y, w: size.width, h: size.height, flip: flip === true });
  }

  return {
    data: {
      id, name: json.name, level: json.level, camera: json.camera, width: room.width, height: room.height,
      nav, props, links: {}, shafts: readShafts(json.elevators, id, nav),
    },
    exits: readExits(json.exits, id),
  };
}

/** Loads a single room on its own, without connecting its doors to other rooms. */
export async function loadRoom(id: string, assetsDir = SIM_ASSETS_DIR): Promise<RoomData> {
  return (await readRoom(id, assetsDir)).data;
}

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
        `${jsonLabel(declaredIn)}: door "${fromDoor}" of ${from.id} would lead to ${to.room} (${to.door}), ` +
        `but it already leads to ${existing.room} (${existing.door}). Each door can only lead to one place.`,
      );
    }
    from.links[fromDoor] = to;
  };

  for (const { data: room, exits } of rooms) {
    for (const [door, target] of exits) {
      const label = jsonLabel(room.id);
      if (!doorIds(room).includes(door)) {
        throw new NavMapError(`${label}: "exits" mentions door "${door}", but navMap.png has: ${listOr(doorIds(room), 'no doors')}.`);
      }
      const other = byId.get(target.room);
      if (!other) {
        throw new NavMapError(`${label}: door "${door}" leads to "${target.room}", but there is no such room folder. Rooms: ${[...byId.keys()].join(', ')}.`);
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
      connect(room, door, { room: other.id, door: otherDoor }, room.id);
      connect(other, otherDoor, { room: room.id, door }, room.id);
    }
  }
}

/**
 * Places every room on a grid per level (west/east are columns, north/south are rows) by following
 * the doors that connect them, so cameras can be shown as a floor plan. Sets `room.map` and returns
 * the rooms ordered level by level, top to bottom, west to east.
 */
export function orderRooms(rooms: RoomData[]): RoomData[] {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const sorted = [...rooms].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
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

  return sorted.sort((a, b) => a.level - b.level || a.map!.row - b.map!.row || a.map!.col - b.map!.col);
}

/** A shaft can only stop once per level: two of its elevators on the same floor would be two different lifts. */
export function checkShafts(rooms: RoomData[]) {
  const stops = new Map<string, RoomData>();
  for (const room of rooms) {
    for (const shaft of Object.values(room.shafts)) {
      const key = `${shaft}@${room.level}`;
      const other = stops.get(key);
      if (other) {
        throw new NavMapError(
          `${jsonLabel(room.id)}: elevator shaft "${shaft}" already stops on level ${room.level} in ${other.id}. ` +
          'Give one of them a different shaft name.',
        );
      }
      stops.set(key, room);
    }
  }
}

/** Loads every room folder, links their doors and elevators together, and orders them for the camera map. */
export async function loadFacility(assetsDir = SIM_ASSETS_DIR): Promise<RoomData[]> {
  const folders = await readdir(path.join(assetsDir, 'rooms'), { withFileTypes: true });
  const ids = folders.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const rooms = await Promise.all(ids.map((id) => readRoom(id, assetsDir)));
  linkRooms(rooms);
  checkShafts(rooms.map((room) => room.data));
  return orderRooms(rooms.map((room) => room.data));
}
