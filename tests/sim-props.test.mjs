import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { PROP_SPRITES, propFrame, propFrames } from '../src/lib/sim/sprites.ts';
import { loadRoom, propPreview } from '../src/lib/sim/roomLoader.ts';
import { drawPropSprite, loadAssets, Renderer } from '../src/lib/sim/render.ts';
import { PropEditor } from '../src/lib/sim/propEditor.ts';
import { Room } from '../src/lib/sim/room.ts';

test('prop crops contain all artwork in each 96x96 cell', async () => {
  for (const [asset, sprite] of Object.entries(PROP_SPRITES)) {
    const { data, info } = await sharp(`src/sim_assets/props/${asset}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frames = [...propFrames(asset, info), ...Object.values(sprite.states ?? {}).flatMap((state) => state.frames)];
    assert.equal(info.width % 96, 0);
    assert.equal(info.height % 96, 0);
    for (const frame of frames) {
      const cellX = Math.floor(frame.x / 96) * 96;
      const cellY = Math.floor(frame.y / 96) * 96;
      let opaque = 0;
      for (let y = cellY; y < cellY + 96; y++) {
        for (let x = cellX; x < cellX + 96; x++) {
          if (!data[(y * info.width + x) * 4 + 3]) continue;
          opaque++;
          assert.ok(x >= frame.x && x < frame.x + frame.w && y >= frame.y && y < frame.y + frame.h, `${asset}: crop clips artwork at ${x}, ${y}`);
        }
      }
      assert.ok(opaque > 0, `${asset}: frame contains artwork`);
    }
    assert.equal(propFrames(asset, info).length, sprite.frames.length);
  }
});

test('lights animate on simulation time while furniture remains still', () => {
  const image = { width: 192, height: 192 };
  assert.equal(propFrame('light', image, 0), PROP_SPRITES.light.frames[0]);
  assert.equal(propFrame('light', image, 0.59), PROP_SPRITES.light.frames[0]);
  assert.equal(propFrame('light', image, 0.6), PROP_SPRITES.light.frames[1]);
  assert.equal(propFrame('light', image, 1.2), PROP_SPRITES.light.frames[0]);
  assert.equal(propFrame('chair', { width: 96, height: 96 }, 100), PROP_SPRITES.chair.frames[0]);
  assert.deepEqual(propFrame('plant', { width: 20, height: 30 }, 100), { x: 0, y: 0, w: 20, h: 30 });
});

test('invalid sheet bounds and animation time are reported', () => {
  assert.throws(() => propFrame('light', { width: 96, height: 96 }), /outside its 96x96 sheet/);
  assert.throws(() => propFrame('chair', { width: 27, height: 38 }), /outside/);
  assert.throws(() => propFrame('plant', { width: 0, height: 0 }), /outside/);
  assert.throws(() => propFrame('light', { width: 192, height: 96 }), /outside its 192x96 sheet/);
  assert.throws(() => propFrame('light', { width: 192, height: 192 }, -1), /finite and non-negative/);
});

test('room loading preserves cropped furniture sizes, seats, and floor geometry', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const sizes = { bench: [71, 33], chair: [27, 38], table: [68, 27], light: [40, 17] };
  for (const prop of room.props) assert.deepEqual([prop.w, prop.h], sizes[prop.type]);
  const left = room.spots.find((seat) => seat.kind === 'chair' && seat.facing === 'left');
  assert.deepEqual([left.x, left.y], [431, 157]);
  assert.ok(room.blockedAreas.some((rect) => rect.x === 321 && rect.y === 152 && rect.w === 21 && rect.h === 8));
});

test('palette previews contain only the first cropped frame', async () => {
  for (const asset of ['light', 'chair']) {
    const preview = await propPreview(asset);
    const actual = await sharp(Buffer.from(preview.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frame = PROP_SPRITES[asset].frames[0];
    const expected = await sharp(`src/sim_assets/props/${asset}.png`)
      .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h }).ensureAlpha().raw().toBuffer();
    assert.deepEqual([actual.info.width, actual.info.height], [frame.w, frame.h]);
    assert.deepEqual(actual.data, expected);
  }
});

test('prop drawing crops and mirrors the current frame, not the whole sheet', () => {
  const calls = [];
  const ctx = {
    drawImage(...args) { calls.push(['draw', ...args]); },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    translate(...args) { calls.push(['translate', ...args]); },
    scale(...args) { calls.push(['scale', ...args]); },
  };
  const image = { width: 192, height: 192 };
  drawPropSprite(ctx, image, 'light', 10, 20, false, 0);
  assert.deepEqual(calls, [['draw', image, 28, 39, 40, 17, 10, 20, 40, 17]]);
  calls.length = 0;
  drawPropSprite(ctx, image, 'light', 10, 20, true, 0.6);
  assert.deepEqual(calls, [
    ['save'], ['translate', 50, 20], ['scale', -1, 1],
    ['draw', image, 124, 39, 40, 17, 0, 0, 40, 17], ['restore'],
  ]);
  calls.length = 0;
  drawPropSprite(ctx, image, 'light', 10, 20, false, 0.6, 'off');
  assert.deepEqual(calls, [['draw', image, 28, 135, 40, 17, 10, 20, 40, 17]]);
});

test('switched-off lights use the off row; looks without artwork fall back', () => {
  const image = { width: 192, height: 192 };
  assert.deepEqual(propFrame('light', image, 0, 'off'), { x: 28, y: 135, w: 40, h: 17 });
  assert.deepEqual(propFrame('light', image, 5, 'off'), { x: 28, y: 135, w: 40, h: 17 });
  // No broken artwork yet: the normal look is used.
  assert.equal(propFrame('chair', { width: 96, height: 96 }, 0, 'broken'), PROP_SPRITES.chair.frames[0]);
});

test('editor placement uses one cropped frame as its footprint', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const editor = new PropEditor({ light: { width: 192, height: 192 }, chair: { width: 96, height: 96 } }, room, () => {});
  editor.add('light');
  editor.pointerDown({ x: 100, y: 100 }, 0.6);
  assert.deepEqual(editor.selected.toData(), { type: 'light', asset: 'light', flip: false, x: 80, y: 83, w: 40, h: 17 });
  assert.ok(room.props.includes(editor.selected));
  editor.add('chair');
  editor.pointerDown({ x: 200, y: 160 });
  assert.deepEqual([editor.selected.w, editor.selected.h, editor.selected.x, editor.selected.y], [27, 38, 187, 122]);
  editor.flip();
  const seat = room.spots.find((s) => s.id === `chair-${room.props.length - 1}-0`);
  assert.equal(seat.facing, 'left');
});

test('elevator doors and lit arrows use their cropped artwork dimensions', async (t) => {
  const source = await sharp('src/sim_assets/props/elevator_lights.png').ensureAlpha().raw().toBuffer();
  let off;
  for (let i = 0; i < source.length && !off; i += 4) {
    if (source[i + 3]) off = source.subarray(i, i + 4);
  }
  assert.ok(off, 'arrow artwork contains opaque pixels');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const draws = [];
        const translations = [];
        const ctx = {
          drawImage(...args) { draws.push(args); },
          getImageData(_x, _y, w, h) {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < data.length; i += 4) data.set(off, i);
            return { data };
          },
          putImageData(image) { this.pixels = image.data; },
          fillRect() {}, save() {}, restore() {}, scale() {},
          translate(...args) { translations.push(args); },
        };
        return { width: 0, height: 0, draws, translations, getContext() { return ctx; } };
      },
    },
  });
  const canvas = document.createElement('canvas');
  const door = { width: 96, height: 96 };
  const lights = { width: 96, height: 96 };
  const room = { elevator: { x: 20, y: 30, w: 48, h: 67 } };
  const renderer = new Renderer(canvas, { character: { width: 576, height: 864 }, elevator_door: door, elevator_lights: lights }, room);
  assert.deepEqual([...renderer.litArrows.getContext('2d').pixels.subarray(0, 4)], [255, 177, 91, 255]);
  const elevator = { open: 0.5, light: 'up' };
  const world = { time: 0, elevatorFor() { return elevator; }, agentsIn() { return []; } };
  renderer.drawElevator(world, new Map());
  assert.deepEqual(canvas.draws[0], [door, 36, 15, 24, 67, 8, 30, 24, 67]);
  assert.deepEqual(canvas.draws[1], [door, 36, 15, 24, 67, 0, 0, 24, 67]);
  assert.deepEqual(canvas.translations, [[80, 30]]);
  assert.deepEqual(canvas.draws[2], [lights, 36, 44, 24, 9, 32, 14, 24, 9]);
  assert.deepEqual(canvas.draws[3].slice(1), [36, 44, 11, 9, 32, 14, 11, 9]);
  canvas.draws.length = 0;
  elevator.light = 'down';
  renderer.drawElevator(world, new Map());
  assert.deepEqual(canvas.draws[3].slice(1), [49, 44, 11, 9, 45, 14, 11, 9]);

  const bigDoor = { width: 96, height: 96 };
  renderer.assets.elevator_door_big = bigDoor;
  room.elevator = { x: 458, y: 251, w: 176, h: 73, big: true };
  canvas.draws.length = 0;
  canvas.translations.length = 0;
  renderer.drawElevator(world, new Map());
  assert.deepEqual(canvas.draws[0], [bigDoor, 5, 12, 87, 73, 414, 251, 87, 73]);
  assert.deepEqual(canvas.draws[1], [bigDoor, 5, 12, 87, 73, 0, 0, 87, 73]);
  assert.deepEqual(canvas.translations, [[678, 251]]);
  assert.deepEqual(canvas.draws[2], [lights, 36, 44, 24, 9, 534, 235, 24, 9]);
});

test('asset loading rejects invalid prop sheets instead of rendering broken crops', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Image', original);
    else delete globalThis.Image;
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      width = 96;
      height = 96;
      set src(_value) { this.onload(); }
    },
  });
  await assert.rejects(loadAssets({ light: '/light.png' }), /outside its 96x96 sheet/);
});
