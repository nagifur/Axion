import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAssets, Renderer } from '../src/lib/sim/render.ts';
import { Agent } from '../src/lib/sim/agent.ts';
import { CHARACTER_FRAMES } from '../src/lib/sim/sprites.ts';
import { Prop } from '../src/lib/sim/prop.ts';

test('a room instance draws its shared template image', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document;
  });
  const draws = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const ctx = {
          setTransform() {}, fillRect() {}, drawImage(image) { draws.push(image); },
          getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
          putImageData() {},
        };
        return { width: 0, height: 0, getContext() { return ctx; } };
      },
    },
  });
  const image = {};
  const room = { id: 'cell-01', templateId: 'cell-template', width: 200, height: 100, props: [], doors: [] };
  const renderer = new Renderer(document.createElement('canvas'), { character: { width: 1, height: 1 }, 'room:cell-template': image }, room);
  draws.length = 0;
  renderer.draw({ time: 0, actorsIn: () => [], elevatorFor() {}, particles: { in: () => [] } }, new Map());
  assert.deepEqual(draws, [image]);
});

test('missing character cells, including rows beyond the sheet, use the placeholder in both scaled sheets', async (t) => {
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage); else delete globalThis.Image;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document;
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      width = 192;
      height = 96;
      set src(_url) { this.onload(); }
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const draws = [];
        const ctx = {
          drawImage(...args) { draws.push(args); },
          getImageData(_x, _y, width, height) {
            const data = new Uint8ClampedArray(width * height * 4);
            data[3] = 255;
            return { data };
          },
          putImageData() {},
        };
        return { width: 0, height: 0, draws, getContext() { return ctx; } };
      },
    },
  });
  const assets = await loadAssets({ character: '/character.png', 'missing-texture': '/missing.png' });
  const renderer = new Renderer(document.createElement('canvas'), assets, {});
  const sheet = renderer.sheet(0.8);
  for (const canvas of [sheet.normal, sheet.redEye]) {
    assert.notEqual(canvas.draws[0][0], assets['missing-texture']);
    assert.equal(canvas.draws[1][0], assets['missing-texture'], 'transparent cell');
    assert.equal(canvas.draws[4][0], assets['missing-texture'], 'row outside the image');
    assert.deepEqual(canvas.draws[4].slice(5), [0, 77, 77, 77]);
    assert.ok(sheet.frames.useRight6.y + sheet.frames.useRight6.h <= canvas.height);
  }
});

test('backup power keeps the scene dim and tints it red, with emergency lights glowing above', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  const fills = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const stack = [];
        const ctx = {
          globalCompositeOperation: 'source-over',
          drawImage() { fills.push({ draw: 'image' }); },
          setTransform() {}, putImageData() {}, clearRect() {}, translate() {}, scale() {},
          createRadialGradient() { return { addColorStop() {} }; },
          getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
          fillRect(...rect) { fills.push({ style: this.fillStyle, composite: this.globalCompositeOperation, rect }); },
          save() { stack.push(this.globalCompositeOperation); },
          restore() { this.globalCompositeOperation = stack.pop(); },
        };
        return { width: 0, height: 0, getContext() { return ctx; } };
      },
    },
  });
  const light = new Prop({ type: 'light', asset: 'light', x: 0, y: 0, w: 40, h: 17, flip: false });
  const room = { id: 'room', width: 200, height: 100, darkness: 0, power: 'backup', props: [light], doors: [] };
  light.setPowerSource(() => room.power);
  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas, {
    character: { width: 576, height: 1152 }, 'room:room': {}, light: { width: 192, height: 288 },
  }, room);
  const world = { time: 0, actorsIn: () => [], elevatorFor() {}, particles: { in: () => [] } };
  renderer.draw(world, new Map());
  const dimAt = fills.findIndex((fill) => fill.style === 'rgba(0, 0, 0, 0.55)');
  assert.deepEqual(fills[dimAt], { style: 'rgba(0, 0, 0, 0.55)', composite: 'source-over', rect: [0, 0, 200, 100] });
  assert.equal(fills[dimAt + 1].composite, 'color', 'the dimmed scene gets a red hue layer');
  assert.deepEqual(fills[dimAt + 1].rect, [0, 0, 200, 100]);
  assert.deepEqual(fills.slice(dimAt + 2).map((fill) => fill.draw ?? fill.composite), ['image', 'screen'],
    'the red light is redrawn above the tint, then its halo');
  assert.equal(canvas.getContext().globalCompositeOperation, 'source-over', 'the tint blend does not leak into glows');
  assert.equal(room.darkness, 0, 'the tint is visual only');

  fills.length = 0;
  room.power = 'normal';
  renderer.draw(world, new Map());
  assert.ok(!fills.some((fill) => fill.composite === 'color' || fill.composite === 'screen'), 'normal power has no tint or halo');
});

