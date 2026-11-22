import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { NAV_COLORS, NavMapError, parseNavMap } from '../src/lib/sim/navMap.ts';
import { Room } from '../src/lib/sim/room.ts';
import { SIM_ASSETS_DIR, loadFacility, loadRoom } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';
import { doorTowardExit, stepTowardWork, wanderDoors, wanderFloors } from '../src/lib/sim/routing.ts';
import { exitThroughDoor, rideElevatorOut } from '../src/lib/sim/transport.ts';
import { wait, walkTo } from '../src/lib/sim/tasks.ts';
import { conversationPoint } from '../src/lib/sim/conversation.ts';
import { planNext } from '../src/lib/sim/planning.ts';

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

test('disconnected floors require an explicit opt-in and their own exits', () => {
  const read = (rows) => {
    const { pixels, width, height } = paint(rows);
    return parseNavMap(pixels, width, height, 'test.png', true);
  };
  const nav = read(['dgg..ggd']);
  assert.equal(nav.floorAreas.length, 2);
  assert.deepEqual(nav.floorAreas, [[[1, 3]], [[5, 7]]]);
  assert.throws(() => read(['dgg..gg.']), /separate floor area.*has no door or elevator/);
  assert.throws(() => read(['ggdgg']), /touches multiple separate floor areas/);
  assert.throws(() => parse(['dgg..ggd']), /split into 2 separate areas/);
});

const areaStaff = {
  id: 'area-staff', name: 'Area staff', href: '', tint: '#fff', scale: 1,
  position: 'Test', species: 'Human', accessLevel: '5', employeeID: 'area-staff', traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
};

function areaRoom(id, split, exits = [], links = {}, level = 0) {
  const left = Array.from({ length: 80 }, () => [0, 64]);
  const right = Array.from({ length: 80 }, () => [80, 160]);
  return new Room({
    id, name: id, level, camera: id, width: 160, height: 80, props: [], links,
    nav: {
      width: 160, height: 80,
      floor: split ? left.map((row, y) => [...row, ...right[y]]) : left.map(() => [0, 160]),
      ...(split ? { floorAreas: [left, right] } : {}),
      exits: exits.map(([id, x]) => ({
        id, kind: 'door', side: id.split('-')[0],
        bounds: { x, y: 10, w: 2, h: 20 }, threshold: { x, y: 40 }, base: { x, y: 40 },
      })),
    },
  });
}

test('floor areas isolate walking and random destinations, while ghosts cross', () => {
  const room = areaRoom('split', true);
  const from = { x: 30, y: 40 };
  const to = { x: 120, y: 40 };
  assert.equal(room.canReach(from, to), false);
  assert.equal(room.route(from, to), null);
  assert.deepEqual(room.route(from, to, true), [to]);
  assert.equal(room.canReach(from, to, true), true);
  for (let i = 0; i < 100; i++) {
    const point = room.randomFloorPoint(() => i / 100, from);
    assert.equal(room.floorArea(point), room.floorArea(from));
    assert.ok(room.canReach(from, point));
  }
  assert.equal(room.floorArea(room.nearestWalkable({ x: 63, y: 40 })), 0);
  assert.equal(room.floorArea(room.nearestWalkable(to, from)), 0, 'exit snapping keeps its serving area');
});

test('routine plans ignore seats, dispensers, and conversation partners on another area', (t) => {
  const room = areaRoom('split', true);
  room.setProps([
    { type: 'bench', asset: 'bench', x: 90, y: 0, w: 71, h: 37, flip: false },
    { type: 'vending_machine', asset: 'vending_machine', x: 100, y: 0, w: 40, h: 30, flip: false },
  ]);
  const world = new World({ rooms: [room], roster: [], now: () => new Date(2026, 0, 1, 12) });
  const agent = world.spawn(areaStaff, room, { x: 40, y: 40 });
  const partner = world.spawn({ ...areaStaff, id: 'partner' }, room, { x: 110, y: 40 });
  partner.setPlan(world, [wait(1000, 'Standing')]);
  partner.update(world, 0);
  assert.equal(world.freeSpot(room, 'bench', agent), undefined);
  assert.equal(world.findChatPartner(agent), undefined);
  assert.equal(conversationPoint(agent, partner), undefined);
  const random = t.mock.method(Math, 'random', () => 0);
  for (let i = 0; i < 100; i++) {
    random.mock.mockImplementation(() => i / 100);
    const plan = planNext(agent, world);
    assert.ok(plan.every((task) => !/bench|vending|talk/i.test(task.activity)));
    agent.setPlan(world, plan);
    agent.update(world, 0.1);
    assert.equal(room.floorArea(agent), 0);
  }
});

