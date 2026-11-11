import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { NAV_COLORS, NavMapError, parseNavMap } from '../src/lib/sim/navMap.ts';
import { Room } from '../src/lib/sim/room.ts';
import { SIM_ASSETS_DIR, loadFacility, loadRoom } from '../src/lib/sim/roomLoader.ts';

const color = (kind) => [...NAV_COLORS.find((entry) => entry.kind === kind).rgb, 255];
const CLEAR = [0, 0, 0, 0];

// Builds RGBA pixels from rows of characters: g = floor, d = door, e = elevator, . = transparent.
function paint(rows, extra = {}) {
  const palette = { g: color('floor'), d: color('door'), e: color('elevator'), r: color('blocked'), '.': CLEAR, ...extra };
  const width = rows[0].length;
  const pixels = new Uint8Array(width * rows.length * 4);
  rows.forEach((row, y) => [...row].forEach((char, x) => pixels.set(palette[char], (y * width + x) * 4)));
  return { pixels, width, height: rows.length };
}

const parse = (rows, extra) => {
  const { pixels, width, height } = paint(rows, extra);
  return parseNavMap(pixels, width, height, 'test.png');
};

test('reads floor spans and exits from a nav map', () => {
  const nav = parse([
    'd...e....d',
    'd...e....d',
    'dgggggggdd',
    '.ggggggggr',
  ]);
  assert.deepEqual(nav.floor[2], [1, 8]);
  assert.deepEqual(nav.floor[3], [1, 9]);
  assert.deepEqual(nav.exits.map((exit) => exit.id), ['west', 'east', 'elevator']);
  const elevator = nav.exits.find((exit) => exit.kind === 'elevator');
  assert.deepEqual(elevator.bounds, { x: 4, y: 0, w: 1, h: 2 });
  assert.deepEqual(elevator.threshold, { x: 4, y: 2 });
});

test('numbers doors that share a wall, left to right', () => {
  const nav = parse([
    'd.d.......',
    'gggggggggg',
  ]);
  assert.deepEqual(nav.exits.map((exit) => exit.id), ['north-1', 'north-2']);
});

test('names doors by the wall they are in, from where the floor touches them', () => {
  const nav = parse([
    '....dd....',
    'd...gg...d',
    'dggggggggd',
    '.gggggggg.',
    '...ddd....',
  ]);
  const sides = Object.fromEntries(nav.exits.map((exit) => [exit.id, exit.side]));
  assert.deepEqual(sides, { west: 'west', north: 'north', south: 'south', east: 'east' });
});

test('reports mistakes with the pixel position', () => {
  assert.throws(() => parse(['ggx'], { x: [12, 34, 56, 255] }), /unexpected colour #0C2238 at \(2, 0\)/);
  assert.throws(() => parse(['ggx'], { x: [5, 255, 0, 128] }), /semi-transparent pixel at \(2, 0\)/);
  assert.throws(() => parse(['gg.g']), /split into 2 separate areas.*\(3, 0\)/);
  assert.throws(() => parse(['d...', '.ggg']), /door at \(0, 0\) doesn't touch the green floor/);
  assert.throws(() => parse(['e.e', 'ggg']), /only one elevator/);
  assert.throws(() => parse(['....']), NavMapError);
});

test('accepts close-enough hand-picked colours', () => {
  assert.doesNotThrow(() => parse(['gx'], { x: [0, 255, 0, 255] }));
});

test('every elevator opening is left transparent in its room art', async () => {
  for (const data of await loadFacility()) {
    const elevator = data.nav.exits.find((exit) => exit.kind === 'elevator');
    if (!elevator) continue;
    const { data: pixels, info } = await sharp(path.join(SIM_ASSETS_DIR, 'rooms', data.id, 'room.png'))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { x, y, w, h } = elevator.bounds;
    let opaque = 0;
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        if (pixels[(row * info.width + col) * 4 + 3] !== 0) opaque++;
      }
    }
    assert.equal(opaque, 0, `${data.id}: the elevator painted on navMap.png should be see-through in room.png`);
  }
});

test('loads the Level 1 office room from its folder', async () => {
  const data = await loadRoom('level-1-offices');
  assert.deepEqual(data.nav.exits.map((exit) => exit.id), ['west', 'east', 'elevator']);

  const room = new Room(data);
  assert.equal(room.spots.length, 5);
  const flippedChair = room.spots.find((spot) => spot.kind === 'chair' && spot.facing === 'left');
  assert.deepEqual([flippedChair.x, flippedChair.y], [431, 157]);
  for (const door of room.doors) assert.ok(room.isWalkable(door.inside), `${door.id} door has a walkable entry point`);
  assert.ok(room.isWalkable(room.elevator.front));
});

test('routes around the elevator column instead of through it', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const from = { x: 100, y: 155 };
  const to = { x: 300, y: 155 };
  assert.equal(room.isWalkable({ x: 200, y: 155 }), false);

  const path = room.route(from, to);
  assert.ok(path.length > 1);
  assert.deepEqual(path.at(-1), to);
  let previous = from;
  for (const point of path) {
    for (let t = 0.1; t < 1; t += 0.1) {
      const sample = { x: previous.x + (point.x - previous.x) * t, y: previous.y + (point.y - previous.y) * t };
      assert.ok(room.isWalkable(sample), `path stays on the floor at (${Math.round(sample.x)}, ${Math.round(sample.y)})`);
    }
    previous = point;
  }

  assert.deepEqual(room.route(from, to, true), [to], 'ghosts go straight through');
});
