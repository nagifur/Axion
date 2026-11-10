import assert from 'node:assert/strict';
import test from 'node:test';
import { NAV_COLORS, NavMapError, parseNavMap } from '../src/lib/sim/navMap.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';

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

test('numbers doors that share a side', () => {
  const nav = parse([
    'd.d.......',
    'gggggggggg',
  ]);
  assert.deepEqual(nav.exits.map((exit) => exit.id), ['west-1', 'west-2']);
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

test('loads the Level 1 office room from its folder', async () => {
  const data = await loadRoom('level-1-offices');
  assert.equal(data.width, 577);
  assert.equal(data.height, 209);
  assert.deepEqual(data.nav.exits.map((exit) => exit.id), ['west', 'east', 'elevator']);
  // The elevator must line up with the transparent opening in room.png.
  assert.deepEqual(data.nav.exits[2].bounds, { x: 177, y: 89, w: 48, h: 67 });

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
