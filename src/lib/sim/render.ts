import type { Agent } from './agent';
import {
  CEILING_LIGHTS, CHARACTER_FRAMES, ELEVATOR, PROPS, ROOM,
  type AssetName, type Frame, type FrameName,
} from './room';
import type { World } from './world';

export type Assets = Record<AssetName, HTMLImageElement>;

export function loadAssets(urls: Record<AssetName, string>): Promise<Assets> {
  const entries = Object.entries(urls).map(([name, url]) => new Promise<[string, HTMLImageElement]>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve([name, image]);
    image.onerror = () => reject(new Error(`Failed to load sim asset "${name}"`));
    image.src = url;
  }));
  return Promise.all(entries).then((loaded) => Object.fromEntries(loaded) as Assets);
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
  private readonly redEyeSheet: Canvas;
  private readonly litArrows: Canvas;
  private readonly sheets = new Map<number, ScaledSheet>();
  private readonly outline = makeCanvas(160, 160);
  private pixelScale = 1;

  constructor(canvas: Canvas, assets: Assets) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.assets = assets;
    this.redEyeSheet = recolor(assets.character, EYE_WHITE, EYE_RED);
    this.litArrows = recolor(assets.elevatorLights, LIGHT_OFF, LIGHT_ON);
  }

  /** Renders at an integer multiple of the room size so pixels stay square and crisp. */
  resize() {
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = this.canvas.clientWidth || ROOM.width;
    const scale = Math.max(1, Math.round((cssWidth * ratio) / ROOM.width));
    if (scale === this.pixelScale && this.canvas.width === ROOM.width * scale) return;
    this.pixelScale = scale;
    this.canvas.width = ROOM.width * scale;
    this.canvas.height = ROOM.height * scale;
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
    if (agent.alpha < 0.3) return false;
    return agent.layer === 'room' || world.elevator.open > 0.4;
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

  draw(world: World, highlights: Map<Agent, string>) {
    const ctx = this.ctx;
    const { assets } = this;
    ctx.setTransform(this.pixelScale, 0, 0, this.pixelScale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, ROOM.width, ROOM.height);

    // Everything visible through the elevator opening is drawn first, then the room covers it.
    const { elevator } = world;
    ctx.fillStyle = '#0b141b';
    ctx.fillRect(ELEVATOR.x, ELEVATOR.y, ELEVATOR.w, ELEVATOR.h);
    ctx.fillStyle = '#1d3340';
    ctx.fillRect(ELEVATOR.x, ELEVATOR.y, ELEVATOR.w, 2);

    for (const agent of world.agents.filter((a) => a.layer === 'inside').sort((a, b) => a.y - b.y)) {
      this.drawAgent(agent, highlights.get(agent));
    }

    const doorWidth = assets.elevatorDoor.width;
    const slide = Math.round(elevator.open * doorWidth);
    ctx.drawImage(assets.elevatorDoor, ELEVATOR.x - slide, ELEVATOR.y);
    ctx.save();
    ctx.translate(ELEVATOR.x + doorWidth * 2 + slide, ELEVATOR.y);
    ctx.scale(-1, 1);
    ctx.drawImage(assets.elevatorDoor, 0, 0);
    ctx.restore();

    const { lights } = ELEVATOR;
    ctx.drawImage(assets.elevatorLights, lights.x, lights.y);
    if (elevator.light && Math.floor(world.time * 3) % 2 === 0) {
      const sx = elevator.light === 'up' ? 0 : lights.downX;
      const sw = elevator.light === 'up' ? lights.upWidth : assets.elevatorLights.width - lights.downX;
      ctx.drawImage(this.litArrows, sx, 0, sw, this.litArrows.height, lights.x + sx, lights.y, sw, this.litArrows.height);
    }

    ctx.drawImage(assets.room, 0, 0);
    for (const light of CEILING_LIGHTS) ctx.drawImage(assets.light, light.x, light.y);

    // Furniture and people share one depth-sorted pass, ordered by where they touch the floor.
    const drawables: { depth: number; draw: () => void }[] = PROPS.map((prop) => {
      const image = assets[prop.asset];
      return {
        depth: prop.y + image.height - 0.5,
        draw: () => {
          if (!prop.flip) return ctx.drawImage(image, prop.x, prop.y);
          ctx.save();
          ctx.translate(prop.x + image.width, prop.y);
          ctx.scale(-1, 1);
          ctx.drawImage(image, 0, 0);
          ctx.restore();
        },
      };
    });
    for (const agent of world.agents) {
      if (agent.layer !== 'room') continue;
      drawables.push({ depth: agent.y, draw: () => this.drawAgent(agent, highlights.get(agent)) });
    }
    drawables.sort((a, b) => a.depth - b.depth).forEach((item) => item.draw());
  }
}
