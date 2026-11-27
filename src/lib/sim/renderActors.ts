import { Creature } from './creature.ts';
import type { Point, Room } from './room.ts';
import type { Remains } from './remains.ts';
import type { CameraActor, World } from './world.ts';
import type { Rect } from './navMap.ts';
import { CHARACTER_FRAMES, TRIP_CYCLE, TRIP_HEAD_OFFSET, frameWithIdleFallback, itemHandAnchor, type Frame, type FrameName } from './sprites.ts';
import { context, fitCanvas, frameHasPixels, FrameAlphaMasks, makeCanvas, placeholderFrame, recolor, requireAsset, type Assets, type Canvas, type SizedImage } from './renderAssets.ts';
import { drawItemSprite, drawSpriteFrame } from './renderSprites.ts';

interface ScaledSheet {
  normal: Canvas;
  redEye: Canvas;
  alpha: Uint8ClampedArray;
  width: number;
  frames: Record<FrameName, Frame>;
}

const EYE_WHITE = [255, 255, 255];
const EYE_RED = [255, 40, 64];

/** Extra pixels around the cursor that still count as clicking a character. */
const AGENT_PICK_TOLERANCE = 2;
/** Size of the stand-in drawn for remains whose artwork is missing. */
const MISSING_REMAINS = { w: 24, h: 16 };
/** Frequency of the subtle one-pixel disposal shake, in radians per second. */
const DISPOSAL_SHAKE_SPEED = 12;

type ActorSheet = 'character' | 'creature' | 'security';

/** Airborne piles sort beside their thrower; landed ones just behind anyone standing on them. */
export const remainsDepth = (remains: Pick<Remains, 'y' | 'flight'>) => remains.flight?.depth ?? remains.y - 0.5;

export function actorDepth(actor: CameraActor) {
  return !(actor instanceof Creature) && actor.sitting && actor.spot ? Math.max(actor.y, actor.spot.propDepth) : actor.y;
}

export abstract class ActorRenderer {
  protected readonly ctx: CanvasRenderingContext2D;
  protected readonly assets: Assets;
  protected room: Room;
  private readonly redEyeSheet: Canvas;
  private readonly sheets = new Map<string, ScaledSheet>();
  private readonly outline = makeCanvas(160, 160);
  private readonly remainsMasks = new FrameAlphaMasks();
  private readonly scaledRemains = new Map<string, Canvas>();

  protected constructor(ctx: CanvasRenderingContext2D, assets: Assets, room: Room) {
    this.ctx = ctx;
    this.assets = assets;
    this.room = room;
    this.redEyeSheet = recolor(assets.character, EYE_WHITE, EYE_RED);
  }

