import assert from 'node:assert/strict';
import test from 'node:test';
import { EventDirector } from '../src/lib/sim/events.ts';
import { exitThroughDoor, rideElevatorOut } from '../src/lib/sim/agent.ts';
import { Room } from '../src/lib/sim/room.ts';
import { checkShafts, linkRooms, loadFacility, orderRooms } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';
import { WALK_CYCLES } from '../src/lib/sim/sprites.ts';

// Minimal room folder contents: only what linking and ordering look at.
function fakeRoom(id, doors, exits = {}) {
  return {
    data: { id, level: 1, links: {}, nav: { exits: doors.map((door) => ({ id: door, kind: 'door' })) } },
    exits: new Map(Object.entries(exits).map(([door, target]) => [door, typeof target === 'string' ? { room: target } : target])),
  };
}

test('links doors both ways and comes out of the opposite door by default', () => {
  const a = fakeRoom('a', ['west', 'east'], { east: 'b' });
  const b = fakeRoom('b', ['west', 'east']);
  linkRooms([a, b]);
  assert.deepEqual(a.data.links, { east: { room: 'b', door: 'west' } });
  assert.deepEqual(b.data.links, { west: { room: 'a', door: 'east' } });
});

test('uses the only door, or the one named explicitly', () => {
  const a = fakeRoom('a', ['east'], { east: 'b' });
  const b = fakeRoom('b', ['east']);
  linkRooms([a, b]);
  assert.deepEqual(a.data.links.east, { room: 'b', door: 'east' });

  const c = fakeRoom('c', ['west-1', 'west-2'], { 'west-2': { room: 'd', door: 'east-1' } });
  const d = fakeRoom('d', ['east-1', 'east-2']);
  linkRooms([c, d]);
  assert.deepEqual(d.data.links['east-1'], { room: 'c', door: 'west-2' });
});

test('explains linking mistakes', () => {
  assert.throws(() => linkRooms([fakeRoom('a', ['west'], { east: 'b' }), fakeRoom('b', ['west'])]), /mentions door "east", but navMap.png has: west/);
  assert.throws(() => linkRooms([fakeRoom('a', ['east'], { east: 'nowhere' })]), /no such room folder/);
  assert.throws(
    () => linkRooms([fakeRoom('a', ['west-1'], { 'west-1': 'b' }), fakeRoom('b', ['east-1', 'east-2'])]),
    /unclear which of its doors \(east-1, east-2\)/,
  );
  assert.throws(
    () => linkRooms([fakeRoom('a', ['east'], { east: 'b' }), fakeRoom('b', ['west'], { west: 'c' }), fakeRoom('c', ['east'])]),
    /already leads to/,
  );
});

test('orders rooms west to east as they connect', () => {
  const rooms = [fakeRoom('a-middle', ['west', 'east'], { west: 'c-left', east: 'b-right' }), fakeRoom('b-right', ['west']), fakeRoom('c-left', ['east'])];
  linkRooms(rooms);
  assert.deepEqual(orderRooms(rooms.map((room) => room.data)).map((room) => room.id), ['c-left', 'a-middle', 'b-right']);
});

test('lays rooms out on a grid, with north up', () => {
  const rooms = [
    fakeRoom('hall', ['west', 'north', 'south']),
    fakeRoom('attic', ['south'], { south: 'hall' }),
    fakeRoom('cellar', ['north'], { north: 'hall' }),
    fakeRoom('wing', ['east'], { east: 'hall' }),
  ];
  linkRooms(rooms);
  assert.deepEqual(rooms[0].data.links, {
    north: { room: 'attic', door: 'south' },
    south: { room: 'cellar', door: 'north' },
    west: { room: 'wing', door: 'east' },
  });
  const ordered = orderRooms(rooms.map((room) => room.data));
  assert.deepEqual(Object.fromEntries(ordered.map((room) => [room.id, room.map])), {
    attic: { col: 1, row: 0 },
    wing: { col: 0, row: 1 },
    hall: { col: 1, row: 1 },
    cellar: { col: 1, row: 2 },
  });
  assert.deepEqual(ordered.map((room) => room.id), ['attic', 'wing', 'hall', 'cellar']);
});

