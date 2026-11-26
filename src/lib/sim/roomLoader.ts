// Build-time only: reads room folders from src/sim_assets/rooms/<id>/ and checks them.
// A room folder holds room.png (the art), nav_map.png (where feet can go) and room.json
// (name, props, and which room each door leads to).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NavMapError, parseNavMap, type DoorSide } from './navMap.ts';
import type { ExitLink, PlacedProp, RoomData } from './room.ts';
import { itemFrame, placeablePropTypes, propCellOccupancy, propFrame, propSheetFeatures, propTypeOf, type PropSheetImage } from './sprites.ts';
import { itemAssetType, type PlacedItem } from './item.ts';
import { passageDoorAsset, passageDoorLayout, passagePanelAsset, passagePanelFrame, type DoorConfig, type DoorStyle } from './door.ts';

export const SIM_ASSETS_DIR = path.resolve('src/sim_assets');

interface RoomJson {
  name?: unknown;
  level?: unknown;
  camera?: unknown;
  props?: unknown;
  items?: unknown;
  exits?: unknown;
  elevators?: unknown;
  doors?: unknown;
  disconnectedFloors?: unknown;
  cameraGroup?: unknown;
  containmentCell?: unknown;
  restroom?: unknown;
  instances?: unknown;
}

/** An exit as written in room.json; the door on the other side may be left for us to work out. */
interface DeclaredExit {
  room: string;
  door?: string;
}

export interface LoadedRoom {
  data: RoomData;
  exits: Map<string, DeclaredExit>;
  instances?: { id: string; name: string; camera: string; exits: Map<string, DeclaredExit> }[];
}

const jsonLabel = (id: string) => `sim_assets/rooms/${id}/room.json`;

async function imageSize(file: string) {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new NavMapError(`${file}: could not read image size.`);
  return { width, height };
}

async function propImage(file: string, cellSize = 96): Promise<PropSheetImage> {
  const { data, info } = await sharp(file).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const image = { width: info.width, height: info.height };
  return { ...image, propCells: propCellOccupancy(image, data, cellSize) };
}