  /** Characters are scaled by height once, at room resolution, then cached. */
  private sheet(scale: number, kind: ActorSheet = 'character'): ScaledSheet {
    const key = `${kind}:${scale}`;
    const cached = this.sheets.get(key);
    if (cached) return cached;

    const source = requireAsset(this.assets, kind);
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
      for (const [name, cell] of Object.entries(CHARACTER_FRAMES)) {
        const scaled = frames[name as FrameName];
        const frame = kind === 'character' ? cell : frameWithIdleFallback(name as FrameName, (pose) => frameHasPixels(source, pose));
        if (kind !== 'character' || frameHasPixels(source, frame)) {
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
      redEye: kind === 'character' ? draw(this.redEyeSheet) : normal,
      alpha: normal.getContext('2d')!.getImageData(0, 0, width, height).data,
      width,
      frames,
    };
    this.sheets.set(key, sheet);
    return sheet;
  }

  /** Where the sprite lands on screen for the agent's current pose. */
  private placement(agent: CameraActor) {
    const sheet = this.sheet(agent.character.scale, agent instanceof Creature ? 'creature' : agent.security ? 'security' : 'character');
    const { name, flip } = agent.frame;
    const frame = sheet.frames[name];
    const relief = agent.disposalActivityTime;
    const shake = !(agent instanceof Creature) && agent.shake > 0 ? Math.round(Math.sin(agent.shake * 60))
      : relief === undefined ? 0 : Math.round(Math.sin(relief * DISPOSAL_SHAKE_SPEED));
    const x = Math.round(agent.x) + shake - (flip ? frame.w - frame.anchorX : frame.anchorX);
    const y = Math.round(agent.y) - frame.h;
    return { sheet, name, frame, flip, x, y };
  }

  /** Swallowed prey have no sprite of their own; their tags ride along with whoever carries them. */
  private carrier(actor: CameraActor): CameraActor {
    return actor.vore.inside?.predator ?? actor;
  }

  /** Point just above an agent's head, in room pixels (for name tags). */
  headPosition(actor: CameraActor) {
    const agent = this.carrier(actor);
    const { name, frame, flip, y } = this.placement(agent);
    const offset = TRIP_CYCLE.includes(name) ? TRIP_HEAD_OFFSET : undefined;
    const x = agent.x + (offset ? Math.round(offset.x * agent.character.scale) * (flip ? -1 : 1) : 0);
    return { x, y: y + (offset ? Math.round(offset.y * agent.character.scale) : 0), height: frame.h };
  }

  isVisible(actor: CameraActor, world: World) {
    const agent = this.carrier(actor);
    if (agent.held || agent.room !== this.room || agent.alpha < 0.3) return false;
    if (agent instanceof Creature && !agent.onCamera) return false;
    return agent.layer === 'room' || (world.elevatorFor(this.room)?.open ?? 0) > 0.4;
  }

  /** Pixel-accurate picking, with a small tolerance so thin limbs are still easy to click. */
  hitTest(world: World, px: number, py: number): CameraActor | null {
    const ordered = world.actorsIn(this.room).reverse().filter((actor) => this.isVisible(actor, world)).sort((a, b) => actorDepth(b) - actorDepth(a));
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

  /** The front-most remains pile under a point, picked by its opaque pixels like characters are. */
  remainsAt(px: number, py: number): Remains | null {
    const front = [...(this.room.remains ?? [])].reverse().sort((a, b) => remainsDepth(b) - remainsDepth(a));
    for (const remains of front) {
      const { image, asset } = this.remainsImage(remains);
      const x = Math.round(remains.x - image.width / 2);
      const y = Math.round(remains.y - (remains.flight?.lift ?? 0) - image.height);
      const mask = this.remainsMasks.get(asset, image, { x: 0, y: 0, w: image.width, h: image.height });
      for (let oy = -AGENT_PICK_TOLERANCE; oy <= AGENT_PICK_TOLERANCE; oy++) {
        for (let ox = -AGENT_PICK_TOLERANCE; ox <= AGENT_PICK_TOLERANCE; ox++) {
          const lx = Math.floor(px) - x + ox;
          const ly = Math.floor(py) - y + oy;
          if (lx < 0 || ly < 0 || lx >= mask.w || ly >= mask.h) continue;
          if (mask.alpha[ly * mask.w + lx] > 0) return remains;
        }
      }
    }
    return null;
  }

  /** The pile's artwork, resized to the prey's size (cached per artwork and size). */
  private remainsImage(remains: Remains): { image: SizedImage; asset: string } {
    const scale = remains.scale ?? 1;
    const source = this.assets[remains.asset];
    const image: SizedImage = source
      ?? placeholderFrame(requireAsset(this.assets, 'missing-texture'), MISSING_REMAINS.w, MISSING_REMAINS.h);
    const asset = source ? remains.asset : 'missing-remains';
    if (scale === 1) return { image, asset };
    const key = `${asset}@${scale}`;
    let scaled = this.scaledRemains.get(key);
    if (!scaled) {
      scaled = makeCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
      context(scaled).drawImage(image, 0, 0, image.width, image.height, 0, 0, scaled.width, scaled.height);
      this.scaledRemains.set(key, scaled);
    }
    return { image: scaled, asset: key };
  }

  /** A 1px outline, stamped as a tinted silhouette around the sprite frame. */
  private drawOutline(image: CanvasImageSource, frame: Rect, x: number, y: number, flip: boolean, color: string) {
    fitCanvas(this.outline, frame.w, frame.h);
    const outlineCtx = context(this.outline);
    outlineCtx.globalCompositeOperation = 'source-over';
    outlineCtx.clearRect(0, 0, this.outline.width, this.outline.height);
    drawSpriteFrame(outlineCtx, image, frame, 0, 0, flip);
    outlineCtx.globalCompositeOperation = 'source-in';
    outlineCtx.fillStyle = color;
    outlineCtx.fillRect(0, 0, frame.w, frame.h);
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      this.ctx.drawImage(this.outline, 0, 0, frame.w, frame.h, x + ox, y + oy, frame.w, frame.h);
    }
  }

  protected carriedItemPlacement(agent: CameraActor, pose = this.placement(agent)) {
    if (agent instanceof Creature || !agent.item) return null;
    const item = agent.item;
    const { name, frame, flip, x, y } = pose;
    const hand = itemHandAnchor(name, agent.facing);
    const scale = agent.character.scale;
    const width = Math.max(1, Math.round(item.w * scale));
    const height = Math.max(1, Math.round(item.h * scale));
    const feetX = x + (flip ? frame.w - frame.anchorX : frame.anchorX);
    return {
      item, scale, width, height, behind: hand.behind, flip: item.flip !== flip,
      x: feetX + Math.round(hand.x * scale) - Math.round(width / 2),
      y: y + frame.h + Math.round(hand.y * scale) - height,
    };
  }

  protected drawAgent(agent: CameraActor, highlight?: string) {
    const ctx = this.ctx;
    const pose = this.placement(agent);
    const { sheet, frame, flip, x, y } = pose;
    const creature = agent instanceof Creature;
    const image = !creature && (agent.eyeFlash > 0 || agent.revealed) ? sheet.redEye : sheet.normal;

    ctx.save();
    ctx.globalAlpha = creature ? agent.alpha : agent.alpha * (agent.ghost ? 0.55 : 1);

    if (agent.layer === 'room') {
      const width = Math.max(6, Math.round(14 * agent.character.scale));
      const fx = Math.round(agent.x);
      const fy = Math.round(agent.y);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(fx - width, fy - 1, width * 2, 2);
      ctx.fillRect(fx - width + 3, fy - 2, width * 2 - 6, 4);
    }

    if (highlight) this.drawOutline(sheet.normal, frame, x, y, flip, highlight);

    const carried = this.carriedItemPlacement(agent, pose);
    const drawCarried = () => {
      if (!carried) return;
      const { item, x, y, scale, flip } = carried;
      const itemImage = requireAsset(this.assets, item.asset);
      drawItemSprite(ctx, itemImage, item, x, y, scale, flip);
    };
    if (carried?.behind) drawCarried();
    drawSpriteFrame(ctx, image, frame, x, y, flip);
    if (carried && !carried.behind) drawCarried();
    ctx.restore();
  }

  /** Held sprites draw above the room without changing their simulation position. */
  drawHeld(agent: CameraActor, point: Point, valid: boolean) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(Math.round(point.x - agent.x), Math.round(point.y - agent.y));
    this.drawAgent(agent, valid ? '#33ff99' : '#ff4060');
    ctx.restore();
  }

  /** A pile left behind by a predator, resting with its bottom centre on the floor point. */
  protected drawRemains(remains: Remains, highlight?: string) {
    const { image } = this.remainsImage(remains);
    const x = Math.round(remains.x - image.width / 2);
    const y = Math.round(remains.y - (remains.flight?.lift ?? 0) - image.height);
    if (highlight) this.drawOutline(image, { x: 0, y: 0, w: image.width, h: image.height }, x, y, false, highlight);
    this.ctx.drawImage(image, x, y);
  }
}
