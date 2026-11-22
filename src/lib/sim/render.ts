import type { Agent } from './agent.ts';
import type { Point, Room } from './room.ts';
import type { Prop } from './prop.ts';
import { Item, type PlacedItem } from './item.ts';
import type { Particle, ParticleEmissionSampler } from './particles.ts';
import { CHARACTER_FRAMES, ELEVATOR_SPRITES, TRIP_CYCLE, TRIP_HEAD_OFFSET, hasPropLook, itemFrame, itemHandAnchor, needsPropCellOccupancy, propCellOccupancy, propFrame, propFrames, type Frame, type FrameName, type PropLook, type PropSheetImage } from './sprites.ts';
import type { World } from './world.ts';
import type { Rect } from './navMap.ts';
import { isPassageDoorAsset, passageDoorFrame, passagePanelFrame } from './door.ts';

/** Images by name: "room:<id>", "character", prop file names, "item:<type>", and "particle:<file>". */
export type Assets = Record<string, HTMLImageElement>;
type Canvas = HTMLCanvasElement;
type SizedImage = CanvasImageSource & { width: number; height: number };

interface ScaledSheet {
  normal: Canvas;
  redEye: Canvas;
  alpha: Uint8ClampedArray;
  width: number;
  frames: Record<FrameName, Frame>;
}

const EYE_WHITE = [255, 255, 255];
const EYE_RED = [255, 40, 64];
const LIGHT_OFF = [70, 42, 25];
const LIGHT_ON = [255, 177, 91];
/** Passage-door panel indicator light: offset inside the panel artwork and glow radius, in room pixels. */
const DOOR_INDICATOR = {
  sideWall: { x: 8, y: 17 }, facing: { x: 9.5, y: 9.5 },
  radius: 12, darkRadius: 32, alpha: 0.3, darkAlpha: 0.4,
};
/** Hue applied to the dimmed scene while backup power runs the emergency lights. */
const EMERGENCY_TINT = 'rgb(171, 126, 126)';
/** Halo around emergency lights, drawn above the tint; stretch widens it to suit the wide fixture. */
const EMERGENCY_GLOW = { radius: 36, stretch: 1.6, alpha: 0.6 };
/** South doors and their panels sit in front of the room, so they are see-through. */
const FOREGROUND_DOOR_ALPHA = 0.35;
/** Extra pixels around the cursor that still count as clicking a character. */
const AGENT_PICK_TOLERANCE = 2;

type AssetKind = 'room' | 'character' | 'item' | 'particle' | 'prop' | 'missing-texture';

function assetKind(name: string): AssetKind {
  if (name === 'missing-texture') return 'missing-texture';
  if (name === 'character') return 'character';
  if (name.startsWith('room:')) return 'room';
  if (name.startsWith('item:')) return 'item';
  if (name.startsWith('particle:')) return 'particle';
  return 'prop';
}

function requireAsset(assets: Assets, name: string): HTMLImageElement {
  const image = assets[name];
  if (!image) throw new Error(`Missing sim asset "${name}".`);
  return image;
}

