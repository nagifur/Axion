import assert from 'node:assert/strict';
import test from 'node:test';
import { seededRandom, setRandomSource } from '../src/lib/sim/random.ts';
import { toSimCreature } from '../src/lib/sim/roster.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadFacility } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';
import { FacilityEventDirector } from '../src/lib/sim/facilityEvents.ts';
import { ATTACK_CHANCE, ESCAPE_CHANCE, RESIST_CHANCE, escapeChance } from '../src/lib/sim/creature.ts';
import { PassageDoor } from '../src/lib/sim/door.ts';
import { wait } from '../src/lib/sim/tasks.ts';
import { exitThroughDoor } from '../src/lib/sim/transport.ts';
import { planSecurity } from '../src/lib/sim/security.ts';
import { CREATURE_REACTIONS, LOOK_STARTLE_CHANCE, PET_CHANCE } from '../src/lib/sim/creatureReactions.ts';
import { STATUS_EFFECTS } from '../src/lib/sim/statusEffects.ts';

const staff = { id: 'guard', name: 'Guard', href: '', tint: '#fff', scale: 1, position: 'Test', species: 'Human',
  accessLevel: '3', employeeID: '1', traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false } };

const profile = (id, containmentClass = 'Maximum Containment') => toSimCreature({ id, data: {
  title: id, nickname: id, containmentClass, type: 'Creature', species: 'Lizard',
} });

function setup(t, seed, containmentClass, count = 1) {
  setRandomSource(seededRandom(seed));
  const original = { ...ESCAPE_CHANCE };
  const resistance = { ...RESIST_CHANCE };
  const attacks = { ...ATTACK_CHANCE };
  ESCAPE_CHANCE.maximum = 1;
  Object.assign(RESIST_CHANCE, { maximum: 0, containment: 0, safe: 0 });
  Object.assign(ATTACK_CHANCE, { maximum: 0, containment: 0, safe: 0 });
  t.after(() => {
    setRandomSource(null);
    Object.assign(ESCAPE_CHANCE, original);
    Object.assign(RESIST_CHANCE, resistance);
    Object.assign(ATTACK_CHANCE, attacks);
  });
  return loadFacility().then((data) => {
    const world = new World({ rooms: data.map((room) => new Room(room)), roster: [],
      creatureRoster: Array.from({ length: count }, (_, i) => profile(i === 0 ? 'breaker' : `breaker-${i}`, containmentClass)) });
    const logs = [];
    world.hooks.log = (text, tone) => logs.push({ text, tone });
    const [creature] = world.creatures;
    const door = creature.home.doors[0];
    return { world, logs, creature, door, state: world.passageDoorFor(door), hall: world.room(door.to.room) };
  });
}

function cellDoorStates(world, hall) {
  return hall.doors.filter((door) => door.cell).map((door) => world.passageDoorFor(door));
}

test('Maximum Containment creatures are far more likely to try than Containment or Safe ones', () => {
  assert.ok(escapeChance('Maximum Containment') > 4 * escapeChance('Containment'));
  assert.ok(escapeChance('Containment') >= escapeChance('Safe'));
  assert.equal(escapeChance('M'), escapeChance('Maximum Containment'));
  assert.equal(escapeChance('Class S'), escapeChance('Safe'));
  assert.equal(escapeChance('Unassigned'), escapeChance('Containment'));
});

test('containment failure opens cell doors one at a time and holds each open', async (t) => {
  const { world, creature, hall } = await setup(t, 11);
  creature.away = true;
  hall.power = 'off';
  const states = cellDoorStates(world, hall);
  const [first, second, ...rest] = states;
  assert.ok(rest.length > 0);
  first.break();
  second.breakPanel();
  const level = world.level(creature.home.level);
  level.startEvent('containment-failure');

  assert.deepEqual(states.map((state) => state.forcedOpen), states.map((_, i) => i === 0));
  world.update(0);
  assert.ok(states.every((state) => state.open === 0), 'pausing does not advance the sequence');
  world.update(first.motionSeconds / 2);
  assert.equal(first.open, 0.5);
  assert.ok(states.slice(1).every((state) => state.open === 0));
  world.update(first.motionSeconds / 2);
  assert.equal(first.open, 1);
  assert.equal(second.open, 0, 'the next door waits until the previous door finishes');
  world.update(second.motionSeconds / 2);
  assert.equal(first.open, 1, 'earlier doors remain held open');
  assert.equal(second.open, 0.5);
  assert.equal(rest[0].open, 0);
  world.update(second.motionSeconds / 2);
  assert.equal(second.open, 1);
  for (const [i, state] of rest.entries()) {
    world.update(state.motionSeconds);
    assert.equal(state.open, 1);
    assert.ok(rest.slice(i + 1).every((next) => next.open === 0));
  }
  assert.ok(states.every((state) => state.forcedOpen && state.passable));
  assert.equal(first.broken, true);
  assert.equal(second.panelBroken, true);
});

