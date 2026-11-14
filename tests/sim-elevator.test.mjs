import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Room } from '../src/lib/sim/room.ts';
import { loadFacility, loadRoom } from '../src/lib/sim/roomLoader.ts';
import { Elevator, World } from '../src/lib/sim/world.ts';
import { rideElevatorOut } from '../src/lib/sim/agent.ts';

const staff = (id) => ({
  id, name: id, href: '/', tint: '#fff', scale: 1, accessLevel: 'Admin',
  traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});

test('main entrance uses the large car and links to the lookout', async () => {
  const rooms = (await loadFacility()).map((data) => new Room(data));
  const world = new World({ rooms, roster: [] });
  const entrance = world.room('level-0-mainEntrance');
  const lookout = world.room('level-0-Lookout');
  assert.equal(entrance.elevator.shaft, 'big');
  assert.equal(entrance.elevator.big, true);
  assert.equal(world.elevatorFor(entrance).capacity, 10);
  assert.equal(world.elevatorFor(lookout).capacity, 1);
  assert.deepEqual(world.elevatorStops(entrance), []);
  assert.equal(entrance.doors.find((door) => door.id === 'east-2').to.room, lookout.id);
  assert.equal(lookout.doors.find((door) => door.id === 'west').to.room, entrance.id);
});

test('elevator configuration validates shaft, size and nav opening', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'axion-elevator-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'rooms', 'test');
  await mkdir(folder, { recursive: true });
  for (const image of ['room.png', 'navMap.png']) {
    await copyFile(`src/sim_assets/rooms/level-0-mainEntrance/${image}`, path.join(folder, image));
  }
  const load = async (elevators) => {
    await writeFile(path.join(folder, 'room.json'), JSON.stringify({ name: 'Test', level: 0, camera: 'Test', elevators }));
    return loadRoom('test', dir);
  };
  assert.deepEqual((await load({ shaft: 'service', big: true })).elevator, { shaft: 'service', big: true });
  assert.deepEqual((await load({ shaft: 'service' })).elevator, { shaft: 'service', big: false });
  assert.deepEqual((await load({ big: true })).elevator, { shaft: undefined, big: true });
  assert.equal((await load(undefined)).elevator, undefined);
  await assert.rejects(load({ elevator: 'service' }), /use "shaft"/);
  await assert.rejects(load({ shaft: ' ' }), /non-empty name/);
  await assert.rejects(load({ shaft: 10 }), /non-empty name/);
  await assert.rejects(load({ big: 'true' }), /must be true or false/);
  await assert.rejects(load([]), /should look like/);
  for (const image of ['room.png', 'navMap.png']) {
    await copyFile(`src/sim_assets/rooms/level-1-recRoom/${image}`, path.join(folder, image));
  }
  await assert.rejects(load({ shaft: 'service' }), /no elevator/);
});

const fakeAgent = (room) => ({ room, removed: false });
const tickUntil = (elevator, world, predicate) => {
  for (let step = 0; step < 500 && !predicate(); step++) elevator.update(world, 0.1);
  assert.ok(predicate(), `elevator did not reach expected state (phase: ${elevator.phase})`);
};

test('a large car admits ten compatible riders, waits for all, and leaves the eleventh queued', async () => {
  const room = new Room(await loadRoom('level-0-mainEntrance'));
  const elevator = new Elevator(10);
  const departed = [];
  const world = { elevatorDeparted(agent) { departed.push(agent); } };
  const requests = Array.from({ length: 11 }, () => elevator.request('depart', fakeAgent(room), { direction: 'down' }));
  tickUntil(elevator, world, () => elevator.phase === 'holding');
  assert.equal(requests.filter((request) => request.board).length, 10);
  assert.equal(new Set(requests.slice(0, 10).map((request) => JSON.stringify(request.inside))).size, 10);
  for (const request of requests.slice(0, 9)) request.ready = true;
  elevator.update(world, 0.1);
  assert.equal(elevator.phase, 'holding');
  requests[9].ready = true;
  tickUntil(elevator, world, () => departed.length === 10);
  assert.deepEqual(departed, requests.slice(0, 10).map((request) => request.agent));
  assert.equal(requests[10].board, false);
  tickUntil(elevator, world, () => requests[10].board);
});

