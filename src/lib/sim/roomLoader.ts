// Build-time only: reads a room folder from src/sim_assets/rooms/<id>/ and checks it.
// A room folder holds room.png (the art), navMap.png (where feet can go) and room.json (props).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NavMapError, parseNavMap } from './navMap.ts';
import type { PlacedProp, RoomData } from './room';
import { PROP_TYPES } from './sprites.ts';

export const SIM_ASSETS_DIR = path.resolve('src/sim_assets');

interface RoomJson {
  name?: unknown;
  level?: unknown;
  camera?: unknown;
  props?: unknown;
}

async function imageSize(file: string) {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new NavMapError(`${file}: could not read image size.`);
  return { width, height };
}

export async function loadRoom(id: string, assetsDir = SIM_ASSETS_DIR): Promise<RoomData> {
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

  return { id, name: json.name, level: json.level, camera: json.camera, width: room.width, height: room.height, nav, props };
}
