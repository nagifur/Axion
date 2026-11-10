// Build-time only: reads room folders from src/sim_assets/rooms/<id>/ and checks them.
// A room folder holds room.png (the art), navMap.png (where feet can go) and room.json
// (name, props, and which room each door leads to).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NavMapError, parseNavMap } from './navMap.ts';
import type { ExitLink, PlacedProp, RoomData } from './room.ts';
import { PROP_TYPES } from './sprites.ts';

export const SIM_ASSETS_DIR = path.resolve('src/sim_assets');

interface RoomJson {
  name?: unknown;
  level?: unknown;
  camera?: unknown;
  props?: unknown;
  exits?: unknown;
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
    data: { id, name: json.name, level: json.level, camera: json.camera, width: room.width, height: room.height, nav, props, links: {} },
    exits: readExits(json.exits, id),
  };
}

/** Loads a single room on its own, without connecting its doors to other rooms. */
export async function loadRoom(id: string, assetsDir = SIM_ASSETS_DIR): Promise<RoomData> {
  return (await readRoom(id, assetsDir)).data;
}

const doorIds = (room: RoomData) => room.nav.exits.filter((exit) => exit.kind === 'door').map((exit) => exit.id);
const listOr = (items: string[], empty: string) => (items.length ? items.join(', ') : empty);
// Only plain "west"/"east" pair up automatically; numbered doors (west-1, west-2) must say which door they lead to.
const OPPOSITE: Record<string, string> = { west: 'east', east: 'west' };

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

/** Orders rooms per level the way they connect, west to east, so cameras can be shown as a floor plan. */
export function orderRooms(rooms: RoomData[]): RoomData[] {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const placement = new Map<string, { group: number; x: number }>();
  const sorted = [...rooms].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));

  sorted.forEach((start, group) => {
    if (placement.has(start.id)) return;
    placement.set(start.id, { group, x: 0 });
    const queue = [start];
    while (queue.length) {
      const room = queue.shift()!;
      const { x } = placement.get(room.id)!;
      for (const [door, link] of Object.entries(room.links)) {
        const next = byId.get(link.room);
        if (!next || placement.has(next.id) || next.level !== room.level) continue;
        placement.set(next.id, { group, x: x + (door.startsWith('west') ? -1 : 1) });
        queue.push(next);
      }
    }
  });

  return sorted.sort((a, b) => {
    const pa = placement.get(a.id)!;
    const pb = placement.get(b.id)!;
    return a.level - b.level || pa.group - pb.group || pa.x - pb.x;
  });
}

/** Loads every room folder, links their doors together, and orders them for the camera map. */
export async function loadFacility(assetsDir = SIM_ASSETS_DIR): Promise<RoomData[]> {
  const folders = await readdir(path.join(assetsDir, 'rooms'), { withFileTypes: true });
  const ids = folders.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const rooms = await Promise.all(ids.map((id) => readRoom(id, assetsDir)));
  linkRooms(rooms);
  return orderRooms(rooms.map((room) => room.data));
}
