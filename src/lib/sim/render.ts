import type { Agent } from './agent.ts';
import type { Room } from './room.ts';
import { CHARACTER_FRAMES, ELEVATOR_SPRITES, type Frame, type FrameName } from './sprites.ts';
import type { World } from './world.ts';

/** Loaded images by name: "room:<room id>", "character", and every prop file name (e.g. "bench"). */
export type Assets = Record<string, HTMLImageElement>;

export function loadAssets(urls: Record<string, string>): Promise<Assets> {
  const entries = Object.entries(urls).map(([name, url]) => new Promise<[string, HTMLImageElement]>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve([name, image]);
    image.onerror = () => reject(new Error(`Failed to load sim asset "${name}"`));
    image.src = url;
  }));
  return Promise.all(entries).then((loaded) => Object.fromEntries(loaded));
}

type Canvas = HTMLCanvasElement;

function makeCanvas(width: number, height: number): Canvas {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

function context(canvas: Canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Copy of an image with every pixel of `from` replaced by `to` (RGB). */
function recolor(image: CanvasImageSource & { width: number; height: number }, from: number[], to: number[]): Canvas {
  const canvas = makeCanvas(image.width, image.height);
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

interface ScaledSheet {
  normal: Canvas;
  redEye: Canvas;
  alpha: Uint8ClampedArray;
  width: number;
  frames: Record<FrameName, Frame>;
}

const EYE_WHITE = [255, 255, 255];
const EYE_RED = [255, 40, 64];
const LIGHT_OFF = [66, 43, 28];
const LIGHT_ON = [255, 177, 91];

export class Renderer {
  private readonly canvas: Canvas;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly assets: Assets;
  private room: Room;
  private readonly redEyeSheet: Canvas;
  private readonly litArrows?: Canvas;
  private readonly sheets = new Map<number, ScaledSheet>();
  private readonly outline = makeCanvas(160, 160);
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
    const width = Math.round(source.width * scale);
    const height = Math.round(source.height * scale);
    const draw = (image: CanvasImageSource) => {
      const canvas = makeCanvas(width, height);
      context(canvas).drawImage(image, 0, 0, width, height);
      return canvas;
    };
    const normal = draw(source);
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

    const sheet: ScaledSheet = {
      normal,
      redEye: draw(this.redEyeSheet),
      alpha: context(normal).getImageData(0, 0, width, height).data,
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
    return { sheet, frame, flip, x, y };
  }

  /** Point just above an agent's head, in room pixels (for name tags). */
  headPosition(agent: Agent) {
    const { frame, y } = this.placement(agent);
    return { x: agent.x, y, height: frame.h };
  }

  isVisible(agent: Agent, world: World) {
    if (agent.room !== this.room || agent.alpha < 0.3) return false;
    return agent.layer === 'room' || (world.elevatorFor(this.room)?.open ?? 0) > 0.4;
  }

  /** Pixel-accurate picking, with a small tolerance so thin limbs are still easy to click. */
  hitTest(world: World, px: number, py: number): Agent | null {
    const ordered = [...world.agents].filter((agent) => this.isVisible(agent, world)).sort((a, b) => b.y - a.y);
    for (const agent of ordered) {
      const { sheet, frame, flip, x, y } = this.placement(agent);
      for (let oy = -2; oy <= 2; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
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
    const { sheet, frame, flip, x, y } = this.placement(agent);
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

    const blit = (target: CanvasRenderingContext2D, source: CanvasImageSource, dx: number, dy: number) => {
      if (!flip) {
        target.drawImage(source, frame.x, frame.y, frame.w, frame.h, dx, dy, frame.w, frame.h);
        return;
      }
      target.save();
      target.translate(dx + frame.w, dy);
      target.scale(-1, 1);
      target.drawImage(source, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
      target.restore();
    };

    if (highlight) {
      // Draw a 1px outline by stamping a tinted silhouette around the sprite.
      const outlineCtx = context(this.outline);
      outlineCtx.globalCompositeOperation = 'source-over';
      outlineCtx.clearRect(0, 0, this.outline.width, this.outline.height);
      blit(outlineCtx, sheet.normal, 0, 0);
      outlineCtx.globalCompositeOperation = 'source-in';
      outlineCtx.fillStyle = highlight;
      outlineCtx.fillRect(0, 0, frame.w, frame.h);
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        ctx.drawImage(this.outline, 0, 0, frame.w, frame.h, x + ox, y + oy, frame.w, frame.h);
      }
    }

    blit(ctx, image, x, y);
    ctx.restore();
  }

  /** The elevator car, its sliding doors and arrow lights, drawn behind the room art. */
  private drawElevator(world: World, highlights: Map<Agent, string>) {
    const opening = this.room.elevator;
    const elevator = world.elevatorFor(this.room);
    if (!opening || !elevator) return;
    const ctx = this.ctx;
    const door = this.assets[ELEVATOR_SPRITES.door];
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
      const slide = Math.round(elevator.open * door.width);
      ctx.drawImage(door, opening.x - slide, opening.y);
      ctx.save();
      ctx.translate(opening.x + opening.w + slide, opening.y);
      ctx.scale(-1, 1);
      ctx.drawImage(door, 0, 0);
      ctx.restore();
    }

    if (lights && this.litArrows) {
      const x = Math.round(opening.x + (opening.w - lights.width) / 2);
      const y = opening.y - ELEVATOR_SPRITES.lightsGap - lights.height;
      ctx.drawImage(lights, x, y);
      if (elevator.light && Math.floor(world.time * 3) % 2 === 0) {
        const { upWidth, downX } = ELEVATOR_SPRITES;
        const sx = elevator.light === 'up' ? 0 : downX;
        const sw = elevator.light === 'up' ? upWidth : lights.width - downX;
        ctx.drawImage(this.litArrows, sx, 0, sw, lights.height, x + sx, y, sw, lights.height);
      }
    }
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
    ctx.drawImage(assets[`room:${room.id}`], 0, 0);

    // Props and people share one depth-sorted pass, ordered by where they touch the floor.
    const drawables: { depth: number; draw: () => void }[] = room.props.map((prop) => {
      const image = assets[prop.asset];
      return {
        depth: prop.y + prop.h - 0.5,
        draw: () => {
          if (!image) return;
          if (!prop.flip) return ctx.drawImage(image, prop.x, prop.y);
          ctx.save();
          ctx.translate(prop.x + image.width, prop.y);
          ctx.scale(-1, 1);
          ctx.drawImage(image, 0, 0);
          ctx.restore();
        },
      };
    });
    for (const agent of world.agentsIn(room)) {
      if (agent.layer !== 'room') continue;
      drawables.push({ depth: agent.y, draw: () => this.drawAgent(agent, highlights.get(agent)) });
    }
    drawables.sort((a, b) => a.depth - b.depth).forEach((item) => item.draw());
  }
}
