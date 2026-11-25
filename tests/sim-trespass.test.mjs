import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { setRandomSource } from '../src/lib/sim/random.ts';
import { toSimCharacter } from '../src/lib/sim/roster.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadFacility } from '../src/lib/sim/roomLoader.ts';
import { wait } from '../src/lib/sim/tasks.ts';
import { reactToTrespassing } from '../src/lib/sim/trespass.ts';
import { VORE_TUNING } from '../src/lib/sim/vore.ts';
import { World } from '../src/lib/sim/world.ts';

afterEach(() => setRandomSource(null));

function room(id, level, shaft, cell = false) {
  const exits = shaft ? [{
    id: 'elevator', kind: 'elevator', bounds: { x: 100, y: 15, w: 40, h: 40 },
    threshold: { x: 120, y: 67 }, base: { x: 120, y: 55 },
  }] : [];
  return new Room({
    id, name: id, camera: id, level, width: 240, height: 160,
    nav: { floor: Array.from({ length: 160 }, () => [0, 240]), exits },
    props: [], links: {}, ...(shaft ? { elevator: { shaft, big: false } } : {}), ...(cell ? { containmentCell: true } : {}),
  });
}

function connect(from, to) {
  from.doors.push({
    id: 'to-lift', side: 'east', inside: { x: 210, y: 100 }, outside: { x: 236, y: 100 },
    to: { room: to.id, door: 'from-hall' },
  });
  to.doors.push({
    id: 'from-hall', side: 'west', inside: { x: 30, y: 100 }, outside: { x: 4, y: 100 },
    to: { room: from.id, door: 'to-lift' },
  });
}

function person(id, { height = '1.7 m', clearance = 3, role = 'None' } = {}) {
  return toSimCharacter({ id, data: {
    title: id, position: id === 'reef' ? 'Head of Security' : 'Researcher', species: 'Human',
    height, accessLevel: clearance, employeeID: id, positiveTraits: [], negativeTraits: [], vorePreference: [role],
  } });
}

function standing(world, room, character, point) {
  const agent = world.spawn(character, room, point);
  agent.setPlan(world, [wait(600, 'Standing')]);
  return agent;
}

function setup({ height = '1.7 m', role = 'None', clearance = 3, witness = false } = {}) {
  setRandomSource(() => 0.99);
  const hall = room('restricted hall', 5);
  const upper = room('upper lift', 5, 'staff');
  const nearest = room('nearest lift', 3, 'staff');
  const farther = room('farther lift', 1, 'staff');
  connect(hall, upper);
  const world = new World({ rooms: [hall, upper, nearest, farther], roster: [] });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text, tone) => logs.push({ text, tone });
  const reef = standing(world, hall, person('reef', { height: '3.07 m', clearance: 5, role: 'Predator' }), { x: 80, y: 100 });
  const target = standing(world, hall, person('target', { height, clearance, role }), { x: 170, y: 100 });
  if (witness) {
    const guard = standing(world, hall, person('guard', { clearance: 5 }), { x: 140, y: 120 });
    guard.security = { post: hall, relieved: false };
  }
  return { world, hall, upper, nearest, farther, reef, target, logs };
}

function until(world, predicate, limit = 2500) {
  for (let i = 0; i < limit && !predicate(); i++) world.update(0.1);
  assert.ok(predicate(), 'the expected escort transition did not happen');
}

test('Reef may swallow trespassers regardless of role and witnesses, but not someone larger', () => {
  const { world, hall, reef, target } = setup({ witness: true });
  assert.equal(world.vore.eligible(reef, target), true, 'Non-Vore and the guard do not prevent enforcement');
  target.character.heightMeters = 3.07;
  assert.equal(world.vore.eligible(reef, target), true, 'someone the same size is not larger');
  target.character.heightMeters = 3.08;
  assert.equal(world.vore.eligible(reef, target), false);
  target.character.heightMeters = 1.7;
  target.character.accessLevel = '5';
  assert.equal(world.vore.eligible(reef, target), false, 'authorized staff are teammates');
  target.character.accessLevel = '3';
  const impostor = world.spawn(reef.character, hall, { x: 60, y: 100 }, {
    id: 'impostor', name: 'Impostor', nickname: 'I', href: '', weight: 1, stats: reef.character.stats,
  });
  assert.equal(world.vore.eligible(impostor, target), false, 'a disguised Reef does not get his exception');
  assert.equal(world.vore.swallow(reef, target, 'oral'), true);
});