test('already-open doors are held immediately and partly open doors finish before the next', async (t) => {
  const { world, creature, hall } = await setup(t, 11);
  creature.away = true;
  hall.power = 'off';
  const [first, second, third] = cellDoorStates(world, hall);
  first.open = 1;
  second.open = 0.5;
  world.level(creature.home.level).startEvent('containment-failure');
  assert.equal(first.forcedOpen, true);
  assert.equal(second.forcedOpen, true);
  assert.equal(third.forcedOpen, false);

  world.update(second.motionSeconds / 2);
  assert.equal(second.open, 1);
  assert.equal(third.open, 0);
  world.update(third.motionSeconds / 2);
  assert.equal(first.open, 1);
  assert.equal(third.open, 0.5);
});

test('the sequence waits for a big unlinked cell door before opening the next', () => {
  const exits = [
    { id: 'west', kind: 'door', side: 'west', bounds: { x: 0, y: 0, w: 86, h: 160 },
      threshold: { x: 90, y: 120 }, base: { x: 0, y: 120 } },
    { id: 'east', kind: 'door', side: 'east', bounds: { x: 250, y: 0, w: 26, h: 96 },
      threshold: { x: 240, y: 80 }, base: { x: 280, y: 80 } },
  ];
  const room = (id, exits, doors = {}) => new Room({
    id, name: id, level: 3, camera: id, width: 300, height: 180, containmentCell: id === 'cell',
    nav: { width: 300, height: 180, floor: Array.from({ length: 180 }, () => [0, 300]), exits },
    props: [], links: {}, doors,
  });
  const hall = room('hall', exits, {
    west: { clearance: 3, cell: true, big: true },
    east: { clearance: 3, cell: true },
  });
  const world = new World({ rooms: [hall, room('cell', [])], roster: [], creatureRoster: [profile('resident')] });
  world.creatures[0].away = true;
  const [big, normal] = cellDoorStates(world, hall);
  world.level(3).startEvent('containment-failure');
  world.update(1);
  assert.equal(big.open, 0.5);
  assert.equal(normal.open, 0);
  world.update(1);
  assert.equal(big.open, 1);
  assert.equal(normal.open, 0);
  world.update(normal.motionSeconds / 2);
  assert.equal(normal.open, 0.5);
});

test('returning residents skips queued doors and advances an interrupted opening', async (t) => {
  const { world, hall } = await setup(t, 42, undefined, 3);
  hall.power = 'off';
  const states = cellDoorStates(world, hall);
  const residents = [...world.creatures].sort((a, b) =>
    states.indexOf(world.passageDoorFor(a.home.doors[0])) - states.indexOf(world.passageDoorFor(b.home.doors[0])));
  const [opening, other, returned] = residents;
  const openingState = world.passageDoorFor(opening.home.doors[0]);
  const returnedState = world.passageDoorFor(returned.home.doors[0]);
  assert.ok(states.indexOf(returnedState) > 0);
  opening.away = true;
  other.away = true;
  returned.room = hall;
  const level = world.level(returned.home.level);
  level.startEvent('containment-failure');
  assert.equal(returnedState.forcedOpen, false);
  world.recontain(returned);

  for (let i = 0; i < 200 && !openingState.forcedOpen; i++) world.update(0.05);
  if (openingState.open === 0) world.update(0.05);
  assert.ok(openingState.open > 0 && openingState.open < 1);
  const next = states.slice(states.indexOf(openingState) + 1).find((state) => state !== returnedState);
  assert.ok(next);
  assert.equal(next.forcedOpen, false);
  opening.away = false;
  opening.room = hall;
  world.recontain(opening);
  assert.equal(openingState.forcedOpen, false);
  assert.equal(next.forcedOpen, true, 'the sequence advances when the current door is released');

  for (let i = 0; i < states.length; i++) world.update(states[0].motionSeconds);
  assert.equal(level.hasEvent('containment-failure'), true);
  assert.equal(returnedState.forcedOpen, false);
  assert.equal(returnedState.open, 0);
  assert.ok(states.filter((state) => state !== returnedState && state !== openingState)
    .every((state) => state.forcedOpen && state.open === 1));
});

