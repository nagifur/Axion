import assert from 'node:assert/strict';
import test from 'node:test';
import { EventDirector } from '../src/lib/sim/events.ts';
import { exitThroughDoor, leaveFacility, planNext, rideElevatorOut } from '../src/lib/sim/agent.ts';
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
  accessLevel: '5', employeeID: id, traits: [], weight: 1,
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

test('population and arrivals stay within clearance, including ghosts', async (t) => {
  const rooms = await facility();
  const staff = Array.from({ length: 14 }, (_, i) => ({ ...character(`limited-${i}`), accessLevel: '3' }));
  const world = new World({ roster: staff, rooms, now: noon });
  t.mock.method(Math, 'random', () => 0.99);
  world.populate();
  assert.ok(world.agents.length > 0);
  assert.ok(world.agents.every((agent) => agent.room.level <= 3));

  const doorArrival = world.arrive(staff[0]);
  assert.ok(doorArrival.room.level <= 3);
  assert.equal(doorArrival.alpha, 0, 'arrives through a door');

  Math.random.mock.mockImplementation(() => 0);
  const elevatorArrival = world.arrive(staff[0]);
  assert.ok(elevatorArrival.room.level <= 3);
  assert.equal(elevatorArrival.layer, 'inside');

  const ghost = { ...staff[0], behavior: { ...staff[0].behavior, ghost: true } };
  const wallArrival = world.arrive(ghost);
  assert.ok(wallArrival.room.level <= 3);
  assert.equal(wallArrival.alpha, 0, 'ghost phases through a wall');

  const isolated = new World({ roster: staff, rooms: [world.room('level-1-recRoom')], now: noon });
  assert.equal(isolated.arrive(staff[0]).room.level, 1, 'no-entrance fallback stays within clearance');

  Math.random.mock.mockImplementation(() => 0.99);
  const impostor = world.arrive(staff[0], { id: 'fake', name: 'Fake', nickname: '', href: '', weight: 1 });
  assert.equal(impostor.room.level, 5, 'impostors ignore their disguise clearance');
});

test('reports when no room is within clearance instead of spawning on a restricted floor', async () => {
  const rooms = (await facility()).filter((room) => room.level > 3);
  const staff = { ...character('limited'), accessLevel: '3' };
  const world = new World({ roster: [staff], rooms, now: noon });
  const warnings = [];
  world.hooks.log = (text, tone) => warnings.push({ text, tone });
  world.populate();
  assert.equal(world.arrive(staff), undefined);
  assert.equal(world.agents.length, 0);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(({ text, tone }) => tone === 'warn' && text.includes('clearance')));
});

test('voluntary door and elevator plans respect clearance, but impostors do not', async (t) => {
  const rooms = await facility();
  const world = new World({ roster: [], rooms, now: noon });
  const offices = world.room('level-1-offices');
  const gallery = world.room('level-4-gallery');
  offices.doors.push({ ...offices.linkedDoors[0], id: 'restricted', to: { room: gallery.id, door: 'north' } });
  const agent = world.spawn({ ...character('limited'), accessLevel: '3' }, offices, offices.randomFloorPoint());
  world.time = agent.arrivedAt = 30;
  t.mock.method(world, 'freeSpot', () => undefined);
  t.mock.method(world, 'findChatPartner', () => undefined);
  t.mock.method(offices, 'route', () => []);
  const destinations = [];
  t.mock.method(world.elevatorFor(offices), 'request', (_type, _agent, options) => {
    destinations.push(options.destination.level);
    return { board: false };
  });
  const random = t.mock.method(Math, 'random', () => 0);
  for (const choice of [0, 0.5, 0.99]) {
    let calls = 0;
    random.mock.mockImplementation(() => calls++ === 0 ? 0.99 : choice);
    const [elevator] = planNext(agent, world);
    assert.equal(elevator.activity, 'Heading to the elevator');
    elevator.start(agent, world);
    elevator.update(agent, world, 0.1);

    calls = 0;
    random.mock.mockImplementation(() => calls++ === 0 ? 0.8 : choice);
    const [door] = planNext(agent, world);
    const allowed = offices.linkedDoors.filter((door) => world.room(door.to.room).level <= 3);
    assert.ok(allowed.some((exit) => door.activity === `Heading to the ${world.room(exit.to.room).name}`), door.activity);
  }
  assert.ok(destinations.every((level) => level <= 3));
  assert.ok(destinations.includes(3), 'own-clearance floor is available');
  assert.ok(destinations.some((level) => level < 3), 'lower floors are available');

  const impostor = world.spawn(agent.character, offices, agent, { id: 'fake', name: 'Fake', nickname: '', href: '', weight: 1 });
  impostor.arrivedAt = 30;
  impostor.enteredRoomAt = 0;
  random.mock.mockImplementation(() => 0.99);
  const [elevator] = planNext(impostor, world);
  elevator.start(impostor, world);
  elevator.update(impostor, world, 0.1);
  assert.equal(destinations.at(-1), 5);
  let calls = 0;
  random.mock.mockImplementation(() => calls++ === 0 ? 0.8 : 0.99);
  assert.equal(planNext(impostor, world)[0].activity, `Heading to the ${gallery.name}`);
});

test('clearance preferences do not block escape routes', async () => {
  const rooms = await facility();
  const world = new World({ roster: [], rooms, now: noon });
  const trophy = world.room('level-4-trophyRoom');
  const gallery = world.room('level-4-gallery');
  const agent = world.spawn({ ...character('limited'), accessLevel: '3' }, trophy, trophy.randomFloorPoint());
  assert.equal(leaveFacility(agent, world, true)[0].activity, `Heading to the ${gallery.name}`);
  assert.equal(agent.leaving, true);
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
