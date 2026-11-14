import assert from 'node:assert/strict';
import test from 'node:test';
import {
  behaviorFromTraits,
  canVisitLevel,
  heightToScale,
  parseHeightMeters,
  toSimCharacter,
  toSimImpostor,
} from '../src/lib/sim/roster.ts';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} ≉ ${expected}`);

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
  assert.equal(heightToScale(1.75), 1);
  assert.equal(heightToScale(6.12), 1.2);
  assert.equal(heightToScale(0.45), 0.75);
  assert.equal(heightToScale(null), 1);
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