test('ending a failure cancels unopened doors without disturbing their normal controls', async (t) => {
  const { world, creature, hall } = await setup(t, 11);
  creature.away = true;
  const states = cellDoorStates(world, hall);
  const [first, second] = states;
  const last = states.at(-1);
  last.update(true, 0.1);
  const level = world.level(creature.home.level);
  level.startEvent('containment-failure');
  world.update(0.1);
  assert.ok(first.open > 0 && first.open < 1);
  assert.equal(second.open, 0);
  const lastOpen = last.open;
  level.stopEvent('containment-failure');
  assert.ok(states.every((state) => !state.forcedOpen));
  assert.equal(last.unlocked, true);
  last.update(false, 0.1);
  assert.ok(last.open > lastOpen, 'the queued door keeps its existing hold');

  world.update(15);
  assert.equal(first.open, 0);
  assert.equal(second.open, 0, 'no queued door opens after the event ends');
  level.startEvent('containment-failure');
  assert.equal(first.forcedOpen, true, 'a new event starts a fresh sequence');
  assert.equal(second.forcedOpen, false);
});

test('containment failure forces escape attempts and holds only the affected floor cell doors open', async (t) => {
  const { world, creature, state, hall } = await setup(t, 11);
  ESCAPE_CHANCE.maximum = 0;
  state.open = 1;
  hall.power = 'off';
  creature.update(world, 0.1); // The normal escape roll already failed for this opening.
  assert.equal(creature.escaping, false);
  const level = world.level(creature.home.level);
  assert.equal(level.hasEvent('containment-failure'), false);
  level.startEvent('containment-failure');
  assert.equal(level.startEvent('containment-failure'), false);
  const affectedStates = new Set();
  for (const room of world.rooms) {
    for (const door of room.doors) {
      const physical = world.passageDoorFor(door);
      if (!physical) continue;
      const destination = door.to && world.room(door.to.room);
      const affected = room.level === level.number && (room.cell || door.cell || destination?.cell);
      if (affected) {
        affectedStates.add(physical);
        assert.equal(physical.open, physical === state ? 1 : 0, 'starting the event preserves the current opening');
      } else {
        assert.equal(physical.forcedOpen, false, `${room.id}/${door.id}`);
      }
    }
  }
  for (let i = 0; i < 200 && !state.forcedOpen; i++) world.update(0.1);
  assert.equal(state.forcedOpen, true);
  assert.equal(creature.activity, 'Escaping the cell', 'failure ignores the failed roll and remembered opening');
  for (let i = 0; i < 300 && creature.contained; i++) world.update(0.1);
  assert.equal(creature.room, hall);
  for (let i = 0; i < 200 && [...affectedStates].some((door) => !door.forcedOpen); i++) world.update(0.1);
  assert.ok([...affectedStates].every((door) => door.forcedOpen), 'all affected doors are eventually held open');
  assert.equal(state.open, 1, 'an outage cannot close the failed cell door');
  assert.equal(level.hasEvent('containment-failure'), true);
  hall.power = 'normal';
  level.stopEvent('containment-failure');
  for (let i = 0; i < 100 && state.open > 0; i++) world.update(0.1);
  assert.equal(state.forcedOpen, false);
  assert.equal(state.open, 0);
  assert.equal(creature.contained, false, 'ending the event does not teleport escapees home');
});

test('each delivered resident releases its cell, not at capture, and the last delivery ends the event', async (t) => {
  const { world, creature, hall, state } = await setup(t, 42, undefined, 2);
  const other = world.creatures[1];
  const otherState = world.passageDoorFor(other.home.doors[0]);
  const level = world.level(creature.home.level);
  creature.away = true;
  other.away = true;
  level.startEvent('containment-failure');
  for (let i = 0; i < 200 && (!state.forcedOpen || !otherState.forcedOpen); i++) world.update(0.1);
  assert.ok(state.forcedOpen && otherState.forcedOpen);
  creature.away = false;
  other.away = false;
  creature.room = hall;
  other.room = hall;
  const guard = world.spawn(staff, hall, hall.randomFloorPoint());
  creature.escort = guard;
  world.update(0.1);
  assert.equal(state.forcedOpen, true, 'being in custody is not delivery');
  world.recontain(creature);
  assert.equal(creature.contained, true);
  assert.equal(state.forcedOpen, false);
  assert.equal(otherState.forcedOpen, true);
  assert.equal(level.hasEvent('containment-failure'), true);
  world.update(2);
  assert.equal(state.open, 0);
  assert.equal(creature.escaping, false, 'a returned creature does not attempt another forced escape');
  world.recontain(other);
  assert.equal(level.hasEvent('containment-failure'), false);
  assert.equal(otherState.forcedOpen, false);
  level.startEvent('containment-failure');
  for (let i = 0; i < 200 && !creature.escaping; i++) world.update(0.1);
  assert.equal(creature.escaping, true, 'a new failure affects previously returned residents again');
});