test('facility routing cannot use a shortcut across another room\'s floor gap', () => {
  const a = areaRoom('a', false, [['east', 120]], { east: { room: 'b', door: 'west' } });
  const b = areaRoom('b', true, [['west', 30], ['east', 120]], {
    west: { room: 'a', door: 'east' }, east: { room: 'c', door: 'west' },
  });
  const c = areaRoom('c', false, [['west', 30], ['east', 120]], { west: { room: 'b', door: 'east' } }, 1);
  const world = new World({ rooms: [a, b, c], roster: [], now: () => new Date(2026, 0, 1, 12) });
  const agent = world.spawn(areaStaff, a, { x: 50, y: 40 });
  assert.equal(doorTowardExit(world, a, true, agent), null);
  assert.equal(stepTowardWork(world, areaStaff, a, agent), undefined);
  assert.equal(doorTowardExit(world, a, true), a.doors[0], 'room-only queries retain their existing behavior');
});

test('routing may revisit a room through a door serving a different floor area', () => {
  const a = areaRoom('a', false, [['east', 30], ['north', 120]], {
    east: { room: 'b', door: 'west' }, north: { room: 'b', door: 'north' },
  });
  const b = areaRoom('b', true, [['west', 30], ['north', 110], ['east', 130]], {
    west: { room: 'a', door: 'east' }, north: { room: 'a', door: 'north' },
  });
  const world = new World({ rooms: [a, b], roster: [], now: () => new Date(2026, 0, 1, 12) });
  const agent = world.spawn(areaStaff, b, { x: 40, y: 40 });
  assert.equal(doorTowardExit(world, b, true, agent), b.doors[0]);
  assert.deepEqual(wanderDoors(world, agent), [b.doors[0]]);
});

test('unreachable walking and transport cancel explicitly instead of crossing the gap', () => {
  for (const taskOf of [
    (room) => walkTo(room.doors[1].inside),
    (room) => exitThroughDoor(room.doors[1]),
    () => rideElevatorOut(),
  ]) {
    const room = areaRoom('split', true, [['west', 30], ['east', 120]]);
    // Put the elevator on the other area to exercise transport independently of the parser.
    room.elevator = { front: { x: 120, y: 40 } };
    const world = new World({ rooms: [room], roster: [], now: () => new Date(2026, 0, 1, 12) });
    const logs = [];
    world.hooks.log = (text) => logs.push(text);
    const agent = world.spawn(areaStaff, room, { x: 30, y: 40 });
    const task = taskOf(room);
    task.start(agent, world);
    assert.equal(task.update(agent, world, 1), true);
    assert.deepEqual({ x: agent.x, y: agent.y }, { x: 30, y: 40 });
    assert.ok(logs.some((text) => text.includes('cannot reach')));
    assert.deepEqual(wanderFloors(world, agent), []);
  }
});

test('the new containment room has one isolated area served only by the south door', async () => {
  const room = new Room(await loadRoom('level-3-containment-room'));
  const south = room.doors.find((door) => door.id === 'south');
  const east = room.doors.find((door) => door.id === 'east');
  assert.ok(south && east);
  assert.ok(room.isWalkable(south.inside));
  assert.ok(room.isWalkable(east.inside));
  assert.equal(room.canReach(south.inside, east.inside), false);
  assert.deepEqual(room.doors.filter((door) => room.sameFloorArea(south.inside, door.inside)).map((door) => door.id), ['south']);
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
    assert.equal(opaque, 0, `${data.id}: the elevator painted on nav_map.png should be see-through in room.png`);
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
