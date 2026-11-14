import assert from 'node:assert/strict';
import test from 'node:test';
import { Renderer } from '../src/lib/sim/render.ts';
import { Agent } from '../src/lib/sim/agent.ts';
import { CHARACTER_FRAMES } from '../src/lib/sim/sprites.ts';

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
  const source = { width: 576, height: 864 };
  const renderer = new Renderer(document.createElement('canvas'), { character: source }, {});
  for (const scale of [0.75, 0.8, 0.85, 0.88, 0.96, 0.97, 1, 1.01, 1.137, 1.2]) {
    const sheet = renderer.sheet(scale);
    assert.equal(renderer.sheet(scale), sheet, 'scaled sheets remain cached');
    for (const image of [sheet.normal, sheet.redEye]) {
      assert.equal(image.draws.length, 24, 'each frame is resized independently');
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
        };
        return { width: 0, height: 0, draws, fills, getContext() { return ctx; } };
      },
    },
  });
  const chair = { width: 96, height: 96 };
  const backdrop = {};
  const room = {
    id: 'room', width: 400, height: 200, darkness: 0,
    props: [{ asset: 'chair', x: 100, y: 100, w: 27, h: 38, flip: false }],
  };
  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas, { character: { width: 576, height: 864 }, chair, 'room:room': backdrop }, room);
  const character = { scale: 1, behavior: { speed: 1 } };
  const seated = new Agent(character, room, { x: 110, y: 135 });
  seated.facing = 'right';
  seated.setPlan({}, [{ activity: 'Resting', interruptible: true, sitting: true, update() { return false; } }]);
  seated.spot = { id: 'chair', kind: 'chair', x: 110, y: 135, facing: 'right', propDepth: 138 };
  seated.update({}, 0);
  const standing = new Agent(character, room, { x: 110, y: 136 });
  const world = { agents: [seated, standing], agentsIn() { return this.agents; }, elevatorFor() {} };
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
});