test('a resident fleeing the facility resolves the event but keeps its cell open until all residents resolve', async (t) => {
  const { world, creature, state, hall } = await setup(t, 11, undefined, 2);
  const other = world.creatures[1];
  other.away = true;
  const level = world.level(creature.home.level);
  level.startEvent('containment-failure');
  for (const id of [hall.id, 'level-3-main-entrance']) {
    const room = world.room(id);
    room.power = 'off';
    for (const door of room.doors) if (!door.cell && world.passageDoorFor(door)) world.passageDoorFor(door).open = 1;
  }
  for (let i = 0; i < 12000 && !creature.escaped; i++) world.update(0.1);
  assert.equal(creature.escaped, true);
  world.update(0.1);
  assert.equal(level.hasEvent('containment-failure'), true, 'a disguised resident remains unresolved');
  assert.equal(state.forcedOpen, true);
  other.away = false;
  other.room = hall;
  world.recontain(other);
  assert.equal(level.hasEvent('containment-failure'), false);
  assert.equal(state.forcedOpen, false);
  level.startEvent('containment-failure');
  other.room = hall;
  world.recontain(other);
  assert.equal(level.hasEvent('containment-failure'), false, 'already escaped residents do not block later events');
});

test('returning an already-resolved escapee releases its cell while other residents remain unresolved', async (t) => {
  const { world, creature, state } = await setup(t, 7, undefined, 2);
  const level = world.level(creature.home.level);
  creature.away = true;
  world.creatures[1].away = true;
  level.startEvent('containment-failure');
  for (let i = 0; i < 200 && !state.forcedOpen; i++) world.update(0.1);
  assert.equal(state.forcedOpen, true);
  creature.escaped = true;
  world.update(0.1);
  assert.equal(state.forcedOpen, true);
  world.recontain(creature);
  assert.equal(state.forcedOpen, false);
  assert.equal(level.hasEvent('containment-failure'), true);
});

test('containment failure opens broken cell doors without repairing them, and they close again when released', async (t) => {
  const { world, creature, state, hall } = await setup(t, 5);
  const level = world.level(creature.home.level);
  state.break();
  state.breakPanel();
  level.startEvent('containment-failure');
  for (let i = 0; i < 200 && state.open === 0; i++) world.update(0.05);
  assert.equal(state.broken, true);
  assert.equal(state.forcedOpen, true);
  assert.ok(state.open > 0 && state.open < 0.5, 'the broken door slides open instead of disappearing');
  assert.equal(state.passable, false);
  world.update(state.motionSeconds);
  assert.equal(state.open, 1);
  assert.equal(state.passable, true);
  assert.equal(state.blocked, false);
  for (let i = 0; i < 300 && creature.contained; i++) world.update(0.1);
  assert.equal(creature.room, hall, 'the resident escapes through the broken door');
  level.stopEvent('containment-failure');
  assert.equal(state.broken, true);
  assert.equal(state.panelBroken, true);
  assert.equal(state.open, 0);
  assert.equal(state.blocked, true);
});

test('security escorts a containment-failure escapee home and automatically ends the event', async (t) => {
  const { world, creature, state, logs } = await setup(t, 42);
  t.mock.method(world, 'now', () => new Date(2026, 0, 1, 12));
  t.mock.method(PassageDoor.prototype, 'breakOnUse', () => []);
  world.populate();
  const level = world.level(creature.home.level);
  level.startEvent('containment-failure');
  let captured = false;
  for (let i = 0; i < 1800 && level.hasEvent('containment-failure'); i++) {
    world.update(0.1);
    if (creature.escort) {
      captured = true;
      assert.equal(state.forcedOpen, true);
    }
  }
  assert.equal(captured, true);
  assert.equal(creature.contained, true);
  assert.equal(level.hasEvent('containment-failure'), false);
  assert.equal(state.forcedOpen, false);
  assert.ok(logs.some(({ text }) => text.includes(`back to ${creature.home.name}`)));
});

test('a creature that sees its cell door stuck open breaks out, roams, and can be recontained', async (t) => {
  const { world, logs, creature, state, hall } = await setup(t, 11);
  const { home } = creature;
  hall.power = 'off';
  state.open = 1;
  assert.ok(state.stuckOpen);
  world.update(0.1);
  assert.equal(creature.activity, 'Escaping the cell');
  for (let i = 0; i < 300 && creature.contained; i++) world.update(0.1);
  assert.equal(creature.room, hall);
  assert.ok(logs.some(({ text, tone }) => tone === 'alert' && text.includes(`escaped ${home.name}`)));
  assert.deepEqual(world.actorsIn(home), []);
  assert.equal(creature.home.cell.creatureId, creature.character.id, 'the cell stays reserved');

  // Stick the way through the main entrance open as well, so it can run.
  for (const id of [hall.id, 'level-3-main-entrance']) {
    const room = world.room(id);
    room.power = 'off';
    for (const door of room.doors) if (!door.cell && world.passageDoorFor(door)) world.passageDoorFor(door).open = 1;
  }
  const visited = new Set();
  for (let i = 0; i < 3000 && !creature.escaped; i++) {
    world.update(0.1);
    visited.add(creature.room.id);
    assert.ok(!creature.room.cell, 'never slips into a cell, including its own');
    if (creature.alpha === 1 && !creature.escaping) assert.ok(creature.room.isWalkable(creature));
    if (creature.onCamera) assert.ok(world.actorsIn(creature.room).includes(creature));
  }
  assert.ok(visited.has('level-3-main-entrance'), 'roams between rooms on camera');
  assert.ok(creature.escaped, 'eventually flees off camera through a way out');
  assert.ok(logs.some(({ text, tone }) => tone === 'alert' && text.includes('fled the facility')));
  assert.ok(world.rooms.every((room) => !world.actorsIn(room).includes(creature)));
  assert.equal(creature.activity, 'Escaped the facility');

  world.recontain(creature);
  assert.ok(creature.contained);
  assert.deepEqual(world.actorsIn(home), [creature]);
  assert.ok(home.isWalkable(creature));
  assert.equal(logs.at(-1).tone, 'ok');
});

