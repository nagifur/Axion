import assert from 'node:assert/strict';
import test from 'node:test';
import { Renderer } from '../src/lib/sim/render.ts';
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
  const source = { width: 576, height: 576 };
  const renderer = new Renderer(document.createElement('canvas'), { character: source }, {});
  for (const scale of [0.75, 0.8, 0.85, 0.88, 0.96, 0.97, 1, 1.01, 1.137, 1.2]) {
    const sheet = renderer.sheet(scale);
    assert.equal(renderer.sheet(scale), sheet, 'scaled sheets remain cached');
    for (const image of [sheet.normal, sheet.redEye]) {
      assert.equal(image.draws.length, 18, 'each frame is resized independently');
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
