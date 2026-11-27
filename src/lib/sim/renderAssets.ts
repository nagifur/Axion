import { isPassageDoorAsset } from './door.ts';
import type { Rect } from './navMap.ts';
import { hasPropLook, itemFrame, needsPropCellOccupancy, propCellOccupancy, propFrame, propFrames, type PropLook, type PropSheetImage } from './sprites.ts';

/** Images by name: room, actor and prop sheets, "item:<type>", "particle:<file>" and "remains:<look>". */
export type Assets = Record<string, HTMLImageElement>;
export type Canvas = HTMLCanvasElement;
export type SizedImage = CanvasImageSource & { width: number; height: number };

type AssetKind = 'room' | 'actor' | 'item' | 'particle' | 'remains' | 'prop' | 'missing-texture';

function assetKind(name: string): AssetKind {
  if (name === 'missing-texture') return 'missing-texture';
  if (name === 'character' || name === 'creature' || name === 'security') return 'actor';
  if (name.startsWith('room:')) return 'room';
  if (name.startsWith('item:')) return 'item';
  if (name.startsWith('particle:')) return 'particle';
  if (name.startsWith('remains:')) return 'remains';
  return 'prop';
}

export function requireAsset(assets: Assets, name: string): HTMLImageElement {
  const image = assets[name];
  if (!image) throw new Error(`Missing sim asset "${name}".`);
  return image;
}

export function makeCanvas(width: number, height: number): Canvas {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

/** Grows a scratch canvas when a frame is larger than any seen before (resizing also clears it). */
export function fitCanvas(canvas: Canvas, width: number, height: number) {
  if (canvas.width < width) canvas.width = width;
  if (canvas.height < height) canvas.height = height;
}

/**
 * `readback` canvases are read with getImageData; browsers keep those in CPU memory, which makes
 * them slow to draw from, so only pixel-inspection scratch canvases ask for it.
 */
export function context(canvas: Canvas, readback = false) {
  const ctx = canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined)!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** RGBA pixels of one frame of an image. */
function framePixels(image: CanvasImageSource, frame: Rect): Uint8ClampedArray {
  const ctx = context(makeCanvas(frame.w, frame.h), true);
  ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
  return ctx.getImageData(0, 0, frame.w, frame.h).data;
}

const inspectedPixels = new WeakMap<object, Uint8ClampedArray>();

export function frameHasPixels(image: SizedImage, frame: Rect): boolean {
  const pixels = inspectedPixels.get(image);
  if (!pixels) return true;
  for (let y = frame.y; y < Math.min(frame.y + frame.h, image.height); y++) {
    for (let x = frame.x; x < Math.min(frame.x + frame.w, image.width); x++) {
      if (pixels[(y * image.width + x) * 4 + 3]) return true;
    }
  }
  return false;
}

const missingFrames = new WeakMap<object, Map<string, Canvas>>();

export function placeholderFrame(image: SizedImage, width: number, height: number): Canvas {
  let frames = missingFrames.get(image);
  if (!frames) {
    frames = new Map();
    missingFrames.set(image, frames);
  }
  const key = `${width}:${height}`;
  let canvas = frames.get(key);
  if (!canvas) {
    canvas = makeCanvas(width, height);
    context(canvas).drawImage(image, 0, 0, image.width, image.height, 0, 0, width, height);
    frames.set(key, canvas);
  }
  return canvas;
}

export function visualPropFrame(asset: string, image: SizedImage & PropSheetImage, time: number, look: PropLook | undefined, placeholder?: SizedImage) {
  const frame = propFrame(asset, image, time, look);
  if (placeholder && ((look && !hasPropLook(asset, look, image)) || !frameHasPixels(image, frame))) {
    return { image: placeholderFrame(placeholder, frame.w, frame.h), frame: { x: 0, y: 0, w: frame.w, h: frame.h } };
  }
  return { image, frame };
}

/** Opacity of each pixel in sprite frames, cached per asset frame. */
export class FrameAlphaMasks {
  private readonly masks = new Map<string, { alpha: Uint8Array; w: number; h: number }>();

  get(asset: string, image: CanvasImageSource, frame: Rect) {
    const key = `${asset}:${frame.x}:${frame.y}:${frame.w}:${frame.h}`;
    let mask = this.masks.get(key);
    if (!mask) {
      const rgba = framePixels(image, frame);
      const alpha = new Uint8Array(frame.w * frame.h);
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
      mask = { alpha, w: frame.w, h: frame.h };
      this.masks.set(key, mask);
    }
    return mask;
  }
}

export function loadAssets(urls: Record<string, string>): Promise<Assets> {
  const entries = Object.entries(urls).map(([name, url]) => new Promise<[string, HTMLImageElement]>((resolve, reject) => {
    const image: HTMLImageElement & PropSheetImage = new Image();
    image.decoding = 'async';
    image.onload = () => {
      try {
        // Validate sheet layouts up front so a bad sprite fails at load, not mid-frame.
        const kind = assetKind(name);
        if (kind === 'item') itemFrame(name.slice('item:'.length), image);
        if (kind === 'prop') {
          if (needsPropCellOccupancy(name, image)) {
            const pixels = framePixels(image, { x: 0, y: 0, w: image.width, h: image.height });
            inspectedPixels.set(image, pixels);
            image.propCells = propCellOccupancy(image, pixels);
          }
          if (!isPassageDoorAsset(name)) propFrames(name, image);
        }
        if ((kind === 'actor' || kind === 'prop') && !inspectedPixels.has(image)) {
          inspectedPixels.set(image, framePixels(image, { x: 0, y: 0, w: image.width, h: image.height }));
        }
        resolve([name, image]);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error(`Failed to load sim asset "${name}"`));
    image.src = url;
  }));
  return Promise.all(entries).then((loaded) => Object.fromEntries(loaded));
}

/** Copy of an image with every pixel of `from` replaced by `to` (RGB). */
export function recolor(image: SizedImage, from: number[], to: number[]): Canvas {
  const canvas = makeCanvas(image.width, image.height);
  // Read back once here, then only drawn from, so it stays a regular (GPU-friendly) canvas.
  const ctx = context(canvas);
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.data.length; i += 4) {
    if (data.data[i + 3] && data.data[i] === from[0] && data.data[i + 1] === from[1] && data.data[i + 2] === from[2]) {
      data.data.set(to, i);
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}