test('nearby staff leave residents contained; intentional entry can tempt escape until the door seals', async (t) => {
  const { world, creature, door, state, hall } = await setup(t, 5);
  const entrance = hall.doors.find(({ id }) => id === door.to.door);
  const guard = world.spawn(staff, hall, entrance.inside);
  guard.setPlan(world, [wait(30, 'Guarding')]);
  for (let i = 0; i < 40; i++) world.update(0.05);
  assert.equal(state.open, 0);
  assert.ok(creature.contained);
  assert.equal(creature.escaping, false);

  t.mock.method(state, 'breakOnUse', () => []);
  guard.setPlan(world, [exitThroughDoor(entrance)]);
  for (let i = 0; i < 40 && creature.activity !== 'Escaping the cell'; i++) world.update(0.05);
  assert.ok(state.passable);
  assert.equal(creature.activity, 'Escaping the cell');
  world.remove(guard, 'east');
  hall.power = 'off';
  state.open = 0;
  for (let i = 0; i < 200; i++) world.update(0.1);
  assert.ok(creature.contained);
  assert.equal(creature.alpha, 1);
  assert.notEqual(creature.activity, 'Escaping the cell');
});

test('closed doors and unlucky rolls keep creatures in, and each opening is only rolled once', async (t) => {
  const { world, creature, state, hall } = await setup(t, 7, 'Safe');
  ESCAPE_CHANCE.safe = 0;
  for (let i = 0; i < 600; i++) world.update(0.1);
  assert.ok(creature.contained, 'never leaves through a closed door');
  hall.power = 'off';
  state.open = 1;
  for (let i = 0; i < 300; i++) world.update(0.1);
  assert.ok(creature.contained);
  ESCAPE_CHANCE.safe = 1;
  for (let i = 0; i < 100; i++) world.update(0.1);
  assert.ok(creature.contained, 'the same opening is not reconsidered');
});

test('one same-floor guard pursues a breach, escorts through working doors, then returns to post', async (t) => {
  const { world, logs, creature, state, hall } = await setup(t, 42);
  t.mock.method(world, 'now', () => new Date(2026, 0, 1, 12));
  t.mock.method(PassageDoor.prototype, 'breakOnUse', () => []); // Only the scripted door failure interrupts this run.
  world.populate();
  const post = world.room('level-3-main-entrance');
  const [guard] = world.agentsIn(post);
  const at = [guard.x, guard.y];
  const until = (predicate, seconds = 90) => {
    for (let i = 0; i < seconds * 10 && !predicate(); i++) world.update(0.1);
    assert.ok(predicate(), `${guard.activity} in ${guard.room.name}; ${creature.activity} in ${creature.room.name}`);
  };
  state.open = 1;
  state.breakPanel();
  until(() => creature.loose);
  assert.equal(creature.home.cell.creatureId, creature.character.id);
  state.repairPanel();
  ESCAPE_CHANCE.maximum = 0;
  until(() => !!guard.security.target);
  assert.equal(guard.room, post, 'dispatched before the creature reaches the elevator room');
  until(() => creature.escort === guard);
  assert.equal(guard.room, hall);
  assert.equal(creature.room, hall, 'capture is not a teleport back to the cell');
  assert.equal(guard.draggable, false);
  assert.ok(!guard.statuses.has('scared'));
  assert.equal(logs.filter(({ text }) => text.includes('dispatched to')).length, 1);

  state.break(); // The return route is cut while the creature is already in custody.
  until(() => guard.activity.includes('Waiting for a passage'));
  for (let i = 0; i < 40; i++) world.update(0.1);
  assert.equal(creature.room, hall);
  assert.equal(creature.escort, guard);
  assert.ok(world.actorsIn(hall).includes(creature));

  state.repair();
  until(() => creature.room === creature.home);
  assert.equal(creature.escort, guard, 'they cross the actual threshold together');
  assert.equal(creature.alpha, guard.alpha);
  until(() => creature.contained);
  assert.equal(creature.escort, undefined);
  assert.ok(creature.home.isWalkable(creature));
  assert.ok(logs.some(({ text, tone }) => tone === 'ok' && text.includes(`back to ${creature.home.name}`)));
  until(() => guard.room === post && guard.activity === 'Guarding the elevator');
  assert.deepEqual([guard.x, guard.y], at);
  assert.equal(guard.security.target, undefined);
});