test('emergency light sprites are red, preserve alpha and framing, and reuse the tinted sheet', (t) => {
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
        const ctx = {
          drawImage(...args) { draws.push(args); },
          getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4).fill(255) }; },
          putImageData(pixels) { this.pixels = pixels; },
          save() {}, restore() {},
        };
        return { width: 0, height: 0, draws, getContext() { return ctx; } };
      },
    },
  });
  const canvas = document.createElement('canvas');
  const image = { width: 192, height: 288 };
  const renderer = new Renderer(canvas, { character: { width: 576, height: 1152 }, light: image }, {});
  const light = new Prop({ type: 'light', asset: 'light', x: 10, y: 20, w: 40, h: 17, flip: false });
  light.setPowerSource(() => 'backup');
  renderer.drawProp(light, 0);
  const tinted = canvas.draws[0][0];
  assert.deepEqual([...tinted.getContext().pixels.data.slice(0, 4)], [255, 20, 20, 255]);
  assert.deepEqual(canvas.draws[0].slice(1), [28, 39, 40, 17, 10, 20, 40, 17]);
  renderer.drawProp(light, 0.6);
  assert.equal(canvas.draws[1][0], tinted, 'red sheet is cached across frames');
  assert.deepEqual(canvas.draws[1].slice(1, 5), [124, 39, 40, 17]);
  light.break();
  renderer.drawProp(light, 0);
  assert.equal(canvas.draws[2][0], image, 'broken lights keep their broken artwork, not the emergency tint');
});

test('scaled sheets crop each frame before resizing to prevent neighboring-row bleed', (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const draws = [];
        const ctx = {
          drawImage(...args) { draws.push(args); },
          getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
          putImageData() {},
        };
        return { width: 0, height: 0, draws, getContext() { return ctx; } };
      },
    },
  });
  const source = { width: 576, height: 1152 };
  const renderer = new Renderer(document.createElement('canvas'), { character: source }, {});
  for (const scale of [0.75, 0.8, 0.85, 0.88, 0.96, 0.97, 1, 1.01, 1.137, 1.2]) {
    const sheet = renderer.sheet(scale);
    assert.equal(renderer.sheet(scale), sheet, 'scaled sheets remain cached');
    for (const image of [sheet.normal, sheet.redEye]) {
      assert.equal(image.draws.length, 34, 'each frame is resized independently');
      Object.entries(CHARACTER_FRAMES).forEach(([name, frame], index) => {
        const scaled = sheet.frames[name];
        assert.deepEqual(image.draws[index].slice(1), [
          frame.x, frame.y, frame.w, frame.h,
          scaled.x, scaled.y, scaled.w, scaled.h,
        ]);
        assert.equal(scaled.anchorX, Math.round(frame.anchorX * scale));
        assert.ok(scaled.x + scaled.w <= image.width && scaled.y + scaled.h <= image.height);
      });
    }

    const agent = new Agent({ scale, behavior: { speed: 1 } }, {}, { x: 200, y: 140 });
    agent.setPlan({}, [{ activity: 'Trip', tripping: true, update() { return false; } }]);
    agent.update({}, 0);
    const height = sheet.frames.tripRight1.h;
    for (const facing of ['right', 'left']) {
      agent.facing = facing;
      assert.deepEqual(renderer.headPosition(agent), {
        x: 200 + Math.round(22 * scale) * (facing === 'left' ? -1 : 1),
        y: 140 - height + Math.round(56 * scale),
        height,
      }, 'prone name tags follow the head at each scale and orientation');
    }
    agent.held = true;
    assert.equal(renderer.headPosition(agent).x, 200, 'a dragged character uses the standing head position');
  }
});

