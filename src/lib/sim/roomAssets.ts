// Build-time image metadata, editor thumbnails, and artwork validation.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NavMapError, type DoorSide } from './navMap.ts';
import type { RoomData } from './room.ts';
import { roomJsonPath } from './facilityLayout.ts';
import { itemFrame } from './sprites.ts';
import { placeablePropTypes } from './propTypes.ts';
import { propCellOccupancy, propFrame, type PropSheetImage } from './propSprites.ts';
import { itemAssetType } from './item.ts';
import { passageDoorAsset, passageDoorLayout, passagePanelAsset, passagePanelFrame, type DoorStyle } from './door.ts';

export const SIM_ASSETS_DIR = path.resolve('src/sim_assets');

export async function imageSize(file: string) {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new NavMapError(`${file}: could not read image size.`);
  return { width, height };
}

export async function propImage(file: string, cellSize = 96): Promise<PropSheetImage> {
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

export async function checkDoorAssets(rooms: RoomData[], assetsDir: string) {
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
    const label = `${roomJsonPath(source.room)}: door "${source.door}"`;
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