for (const hp of [100, 5]) test(`an escorted creature breaks free from a guard with ${hp} HP; only surviving guards recover`, async (t) => {
  const { world, creature, hall, logs } = await setup(t, 42);
  const post = world.room('level-3-main-entrance');
  const guard = world.spawn(staff, hall, hall.nearestWalkable({ x: hall.width / 2, y: hall.height / 2 }));
  Object.assign(creature, { room: hall, x: guard.x, y: guard.y });
  guard.security = { post, relieved: false, target: creature };
  guard.stats.hp.current = hp;
  creature.escort = guard;
  guard.setPlan(world, planSecurity(guard, world, guard.security));
  RESIST_CHANCE.maximum = 1;

  creature.update(world, 0.1);
  assert.equal(creature.escort, undefined);
  assert.equal(guard.security.target, undefined);
  assert.equal(guard.stats.hp.current, Math.max(0, hp - 10));
  assert.equal(creature.loose, true);
  assert.equal(creature.room, hall);
  assert.equal(creature.home.cell.creatureId, creature.character.id);
  assert.ok(hall.isWalkable(creature));
  if (hp > 10) assert.match(guard.activity, /Recovering/);
  else {
    assert.equal(guard.activity, 'Dead');
    assert.equal(guard.statuses.get('dead').remaining, null);
    assert.equal(guard.bubble, null);
  }
  assert.ok(logs.some(({ text, tone }) => tone === 'alert' && text.includes('broke free') && text.includes('injuring')));

  creature.hold(30, guard); // A nearby staff member trying to pet it must not stop the getaway.
  const at = { x: guard.x, y: guard.y };
  for (let i = 0; i < 20; i++) {
    guard.update(world, 0.1);
    creature.update(world, 0.1);
    assert.equal(creature.escort, undefined, 'the recovering guard cannot immediately recapture it');
    assert.deepEqual({ x: guard.x, y: guard.y }, at, 'the old escort route was cancelled');
    assert.ok(hall.isWalkable(creature));
  }
  assert.ok(Math.hypot(creature.x - guard.x, creature.y - guard.y) > 14, 'the creature runs out of capture reach');
  assert.equal(guard.stats.hp.current, Math.max(0, hp - 10), 'damage occurs only on the break');
  for (let i = 0; i < 12; i++) guard.update(world, 0.1);
  assert.equal(guard.security.target, hp > 10 ? creature : undefined, 'only surviving security resumes pursuit');
});

test('resistance uses elapsed time, preserves unlucky escorts, and pauses during fades and delivery', async (t) => {
  const { world, creature, hall } = await setup(t, 42);
  const guard = world.spawn(staff, hall, hall.randomFloorPoint());
  guard.security = { post: world.room('level-3-main-entrance'), relieved: false, target: creature };
  Object.assign(creature, { room: hall, x: guard.x, y: guard.y, escort: guard });
  RESIST_CHANCE.maximum = 1;
  creature.update(world, 0);
  guard.alpha = 0.5;
  creature.update(world, 1);
  assert.equal(creature.escort, guard);
  assert.equal(creature.alpha, 0.5);
  guard.alpha = 1;
  guard.room = creature.home;
  Object.assign(guard, creature.home.randomFloorPoint());
  creature.update(world, 1);
  assert.equal(creature.escort, guard, 'reaching home must complete delivery rather than trigger resistance');
  assert.equal(guard.stats.hp.current, 100);

  guard.room = hall;
  Object.assign(guard, hall.randomFloorPoint());
  RESIST_CHANCE.maximum = 0.04;
  setRandomSource(() => 0.03);
  creature.update(world, 0.5);
  assert.equal(creature.escort, guard, 'a half-second has a lower break chance than a full second');
  assert.equal(guard.stats.hp.current, 100);
  creature.update(world, 1);
  assert.equal(creature.escort, undefined);
  assert.equal(guard.stats.hp.current, 90);
});

