import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/lib/sim/agent.ts';
import { Creature } from '../src/lib/sim/creature.ts';
import { Room } from '../src/lib/sim/room.ts';
import { DEFAULT_STATS, STAMINA_DRAIN_PER_SECOND, STAMINA_RECOVERY_PER_SECOND, STAMINA_RECOVERY_THRESHOLD, createLiveStats, recoverStamina, resolveStats, spendStamina } from '../src/lib/sim/stats.ts';
import { toSimCharacter, toSimCreature, toSimImpostor } from '../src/lib/sim/roster.ts';

const personnel = (stats) => ({
  id: 'test.md',
  data: {
    title: 'Test',
    position: 'Researcher',
    species: 'Human',
    height: '1.75 m',
    accessLevel: 1,
    employeeID: 1,
    positiveTraits: [],
    negativeTraits: [],
    stats,
  },
});

test('default capacities start resources full, needs satisfied, and magic disabled', () => {
  const character = toSimCharacter(personnel());
  assert.deepEqual(character.stats, DEFAULT_STATS);
  const agent = new Agent(character, {}, { x: 0, y: 0 });
  assert.deepEqual(agent.stats, {
    hp: { current: 100, max: 100 },
    stamina: { current: 100, max: 100, exhausted: false },
    magic: { current: 0, max: 0 },
    hunger: { current: 0, max: 100 },
    thirst: { current: 0, max: 100 },
  });
  assert.equal(agent.hasMagic, false);
});

test('profile overrides merge independently and magic requires an explicit positive capacity', () => {
  const character = toSimCharacter(personnel({ hp: 250, magic: 75, hunger: 150 }));
  assert.deepEqual(character.stats, { hp: 250, stamina: 100, magic: 75, hunger: 150, thirst: 100 });
  const agent = new Agent(character, {}, { x: 0, y: 0 });
  assert.equal(agent.stats.hp.current, 250);
  assert.equal(agent.stats.magic.current, 75);
  assert.equal(agent.stats.hunger.current, 0);
  assert.equal(agent.stats.hunger.max, 150);
  assert.equal(agent.hasMagic, true);
  agent.stats.magic.current = 0;
  assert.equal(agent.hasMagic, true, 'being depleted does not remove magic capability');
});

test('live stat pools are independent of profiles, defaults, and other agents', () => {
  const character = toSimCharacter(personnel());
  const first = new Agent(character, {}, { x: 0, y: 0 });
  const second = new Agent(character, {}, { x: 0, y: 0 });
  first.stats.hp.current = 20;
  first.stats.thirst.current = 50;
  assert.equal(second.stats.hp.current, 100);
  assert.equal(second.stats.thirst.current, 0);
  assert.equal(character.stats.hp, 100);
  assert.equal(DEFAULT_STATS.hp, 100);
  assert.notEqual(resolveStats(), resolveStats());
});

test('impostors use entity capacities even while disguised as staff', () => {
  const impostor = toSimImpostor({
    id: 'test-entity',
    data: {
      title: 'Entity',
      nickname: 'Test',
      usefulAbilities: ['Shapeshifting'],
      noteableEvents: [],
      stats: { hp: 500, magic: 40 },
    },
  });
  const agent = new Agent(toSimCharacter(personnel()), {}, { x: 0, y: 0 }, impostor);
  assert.equal(agent.stats.hp.max, 500);
  assert.equal(agent.stats.magic.current, 40);
  assert.equal(agent.stats.stamina.max, 100);
  assert.equal(agent.hasMagic, true);
});

test('creatures get independent live pools from their entity profile capacities', () => {
  const data = { title: 'C-100', nickname: 'Echo', containmentClass: 'Containment', type: 'Creature', species: 'Lizard' };
  const creature = toSimCreature({ id: 'c-100.md', data: { ...data, stats: { hp: 300, thirst: 40 } } });
  assert.deepEqual(creature.stats, { ...DEFAULT_STATS, hp: 300, thirst: 40 });
  const cell = new Room({
    id: 'cell', name: 'cell', camera: 'cell', level: 3, width: 240, height: 160, containmentCell: true,
    nav: { floor: Array.from({ length: 160 }, () => [0, 240]), exits: [] }, props: [], links: {},
  });
  const first = new Creature(creature, cell);
  const second = new Creature(creature, cell);
  assert.deepEqual(first.stats.hp, { current: 300, max: 300 });
  assert.deepEqual(first.stats.thirst, { current: 0, max: 40 });
  assert.equal(first.hasMagic, false);
  first.stats.hp.current = 10;
  assert.equal(second.stats.hp.current, 300);
  assert.throws(() => toSimCreature({ id: 'bad.md', data: { ...data, stats: { hp: 0 } } }), /Invalid stat "hp"/);
});