test('Reef chooses vore 10% of the time and otherwise escorts; larger targets are always escorted', (t) => {
  const { world, reef, target } = setup({ witness: true });
  let hunts = 0;
  for (let i = 0; i < 100; i++) {
    reef.setPlan(world, [wait(600, 'Standing')]);
    setRandomSource(() => (i + 0.5) / 100);
    reactToTrespassing(reef, world);
    reef.update(world, 0);
    if (reef.activity === 'Stalking target') hunts++;
    else assert.equal(reef.activity, 'Approaching target for an escort');
  }
  assert.equal(hunts, 10);

  target.character.heightMeters = 3.08;
  reef.setPlan(world, [wait(600, 'Standing')]);
  setRandomSource(() => 0);
  reactToTrespassing(reef, world);
  reef.update(world, 0);
  assert.equal(reef.activity, 'Approaching target for an escort');

  target.character.heightMeters = 1;
  target.character.vore.role = 'prey';
  const oldRate = VORE_TUNING.huntRate.predator;
  t.after(() => { VORE_TUNING.huntRate.predator = oldRate; });
  VORE_TUNING.huntRate.predator = 1000;
  reef.setPlan(world, [wait(600, 'Standing')]);
  setRandomSource(() => 0.5);
  world.update(0.1);
  assert.equal(reef.activity, 'Approaching target for an escort', 'ordinary hunting must not bypass his choice');
});

test('Reef ignores authorized staff and cannot see trespassers on another camera', () => {
  const { world, upper, reef, target } = setup();
  target.character.accessLevel = '5';
  world.update(0.1);
  assert.equal(reef.activity, 'Standing');
  target.character.accessLevel = '3';
  target.room = upper;
  world.update(0.1);
  assert.equal(reef.activity, 'Standing');
});

test('Reef follows through on the vore response even with a witness and a Non-Vore trespasser', () => {
  const { world, reef, target } = setup({ witness: true });
  setRandomSource(() => 0);
  until(world, () => target.swallowed);
  assert.equal(target.vore.inside.predator, reef);
});

test('Reef escorts a larger trespasser even when the vore roll would otherwise succeed', () => {
  const { world, nearest, target } = setup({ height: '4 m', role: 'Prey' });
  setRandomSource(() => 0);
  until(world, () => !!target.staffEscort);
  assert.equal(target.swallowed, false);
  until(world, () => !target.staffEscort && target.room === nearest);
});

test('Reef escorts a trespasser through a doorway and a single-person elevator to the nearest allowed floor', () => {
  const { world, hall, upper, nearest, reef, target, logs } = setup();
  const departures = [];
  const depart = world.elevatorDeparted.bind(world);
  world.elevatorDeparted = (agent, destination) => {
    if (agent === reef || agent === target) departures.push({ agent, time: world.time });
    depart(agent, destination);
  };
  until(world, () => !!target.staffEscort);
  assert.equal(target.staffEscort.leader, reef);
  assert.equal(target.activity, 'Being escorted to Level 3');
  assert.equal(reef.draggable, false);
  assert.equal(target.draggable, false);

  let crossedFading = false;
  until(world, () => {
    if (target.alpha < 1) crossedFading = true;
    return reef.room === upper && target.room === upper;
  });
  assert.notEqual(target.room, hall);
  assert.ok(crossedFading, 'the escorted person follows the doorway fade');
  until(world, () => departures.length === 2);
  assert.deepEqual(new Set(departures.map(({ agent }) => agent)), new Set([reef, target]));
  assert.notEqual(departures[0].time, departures[1].time, 'a one-person car takes separate trips');
  assert.ok(world.everyone().includes(reef) && world.everyone().includes(target));
  until(world, () => !target.staffEscort && target.room === nearest);
  assert.equal(target.room.level, 3);
  assert.equal(reef.room, nearest);
  assert.equal(target.alpha, 1);
  assert.equal(target.layer, 'room');
  assert.equal(target.swallowed, false);
  assert.ok(logs.some(({ text, tone }) => text === 'reef escorted target to Level 3.' && tone === 'ok'));
});

test('a blocked route keeps the escort together and resumes when the lift is connected', () => {
  const { world, nearest, farther, reef, target, logs } = setup();
  nearest.elevator.shaft = 'disconnected';
  farther.elevator.shaft = 'disconnected';
  until(world, () => !!target.staffEscort);
  until(world, () => logs.some(({ text }) => text.includes('waiting for a route')));
  const roomBefore = reef.room;
  for (let i = 0; i < 30; i++) world.update(0.1);
  assert.equal(reef.room, roomBefore);
  assert.equal(target.room, roomBefore);
  assert.equal(logs.filter(({ text }) => text.includes('waiting for a route')).length, 1);
  nearest.elevator.shaft = 'staff';
  until(world, () => !target.staffEscort && target.room === nearest);
});