test('a resisting creature runs through a passable non-cell door without ending containment failure', async (t) => {
  const { world, creature, hall } = await setup(t, 42);
  const door = hall.doors.find((door) => door.to && !door.cell && !world.room(door.to.room).cell);
  const state = world.passageDoorFor(door);
  state.open = 1;
  hall.power = 'off';
  const guard = world.spawn(staff, hall, door.inside);
  guard.security = { post: world.room('level-3-main-entrance'), relieved: false, target: creature };
  Object.assign(creature, { room: hall, x: guard.x, y: guard.y, escort: guard });
  const level = world.level(creature.home.level);
  level.startEvent('containment-failure');
  RESIST_CHANCE.maximum = 1;
  creature.update(world, 0.1);
  assert.equal(creature.escaping, true);
  assert.equal(level.hasEvent('containment-failure'), true);
  for (let i = 0; i < 300 && creature.room === hall; i++) creature.update(world, 0.1);
  assert.equal(creature.room, world.room(door.to.room));
  assert.equal(level.hasEvent('containment-failure'), true);
  assert.equal(creature.home.cell.creatureId, creature.character.id);
});

test('a guard walking back to post takes a new breach call instead of finishing the walk', async (t) => {
  const { world, creature, hall } = await setup(t, 42);
  const post = world.room('level-3-main-entrance');
  const guard = world.spawn(staff, hall, hall.randomFloorPoint());
  guard.security = { post, relieved: false };
  assert.match(planSecurity(guard, world, guard.security)[0].activity ?? '', /Returning to the elevator post/);

  Object.assign(creature, { room: hall, ...hall.nearestWalkable({ x: guard.x + 40, y: guard.y }, guard) });
  assert.ok(creature.loose);
  planSecurity(guard, world, guard.security);
  assert.equal(guard.security.target, creature, 'dispatched from the hall, not only once back at the post');
  assert.notEqual(guard.room, post);
});

for (const pursuing of [false, true]) test(`security prioritizes the nearest local escapee ${pursuing ? 'over an existing distant pursuit' : 'when dispatched'}`, async (t) => {
  const { world, hall } = await setup(t, 42, undefined, 3);
  const post = world.room('level-3-main-entrance');
  const guard = world.spawn(staff, hall, hall.nearestWalkable({ x: hall.width / 2, y: hall.height / 2 }));
  const [remote, farther, nearest] = world.creatures;
  Object.assign(remote, { room: post, ...post.randomFloorPoint() });
  Object.assign(farther, { room: hall, ...hall.nearestWalkable({ x: guard.x + 60, y: guard.y }, guard) });
  Object.assign(nearest, { room: hall, x: guard.x, y: guard.y });
  assert.ok(Math.hypot(farther.x - guard.x, farther.y - guard.y) > 14);
  assert.ok(world.creatures.every((creature) => creature.loose));
  guard.security = { post, relieved: false, target: pursuing ? remote : undefined };

  const [task] = planSecurity(guard, world, guard.security);
  assert.equal(guard.security.target, nearest);
  assert.equal(task.activity, `Pursuing ${nearest.character.name}`);
  planSecurity(guard, world, guard.security);
  assert.equal(nearest.escort, guard, 'the creature beside the guard is caught before leaving the room');
  assert.equal(remote.escort, undefined);
});

test('local dispatch skips claimed, fading, and unreachable creatures', async (t) => {
  const { world, hall } = await setup(t, 42, undefined, 4);
  const post = world.room('level-3-main-entrance');
  const guard = world.spawn(staff, hall, hall.randomFloorPoint());
  guard.security = { post, relieved: false };
  const [claimed, fading, unreachable, available] = world.creatures;
  for (const creature of world.creatures) Object.assign(creature, { room: hall, x: guard.x, y: guard.y });
  const other = world.spawn({ ...staff, id: 'other-guard' }, hall, guard);
  other.security = { post, relieved: false, target: claimed };
  fading.alpha = 0.5;
  const canReach = hall.canReach.bind(hall);
  t.mock.method(hall, 'canReach', (from, to, ghost) => to !== unreachable && canReach(from, to, ghost));

  planSecurity(guard, world, guard.security);
  assert.equal(guard.security.target, available);
  assert.equal(other.security.target, claimed);
});

test('security finishes its local pursuit and escort rather than switching to a closer escapee', async (t) => {
  const { world, hall } = await setup(t, 42, undefined, 2);
  const post = world.room('level-3-main-entrance');
  const guard = world.spawn(staff, hall, hall.nearestWalkable({ x: hall.width / 2, y: hall.height / 2 }));
  const [target, closer] = world.creatures;
  Object.assign(target, { room: hall, ...hall.nearestWalkable({ x: guard.x + 60, y: guard.y }, guard) });
  Object.assign(closer, { room: hall, x: guard.x, y: guard.y });
  guard.security = { post, relieved: false, target };

  assert.equal(planSecurity(guard, world, guard.security)[0].activity, `Pursuing ${target.character.name}`);
  assert.equal(guard.security.target, target);
  target.escort = guard;
  assert.match(planSecurity(guard, world, guard.security)[0].activity, /Escorting/);
  assert.equal(guard.security.target, target);
  assert.equal(target.escort, guard);
  assert.equal(closer.escort, undefined);
});