const facility = async () => (await loadFacility()).map((data) => new Room(data));

const character = (id, behavior = {}) => ({
  id, name: id, href: `/Personnel/${id}`, tint: '#fff', scale: 1, position: 'Test', species: 'Test',
  accessLevel: '1', employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0.4, ghost: false, ...behavior },
});
const roster = Array.from({ length: 14 }, (_, i) => character(`staff-${i}`));
const noon = () => new Date(2026, 0, 1, 12);

test('loads the rooms in floor-plan order, level by level', async () => {
  const rooms = await facility();
  assert.deepEqual(rooms.map((room) => room.id), [
    'level-1-pipeRoom', 'level-1-offices', 'level-1-recRoom', 'level-2-lobby', 'level-3-checkpoint',
    'level-4-trophyRoom', 'level-4-gallery', 'level-5-sideEntry',
  ]);
  const offices = rooms[1];
  assert.deepEqual(offices.linkedDoors.map((door) => door.to.room), ['level-1-pipeRoom', 'level-1-recRoom']);
  assert.equal(offices.outerDoors.length, 0);
  assert.equal(rooms[0].outerDoors[0].id, 'west', 'the pipe room west door leads off camera');
});

test('finds the way out from rooms without an exit', async () => {
  const rooms = await facility();
  const world = new World({ roster, rooms, now: noon });
  const [pipe, offices, rec] = rooms;
  assert.equal(world.doorTowardExit(rec).to.room, offices.id, 'rec room leads to the elevator in the offices');
  assert.equal(world.doorTowardExit(offices), null, 'offices has the elevator');
  assert.equal(world.doorTowardExit(offices, true).to.room, pipe.id, 'without the elevator, run for the pipe room door');
});

test('people walk between rooms and come and go', async () => {
  const rooms = await facility();
  const world = new World({ roster, rooms, now: noon });
  world.populate();
  const visited = new Map();
  for (let t = 0; t < 900; t += 0.1) {
    world.update(0.1);
    for (const agent of world.agents) {
      if (!visited.has(agent)) visited.set(agent, new Set());
      visited.get(agent).add(agent.room.id);
      assert.ok(Number.isFinite(agent.x) && Number.isFinite(agent.y), `${agent.character.name} has a valid position`);
    }
  }
  const movers = [...visited.values()].filter((roomIds) => roomIds.size > 1).length;
  assert.ok(movers > 0, 'someone moved to another room');
  for (const room of rooms) {
    assert.ok([...visited.values()].some((roomIds) => roomIds.has(room.id)), `someone visited ${room.id}`);
  }
});

test('an unmasked impostor escapes through another room if needed', async () => {
  const rooms = await facility();
  const world = new World({ roster, rooms, now: noon });
  world.populate();
  const director = new EventDirector([{ id: 'm-779', name: 'M-779', nickname: 'Carny', href: '/Entities/m-779', weight: 1 }]);
  assert.ok(director.triggerImpostor(world));
  const impostor = world.agents.find((agent) => agent.impostor);
  for (let t = 0; t < 3 && impostor.alpha < 1; t += 0.1) world.update(0.1);

  assert.equal(world.interact(impostor), 'revealed');
  for (let t = 0; t < 120 && !impostor.removed; t += 0.1) world.update(0.1);
  assert.ok(impostor.removed, 'the impostor got away');
});

test('an elevator shaft stops at most once per level', () => {
  const stop = (id, level, shaft) => ({ id, level, shafts: { elevator: shaft } });
  assert.doesNotThrow(() => checkShafts([stop('a', 1, 'main'), stop('b', 2, 'main'), stop('c', 1, 'service')]));
  assert.throws(() => checkShafts([stop('a', 1, 'main'), stop('b', 1, 'main')]), /shaft "main" already stops on level 1 in a/);
});

