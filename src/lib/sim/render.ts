import { Creature } from './creature.ts';
import type { Room } from './room.ts';
import type { Prop } from './prop.ts';
import type { Item } from './item.ts';
import type { Remains } from './remains.ts';
import type { CameraActor, World } from './world.ts';
import { ELEVATOR_SPRITES, propFrame } from './sprites.ts';
import { passageDoorFrame, passagePanelFrame } from './door.ts';
import { context, fitCanvas, makeCanvas, recolor, requireAsset, visualPropFrame, type Assets, type Canvas } from './renderAssets.ts';
import { drawItemSprite, drawParticle, drawPropSprite, drawSpriteFrame } from './renderSprites.ts';
import { ActorRenderer, actorDepth, remainsDepth } from './renderActors.ts';

export { loadAssets, type Assets } from './renderAssets.ts';
export { drawItemSprite, drawParticle, drawPropSprite, PropEmissionSampler, PropPicker } from './renderSprites.ts';

const LIGHT_OFF = [70, 42, 25];
const LIGHT_ON = [255, 177, 91];
/** Passage-door panel indicator light: offset inside the panel artwork and glow radius, in room pixels. */
const DOOR_INDICATOR = {
  sideWall: { x: 8, y: 17 }, facing: { x: 9.5, y: 9.5 }, small: { x: 5.5, y: 5 },
  radius: 12, darkRadius: 32, alpha: 0.3, darkAlpha: 0.4,
};
/** Hue applied to the dimmed scene while backup power runs the emergency lights. */
const EMERGENCY_TINT = 'rgb(171, 126, 126)';
/** Halo around emergency lights, drawn above the tint; stretch widens it to suit the wide fixture. */
const EMERGENCY_GLOW = { radius: 36, stretch: 1.6, alpha: 0.6 };
/** South doors and their panels sit in front of the room, so they are see-through. */
const FOREGROUND_DOOR_ALPHA = 0.35;

export class Renderer extends ActorRenderer {
  private readonly canvas: Canvas;
  private readonly litArrows?: Canvas;
  private readonly passageDoorCanvas = makeCanvas(96, 96);
  private readonly emergencySheets = new Map<string, Canvas>();
  private pixelScale = 1;

  constructor(canvas: Canvas, assets: Assets, room: Room) {
    super(canvas.getContext('2d')!, assets, room);
    this.canvas = canvas;
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

  /** The elevator car, its sliding doors and arrow lights, drawn behind the room art. */
  private drawElevator(world: World, highlights: ReadonlyMap<CameraActor | Remains, string>) {
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

    for (const agent of world.actorsIn(this.room).filter((a) => !a.held && a.layer === 'inside').sort((a, b) => a.y - b.y)) {
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
      const frame = passageDoorFrame(door.side, state.broken, art.big, art.style);
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
      drawSpriteFrame(ctx, panel, passagePanelFrame(door.side, state.powered && state.unlocked, world.time, state.panelBroken, panel, art.style), art.panel.x, art.panel.y, art.panelFlip);
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
      const panel = passagePanelFrame(door.side, state.unlocked, world.time, false, undefined, art.style);
      const indicator = art.style === 'heavy_containment' ? DOOR_INDICATOR.small : sideWall ? DOOR_INDICATOR.sideWall : DOOR_INDICATOR.facing;
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

  private drawItemLight(item: Item, x: number, y: number, scale = 1, flip = item.flip, alpha = 1) {
    const light = item.light;
    if (!light) return;
    const ctx = this.ctx;
    const radius = light.radius * scale;
    const cx = x + Math.max(1, Math.round(item.w * scale)) / 2;
    const cy = y + Math.max(1, Math.round(item.h * scale)) / 2;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, light.color);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = glow;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.globalAlpha = alpha;
    drawItemSprite(ctx, requireAsset(this.assets, item.asset), item, x, y, scale, flip);
    ctx.restore();
  }

  draw(world: World, highlights: ReadonlyMap<CameraActor | Remains, string>) {
    const ctx = this.ctx;
    const { assets, room } = this;
    ctx.setTransform(this.pixelScale, 0, 0, this.pixelScale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, room.width, room.height);

    // Everything visible through openings in the room art is drawn first, then the room covers it.
    this.drawElevator(world, highlights);
    ctx.drawImage(requireAsset(assets, `room:${room.templateId ?? room.id}`), 0, 0);
    this.drawPassageDoors(world);

    // Props and people share one depth-sorted pass, ordered by where they touch the floor.
    const drawables: { depth: number; draw: () => void }[] = room.props.map((prop) => ({
      depth: prop.y + prop.h - 0.5,
      draw: () => this.drawProp(prop, world.time),
    }));
    for (const item of room.items ?? []) {
      drawables.push({ depth: item.y + item.h - 0.5, draw: () => drawItemSprite(ctx, requireAsset(assets, item.asset), item) });
    }
    for (const remains of room.remains ?? []) {
      drawables.push({ depth: remainsDepth(remains), draw: () => this.drawRemains(remains, highlights.get(remains)) });
    }
    for (const particle of world.particles.in(room)) {
      drawables.push({ depth: particle.depth, draw: () => drawParticle(ctx, requireAsset(assets, particle.asset), particle) });
    }
    for (const actor of world.actorsIn(room)) {
      if (actor.held || actor.layer !== 'room') continue;
      drawables.push({ depth: actorDepth(actor), draw: () => this.drawAgent(actor, highlights.get(actor)) });
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
    for (const item of room.items ?? []) this.drawItemLight(item, item.x, item.y);
    for (const actor of world.actorsIn(room)) {
      if (actor instanceof Creature || actor.held || actor.layer !== 'room' || !actor.item?.light) continue;
      const carried = this.carriedItemPlacement(actor);
      if (carried) this.drawItemLight(carried.item, carried.x, carried.y, carried.scale, carried.flip,
        actor.alpha * (actor.ghost ? 0.55 : 1));
    }
  }
}