function makeCanvas(width: number, height: number): Canvas {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

/** Grows a scratch canvas when a frame is larger than any seen before (resizing also clears it). */
function fitCanvas(canvas: Canvas, width: number, height: number) {
  if (canvas.width < width) canvas.width = width;
  if (canvas.height < height) canvas.height = height;
}

/**
 * `readback` canvases are read with getImageData; browsers keep those in CPU memory, which makes
 * them slow to draw from, so only pixel-inspection scratch canvases ask for it.
 */
function context(canvas: Canvas, readback = false) {
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

function frameHasPixels(image: SizedImage, frame: Rect): boolean {
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

function placeholderFrame(image: SizedImage, width: number, height: number): Canvas {
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

function visualPropFrame(asset: string, image: SizedImage & PropSheetImage, time: number, look: PropLook | undefined, placeholder?: SizedImage) {
  const frame = propFrame(asset, image, time, look);
  if (placeholder && ((look && !hasPropLook(asset, look, image)) || !frameHasPixels(image, frame))) {
    return { image: placeholderFrame(placeholder, frame.w, frame.h), frame: { x: 0, y: 0, w: frame.w, h: frame.h } };
  }
  return { image, frame };
}

/** Opacity of each pixel in sprite frames, cached per asset frame. */
class FrameAlphaMasks {
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
        if ((kind === 'character' || kind === 'prop') && !inspectedPixels.has(image)) {
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

function drawSpriteFrame(ctx: CanvasRenderingContext2D, image: CanvasImageSource, frame: Rect, x: number, y: number, flip: boolean) {
  if (!flip) {
    ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, x, y, frame.w, frame.h);
    return;
  }
  ctx.save();
  ctx.translate(x + frame.w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
  ctx.restore();
}

/** Draws one artwork-sized prop frame, with mirroring around that frame rather than the sheet. */
export function drawPropSprite(
  ctx: CanvasRenderingContext2D, image: SizedImage,
  asset: string, x: number, y: number, flip = false, time = 0, look?: PropLook, placeholder?: SizedImage,
) {
  const visual = visualPropFrame(asset, image, time, look, placeholder);
  drawSpriteFrame(ctx, visual.image, visual.frame, x, y, flip);
}

/** Draws a spinning, mirrored particle, with its rotated bounds above its floor position. */
export function drawParticle(ctx: CanvasRenderingContext2D, image: SizedImage, particle: Particle) {
  const alpha = particle.alpha;
  if (alpha <= 0) return;
  const halfWidth = image.width / 2;
  const halfHeight = image.height / 2;
  const bottom = Math.abs(Math.sin(particle.angle)) * halfWidth + Math.abs(Math.cos(particle.angle)) * halfHeight;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(Math.round(particle.x), Math.round(particle.y) - bottom);
  ctx.rotate(particle.angle);
  if (particle.flip) ctx.scale(-1, 1);
  const glow = particle.set.glow;
  if (glow) {
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, glow.radius);
    gradient.addColorStop(0, glow.color);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = gradient;
    ctx.fillRect(-glow.radius, -glow.radius, glow.radius * 2, glow.radius * 2);
    ctx.restore();
  }
  ctx.drawImage(image, -halfWidth, -halfHeight);
  ctx.restore();
}

export function drawItemSprite(
  ctx: CanvasRenderingContext2D, image: SizedImage,
  item: PlacedItem, x = item.x, y = item.y, scale = 1, flip = item.flip,
) {
  const frame = itemFrame(item.type, image);
  const w = Math.max(1, Math.round(frame.w * scale));
  const h = Math.max(1, Math.round(frame.h * scale));
  ctx.save();
  ctx.translate(Math.round(x) + (flip ? w : 0), Math.round(y));
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, w, h);
  ctx.restore();
}

/** Shared pixel-aware prop picking for player drops and the debug editor. */
export class PropPicker {
  private readonly masks = new FrameAlphaMasks();
  private readonly assets: Assets;

  constructor(assets: Assets) {
    this.assets = assets;
  }

  at(room: Room, point: Point, time = 0): Prop | null {
    return this.pick(room.props, point, time);
  }

  atLayout(room: Room, point: Point, time = 0): Prop | Item | null {
    return this.pick([...room.props, ...room.items], point, time);
  }

  private pick<T extends Prop | Item>(objects: readonly T[], point: Point, time: number): T | null {
    const front = [...objects].reverse().sort((a, b) => b.y + b.h - (a.y + a.h));
    const inBox = front.filter((prop) =>
      point.x >= prop.x && point.x < prop.x + prop.w && point.y >= prop.y && point.y < prop.y + prop.h);
    const solid = inBox.find((prop) => {
      const image = requireAsset(this.assets, prop.asset);
      const visual = prop instanceof Item
        ? { image, frame: itemFrame(prop.type, image) }
        : visualPropFrame(prop.asset, image, time, prop.look, this.assets['missing-texture']);
      const mask = this.masks.get(visual.image === image ? prop.asset : 'missing-texture', visual.image, visual.frame);
      let lx = Math.floor(point.x - prop.x);
      const ly = Math.floor(point.y - prop.y);
      if (prop.flip) lx = prop.w - 1 - lx;
      return mask.alpha[ly * mask.w + lx] > 0;
    });
    return solid ?? inBox[0] ?? null;
  }
}

/** Samples only opaque artwork pixels inside a prop's emission rectangle. */
export class PropEmissionSampler {
  private readonly masks = new FrameAlphaMasks();
  private readonly assets: Assets;

  constructor(assets: Assets) {
    this.assets = assets;
  }

  readonly sample: ParticleEmissionSampler = (prop, area, time) => {
    const image = requireAsset(this.assets, prop.asset);
    const visual = visualPropFrame(prop.asset, image, time, prop.look, this.assets['missing-texture']);
    const mask = this.masks.get(visual.image === image ? prop.asset : 'missing-texture', visual.image, visual.frame);

    const points: { x: number; y: number }[] = [];
    for (let py = 0; py < mask.h; py++) {
      const y = prop.y + py + 0.5;
      if (y < area.y || y >= area.y + area.h) continue;
      for (let px = 0; px < mask.w; px++) {
        const x = prop.x + (prop.flip ? mask.w - 1 - px : px) + 0.5;
        if (x < area.x || x >= area.x + area.w || !mask.alpha[py * mask.w + px]) continue;
        points.push({ x, y });
      }
    }
    return points;
  };
}

/** Copy of an image with every pixel of `from` replaced by `to` (RGB). */
function recolor(image: SizedImage, from: number[], to: number[]): Canvas {
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


function agentDepth(agent: Agent) {
  return agent.sitting && agent.spot ? Math.max(agent.y, agent.spot.propDepth) : agent.y;
}

export class Renderer {
  private readonly canvas: Canvas;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly assets: Assets;
  private room: Room;
  private readonly redEyeSheet: Canvas;
  private readonly litArrows?: Canvas;
  private readonly sheets = new Map<number, ScaledSheet>();
  private readonly outline = makeCanvas(160, 160);
  private readonly passageDoorCanvas = makeCanvas(96, 96);
  private readonly emergencySheets = new Map<string, Canvas>();
  private pixelScale = 1;

  constructor(canvas: Canvas, assets: Assets, room: Room) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.assets = assets;
    this.room = room;
    this.redEyeSheet = recolor(assets.character, EYE_WHITE, EYE_RED);
    const lights = assets[ELEVATOR_SPRITES.lights];
    if (lights) this.litArrows = recolor(lights, LIGHT_OFF, LIGHT_ON);
  }

  /** Switches which room's camera is drawn. */
  setRoom(room: Room) {
    this.room = room;
    this.resize();
  }

  /** Drawing context, already scaled so 1 unit is 1 room pixel (valid after draw()). */
  get context() {
    return this.ctx;
  }

  /** Screen pixels per room pixel. */
  get scale() {
    return this.pixelScale;
  }

  /** Renders at an integer multiple of the room size so pixels stay square and crisp. */
  resize() {
    const { width, height } = this.room;
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = this.canvas.clientWidth || width;
    const scale = Math.max(1, Math.round((cssWidth * ratio) / width));
    if (scale === this.pixelScale && this.canvas.width === width * scale && this.canvas.height === height * scale) return;
    this.pixelScale = scale;
    this.canvas.width = width * scale;
    this.canvas.height = height * scale;
  }

  /** Characters are scaled by height once, at room resolution, then cached. */
  private sheet(scale: number): ScaledSheet {
    const cached = this.sheets.get(scale);
    if (cached) return cached;

    const source = this.assets.character;
    const width = Math.round(Math.max(source.width, 576) * scale);
    const height = Math.round(Math.max(source.height, 1152) * scale);
    const frames = Object.fromEntries(Object.entries(CHARACTER_FRAMES).map(([name, frame]) => {
      const x = Math.round(frame.x * scale);
      const y = Math.round(frame.y * scale);
      return [name, {
        x,
        y,
        w: Math.round((frame.x + frame.w) * scale) - x,
        h: Math.round((frame.y + frame.h) * scale) - y,
        anchorX: Math.round(frame.anchorX * scale),
      }];
    })) as Record<FrameName, Frame>;
    const draw = (image: CanvasImageSource) => {
      const canvas = makeCanvas(width, height);
      const ctx = context(canvas);
      // Crop before scaling so rounded frame boundaries cannot sample neighboring rows.
      for (const [name, frame] of Object.entries(CHARACTER_FRAMES)) {
        const scaled = frames[name as FrameName];
        if (frameHasPixels(source, frame)) {
          ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, scaled.x, scaled.y, scaled.w, scaled.h);
        } else {
          const missing = requireAsset(this.assets, 'missing-texture');
          ctx.drawImage(missing, 0, 0, missing.width, missing.height, scaled.x, scaled.y, scaled.w, scaled.h);
        }
      }
      return canvas;
    };
    const normal = draw(source);

    const sheet: ScaledSheet = {
      normal,
      redEye: draw(this.redEyeSheet),
      alpha: normal.getContext('2d')!.getImageData(0, 0, width, height).data,
      width,
      frames,
    };
    this.sheets.set(scale, sheet);
    return sheet;
  }

  /** Where the sprite lands on screen for the agent's current pose. */
  private placement(agent: Agent) {
    const sheet = this.sheet(agent.character.scale);
    const { name, flip } = agent.frame;
    const frame = sheet.frames[name];
    const shake = agent.shake > 0 ? Math.round(Math.sin(agent.shake * 60)) : 0;
    const x = Math.round(agent.x) + shake - (flip ? frame.w - frame.anchorX : frame.anchorX);
    const y = Math.round(agent.y) - frame.h;
    return { sheet, name, frame, flip, x, y };
  }

  /** Point just above an agent's head, in room pixels (for name tags). */
  headPosition(agent: Agent) {
    const { name, frame, flip, y } = this.placement(agent);
    const offset = TRIP_CYCLE.includes(name) ? TRIP_HEAD_OFFSET : undefined;
    const x = agent.x + (offset ? Math.round(offset.x * agent.character.scale) * (flip ? -1 : 1) : 0);
    return { x, y: y + (offset ? Math.round(offset.y * agent.character.scale) : 0), height: frame.h };
  }

  isVisible(agent: Agent, world: World) {
    if (agent.held || agent.room !== this.room || agent.alpha < 0.3) return false;
    return agent.layer === 'room' || (world.elevatorFor(this.room)?.open ?? 0) > 0.4;
  }

  /** Pixel-accurate picking, with a small tolerance so thin limbs are still easy to click. */
  hitTest(world: World, px: number, py: number): Agent | null {
    const ordered = [...world.agents].reverse().filter((agent) => this.isVisible(agent, world)).sort((a, b) => agentDepth(b) - agentDepth(a));
    for (const agent of ordered) {
      const { sheet, frame, flip, x, y } = this.placement(agent);
      for (let oy = -AGENT_PICK_TOLERANCE; oy <= AGENT_PICK_TOLERANCE; oy++) {
        for (let ox = -AGENT_PICK_TOLERANCE; ox <= AGENT_PICK_TOLERANCE; ox++) {
          let lx = Math.floor(px) - x + ox;
          const ly = Math.floor(py) - y + oy;
          if (lx < 0 || ly < 0 || lx >= frame.w || ly >= frame.h) continue;
          if (flip) lx = frame.w - 1 - lx;
          if (sheet.alpha[((frame.y + ly) * sheet.width + frame.x + lx) * 4 + 3] > 0) return agent;
        }
      }
    }
    return null;
  }

  private drawAgent(agent: Agent, highlight?: string) {
    const ctx = this.ctx;
    const { sheet, name, frame, flip, x, y } = this.placement(agent);
    const image = agent.eyeFlash > 0 || agent.revealed ? sheet.redEye : sheet.normal;

    ctx.save();
    ctx.globalAlpha = agent.alpha * (agent.ghost ? 0.55 : 1);

    if (agent.layer === 'room') {
      const width = Math.max(6, Math.round(14 * agent.character.scale));
      const fx = Math.round(agent.x);
      const fy = Math.round(agent.y);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(fx - width, fy - 1, width * 2, 2);
      ctx.fillRect(fx - width + 3, fy - 2, width * 2 - 6, 4);
    }

    if (highlight) {
      // Draw a 1px outline by stamping a tinted silhouette around the sprite.
      fitCanvas(this.outline, frame.w, frame.h);
      const outlineCtx = context(this.outline);
      outlineCtx.globalCompositeOperation = 'source-over';
      outlineCtx.clearRect(0, 0, this.outline.width, this.outline.height);
      drawSpriteFrame(outlineCtx, sheet.normal, frame, 0, 0, flip);
      outlineCtx.globalCompositeOperation = 'source-in';
      outlineCtx.fillStyle = highlight;
      outlineCtx.fillRect(0, 0, frame.w, frame.h);
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        ctx.drawImage(this.outline, 0, 0, frame.w, frame.h, x + ox, y + oy, frame.w, frame.h);
      }
    }

    const hand = itemHandAnchor(name, agent.facing);
    const drawCarried = () => {
      const item = agent.item;
      if (!item) return;
      const itemImage = requireAsset(this.assets, item.asset);
      const scale = agent.character.scale;
      const width = Math.max(1, Math.round(item.w * scale));
      const height = Math.max(1, Math.round(item.h * scale));
      const feetX = x + (flip ? frame.w - frame.anchorX : frame.anchorX);
      drawItemSprite(ctx, itemImage, item,
        feetX + Math.round(hand.x * scale) - Math.round(width / 2),
        y + frame.h + Math.round(hand.y * scale) - height,
        scale, item.flip !== flip);
    };
    if (hand.behind) drawCarried();
    drawSpriteFrame(ctx, image, frame, x, y, flip);
    if (!hand.behind) drawCarried();
    ctx.restore();
  }

  /** Held sprites draw above the room without changing their simulation position. */
  drawHeld(agent: Agent, point: Point, valid: boolean) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(Math.round(point.x - agent.x), Math.round(point.y - agent.y));
    this.drawAgent(agent, valid ? '#33ff99' : '#ff4060');
    ctx.restore();
  }

  /** The elevator car, its sliding doors and arrow lights, drawn behind the room art. */
  private drawElevator(world: World, highlights: Map<Agent, string>) {
    const opening = this.room.elevator;
    const elevator = world.elevatorFor(this.room);
    if (!opening || !elevator) return;
    const ctx = this.ctx;
    const doorAsset = opening.big ? ELEVATOR_SPRITES.bigDoor : ELEVATOR_SPRITES.door;
    const door = this.assets[doorAsset];
    const lights = this.assets[ELEVATOR_SPRITES.lights];

    ctx.fillStyle = '#0b141b';
    ctx.fillRect(opening.x, opening.y, opening.w, opening.h);
    ctx.fillStyle = '#1d3340';
    ctx.fillRect(opening.x, opening.y, opening.w, 2);

    for (const agent of world.agentsIn(this.room).filter((a) => a.layer === 'inside').sort((a, b) => a.y - b.y)) {
      this.drawAgent(agent, highlights.get(agent));
    }

    if (door) {
      // The room art is drawn on top afterwards, hiding the parts of the doors that slide into the wall.
      const frame = propFrame(doorAsset, door, world.time);
      const slide = Math.round(elevator.open * frame.w);
      drawPropSprite(ctx, door, doorAsset, opening.x - slide, opening.y, false, world.time);
      drawPropSprite(ctx, door, doorAsset, opening.x + opening.w + slide - frame.w, opening.y, true, world.time);
    }

    if (lights && this.litArrows) {
      const frame = propFrame(ELEVATOR_SPRITES.lights, lights, world.time);
      const x = Math.round(opening.x + (opening.w - frame.w) / 2);
      const y = opening.y - ELEVATOR_SPRITES.lightsGap - frame.h;
      drawPropSprite(ctx, lights, ELEVATOR_SPRITES.lights, x, y, false, world.time);
      if (this.room.power !== 'off' && elevator.light && Math.floor(world.time * 3) % 2 === 0) {
        const { upWidth, downX } = ELEVATOR_SPRITES;
        const sx = elevator.light === 'up' ? 0 : downX;
        const sw = elevator.light === 'up' ? upWidth : frame.w - downX;
        ctx.drawImage(this.litArrows, frame.x + sx, frame.y, sw, frame.h, x + sx, y, sw, frame.h);
      }
    }
  }

  private drawPassageDoors(world: World, foreground = false) {
    const ctx = this.ctx;
    const mask = context(this.passageDoorCanvas);
    for (const door of this.room.doors ?? []) {
      if ((door.side === 'south') !== foreground) continue;
      const art = door.appearance;
      if (!art) continue;
      const state = world.passageDoorFor(door);
      if (!state) throw new Error(`Missing door state for ${this.room.id}/${door.id}.`);
      const image = requireAsset(this.assets, art.asset);
      const panel = requireAsset(this.assets, art.panelAsset);
      const frame = passageDoorFrame(door.side, state.broken, art.big);
      fitCanvas(this.passageDoorCanvas, frame.w, frame.h);
      const slide = Math.round(state.open * frame.h);
      mask.globalCompositeOperation = 'source-over';
      mask.clearRect(0, 0, this.passageDoorCanvas.width, this.passageDoorCanvas.height);
      mask.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, -slide, frame.w, frame.h);
      mask.globalCompositeOperation = 'destination-in';
      mask.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
      mask.globalCompositeOperation = 'source-over';
      ctx.save();
      if (foreground) ctx.globalAlpha *= FOREGROUND_DOOR_ALPHA;
      drawSpriteFrame(ctx, this.passageDoorCanvas, { x: 0, y: 0, w: frame.w, h: frame.h }, art.x, art.y, false);
      if (!state.powered) ctx.filter = 'grayscale(1) brightness(0.25)';
      drawSpriteFrame(ctx, panel, passagePanelFrame(door.side, state.powered && state.unlocked, world.time, state.panelBroken, panel), art.panel.x, art.panel.y, art.panelFlip);
      ctx.restore();
    }
  }

  private drawDoorGlows(world: World, darkness: number) {
    const ctx = this.ctx;
    for (const door of this.room.doors ?? []) {
      const art = door.appearance;
      if (!art) continue;
      const state = world.passageDoorFor(door);
      if (!state) throw new Error(`Missing door state for ${this.room.id}/${door.id}.`);
      if (!state.powered || state.panelBroken) continue;
      const sideWall = door.side === 'west' || door.side === 'east';
      const panel = passagePanelFrame(door.side, state.unlocked, world.time);
      const indicator = sideWall ? DOOR_INDICATOR.sideWall : DOOR_INDICATOR.facing;
      const radius = DOOR_INDICATOR.radius + (DOOR_INDICATOR.darkRadius - DOOR_INDICATOR.radius) * darkness;
      const alpha = DOOR_INDICATOR.alpha + (DOOR_INDICATOR.darkAlpha - DOOR_INDICATOR.alpha) * darkness;
      const x = art.panel.x + (art.panelFlip ? panel.w - indicator.x : indicator.x);
      const y = art.panel.y + indicator.y;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, state.unlocked ? `rgba(40, 255, 115, ${alpha})` : `rgba(255, 35, 65, ${alpha})`);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.save();
      if (door.side === 'south') ctx.globalAlpha *= FOREGROUND_DOOR_ALPHA;
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = glow;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      ctx.restore();
    }
  }

  /** Emergency lights are light sources, so they stay bright above the dim and tint, with a red halo. */
  private drawEmergencyLights(time: number) {
    const ctx = this.ctx;
    for (const prop of this.room.props) {
      if (!prop.emergency) continue;
      this.drawProp(prop, time);
      const { radius, stretch, alpha } = EMERGENCY_GLOW;
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      glow.addColorStop(0, `rgba(255, 35, 35, ${alpha})`);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.save();
      ctx.translate(prop.x + prop.w / 2, prop.y + prop.h / 2);
      ctx.scale(stretch, 1);
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = glow;
      ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
      ctx.restore();
    }
  }

  private drawProp(prop: Prop, time: number) {
    const image = requireAsset(this.assets, prop.asset);
    if (!prop.emergency) {
      drawPropSprite(this.ctx, image, prop.asset, prop.x, prop.y, prop.flip, time, prop.look, this.assets['missing-texture']);
      return;
    }
    const visual = visualPropFrame(prop.asset, image, time, prop.look, this.assets['missing-texture']);
    if (visual.image !== image) {
      drawSpriteFrame(this.ctx, visual.image, visual.frame, prop.x, prop.y, prop.flip);
      return;
    }
    let red = this.emergencySheets.get(prop.asset);
    if (!red) {
      red = makeCanvas(image.width, image.height);
      const ctx = context(red);
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const brightness = Math.max(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]);
        pixels.data[i] = brightness;
        pixels.data[i + 1] = Math.round(brightness * 0.08);
        pixels.data[i + 2] = Math.round(brightness * 0.08);
      }
      ctx.putImageData(pixels, 0, 0);
      this.emergencySheets.set(prop.asset, red);
    }
    drawSpriteFrame(this.ctx, red, visual.frame, prop.x, prop.y, prop.flip);
  }

  draw(world: World, highlights: Map<Agent, string>) {
    const ctx = this.ctx;
    const { assets, room } = this;
    ctx.setTransform(this.pixelScale, 0, 0, this.pixelScale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, room.width, room.height);

    // Everything visible through openings in the room art is drawn first, then the room covers it.
    this.drawElevator(world, highlights);
    ctx.drawImage(requireAsset(assets, `room:${room.id}`), 0, 0);
    this.drawPassageDoors(world);

    // Props and people share one depth-sorted pass, ordered by where they touch the floor.
    const drawables: { depth: number; draw: () => void }[] = room.props.map((prop) => ({
      depth: prop.y + prop.h - 0.5,
      draw: () => this.drawProp(prop, world.time),
    }));
    for (const item of room.items ?? []) {
      drawables.push({ depth: item.y + item.h - 0.5, draw: () => drawItemSprite(ctx, requireAsset(assets, item.asset), item) });
    }
    for (const particle of world.particles.in(room)) {
      drawables.push({ depth: particle.depth, draw: () => drawParticle(ctx, requireAsset(assets, particle.asset), particle) });
    }
    for (const agent of world.agentsIn(room)) {
      if (agent.held || agent.layer !== 'room') continue;
      drawables.push({ depth: agentDepth(agent), draw: () => this.drawAgent(agent, highlights.get(agent)) });
    }
    drawables.sort((a, b) => a.depth - b.depth).forEach((item) => item.draw());
    this.drawPassageDoors(world, true);

    // Emergency lighting looks as dim as darkness, tinted red, without changing gameplay darkness.
    const emergency = room.power === 'backup' && room.props.some((prop) => prop.emergency);
    const dim = emergency ? 1 : room.visualDarkness;
    if (dim > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${dim * 0.55})`;
      ctx.fillRect(0, 0, room.width, room.height);
    }
    if (emergency) {
      ctx.save();
      // 'color' recolours by hue only, keeping each pixel's brightness, so every floor palette tints evenly.
      ctx.globalCompositeOperation = 'color';
      ctx.fillStyle = EMERGENCY_TINT;
      ctx.fillRect(0, 0, room.width, room.height);
      ctx.restore();
      this.drawEmergencyLights(world.time);
    }
    this.drawDoorGlows(world, dim);
  }
}
