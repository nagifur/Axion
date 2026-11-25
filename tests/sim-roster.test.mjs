import assert from 'node:assert/strict';
import test from 'node:test';
import { generateNpc } from '../src/lib/sim/npc.ts';
import { seededRandom, setRandomSource } from '../src/lib/sim/random.ts';
import {
  behaviorFromTraits,
  BEHAVIOR_RULES,
  canVisitLevel,
  heightToScale,
  parseHeightMeters,
  toSimCharacter,
  toSimCreature,
  toSimImpostor,
  SIM_OVERRIDES,
} from '../src/lib/sim/roster.ts';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} ≉ ${expected}`);

test('procedural personnel get reproducible names, traits and capacities independently of their job', (t) => {
  t.after(() => setRandomSource(null));
  const batch = () => {
    setRandomSource(seededRandom(29));
    return Array.from({ length: 12 }, (_, i) => generateNpc(i + 1, { position: 'Caretaker', accessLevel: '2' }));
  };
  const crew = batch();
  assert.deepEqual(crew, batch());
  for (const key of ['name', 'traits', 'stats']) {
    assert.ok(new Set(crew.map((npc) => JSON.stringify(npc[key]))).size > 1, key);
  }
  for (const npc of crew) {
    assert.equal(npc.position, 'Caretaker');
    assert.equal(npc.href, undefined);
    assert.equal(npc.scale, heightToScale(null));
    assert.deepEqual(npc.behavior, behaviorFromTraits(npc.traits, npc.species));
  }
});

test('parses the height formats used in profiles', () => {
  close(parseHeightMeters('{{5\'7"|1.70 m}}'), 1.7);
  close(parseHeightMeters('172 cm'), 1.72);
  close(parseHeightMeters('{{5\'8" | 178.78 cm}}'), 1.7878);
  close(parseHeightMeters("5'5"), 1.651);
  close(parseHeightMeters("{{7' 0''|2.13 m}}"), 2.13);
  close(parseHeightMeters('{{2inch up to 7ft |5cm up to 2.1m}}'), 2.1);
  assert.equal(parseHeightMeters('█████'), null);
  assert.equal(parseHeightMeters(undefined), null);
});

test('clamps sprite scale so giants and tiny staff stay readable', () => {
  assert.equal(heightToScale(1.9), 0.85);
  assert.equal(heightToScale(6.12), 1.2);
  assert.equal(heightToScale(0.45), 0.5);
  for (const height of [null, 0, NaN, Infinity]) {
    assert.equal(heightToScale(height), 0.85);
  }
});

test('short, typical and tall profiles stay distinct for both staff and creatures', () => {
  const scales = [1.2, 1.7, 1.9, 2.13, 2.6].map((meters) => {
    const height = `${meters} m`;
    const staff = toSimCharacter(personnel('test', { height }));
    const creature = toSimCreature({
      id: 'test',
      data: { title: 'Test', type: 'Creature', containmentClass: 'Containment', species: 'Human', nickname: '', height },
    });
    assert.equal(creature.scale, staff.scale);
    return staff.scale;
  });
  assert.deepEqual(scales, [0.54, 0.76, 0.85, 0.95, 1.16]);
  assert.ok(scales.at(-1) / scales[0] > 2, 'tall and short profiles differ by more than 2x');
});

test('derives behaviour from profile traits', () => {
  const somni = behaviorFromTraits(['Strong', 'Sleepy', 'Short']);
  assert.ok(somni.napChance > 0.5);

  const nagi = behaviorFromTraits(['Friendly', 'Clumsy', 'Slow']);
  assert.equal(nagi.clumsy, true);
  assert.equal(nagi.speed, 0.75);
  assert.ok(nagi.social > 0.5);

  const skye = behaviorFromTraits(['Smart', 'Anti-Social']);
  assert.ok(skye.social < 0.2);

  assert.equal(behaviorFromTraits(['Immortal', 'Can phase through objects'], 'Ghost').ghost, true);
  assert.equal(behaviorFromTraits([], ' Feline ').meow, 1);
  assert.equal(behaviorFromTraits([], 'Catfolk').meow, 0.1, 'species must match exactly');
  const conflicting = behaviorFromTraits(['Fast', 'Slow', 'Friendly', 'Shy']);
  assert.equal(conflicting.speed, 0.75);
  assert.equal(conflicting.social, 0.1);
});

test('behaviour rules can be extended and character overrides take final precedence', (t) => {
  const length = BEHAVIOR_RULES.length;
  t.after(() => {
    BEHAVIOR_RULES.length = length;
    delete SIM_OVERRIDES['custom-behavior'];
  });
  BEHAVIOR_RULES.push({ species: /robot/i, traits: /turbo/i, values: { speed: 2, social: 0 } });
  assert.equal(behaviorFromTraits(['Turbo'], 'Robot').speed, 2);
  assert.equal(behaviorFromTraits(['Turbo'], 'Human').speed, 1, 'all conditions must match');
  SIM_OVERRIDES['custom-behavior'] = { behavior: { speed: 0.6 }, vore: { role: 'switch' } };
  const character = toSimCharacter(personnel('custom-behavior', { negativeTraits: ['Fast'] }));
  assert.equal(character.behavior.speed, 0.6);
  assert.equal(character.vore.role, 'switch', 'simulation settings can override a missing profile role');
  character.behavior.speed = 3;
  assert.equal(toSimCharacter(personnel('custom-behavior')).behavior.speed, 0.6, 'instances do not mutate definitions');
});

const personnel = (id, data = {}) => ({
  id,
  data: {
    title: 'Test',
    position: 'Caretaker ',
    species: 'Feline',
    height: '1.75 m',
    accessLevel: 3,
    employeeID: 1234,
    positiveTraits: [],
    negativeTraits: [],
    ...data,
  },
});

test('builds characters and skips wanted or excluded staff', () => {
  const character = toSimCharacter(personnel('nagi.md'), '', '/thumb.webp');
  assert.equal(character.id, 'nagi');
  assert.equal(character.href, '/Personnel/nagi');
  assert.equal(character.position, 'Caretaker');
  assert.equal(character.accessLevel, '3');
  assert.equal(character.image, '/thumb.webp');

  assert.equal(toSimCharacter(personnel('canvas.md', { wanted: { status: 'Wanted' } })), null);
  assert.equal(toSimCharacter(personnel('mellisa.md')), null);
  assert.equal(toSimCharacter(personnel('sypher.md')).weight, 0.15);
});

test('per-character starting items pass through to the simulation loadout', (t) => {
  t.after(() => { delete SIM_OVERRIDES['test-loadout']; });
  SIM_OVERRIDES['test-loadout'] = { startingItems: ['can', 'can'] };
  assert.deepEqual(toSimCharacter(personnel('test-loadout')).startingItems, ['can', 'can']);
});

test('floor preferences follow numeric clearance, with admin and unknown handling', () => {
  for (const clearance of [0, 1, 2, 3, 4, 5]) {
    const character = toSimCharacter(personnel('test', { accessLevel: clearance }));
    for (let level = 0; level <= 5; level++) {
      assert.equal(canVisitLevel(character, level), level <= clearance);
    }
  }
  for (const accessLevel of ['Admin', ' admin ']) {
    assert.equal(canVisitLevel(toSimCharacter(personnel('test', { accessLevel })), 5), true);
  }
  for (const accessLevel of ['█████', '', 'None', '-1', '3.5']) {
    const character = toSimCharacter(personnel('test', { accessLevel }));
    assert.equal(canVisitLevel(character, 1), true);
    assert.equal(canVisitLevel(character, 2), false);
  }
});

test('only shapeshifting entities can pose as staff', () => {
  const entity = (id, usefulAbilities, noteableEvents = []) => ({
    id,
    data: { title: id.toUpperCase(), nickname: 'Nick', usefulAbilities, noteableEvents },
  });
  const carny = toSimImpostor(entity('m-779', ['Shapeshifting', 'Mass Confusion'], ['Keeps Escaping']));
  assert.equal(carny.href, '/Entities/m-779');
  assert.equal(carny.weight, 1);
  assert.equal(toSimImpostor(entity('m-031', ['Shapeshifting'], ['Escaped containment'])).weight, 0.15);
  assert.equal(toSimImpostor(entity('c-282', ['Exceptional hearing'])), null);
});