test('a seated character is drawn and picked in front of their chair', (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const draws = [];
        const fills = [];
        const ctx = {
          drawImage(...args) { draws.push(args); },
          getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4).fill(255) }; },
          putImageData() {},
          setTransform() {},
          fillRect(...args) { fills.push({ style: this.fillStyle, rect: args, afterDraw: draws.length }); },
          save() {},
          restore() {},
          translate() {},
          scale() {},
          clearRect() {},
        };
        return { width: 0, height: 0, draws, fills, getContext() { return ctx; } };
      },
    },
  });
  const chair = { width: 192, height: 288 };
  const backdrop = {};
  const room = {
    id: 'room', width: 400, height: 200, darkness: 0,
    get visualDarkness() { return this.darkness; },
    props: [{ asset: 'chair', x: 100, y: 100, w: 27, h: 38, flip: false }],
  };
  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas, { character: { width: 576, height: 1152 }, chair, 'room:room': backdrop }, room);
  const character = { scale: 1, behavior: { speed: 1 } };
  const seated = new Agent(character, room, { x: 110, y: 135 });
  seated.facing = 'right';
  seated.setPlan({}, [{ activity: 'Resting', interruptible: true, sitting: true, update() { return false; } }]);
  seated.spot = { id: 'chair', kind: 'chair', x: 110, y: 135, facing: 'right', propDepth: 138 };
  seated.update({}, 0);
  const standing = new Agent(character, room, { x: 110, y: 136 });
  const world = { agents: [seated, standing], actorsIn() { return [...this.agents]; }, elevatorFor() {}, particles: { in() { return []; } } };
  renderer.draw(world, new Map());
  const images = canvas.draws.map((draw) => draw[0]);
  const sheet = renderer.sheet(1);
  assert.deepEqual(images, [backdrop, sheet.normal, chair, sheet.normal], 'occupant is drawn after the chair');
  assert.equal(renderer.hitTest(world, 110, 100), seated, 'picking uses the same depth as drawing');
  const second = new Agent(character, room, { x: 110, y: 138 });
  world.agents.push(second);
  assert.equal(renderer.hitTest(world, 110, 100), second, 'the last-drawn character wins at equal depth');

  const dimming = () => canvas.fills.filter((fill) => fill.style === 'rgba(0, 0, 0, 0.55)');
  assert.equal(dimming().length, 0, 'lit rooms are not dimmed');
  room.darkness = 1;
  renderer.draw(world, new Map());
  assert.deepEqual(canvas.fills.at(-1), {
    style: 'rgba(0, 0, 0, 0.55)', rect: [0, 0, room.width, room.height], afterDraw: canvas.draws.length,
  }, 'darkness dims the entire scene after the props and people');
  room.darkness = 0;
  renderer.draw(world, new Map());
  assert.equal(dimming().length, 1, 'restoring light removes the dimming pass');

  world.agents = [seated];
  seated.held = true;
  assert.equal(renderer.isVisible(seated, world), false, 'held sprites are not targets');
  assert.equal(renderer.hitTest(world, 110, 100), null);
  assert.equal(seated.sitting, false, 'pickup uses a standing pose');
  const before = canvas.draws.length;
  renderer.draw(world, new Map());
  assert.equal(canvas.draws.length - before, 2, 'held sprite is omitted from the depth-sorted scene');
  const position = [seated.x, seated.y];
  renderer.drawHeld(seated, { x: 220, y: 170 }, true);
  assert.deepEqual([seated.x, seated.y], position, 'preview does not change simulation coordinates');
  assert.equal(canvas.draws.at(-1)[0], sheet.normal);
  seated.held = false;
  assert.equal(renderer.isVisible(seated, world), true, 'cancelling makes the original sprite visible again');
});

test('remains stand on the floor by their bottom centre, with a stand-in for missing artwork', (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const draws = [];
        const ctx = {
          drawImage(...args) { draws.push(args); },
          getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
          putImageData() {}, setTransform() {}, fillRect() {}, save() {}, restore() {}, translate() {}, scale() {}, clearRect() {},
        };
        return { width: 0, height: 0, draws, getContext() { return ctx; } };
      },
    },
  });
  const backdrop = {};
  const bones = { width: 30, height: 20 };
  const missing = { width: 8, height: 8 };
  const room = {
    id: 'hall', width: 200, height: 100, darkness: 0, visualDarkness: 0, props: [],
    remains: [{ x: 100.4, y: 80, asset: 'remains:bones' }, { x: 50, y: 60, asset: 'remains:unknown' }],
  };
  const canvas = document.createElement('canvas');
  const assets = { character: { width: 576, height: 1152 }, 'room:hall': backdrop, 'remains:bones': bones, 'missing-texture': missing };
  const renderer = new Renderer(canvas, assets, room);
  renderer.draw({ agents: [], actorsIn: () => [], elevatorFor() {}, particles: { in: () => [] } }, new Map());
  const [, standIn, pile] = canvas.draws;
  assert.deepEqual(pile, [bones, 85, 60], 'resting on the floor point, further down the room is drawn later');
  assert.deepEqual([standIn[0].width, standIn[0].height, standIn[1], standIn[2]], [24, 16, 38, 44]);
  assert.deepEqual(standIn[0].draws[0], [missing, 0, 0, 8, 8, 0, 0, 24, 16], 'the missing texture, sized like a pile');
});
