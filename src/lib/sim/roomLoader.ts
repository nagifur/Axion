// Build-time only: reads room folders from src/sim_assets/rooms/<id>/ and checks them.
// A room folder holds room.png (the art), nav_map.png (where feet can go) and room.json
// (name, props, and which room each door leads to).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NavMapError, parseNavMap } from './navMap.ts';
import type { PlacedProp, RoomData } from './room.ts';
import { itemFrame } from './sprites.ts';
import { propFrame, type PropSheetImage } from './propSprites.ts';
import { propSheetFeatures, propTypeOf } from './propTypes.ts';
import { itemAssetType, type PlacedItem } from './item.ts';
import type { DoorConfig } from './door.ts';
import { checkShafts, linkRooms, orderRooms, roomJsonPath, type DeclaredExit, type LoadedRoom } from './facilityLayout.ts';
import { SIM_ASSETS_DIR, checkDoorAssets, imageSize, listPropTypes, propImage } from './roomAssets.ts';

export { checkShafts, linkRooms, orderRooms, type LoadedRoom } from './facilityLayout.ts';
export { SIM_ASSETS_DIR, itemPreview, listPropTypes, propPreview } from './roomAssets.ts';

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

function readExits(raw: unknown, id: string): Map<string, DeclaredExit> {
  const exits = new Map<string, DeclaredExit>();
  if (raw === undefined) return exits;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NavMapError(`${roomJsonPath(id)}: "exits" should look like { "west": "other-room-folder" }.`);
  }
  for (const [door, value] of Object.entries(raw)) {
    if (typeof value === 'string') exits.set(door, { room: value });
    else if (value && typeof value === 'object' && typeof value.room === 'string' && (value.door === undefined || typeof value.door === 'string')) {
      exits.set(door, { room: value.room, door: value.door });
    } else {
      throw new NavMapError(`${roomJsonPath(id)}: exit "${door}" should be a room folder name, or { "room": "...", "door": "..." }.`);
    }
  }
  return exits;
}

function readDoors(raw: unknown, id: string, nav: RoomData['nav']): Record<string, DoorConfig> {
  const doors: Record<string, DoorConfig> = {};
  if (raw === undefined) return doors;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NavMapError(`${roomJsonPath(id)}: "doors" must be an object keyed by passage id.`);
  }
  for (const [door, value] of Object.entries(raw)) {
    const exit = nav.exits.find((candidate) => candidate.kind === 'door' && candidate.id === door);
    if (!exit) {
      const available = nav.exits.filter((exit) => exit.kind === 'door').map((exit) => exit.id);
      throw new NavMapError(`${roomJsonPath(id)}: "doors" mentions passage "${door}", but nav_map.png has: ${available.join(', ') || 'no doors'}.`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new NavMapError(`${roomJsonPath(id)}: door "${door}" needs { "clearance": 0 }.`);
    }
    for (const key of Object.keys(value)) {
      if (key !== 'clearance' && key !== 'big' && key !== 'style' && key !== 'cell' && key !== 'offset' && key !== 'panelOffset') {
        throw new NavMapError(`${roomJsonPath(id)}: door "${door}" has unknown property "${key}".`);
      }
    }
    const clearance = 'clearance' in value ? value.clearance : undefined;
    if (typeof clearance !== 'number' || !Number.isSafeInteger(clearance) || clearance < 0) {
      throw new NavMapError(`${roomJsonPath(id)}: door "${door}" needs a non-negative whole-number "clearance".`);
    }
    const big = 'big' in value ? value.big : undefined;
    if (big !== undefined && typeof big !== 'boolean') {
      throw new NavMapError(`${roomJsonPath(id)}: door "${door}" "big" must be true or false.`);
    }
    const style = 'style' in value ? value.style : undefined;
    if (style !== undefined && style !== 'heavy_containment') {
      throw new NavMapError(`${roomJsonPath(id)}: door "${door}" "style" must be "heavy_containment".`);
    }
    if (style === 'heavy_containment' && (exit.side !== 'north' || big === true)) {
      throw new NavMapError(`${roomJsonPath(id)}: door "${door}" "heavy_containment" style only supports north-facing, non-big doors.`);
    }
    const cell = 'cell' in value ? value.cell : undefined;
    if (cell !== undefined && typeof cell !== 'boolean') {
      throw new NavMapError(`${roomJsonPath(id)}: door "${door}" "cell" must be true or false.`);
    }
    const offset = (key: 'offset' | 'panelOffset') => {
      const point = key in value ? value[key] : undefined;
      if (point === undefined) return undefined;
      if (!point || typeof point !== 'object' || Array.isArray(point) ||
        !('x' in point) || !('y' in point) || typeof point.x !== 'number' || typeof point.y !== 'number' ||
        !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
        Object.keys(point).some((name) => name !== 'x' && name !== 'y')) {
        throw new NavMapError(`${roomJsonPath(id)}: door "${door}" "${key}" needs whole-number "x" and "y".`);
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

/** "elevators": { "shaft": "main", "big": true }. */
function readElevator(raw: unknown, id: string, nav: RoomData['nav']): RoomData['elevator'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NavMapError(`${roomJsonPath(id)}: "elevators" should look like { "shaft": "main", "big": true }.`);
  }
  if (!nav.exits.some((exit) => exit.kind === 'elevator')) {
    throw new NavMapError(`${roomJsonPath(id)}: "elevators" is configured, but nav_map.png has no elevator.`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'shaft' && key !== 'big') {
      throw new NavMapError(`${roomJsonPath(id)}: unknown elevator property "${key}"; use "shaft" for the shaft name and "big" for a large car.`);
    }
  }
  const shaft = 'shaft' in raw ? raw.shaft : undefined;
  const big = 'big' in raw ? raw.big : undefined;
  if (shaft !== undefined && (typeof shaft !== 'string' || !shaft.trim())) {
    throw new NavMapError(`${roomJsonPath(id)}: elevator "shaft" needs a non-empty name, e.g. "main".`);
  }
  if (big !== undefined && typeof big !== 'boolean') {
    throw new NavMapError(`${roomJsonPath(id)}: elevator "big" must be true or false.`);
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
  for (const flag of ['containmentCell', 'restroom'] as const) {
    const value = json[flag];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new NavMapError(`${label}/room.json: "${flag}" must be true or false.`);
    }
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