test('riders can join an opening car, but different trips wait', async () => {
  const room = new Room(await loadRoom('level-0-mainEntrance'));
  const elevator = new Elevator(10);
  const destination = {};
  const first = elevator.request('depart', fakeAgent(room), { direction: 'down', destination });
  tickUntil(elevator, {}, () => elevator.phase === 'opening');
  const opposite = elevator.request('depart', fakeAgent(room), { direction: 'up', destination });
  const elsewhere = elevator.request('depart', fakeAgent(room), { direction: 'down', destination: {} });
  const arrival = elevator.request('arrive', fakeAgent(room), { direction: 'down', destination });
  const second = elevator.request('depart', fakeAgent(room), { direction: 'down', destination });
  tickUntil(elevator, {}, () => first.board);
  assert.equal(second.board, true);
  for (const request of [opposite, elsewhere, arrival]) assert.equal(request.board, false);
  const third = elevator.request('depart', fakeAgent(room), { direction: 'down', destination });
  elevator.update({}, 0.1);
  assert.equal(third.board, true, 'a compatible rider can also join while doors are held open');
});

test('cancelled and removed riders neither block nor ride the large car', async () => {
  const room = new Room(await loadRoom('level-0-mainEntrance'));
  const elevator = new Elevator(10);
  const departed = [];
  const world = { elevatorDeparted(agent) { departed.push(agent); } };
  const cancelled = elevator.request('depart', fakeAgent(room), { direction: 'down' });
  cancelled.cancelled = true;
  const requests = Array.from({ length: 3 }, () => elevator.request('depart', fakeAgent(room), { direction: 'down' }));
  tickUntil(elevator, world, () => requests[0].board);
  requests[0].cancelled = true;
  requests[1].agent.removed = true;
  requests[2].ready = true;
  tickUntil(elevator, world, () => departed.length === 1);
  assert.deepEqual(departed, [requests[2].agent]);
  assert.equal(cancelled.board, false);
});

test('standard cars still admit one rider per trip', () => {
  const elevator = new Elevator();
  const first = elevator.request('depart', fakeAgent({}), { direction: 'down' });
  const second = elevator.request('depart', fakeAgent({}), { direction: 'down' });
  tickUntil(elevator, {}, () => first.board);
  assert.equal(second.board, false);
  assert.equal(first.inside, undefined);
});

test('large cars unload ten arrivals together and retain the arrival safety timeout', async () => {
  const room = new Room(await loadRoom('level-0-mainEntrance'));
  const elevator = new Elevator(10);
  const requests = Array.from({ length: 10 }, () => elevator.request('arrive', fakeAgent(room), { direction: 'up' }));
  tickUntil(elevator, {}, () => requests.every((request) => request.board));
  for (const request of requests) {
    assert.equal(request.agent.x, request.inside.x);
    assert.equal(request.agent.y, request.inside.y);
  }
  tickUntil(elevator, {}, () => elevator.phase === 'idle');
  assert.equal(elevator.open, 0);
});

test('ten people actually walk into the main entrance car and depart together', async () => {
  const room = new Room(await loadRoom('level-0-mainEntrance'));
  const world = new World({ rooms: [room], roster: [] });
  const agents = Array.from({ length: 10 }, (_, index) => {
    const agent = world.spawn(staff(`rider-${index}`), room, room.elevator.front);
    agent.setPlan(world, [rideElevatorOut()]);
    return agent;
  });
  // Give all off-camera requests the same direction without changing other randomness.
  const elevator = world.elevatorFor(room);
  const request = elevator.request.bind(elevator);
  elevator.request = (type, agent, options) => request(type, agent, { ...options, direction: 'down' });
  let maximumInside = 0;
  const departures = [];
  world.hooks.removed = () => departures.push(world.time);
  for (let step = 0; step < 1000 && agents.some((agent) => !agent.removed); step++) {
    world.update(0.1);
    maximumInside = Math.max(maximumInside, agents.filter((agent) => !agent.removed && agent.layer === 'inside').length);
  }
  assert.equal(maximumInside, 10);
  assert.equal(departures.length, 10);
  assert.equal(new Set(departures).size, 1, 'everyone leaves on the same trip');
});
