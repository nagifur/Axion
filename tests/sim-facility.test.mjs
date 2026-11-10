import assert from 'node:assert/strict';
import test from 'node:test';
import { EventDirector } from '../src/lib/sim/events.ts';
import { Room } from '../src/lib/sim/room.ts';
import { linkRooms, loadFacility, orderRooms } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';

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

const facility = async () => (await loadFacility()).map((data) => new Room(data));

const character = (id, behavior = {}) => ({
  id, name: id, href: `/Personnel/${id}`, tint: '#fff', scale: 1, position: 'Test', species: 'Test',
  accessLevel: '1', employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0.4, ghost: false, ...behavior },
});
const roster = Array.from({ length: 14 }, (_, i) => character(`staff-${i}`));
const noon = () => new Date(2026, 0, 1, 12);

test('loads the Level 1 rooms in floor-plan order', async () => {
  const rooms = await facility();
  assert.deepEqual(rooms.map((room) => room.id), ['level-1-pipeRoom', 'level-1-offices', 'level-1-recRoom']);
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