/** First-frame thumbnail for the editor palette, never the entire sprite sheet. */
export async function propPreview(asset: string, assetsDir = SIM_ASSETS_DIR): Promise<string> {
  const file = path.join(assetsDir, 'props', `${asset}.png`);
  const frame = propFrame(asset, await propImage(file));
  const crop = await sharp(file).extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h }).ensureAlpha().png().toBuffer();
  const { channels } = await sharp(crop).stats();
  const png = channels[channels.length - 1].max
    ? crop
    : await sharp(path.join(assetsDir, 'missing_texture.png')).resize(frame.w, frame.h, { kernel: 'nearest', fit: 'fill' }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** Every prop type a room can place (see placeablePropTypes). */
export async function listPropTypes(assetsDir = SIM_ASSETS_DIR): Promise<string[]> {
  const files = await readdir(path.join(assetsDir, 'props'));
  return placeablePropTypes(files.filter((file) => file.endsWith('.png')).map((file) => file.slice(0, -4)));
}

export async function itemPreview(type: string, assetsDir = SIM_ASSETS_DIR): Promise<string> {
  const file = path.join(assetsDir, 'items', `${itemAssetType(type)}.png`);
  const frame = itemFrame(type, await imageSize(file));
  const png = await sharp(file).extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
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

function readDoors(raw: unknown, id: string, nav: RoomData['nav']): Record<string, DoorConfig> {
  const doors: Record<string, DoorConfig> = {};
  if (raw === undefined) return doors;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NavMapError(`${jsonLabel(id)}: "doors" must be an object keyed by passage id.`);
  }
  for (const [door, value] of Object.entries(raw)) {
    const exit = nav.exits.find((candidate) => candidate.kind === 'door' && candidate.id === door);
    if (!exit) {
      const available = nav.exits.filter((exit) => exit.kind === 'door').map((exit) => exit.id);
      throw new NavMapError(`${jsonLabel(id)}: "doors" mentions passage "${door}", but nav_map.png has: ${listOr(available, 'no doors')}.`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new NavMapError(`${jsonLabel(id)}: door "${door}" needs { "clearance": 0 }.`);
    }
    for (const key of Object.keys(value)) {
      if (key !== 'clearance' && key !== 'big' && key !== 'style' && key !== 'cell' && key !== 'offset' && key !== 'panelOffset') {
        throw new NavMapError(`${jsonLabel(id)}: door "${door}" has unknown property "${key}".`);
      }
    }
    const clearance = 'clearance' in value ? value.clearance : undefined;
    if (typeof clearance !== 'number' || !Number.isSafeInteger(clearance) || clearance < 0) {
      throw new NavMapError(`${jsonLabel(id)}: door "${door}" needs a non-negative whole-number "clearance".`);
    }
    const big = 'big' in value ? value.big : undefined;
    if (big !== undefined && typeof big !== 'boolean') {
      throw new NavMapError(`${jsonLabel(id)}: door "${door}" "big" must be true or false.`);
    }
    const style = 'style' in value ? value.style : undefined;
    if (style !== undefined && style !== 'heavy_containment') {
      throw new NavMapError(`${jsonLabel(id)}: door "${door}" "style" must be "heavy_containment".`);
    }
    if (style === 'heavy_containment' && (exit.side !== 'north' || big === true)) {
      throw new NavMapError(`${jsonLabel(id)}: door "${door}" "heavy_containment" style only supports north-facing, non-big doors.`);
    }
    const cell = 'cell' in value ? value.cell : undefined;
    if (cell !== undefined && typeof cell !== 'boolean') {
      throw new NavMapError(`${jsonLabel(id)}: door "${door}" "cell" must be true or false.`);
    }
    const offset = (key: 'offset' | 'panelOffset') => {
      const point = key in value ? value[key] : undefined;
      if (point === undefined) return undefined;
      if (!point || typeof point !== 'object' || Array.isArray(point) ||
        !('x' in point) || !('y' in point) || typeof point.x !== 'number' || typeof point.y !== 'number' ||
        !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
        Object.keys(point).some((name) => name !== 'x' && name !== 'y')) {
        throw new NavMapError(`${jsonLabel(id)}: door "${door}" "${key}" needs whole-number "x" and "y".`);
      }
      return { x: point.x, y: point.y };
    };
    const doorOffset = offset('offset');
    const panelOffset = offset('panelOffset');
    doors[door] = {
      clearance,
      ...(big !== undefined ? { big } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(cell !== undefined ? { cell } : {}),
      ...(doorOffset ? { offset: doorOffset } : {}),
      ...(panelOffset ? { panelOffset } : {}),
    };
  }
  return doors;
}

async function checkDoorAssets(rooms: RoomData[], assetsDir: string) {
  const required = new Map<string, {
    room: string;
    door: string;
    panel: boolean;
    cellSize: number;
    side: DoorSide;
    style?: DoorStyle;
    crop?: { x: number; y: number; w: number; h: number };
  }>();
  for (const room of rooms) {
    for (const [id, config] of Object.entries(room.doors ?? {})) {
      const exit = room.nav.exits.find((candidate) => candidate.kind === 'door' && candidate.id === id)!;
      const side = exit.side ?? 'west';
      const layout = passageDoorLayout(side, config.big, config.style);
      required.set(passageDoorAsset(config.clearance, side, config.big, config.style), {
        room: room.templateId ?? room.id, door: id, panel: false, cellSize: layout.cellSize, side, style: config.style, crop: layout.crop,
      });
      required.set(passagePanelAsset(side, config.style), {
        room: room.templateId ?? room.id, door: id, panel: true, cellSize: 96, side, style: config.style,
      });
    }
  }
  if (!required.size) return;
  const folder = path.join(assetsDir, 'props');
  const files = new Set(await readdir(folder));
  for (const [asset, source] of required) {
    const label = `${jsonLabel(source.room)}: door "${source.door}"`;
    if (!files.has(`${asset}.png`)) throw new NavMapError(`${label} needs sim_assets/props/${asset}.png.`);
    const file = path.join(folder, `${asset}.png`);
    const { data, info } = await sharp(file).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const image = { width: info.width, height: info.height };
    const cells = propCellOccupancy(image, data, source.cellSize);
    const validSize = info.width % source.cellSize === 0 && info.height % source.cellSize === 0;
    const validFrames = source.panel
      ? cells?.[0]?.[0] && cells?.[0]?.[1] && cells?.[3]?.[0] && cells?.[3]?.[1]
      : cells?.[0]?.[0];
    if (!validSize || !validFrames || !cells?.[2]?.[0]) {
      throw new NavMapError(`${label}: ${asset}.png needs complete ${source.cellSize}px cells and ${source.panel ? 'two red and two green panel frames' : 'a closed door frame'}, plus a broken frame in the third row.`);
    }
    const checkCrop = (column: number, row: number, crop: { x: number; y: number; w: number; h: number }) => {
      const { x, y, w, h } = crop;
      if (![x, y, w, h].every(Number.isSafeInteger) || x < 0 || y < 0 || w <= 0 || h <= 0 ||
        x + w > source.cellSize || y + h > source.cellSize) {
        throw new NavMapError(`${label}: ${asset}.png has a crop that does not fit inside its ${source.cellSize}px cell.`);
      }
      let visibleInCrop = false;
      for (let cellY = 0; cellY < source.cellSize; cellY++) {
        for (let cellX = 0; cellX < source.cellSize; cellX++) {
          const alpha = data[((row * source.cellSize + cellY) * info.width + column * source.cellSize + cellX) * 4 + 3];
          if (!alpha) continue;
          if (cellX < x || cellX >= x + w || cellY < y || cellY >= y + h) {
            const cell = source.panel ? `, column ${column + 1}` : '';
            throw new NavMapError(
              `${label}: ${asset}.png has visible artwork at (${cellX}, ${cellY}) in row ${row + 1}${cell}, outside crop (${x}, ${y}, ${w}, ${h}).`,
            );
          }
          visibleInCrop = true;
        }
      }
      if (!visibleInCrop) {
        const cell = source.panel ? `, column ${column + 1}` : '';
        throw new NavMapError(`${label}: ${asset}.png has no visible ${source.panel ? 'panel' : 'door'} artwork inside its crop in row ${row + 1}${cell}.`);
      }
    };
    if (!source.panel && source.crop) {
      for (const row of [0, 2]) checkCrop(0, row, source.crop);
    } else if (source.panel && source.style === 'heavy_containment') {
      for (const row of [0, 2, 3]) {
        const frame = passagePanelFrame(source.side, row === 3, 0, row === 2, undefined, source.style);
        const crop = { ...frame, y: frame.y - row * source.cellSize };
        const columns = row === 2 ? cells[row].flatMap((populated, column) => populated ? [column] : []) : [0, 1];
        for (const column of columns) checkCrop(column, row, crop);
      }
    }
  }
}

/** "elevators": { "shaft": "main", "big": true }. */
function readElevator(raw: unknown, id: string, nav: RoomData['nav']): RoomData['elevator'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NavMapError(`${jsonLabel(id)}: "elevators" should look like { "shaft": "main", "big": true }.`);
  }
  if (!nav.exits.some((exit) => exit.kind === 'elevator')) {
    throw new NavMapError(`${jsonLabel(id)}: "elevators" is configured, but nav_map.png has no elevator.`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'shaft' && key !== 'big') {
      throw new NavMapError(`${jsonLabel(id)}: unknown elevator property "${key}"; use "shaft" for the shaft name and "big" for a large car.`);
    }
  }
  const shaft = 'shaft' in raw ? raw.shaft : undefined;
  const big = 'big' in raw ? raw.big : undefined;
  if (shaft !== undefined && (typeof shaft !== 'string' || !shaft.trim())) {
    throw new NavMapError(`${jsonLabel(id)}: elevator "shaft" needs a non-empty name, e.g. "main".`);
  }
  if (big !== undefined && typeof big !== 'boolean') {
    throw new NavMapError(`${jsonLabel(id)}: elevator "big" must be true or false.`);
  }
  return { shaft, big: big ?? false };
}

async function readRoom(id: string, assetsDir: string): Promise<LoadedRoom> {
  const folder = path.join(assetsDir, 'rooms', id);
  const label = `sim_assets/rooms/${id}`;
  const json = JSON.parse(await readFile(path.join(folder, 'room.json'), 'utf8')) as RoomJson;

  if (typeof json.name !== 'string' || typeof json.level !== 'number' || typeof json.camera !== 'string') {
    throw new NavMapError(`${label}/room.json: needs "name" (text), "level" (number) and "camera" (text).`);
  }
  if (json.cameraGroup !== undefined && (typeof json.cameraGroup !== 'string' || !json.cameraGroup.trim())) {
    throw new NavMapError(`${label}/room.json: "cameraGroup" needs a non-empty name.`);
  }
  if (json.containmentCell !== undefined && typeof json.containmentCell !== 'boolean') {
    throw new NavMapError(`${label}/room.json: "containmentCell" must be true or false.`);
  }
  if (json.restroom !== undefined && typeof json.restroom !== 'boolean') {
    throw new NavMapError(`${label}/room.json: "restroom" must be true or false.`);
  }
  let instances: LoadedRoom['instances'];
  if (json.instances !== undefined) {
    if (!Array.isArray(json.instances) || !json.instances.length || typeof json.cameraGroup !== 'string') {
      throw new NavMapError(`${label}/room.json: "instances" needs a non-empty array and a "cameraGroup".`);
    }
    if (json.exits !== undefined) {
      throw new NavMapError(`${label}/room.json: put "exits" on each instance, not on the template.`);
    }
    instances = json.instances.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) ||
        typeof entry.name !== 'string' || !entry.name.trim() ||
        typeof entry.camera !== 'string' || !entry.camera.trim()) {
        throw new NavMapError(`${label}/room.json: instance ${index + 1} needs a kebab-case "id", non-empty "name", and "camera".`);
      }
      for (const key of Object.keys(entry)) {
        if (!['id', 'name', 'camera', 'exits'].includes(key)) {
          throw new NavMapError(`${label}/room.json: instance ${index + 1} has unknown property "${key}".`);
        }
      }
      return { id: entry.id, name: entry.name, camera: entry.camera, exits: readExits(entry.exits, id) };
    });
  } else if (json.cameraGroup !== undefined) {
    throw new NavMapError(`${label}/room.json: "cameraGroup" requires "instances".`);
  }

  const room = await imageSize(path.join(folder, 'room.png'));
  const { data, info } = await sharp(path.join(folder, 'nav_map.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== room.width || info.height !== room.height) {
    throw new NavMapError(
      `${label}/nav_map.png is ${info.width}×${info.height} but room.png is ${room.width}×${room.height}. They must match pixel for pixel.`,
    );
  }
  if (json.disconnectedFloors !== undefined && typeof json.disconnectedFloors !== 'boolean') {
    throw new NavMapError(`${label}/room.json: "disconnectedFloors" must be true or false.`);
  }
  const nav = parseNavMap(data, info.width, info.height, `${label}/nav_map.png`, json.disconnectedFloors === true);

  const props: PlacedProp[] = [];
  const entries = Array.isArray(json.props) ? json.props : [];
  const known = entries.length ? await listPropTypes(assetsDir) : [];
  const propImages = new Map<string, PropSheetImage>();
  for (const [index, entry] of entries.entries()) {
    const { type, x, y, flip, on, broken } = entry ?? {};
    if (typeof type !== 'string' || !known.includes(type)) {
      throw new NavMapError(
        `${label}/room.json: prop ${index + 1} has unknown type "${type}". ` +
        `Known: ${known.join(', ')} (any image in sim_assets/props/ can be placed).`,
      );
    }
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new NavMapError(`${label}/room.json: prop ${index + 1} (${type}) needs whole-number "x" and "y".`);
    }
    const baseKind = propTypeOf(type);
    let image = propImages.get(baseKind.asset);
    if (!image) {
      image = await propImage(path.join(assetsDir, 'props', `${baseKind.asset}.png`));
      propImages.set(baseKind.asset, image);
    }
    const frame = propFrame(baseKind.asset, image);
    const kind = propTypeOf(type, image);
    const start: PlacedProp['start'] = {};
    if (on !== undefined) {
      if (typeof on !== 'boolean' || !kind.switchable) {
        throw new NavMapError(`${label}/room.json: prop ${index + 1} (${type}) can't have "on"; only switchable props like lights can, as true or false.`);
      }
      if (!on) start.on = false;
    }
    if (broken !== undefined) {
      if (typeof broken !== 'boolean' || !kind.breakable) {
        throw new NavMapError(`${label}/room.json: prop ${index + 1} (${type}) can't have "broken"; only breakable props can, as true or false.`);
      }
      if (broken) start.broken = true;
    }
    const { asset } = kind;
    props.push({
      type, asset, x, y, w: frame.w, h: frame.h, flip: flip === true,
      ...propSheetFeatures(type, image),
      ...(Object.keys(start).length ? { start } : {}),
    });
  }

  const items: PlacedItem[] = [];
  if (json.items !== undefined && !Array.isArray(json.items)) {
    throw new NavMapError(`${label}/room.json: "items" must be an array.`);
  }
  if (Array.isArray(json.items) && json.items.length) {
    const knownItems = (await readdir(path.join(assetsDir, 'items')))
      .filter((file) => file.endsWith('.png')).map((file) => file.slice(0, -4));
    for (const [index, entry] of json.items.entries()) {
      const { type, x, y, flip } = entry ?? {};
      if (typeof type !== 'string' || !knownItems.includes(itemAssetType(type))) {
        throw new NavMapError(`${label}/room.json: item ${index + 1} has unknown type "${type}". Known: ${knownItems.join(', ')}.`);
      }
      if (!Number.isInteger(x) || !Number.isInteger(y) || (flip !== undefined && typeof flip !== 'boolean')) {
        throw new NavMapError(`${label}/room.json: item ${index + 1} needs whole-number "x"/"y" and an optional boolean "flip".`);
      }
      const assetType = itemAssetType(type);
      const frame = itemFrame(type, await imageSize(path.join(assetsDir, 'items', `${assetType}.png`)));
      items.push({ type, asset: `item:${assetType}`, x, y, w: frame.w, h: frame.h, flip: flip === true });
    }
  }

  return {
    data: {
      id, name: json.name, level: json.level, camera: json.camera, width: room.width, height: room.height,
      nav, props, items, links: {}, doors: readDoors(json.doors, id, nav), elevator: readElevator(json.elevators, id, nav),
      ...(typeof json.cameraGroup === 'string' ? { cameraGroup: json.cameraGroup } : {}),
      ...(json.containmentCell ? { containmentCell: true } : {}),
      ...(json.restroom ? { restroom: true } : {}),
    },
    exits: readExits(json.exits, id),
    instances,
  };
}