test('an escaped shapeshifter cannot also walk in disguised', async (t) => {
  const { world, creature, state, hall } = await setup(t, 3);
  hall.power = 'off';
  state.open = 1;
  for (let i = 0; i < 300 && creature.contained; i++) world.update(0.1);
  assert.ok(!creature.contained);
  world.spawn(staff, hall, hall.randomFloorPoint());
  const director = new FacilityEventDirector([{ ...creature.character, weight: 1 }]);
  assert.equal(director.triggerImpostor(world), false);
  assert.equal(creature.away, false);
});

async function looseInHall(t, seed, reactions) {
  const scene = await setup(t, seed);
  const original = { reactions: { ...CREATURE_REACTIONS }, pet: { ...PET_CHANCE }, startle: LOOK_STARTLE_CHANCE };
  Object.assign(CREATURE_REACTIONS, { scared: 0, look: 0, pet: 0 }, reactions);
  t.after(() => {
    Object.assign(CREATURE_REACTIONS, original.reactions);
    Object.assign(PET_CHANCE, original.pet);
  });
  const { world, creature, door, state, hall } = scene;
  // Stand on the cells' side of the hall, but out of the door's sensor range.
  const outside = hall.doors.find(({ id }) => id === door.to.door).inside;
  let at = hall.randomFloorPoint();
  while (hall.floorArea(at) !== hall.floorArea(outside) || Math.hypot(at.x - outside.x, at.y - outside.y) < 80) at = hall.randomFloorPoint();
  const guard = world.spawn(staff, hall, at);
  guard.setPlan(world, [wait(600, 'Guarding')]);
  for (let i = 0; i < 100; i++) world.update(0.1);
  assert.ok(!guard.statuses.has('scared'), 'a creature behind its cell door is no reason to panic');
  hall.power = 'off';
  state.open = 1;
  for (let i = 0; i < 300 && (creature.contained || creature.alpha < 1); i++) world.update(0.1);
  assert.equal(creature.room, hall);
  world.update(0.05); // Agents update before creatures, so they notice it on the next tick.
  return { ...scene, guard };
}

test('staff who see a loose creature get the white "scared" status and flee, once per sighting', async (t) => {
  const { world, logs, creature, guard, hall } = await looseInHall(t, 11, { scared: 1 });
  assert.equal(STATUS_EFFECTS.scared.popup.color, '#ffffff');
  assert.match(STATUS_EFFECTS.scared.popup.icon, /scared\.svg/);
  assert.ok(guard.statuses.has('scared'));
  assert.equal(guard.bubble, '!');
  assert.equal(guard.activity, `Fleeing from the ${creature.character.name}`);
  assert.ok(logs.some(({ text, tone }) => tone === 'warn' && text.includes('panicked')));

  // Without a card for any door out, the guard backs into the far corner instead.
  const before = Math.hypot(guard.x - creature.x, guard.y - creature.y);
  guard.statuses.remove('scared');
  let cowered = false;
  for (let i = 0; i < 300 && !cowered; i++) {
    world.update(0.1);
    cowered = guard.activity === 'Cowering in fear';
    assert.ok(!guard.statuses.has('scared'), 'no second panic for the same sighting');
  }
  assert.ok(cowered);
  assert.ok(Math.hypot(guard.x - creature.x, guard.y - creature.y) > before);
});

test('curious staff creep closer or try to pet a loose creature, which can go either way', async (t) => {
  const petted = await looseInHall(t, 11, { pet: 1 });
  PET_CHANCE.maximum = 1;
  assert.equal(petted.guard.bubble, '?');
  for (let i = 0; i < 200 && !petted.logs.some(({ text }) => text.includes('petted')); i++) petted.world.update(0.1);
  assert.ok(petted.logs.some(({ text, tone }) => tone === 'ok' && text.includes('petted the loose')));
  assert.equal(petted.guard.bubble, '♥');
  assert.ok(!petted.guard.statuses.has('scared'));

  const bitten = await looseInHall(t, 11, { pet: 1 });
  PET_CHANCE.maximum = 0;
  for (let i = 0; i < 200 && !bitten.guard.statuses.has('scared'); i++) bitten.world.update(0.1);
  assert.ok(bitten.logs.some(({ text, tone }) => tone === 'warn' && text.includes('snapped at')));
  assert.ok(bitten.guard.statuses.has('scared'));

  const watcher = await looseInHall(t, 11, { look: 1 });
  const name = watcher.creature.character.name;
  let watched = false;
  for (let i = 0; i < 200 && !watched; i++) {
    watcher.world.update(0.1);
    watched = watcher.guard.activity === `Watching the ${name}`;
  }
  assert.ok(watched);
  assert.ok(Math.hypot(watcher.guard.x - watcher.creature.x, watcher.guard.y - watcher.creature.y) <= 60);
});