test('invalid capacities fail explicitly rather than silently defaulting', () => {
  for (const key of ['hp', 'stamina', 'magic', 'hunger', 'thirst']) {
    for (const value of [-1, NaN, Infinity, -Infinity, '100', null, undefined]) {
      assert.throws(() => resolveStats({ [key]: value }), new RegExp(`Invalid stat "${key}"`));
    }
    if (key !== 'magic') assert.throws(() => createLiveStats({ [key]: 0 }), /Invalid stat/);
  }
  assert.equal(resolveStats({ magic: 0 }).magic, 0);
});

test('updates do not automatically drain or restore HP or needs', () => {
  const agent = new Agent(toSimCharacter(personnel()), {}, { x: 0, y: 0 });
  agent.stats.hp.current = 0;
  agent.stats.stamina.current = 20;
  agent.stats.hunger.current = 100;
  agent.stats.thirst.current = 100;
  const before = structuredClone(agent.stats);
  agent.setPlan({}, [{ activity: 'Waiting', interruptible: true, update: () => false }]);
  agent.update({}, 60);
  assert.deepEqual(agent.stats, before, 'the dead do not recover stamina either');
  assert.equal(agent.removed, false);
});

test('running drains stamina and exhaustion forces walking until 30% recovers', () => {
  const agent = new Agent(toSimCharacter(personnel()), {}, { x: 0, y: 0 });
  const runSpeed = agent.movementSpeed(2);
  const walkSpeed = agent.movementSpeed(1);
  const far = { x: 100000, y: 0 };
  let x = agent.x;
  agent.moveToward(far, 1, 2);
  assert.equal(agent.x - x, runSpeed);
  assert.equal(agent.stats.stamina.current, 100 - STAMINA_DRAIN_PER_SECOND);

  agent.moveToward(far, 100 / STAMINA_DRAIN_PER_SECOND, 2);
  assert.equal(agent.stats.stamina.current, 0);
  assert.equal(agent.stats.stamina.exhausted, true);
  x = agent.x;
  agent.moveToward(far, 1, 2);
  assert.equal(agent.x - x, walkSpeed, 'exhausted agents walk instead of running');
  assert.equal(agent.stats.stamina.current, 0);

  const resting = { activity: 'Resting', interruptible: true, update: () => false };
  agent.setPlan({}, [resting]);
  agent.update({}, 0);
  agent.update({}, (100 * STAMINA_RECOVERY_THRESHOLD) / STAMINA_RECOVERY_PER_SECOND - 0.5);
  assert.equal(agent.stats.stamina.exhausted, true, 'still exhausted below the threshold');
  x = agent.x;
  agent.moveToward(far, 0.1, 2);
  assert.ok(Math.abs(agent.x - x - walkSpeed * 0.1) < 1e-9);
  agent.update({}, 1);
  assert.equal(agent.stats.stamina.exhausted, false);
  x = agent.x;
  agent.moveToward(far, 0.1, 2);
  assert.ok(Math.abs(agent.x - x - runSpeed * 0.1) < 1e-9, 'running resumes at the threshold');
});

test('walking neither drains nor blocks stamina recovery', () => {
  const agent = new Agent(toSimCharacter(personnel()), {}, { x: 0, y: 0 });
  agent.stats.stamina.current = 50;
  agent.setPlan({}, [{ activity: 'Walking', interruptible: true, update: (a, _w, dt) => a.moveToward({ x: 1000, y: 0 }, dt) }]);
  agent.update({}, 1);
  assert.equal(agent.stats.stamina.current, 50 + STAMINA_RECOVERY_PER_SECOND);
  agent.update({}, 100);
  assert.equal(agent.stats.stamina.current, 100);
});

test('creatures spend stamina while dashing and recover while idle', () => {
  const stats = createLiveStats();
  assert.equal(spendStamina(stats, 100 / STAMINA_DRAIN_PER_SECOND), true);
  assert.equal(stats.stamina.exhausted, true);
  assert.equal(spendStamina(stats, 1), false);
  recoverStamina(stats, 1000);
  assert.deepEqual(stats.stamina, { current: 100, max: 100, exhausted: false });
});