test('the main elevator stops on every level', async () => {
  const rooms = await facility();
  const world = new World({ roster, rooms, now: noon });
  const offices = world.room('level-1-offices');
  const lobby = world.room('level-2-lobby');
  const stops = ['level-2-lobby', 'level-3-checkpoint', 'level-4-gallery', 'level-5-sideEntry'];
  assert.deepEqual(world.elevatorStops(offices).map((room) => room.id), stops);
  assert.ok(world.elevatorStops(lobby).some((room) => room === offices));
  assert.deepEqual(world.elevatorStops(world.room('level-1-recRoom')), []);
});

test('riding the elevator down to level 2', async () => {
  const rooms = await facility();
  // A roster of one, so nobody else arrives by elevator and changes its lights.
  const world = new World({ roster: roster.slice(0, 1), rooms, now: noon });
  const offices = world.room('level-1-offices');
  const lobby = world.room('level-2-lobby');
  const log = [];
  world.hooks.log = (text) => log.push(text);

  const agent = world.spawn(roster[0], offices, offices.randomFloorPoint());
  agent.setPlan(world, [rideElevatorOut(lobby)]);
  const lights = { offices: new Set(), lobby: new Set() };
  let rode = false;
  for (let t = 0; t < 60 && !(agent.room === lobby && agent.layer === 'room' && !world.isRiding(agent)); t += 0.1) {
    world.update(0.1);
    lights.offices.add(world.elevatorFor(offices).light);
    lights.lobby.add(world.elevatorFor(lobby).light);
    if (world.isRiding(agent)) {
      rode = true;
      assert.ok(world.isPresent(agent.character.id), 'riders still count as present');
      assert.ok(!world.agentsIn(offices).includes(agent) && !world.agentsIn(lobby).includes(agent), 'riders are on no camera');
    }
  }

  assert.ok(rode, 'the agent spent time inside the moving car');
  assert.equal(agent.room, lobby);
  assert.equal(agent.layer, 'room');
  assert.ok(lights.offices.has('down') && !lights.offices.has('up'), 'level 2 is down from level 1');
  assert.ok(lights.lobby.has('down'), 'the car arrives at level 2 going down');
  assert.ok(log.some((line) => line.includes('from Level 1 to Level 2')));
});

test('walking through the gallery north door into the trophy room and back', async () => {
  const rooms = await facility();
  const world = new World({ roster: roster.slice(0, 1), rooms, now: noon });
  const gallery = world.room('level-4-gallery');
  const trophy = world.room('level-4-trophyRoom');
  const north = gallery.doors.find((door) => door.id === 'north');
  const south = trophy.doors.find((door) => door.id === 'south');
  assert.deepEqual(north.to, { room: trophy.id, door: 'south' });
  assert.ok(north.outside.y < north.inside.y, 'the north door is walked into, away from the camera');
  assert.ok(south.outside.y > trophy.height, 'the south door is walked out of the picture');

  const agent = world.spawn(roster[0], gallery, gallery.randomFloorPoint());
  agent.setPlan(world, [exitThroughDoor(north)]);
  const poses = new Set();
  for (let t = 0; t < 40 && agent.room !== trophy; t += 0.1) {
    world.update(0.1);
    if (agent.alpha < 1 && agent.room === gallery) poses.add(agent.frame.name);
  }
  assert.equal(agent.room, trophy);
  assert.ok(poses.size > 1, 'animates while stepping through');
  assert.ok([...poses].every((pose) => WALK_CYCLES.back.includes(pose)), 'walks away from the camera while stepping through');

  for (let t = 0; t < 5 && agent.alpha < 1; t += 0.1) world.update(0.1);
  assert.equal(agent.alpha, 1);
  assert.ok(trophy.isWalkable(agent), 'came in through the south edge onto the floor');

  agent.setPlan(world, [exitThroughDoor(south)]);
  for (let t = 0; t < 40 && agent.room !== gallery; t += 0.1) world.update(0.1);
  assert.equal(agent.room, gallery, 'and back through the same doors');
});
