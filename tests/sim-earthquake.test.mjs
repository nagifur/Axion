import assert from 'node:assert/strict';
import test from 'node:test';
import { EARTHQUAKE } from '../src/lib/sim/earthquake.ts';
import { MAX_PARTICLES } from '../src/lib/sim/particles.ts';
import { Room } from '../src/lib/sim/room.ts';
import { trip, wait } from '../src/lib/sim/tasks.ts';
import { World } from '../src/lib/sim/world.ts';

const character = (id) => ({
  id, name: id, scale: 1, accessLevel: '5', species: 'Human',
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});
const placed = (type) => ({
  type, asset: type, x: 140, y: 70, w: 20, h: 20, flip: false,
  ...(type === 'glass' ? { brokenLook: true } : {}),
});
const room = (id, level, to) => new Room({
  id, name: id, level, camera: id, width: 200, height: 160,
  nav: {
    floor: Array.from({ length: 160 }, (_, y) => y >= 100 ? [0, 200] : []),
    exits: [{
      id: 'east', kind: 'door', side: 'east', bounds: { x: 170, y: 0, w: 26, h: 96 },
      threshold: { x: 175, y: 120 }, base: { x: 185, y: 120 },
    }],
  },
  doors: { east: { clearance: 2 } },
  links: to ? { east: { room: to, door: 'east' } } : {},
  props: [placed('table'), placed('glass'), placed('plant')],
});
const setup = () => {
  const a = room('a', 0, 'b');
  const b = room('b', 0, 'a');
  const other = room('other', 2);
  const world = new World({ rooms: [a, b, other], roster: [] });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text) => logs.push(text);
  return { world, a, b, other, logs, door: world.passageDoorFor(a.doors[0]) };
};
const spawn = (world, current, id) => {
  const agent = world.spawn(character(id), current, { x: 60, y: 120 });
  agent.setPlan(world, [wait(1000, 'Waiting')]);
  agent.update(world, 0);
  return agent;
};
const rocks = (world) => world.particles.particles.filter((particle) => particle.asset.startsWith('particle:rock_'));

test('earthquake spans all floors, pauses, expires, and retains damage without leaking into another world', (t) => {
  const { world, a, b, other, logs, door } = setup();
  const fresh = setup().world;
  t.mock.method(Math, 'random', () => 0);
  assert.equal(world.events.startEvent('earthquake'), true);
  assert.equal(world.events.startEvent('earthquake'), false);
  assert.deepEqual(world.events.activeAlerts, [{ id: 'earthquake', text: 'Earthquake', priority: 80 }]);
  assert.equal(fresh.events.hasEvent('earthquake'), false);
  assert.equal(world.level(0).hasEvent('earthquake'), false);
  world.update(0);
  assert.equal(rocks(world).length, 0, 'paused events have no effects');
  assert.equal(a.props[0].broken, false);
  world.update(0.1);
  for (const current of [a, b, other]) {
    assert.equal(current.props[0].broken, true);
    assert.equal(current.props[1].broken, true);
    assert.equal(current.props[2].broken, false, 'non-breakable decoration survives');
    assert.ok(rocks(world).some((particle) => particle.room === current), 'off-camera rooms emit rocks');
    assert.ok(world.particles.in(current).some((particle) => particle.asset.startsWith('particle:glass_')),
      'breakage still emits the normal debris');
  }
  assert.equal(door.forcedOpen, true);
  const shake = world.events.cameraShake;
  assert.notDeepEqual(shake, { x: 0, y: 0 });
  assert.ok(Math.abs(shake.x) <= EARTHQUAKE.cameraShake.amplitude);
  assert.ok(Math.abs(shake.y) <= EARTHQUAKE.cameraShake.amplitude);
  world.update(0);
  assert.deepEqual(world.events.cameraShake, shake, 'pause freezes the display offset');
  world.update(EARTHQUAKE.duration - 0.1);
  assert.equal(world.events.hasEvent('earthquake'), false);
  assert.equal(door.forcedOpen, false);
  assert.equal(a.props[0].broken, true, 'ending does not repair damage');
  assert.deepEqual(world.events.cameraShake, { x: 0, y: 0 });
  assert.equal(logs.filter((text) => text.includes('earthquake ended')).length, 1);
  assert.equal(world.events.stopEvent('earthquake'), false);
  assert.equal(world.events.startEvent('earthquake', 1), true, 'restart creates a fresh lifecycle');
  world.update(1);
  assert.equal(logs.filter((text) => text.includes('earthquake ended')).length, 2);
});

test('earthquake repeatedly trips standing agents and impostors, but not unavailable agents', (t) => {
  const { world, a, other } = setup();
  const standing = spawn(world, a, 'standing');
  const offCamera = spawn(world, other, 'off-camera');
  const impostor = spawn(world, a, 'impostor');
  impostor.impostor = { ...character('entity'), stats: {} };
  const held = spawn(world, a, 'held');
  held.held = true;
  const ghost = spawn(world, a, 'ghost');
  ghost.character.behavior.ghost = true;
  const asleep = spawn(world, a, 'asleep');
  asleep.statuses.apply('napping', 100);
  asleep.update(world, 0);
  const seated = spawn(world, a, 'seated');
  seated.setPlan(world, [{ ...wait(100, 'Seated'), sitting: true }]);
  seated.update(world, 0);
  const recovering = spawn(world, a, 'recovering');
  recovering.interrupt(world, trip());
  const originalPlan = recovering.plan.length;
  t.mock.method(Math, 'random', () => 0);
  world.events.startEvent('earthquake');
  world.update(0.1);
  for (const agent of [standing, offCamera, impostor]) assert.equal(agent.tripping, true);
  for (const agent of [held, ghost, asleep, seated]) assert.equal(agent.tripping, false);
  assert.equal(recovering.plan.length, originalPlan, 'no stacked trip interrupts');
  world.events.stopEvent('earthquake');
  world.update(1.3);
  assert.equal(standing.tripping, false);
  world.events.startEvent('earthquake');
  world.update(0.1);
  assert.equal(standing.tripping, true, 'recovered agents can trip again');
});

