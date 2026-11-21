import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from '../src/lib/sim/room.ts';
import { World } from '../src/lib/sim/world.ts';

const room = (id, level) => new Room({
  id, level, name: id, camera: id, width: 120, height: 80,
  nav: { floor: Array.from({ length: 80 }, () => [0, 120]), exits: [] },
  props: [], links: {}, shafts: {},
});

test('rooms on the same floor share state; other floors and worlds do not', () => {
  const rooms = [room('lobby', 0), room('lab', 2), room('hall', 2), room('vault', 4)];
  const floor = {
    variables: { powerOnline: true },
    events: { blackout: {
      onStart: (level) => { level.variables.set('powerOnline', false); },
      onEnd: (level) => { level.variables.set('powerOnline', true); },
    } },
  };
  const levels = { 2: floor, 4: floor, 5: floor };
  const world = new World({ rooms, roster: [], levels });
  const [lobby, lab, hall, vault] = rooms.map((room) => world.level(room.level));
  assert.equal(lobby.number, 0);
  assert.equal(lobby.variables.size, 0);
  assert.deepEqual(lobby.activeEvents, []);
  assert.equal(world.level(5), undefined, 'definitions do not create floors without rooms');
  assert.equal(lab, hall);
  assert.deepEqual(lab.rooms, [rooms[1], rooms[2]]);
  assert.equal(lab.startEvent('blackout'), true);
  assert.equal(hall.hasEvent('blackout'), true);
  assert.equal(hall.variables.get('powerOnline'), false);
  assert.equal(vault.hasEvent('blackout'), false);
  assert.equal(vault.variables.get('powerOnline'), true);
  assert.equal(vault.startEvent('blackout'), true, 'same event ID can run independently on another floor');
  const fresh = new World({ rooms, roster: [], levels }).level(2);
  assert.equal(fresh.hasEvent('blackout'), false);
  assert.equal(fresh.variables.get('powerOnline'), true);
  assert.equal(hall.stopEvent('blackout'), true);
  assert.equal(lab.variables.get('powerOnline'), true);
  assert.equal(vault.hasEvent('blackout'), true);
});

test('timed and manual events overlap and clean up exactly once', () => {
  const calls = [];
  const events = {
    'portal-storm': {
      duration: 2,
      onStart: (level, world) => calls.push(['start', level.number, world.time]),
      onUpdate: (_level, _world, dt) => calls.push(['update', dt]),
      onEnd: (level, _world, reason) => calls.push(['storm end', reason, level.hasEvent('portal-storm')]),
    },
    lockdown: {
      onEnd: (_level, _world, reason) => calls.push(['lockdown end', reason]),
    },
  };
  const world = new World({ rooms: [room('lab', 2)], roster: [], levels: { 2: { events } } });
  const level = world.level(2);
  assert.equal(level.startEvent('portal-storm'), true);
  assert.equal(level.startEvent('lockdown'), true);
  assert.equal(level.startEvent('portal-storm', 10), false);
  assert.deepEqual(level.activeEvents, [
    { id: 'portal-storm', startedAt: 0, endsAt: 2 },
    { id: 'lockdown', startedAt: 0, endsAt: null },
  ]);
  world.update(0);
  assert.deepEqual(calls, [['start', 2, 0]]);
  world.update(0.5);
  world.update(3);
  assert.deepEqual(calls, [
    ['start', 2, 0], ['update', 0.5], ['update', 1.5], ['storm end', 'expired', false],
  ]);
  assert.equal(level.stopEvent('portal-storm'), false);
  assert.equal(level.hasEvent('lockdown'), true);
  assert.equal(level.stopEvent('lockdown'), true);
  assert.equal(level.stopEvent('lockdown'), false);
  assert.deepEqual(calls.at(-1), ['lockdown end', 'stopped']);
  assert.equal(level.startEvent('portal-storm', 0.25), true);
  world.update(0.25);
  assert.deepEqual(calls.slice(-3), [['start', 2, 3.5], ['update', 0.25], ['storm end', 'expired', false]]);
  assert.deepEqual(level.activeEvents, []);
});

test('floor triggers run for all floors and newly started events do not consume the current frame', () => {
  const calls = [];
  const events = {
    blackout: {
      duration: 1,
      onUpdate: (level, _world, dt) => calls.push([level.number, dt]),
    },
  };
  const world = new World({
    rooms: [room('lab', 2), room('vault', 4)],
    roster: [],
    levels: {
      2: { events, onUpdate: (level, world) => {
        if (world.time !== 1) return;
        level.startEvent('blackout');
        world.level(4).startEvent('blackout');
      } },
      4: { events },
    },
  });
  const lab = world.level(2);
  const vault = world.level(4);
  world.update(1);
  assert.deepEqual(calls, []);
  assert.equal(lab.hasEvent('blackout'), true);
  assert.equal(vault.hasEvent('blackout'), true);
  world.update(1);
  assert.deepEqual(calls, [[2, 1], [4, 1]]);
  assert.equal(lab.hasEvent('blackout'), false);
  assert.equal(vault.hasEvent('blackout'), false);
});

test('invalid event requests fail without creating active events', () => {
  const events = { blackout: {}, lockdown: { duration: -1 } };
  const world = new World({ rooms: [room('lab', 2)], roster: [], levels: { 2: { events } } });
  const level = world.level(2);
  assert.throws(() => level.startEvent('toString'), /Unknown event "toString" on Level 2/);
  for (const duration of [0, -1, Infinity, NaN]) {
    assert.throws(() => level.startEvent('blackout', duration), /positive, finite/);
  }
  assert.throws(() => level.startEvent('lockdown'), /positive, finite/);
  assert.deepEqual(level.activeEvents, []);
});