test('Reef uses the next-nearest permitted floor when the closest one is unreachable', () => {
  const { world, nearest, farther, target } = setup();
  nearest.elevator.shaft = 'disconnected';
  until(world, () => !!target.staffEscort);
  assert.equal(target.staffEscort.destination, farther);
  until(world, () => !target.staffEscort && target.room === farther);
});

test('Reef finishes an escort outside a cell even when the route crosses one on the allowed floor', () => {
  setRandomSource(() => 0.99);
  const hall = room('restricted hall', 5);
  const cell = room('cell', 3, undefined, true);
  const safe = room('safe room', 3);
  connect(hall, cell);
  connect(cell, safe);
  const world = new World({ rooms: [hall, cell, safe], roster: [] });
  world.arrive = () => undefined;
  const reef = standing(world, hall, person('reef', { height: '3.07 m', clearance: 5, role: 'Predator' }), { x: 80, y: 100 });
  const target = standing(world, hall, person('target'), { x: 90, y: 100 });
  until(world, () => target.room === cell);
  assert.equal(target.staffEscort.leader, reef);
  until(world, () => !target.staffEscort && target.room === safe);
});

test('Reef reports when no floor is within the trespasser clearance', () => {
  const { world, target, logs } = setup({ clearance: 0 });
  until(world, () => logs.some(({ text }) => text.includes('no floor is within their clearance')));
  assert.equal(target.staffEscort, undefined);
  assert.equal(target.swallowed, false);
});

test('a failed elevator approach waits before retrying and does not strand the escort', (t) => {
  const { world, upper, nearest, target, logs } = setup();
  const route = upper.route.bind(upper);
  let blocked = true;
  t.mock.method(upper, 'route', (from, to, ghost) => blocked && from === target ? null : route(from, to, ghost));
  until(world, () => logs.some(({ text }) => text === 'target cannot reach the elevator in upper lift.'));
  for (let i = 0; i < 10; i++) world.update(0.1);
  assert.equal(logs.filter(({ text }) => text === 'target cannot reach the elevator in upper lift.').length, 1);
  assert.ok(target.staffEscort);
  blocked = false;
  until(world, () => !target.staffEscort && target.room === nearest);
});

test('Reef escorts someone between real facility floors', async () => {
  setRandomSource(() => 0.99);
  const rooms = (await loadFacility()).map((data) => new Room(data));
  const world = new World({ rooms, roster: [] });
  world.arrive = () => undefined;
  const upper = world.room('level-5-side-entry');
  const nearest = world.room('level-4-gallery');
  const reef = standing(world, upper, person('reef', { height: '3.07 m', clearance: 5, role: 'Predator' }), upper.elevator.front);
  const at = upper.nearestWalkable({ x: reef.x + 10, y: reef.y }, reef);
  const target = standing(world, upper, person('target', { clearance: 4 }), at);
  until(world, () => !!target.staffEscort);
  until(world, () => !target.staffEscort && target.room === nearest, 5000);
  assert.equal(reef.room, nearest);
  assert.equal(target.swallowed, false);
});

test('an escort ends safely if Reef dies, including during an elevator ride', () => {
  let scene = setup();
  until(scene.world, () => !!scene.target.staffEscort);
  scene.reef.statuses.apply('dead');
  scene.world.update(0.1);
  assert.equal(scene.target.staffEscort, undefined);
  assert.equal(scene.target.alpha, 1);
  assert.equal(scene.target.layer, 'room');
  assert.equal(scene.target.room, scene.hall);

  scene = setup();
  until(scene.world, () => !!scene.target.staffEscort);
  scene.world.remove(scene.reef, 'door');
  assert.equal(scene.target.staffEscort, undefined);
  assert.equal(scene.target.room, scene.hall);

  scene = setup();
  until(scene.world, () => scene.world.isRiding(scene.reef) && scene.world.isRiding(scene.target));
  scene.reef.statuses.apply('dead');
  scene.world.update(0.1);
  assert.equal(scene.target.staffEscort, undefined);
  assert.equal(scene.world.isRiding(scene.target), true);
  until(scene.world, () => !scene.world.isRiding(scene.target) && scene.target.exposed);
  assert.equal(scene.target.room, scene.nearest);
});