test('trip probability matches the configured rate and scales with frame length', (t) => {
  const { world, a } = setup();
  for (const current of world.rooms) current.setProps([]);
  const agent = spawn(world, a, 'staff');
  let roll = 0;
  t.mock.method(Math, 'random', () => roll);
  world.events.startEvent('earthquake', 10000);
  for (const dt of [0.01, 0.1, 0.5]) {
    let trips = 0;
    for (let i = 0; i < 1000; i++) {
      roll = (i + 0.5) / 1000;
      agent.setPlan(world, [wait(1000, 'Waiting')]);
      agent.update(world, 0);
      world.update(dt);
      if (agent.tripping) trips++;
    }
    const expected = 1000 * (1 - Math.exp(-EARTHQUAKE.tripRate * dt));
    assert.ok(Math.abs(trips - expected) < 1, `${dt}s: ${trips} trips, expected ${expected}`);
  }
});

test('linked doors roll once, open through a blackout, and release without cancelling other owners', (t) => {
  const { world, a, b, door } = setup();
  for (const current of world.rooms) current.setProps([]);
  assert.equal(world.passageDoorFor(b.doors[0]), door);
  const random = t.mock.method(Math, 'random', () => 0.99);
  world.events.startEvent('earthquake');
  world.update(0.1);
  const doorProbability = -Math.expm1(-EARTHQUAKE.doorOpenRate * 0.1);
  // After the initial debris bursts, their delays prevent additional random sampling.
  random.mock.resetCalls();
  world.update(0.1);
  assert.equal(random.mock.callCount(), 2, 'one roll for the shared door, one for the other floor');
  random.mock.restore();
  t.mock.method(Math, 'random', () => doorProbability / 2);
  world.level(0).startEvent('blackout');
  world.update(0.7);
  assert.equal(door.forcedOpen, true);
  assert.equal(door.open, 1);
  assert.equal(door.powered, false);
  assert.equal(door.passable, true);
  const owner = {};
  door.forceOpen(owner);
  world.events.stopEvent('earthquake');
  assert.equal(door.forcedOpen, true, 'another event still owns its hold');
  door.releaseOpen(owner);
  assert.equal(door.forcedOpen, false);
  assert.equal(a.power, 'off', 'earthquake cleanup does not end blackout');
});

test('door holds expire during a quake; broken doors remain broken and closed', (t) => {
  const { world, door, other } = setup();
  const broken = world.passageDoorFor(other.doors[0]);
  broken.break();
  let roll = 0;
  t.mock.method(Math, 'random', () => roll);
  world.events.startEvent('earthquake', 100);
  world.update(0.1);
  assert.equal(door.forcedOpen, true);
  assert.equal(broken.forcedOpen, false);
  assert.equal(broken.broken, true);
  assert.equal(broken.open, 0);
  roll = 0.99;
  world.update(EARTHQUAKE.doorHoldSeconds.min);
  assert.equal(door.forcedOpen, false);
  assert.equal(door.open, 0);
  assert.equal(world.events.hasEvent('earthquake'), true);
});

test('ceiling rocks fall to painted floor, fade after stopping, and remain bounded on long frames', (t) => {
  const { world } = setup();
  for (const current of world.rooms) current.setProps([]);
  t.mock.method(Math, 'random', () => 0.5);
  world.events.startEvent('earthquake', 10000);
  world.update(0.1);
  const first = rocks(world);
  assert.equal(first.length, 6, 'one small burst in each room');
  for (const particle of first) {
    assert.equal(particle.y, EARTHQUAKE.debris.ceilingY);
    assert.ok(particle.vy >= 0, 'rocks do not launch upward');
  }
  world.events.stopEvent('earthquake');
  for (let i = 0; i < 10; i++) world.update(0.1);
  assert.ok(first.every((particle) => particle.y >= 100 && particle.floor >= 100), 'rocks land on green floor, not the ceiling');
  world.update(10);
  assert.equal(rocks(world).length, 0, 'existing debris expires without new bursts');
  world.events.startEvent('earthquake', 10000);
  world.update(100);
  assert.equal(rocks(world).length, 6, 'missed bursts are not replayed');
  const crowded = new World({
    rooms: Array.from({ length: 200 }, (_, i) => room(`room-${i}`, 0)),
    roster: [],
  });
  crowded.events.startEvent('earthquake');
  crowded.update(0.1);
  assert.equal(crowded.particles.particles.length, MAX_PARTICLES, 'facility bursts obey the global cap');
});

test('facility definitions add events without changing the world loop and use clipped lifetimes', () => {
  const calls = [];
  const world = new World({
    rooms: [], roster: [], events: {
      test: {
        duration: 0.5,
        onStart: (context, current) => calls.push(['start', context === world, current === world]),
        onUpdate: (_context, _world, dt) => calls.push(['update', dt]),
        onEnd: (_context, _world, reason) => calls.push(['end', reason]),
      },
    },
  });
  assert.throws(() => world.events.startEvent('toString'), /Unknown event/);
  for (const duration of [0, -1, NaN, Infinity]) {
    assert.throws(() => world.events.startEvent('test', duration), /positive, finite/);
  }
  world.events.startEvent('test');
  world.update(0);
  world.update(10);
  assert.deepEqual(calls, [['start', true, true], ['update', 0.5], ['end', 'expired']]);
});
