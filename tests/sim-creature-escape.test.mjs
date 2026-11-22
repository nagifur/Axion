import assert from 'node:assert/strict';
import test from 'node:test';
import { seededRandom, setRandomSource } from '../src/lib/sim/random.ts';
import { toSimCreature } from '../src/lib/sim/roster.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadFacility } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';
import { EventDirector } from '../src/lib/sim/events.ts';
import { ESCAPE_CHANCE, escapeChance } from '../src/lib/sim/creature.ts';
import { wait } from '../src/lib/sim/tasks.ts';

const staff = { id: 'guard', name: 'Guard', href: '', tint: '#fff', scale: 1, position: 'Test', species: 'Human',
  accessLevel: '3', employeeID: '1', traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false } };

const profile = (id, containmentClass = 'Maximum Containment') => toSimCreature({ id, data: {
  title: id, nickname: id, containmentClass, type: 'Creature', species: 'Lizard',
} });

function setup(t, seed, containmentClass) {
  setRandomSource(seededRandom(seed));
  const original = { ...ESCAPE_CHANCE };
  ESCAPE_CHANCE.maximum = 1;
  t.after(() => {
    setRandomSource(null);
    Object.assign(ESCAPE_CHANCE, original);
  });
  return loadFacility().then((data) => {
    const world = new World({ rooms: data.map((room) => new Room(room)), roster: [], creatureRoster: [profile('breaker', containmentClass)] });
    const logs = [];
    world.hooks.log = (text, tone) => logs.push({ text, tone });
    const [creature] = world.creatures;
    const door = creature.home.doors[0];
    return { world, logs, creature, door, state: world.passageDoorFor(door), hall: world.room(door.to.room) };
  });
}

test('Maximum Containment creatures are far more likely to try than Containment or Safe ones', () => {
  assert.ok(escapeChance('Maximum Containment') > 4 * escapeChance('Containment'));
  assert.ok(escapeChance('Containment') >= escapeChance('Safe'));
  assert.equal(escapeChance('M'), escapeChance('Maximum Containment'));
  assert.equal(escapeChance('Class S'), escapeChance('Safe'));
  assert.equal(escapeChance('Unassigned'), escapeChance('Containment'));
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

test('staff opening the cell door tempt the creature, but a door that seals in time stops it', async (t) => {
  const { world, creature, door, state, hall } = await setup(t, 5);
  const guard = world.spawn(staff, hall, world.room(door.to.room).doors.find(({ id }) => id === door.to.door).inside);
  guard.setPlan(world, [wait(30, 'Guarding')]);
  for (let i = 0; i < 40 && creature.activity !== 'Escaping the cell'; i++) world.update(0.05);
  assert.equal(state.open, 1);
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

test('an escaped shapeshifter cannot also walk in disguised', async (t) => {
  const { world, creature, state, hall } = await setup(t, 3);
  hall.power = 'off';
  state.open = 1;
  for (let i = 0; i < 300 && creature.contained; i++) world.update(0.1);
  assert.ok(!creature.contained);
  world.spawn(staff, hall, hall.randomFloorPoint());
  const director = new EventDirector([{ ...creature.character, weight: 1 }]);
  assert.equal(director.triggerImpostor(world), false);
  assert.equal(creature.away, false);
});
