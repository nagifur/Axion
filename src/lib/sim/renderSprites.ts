import type { Point, Room } from './room.ts';
import type { Prop } from './prop.ts';
import { Item, type PlacedItem } from './item.ts';
import type { Particle, ParticleEmissionSampler } from './particles.ts';
import type { Rect } from './navMap.ts';
import { itemFrame, type PropLook } from './sprites.ts';
import { FrameAlphaMasks, requireAsset, visualPropFrame, type Assets, type SizedImage } from './renderAssets.ts';

export function drawSpriteFrame(ctx: CanvasRenderingContext2D, image: CanvasImageSource, frame: Rect, x: number, y: number, flip: boolean) {
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