/** Loads a single room on its own, without connecting its doors to other rooms. */
export async function loadRoom(id: string, assetsDir = SIM_ASSETS_DIR): Promise<RoomData> {
  const { data } = await readRoom(id, assetsDir);
  await checkDoorAssets([data], assetsDir);
  return data;
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
      const label = jsonLabel(room.templateId ?? room.id);
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
          `${jsonLabel(room.templateId ?? room.id)}: door "${door}" and ${other.id}'s "${target.door}" need the same clearance.`,
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
  const templates = await Promise.all(ids.map((id) => readRoom(id, assetsDir)));
  const rooms = templates.flatMap((template): LoadedRoom[] => template.instances
    ? template.instances.map((instance) => ({
      data: {
        ...structuredClone(template.data),
        id: instance.id, templateId: template.data.id, name: instance.name, camera: instance.camera,
      },
      exits: instance.exits,
    }))
    : [template]);
  const seen = new Set<string>();
  for (const room of rooms) {
    if (seen.has(room.data.id)) throw new NavMapError(`Duplicate room ID "${room.data.id}". Each room instance needs a unique ID.`);
    seen.add(room.data.id);
  }
  linkRooms(rooms);
  await checkDoorAssets(rooms.map((room) => room.data), assetsDir);
  checkShafts(rooms.map((room) => room.data));
  return orderRooms(rooms.map((room) => room.data));
}
