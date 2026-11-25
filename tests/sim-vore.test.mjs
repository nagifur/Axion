import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { Creature } from '../src/lib/sim/creature.ts';
import { Item } from '../src/lib/sim/item.ts';
import { followCameraRoom } from '../src/lib/sim/monitorFollow.ts';
import { setRandomSource } from '../src/lib/sim/random.ts';
import { toSimCharacter, toSimCreature } from '../src/lib/sim/roster.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';
import { statusPopups } from '../src/lib/sim/statusEffects.ts';
import { wait } from '../src/lib/sim/tasks.ts';
import {
  ABSORPTION_HOOKS, INSIDE_ACTIONS, VORE_TUNING, VORE_TYPES, canSwallow, createVoreProfile, huntRate, parseVoreRole,
  pickRemainsLook, pickVoreType, voreStance,
} from '../src/lib/sim/vore.ts';
import { stalk } from '../src/lib/sim/voreTasks.ts';
import { World } from '../src/lib/sim/world.ts';

const pristine = {
  tuning: structuredClone(VORE_TUNING),
  types: structuredClone(VORE_TYPES),
  actions: structuredClone(INSIDE_ACTIONS),
};

afterEach(() => {
  setRandomSource(null);
  Object.assign(VORE_TUNING, structuredClone(pristine.tuning));
  for (const [type, definition] of Object.entries(pristine.types)) Object.assign(VORE_TYPES[type], definition);
  INSIDE_ACTIONS.splice(0, INSIDE_ACTIONS.length, ...structuredClone(pristine.actions));
  ABSORPTION_HOOKS.length = 0;
});

const flatRoom = (id, cell = false) => new Room({
  id, name: id, camera: id, level: 3, width: 240, height: 160, containmentCell: cell,
  nav: { floor: Array.from({ length: 160 }, () => [0, 240]), exits: [] }, props: [], links: {},
});

/** A room cut in two by a gap nobody can cross: x < 100 and x >= 140 are separate floors. */
const splitRoom = (id) => new Room({
  id, name: id, camera: id, level: 3, width: 240, height: 160,
  nav: {
    floor: Array.from({ length: 160 }, () => [0, 100, 140, 240]),
    floorAreas: [Array.from({ length: 160 }, () => [0, 100]), Array.from({ length: 160 }, () => [140, 240])],
    exits: [],
  },
  props: [], links: {},
});

const person = (id, vorePreference, height = '1.7 m', species = 'Human') => toSimCharacter({ id, data: {
  title: id, position: 'Researcher', species, height, accessLevel: 3, employeeID: 1,
  positiveTraits: [], negativeTraits: [], vorePreference,
} });

const beast = (id, vorePreference, { height = '4 m', species = 'Lizard' } = {}) => toSimCreature({ id, data: {
  title: id, nickname: id, containmentClass: 'Safe', type: 'Creature', species, height, vorePreference,
} });

/** A quiet world: nothing random happens unless a test says so (0.99 fails every roll). */
function setup(hall = flatRoom('hall')) {
  setRandomSource(() => 0.99);
  const annex = flatRoom('annex');
  const world = new World({ rooms: [hall, annex], roster: [], creatureRoster: [] });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text, tone) => logs.push({ text, tone });
  return { world, hall, annex, logs };
}

/** Someone who stays where they are, so only the vore system moves them. */
function standing(world, room, character, at) {
  const agent = world.spawn(character, room, at);
  agent.setPlan(world, [wait(600, 'Standing')]);
  return agent;
}

function addCreature(world, room, character, at) {
  const creature = new Creature(character, room);
  creature.x = at.x;
  creature.y = at.y;
  world.creatures.push(creature);
  return creature;
}

/** Two staff members who meet the private Predator/Prey size requirement. */
function duel({ predator = ['Predator'], prey = ['Prey'], predatorHeight = '6 m', preyHeight = '1.7 m' } = {}) {
  const scene = setup();
  const pred = standing(scene.world, scene.hall, person('pred', predator, predatorHeight), { x: 100, y: 100 });
  const meal = standing(scene.world, scene.hall, person('meal', prey, preyHeight), { x: 104, y: 100 });
  return { ...scene, pred, meal };
}

const step = (world, seconds, dt = 0.1) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) world.update(dt);
};

const fighter = (role, heightMeters, hp = 1, traits = {}) => ({
  vore: createVoreProfile(role, { heightMeters, ...traits }), heightMeters, hp,
});

// --- Rules ---------------------------------------------------------------------------------------

test('profile values map onto a vore role', () => {
  for (const [values, role] of [
    [['Predator'], 'predator'], [['Pred'], 'predator'], [['prey'], 'prey'], [['Switch'], 'switch'],
    [['Predator', 'Prey'], 'switch'], [['None'], 'none'], [['Predator', 'Non-Vore'], 'none'], [[], 'none'], [undefined, 'none'],
  ]) assert.equal(parseVoreRole(values), role, JSON.stringify(values));
});

test('roster profiles carry their role, size and how much they can hold', () => {
  const slime = beast('slime', ['Predator'], { species: 'Slime', height: '{{Varies |Shapeshifting}}' });
  assert.deepEqual(slime.vore, { role: 'predator', anySize: true, capacity: 3 });
  assert.equal(slime.heightMeters, undefined);
  const giant = beast('giant', ['Predator'], { height: '{{30\'1"|9.10 m}}' });
  assert.deepEqual(giant.vore, { role: 'predator', anySize: false, capacity: 3 });
  assert.equal(giant.heightMeters, 9.1);
  assert.equal(beast('tall', ['Predator'], { height: '3 m' }).vore.capacity, 2);
  assert.deepEqual(person('human', ['Prey']).vore, { role: 'prey', anySize: false, capacity: 1 });
  assert.equal(person('human', undefined).vore.role, 'none');
  assert.deepEqual(
    createVoreProfile('predator', { species: 'Human' }, { types: { cock: 1 }, capacity: 2, anySize: true }),
    { role: 'predator', anySize: true, capacity: 2, types: { cock: 1 } },
  );
});

test('predators need the size advantage, while slimes and shapeshifters swallow anything', () => {
  const prey = fighter('prey', 1.9);
  assert.equal(canSwallow(fighter('predator', 2.4), prey), true);
  assert.equal(canSwallow(fighter('predator', 1.9), prey), false, 'same size');
  assert.equal(canSwallow(fighter('predator', 1.2), prey), false, 'smaller');
  assert.equal(canSwallow(fighter('predator', 1.2, 1, { species: 'Slime' }), prey), true);
  assert.equal(canSwallow(fighter('predator', undefined, 1, { heightVaries: true }), fighter('prey', 9)), true);
  assert.equal(canSwallow(fighter('predator', undefined), fighter('prey', undefined)), false, 'unknown heights match');
  assert.equal(canSwallow(fighter('predator', 2.4), fighter('prey', undefined)), true);
});

test('prey only swallow someone far smaller, and less often than predators do', () => {
  const small = fighter('prey', 1.5);
  const giant = fighter('prey', 9.1);
  assert.equal(canSwallow(giant, small), true);
  assert.equal(huntRate(giant, small), VORE_TUNING.huntRate.prey);
  assert.ok(huntRate(giant, small) < huntRate(fighter('predator', 2.4), small));
  assert.equal(canSwallow(fighter('prey', 4), small), false, 'big, but not three times their size');
  assert.equal(canSwallow(fighter('prey', 4.6), small), true);
  assert.equal(canSwallow(giant, fighter('predator', 1.5)), false, 'predators are not for prey to swallow');
  assert.equal(canSwallow(giant, fighter('none', 1.5)), false);
  assert.equal(canSwallow(giant, fighter('switch', 1.5)), false, 'a healthy switch is the predator against prey');
});

test('characters without a role are left out entirely', () => {
  const prey = fighter('prey', 1);
  assert.equal(canSwallow(fighter('none', 20), prey), false);
  assert.equal(canSwallow({ hp: 1, heightMeters: 20 }, prey), false, 'no profile at all');
  assert.equal(canSwallow(fighter('predator', 20), fighter('none', 1)), false);
  assert.equal(canSwallow(fighter('predator', 20), fighter('predator', 1)), false, 'predators are never swallowed');
});

test('switches act as prey when hurt and as predators when they overpower someone', () => {
  const tall = (hp) => fighter('switch', 3, hp);
  const small = (role, hp = 1) => fighter(role, 1.5, hp);
  assert.equal(voreStance(tall(1), small('prey')), 'predator');
  assert.equal(canSwallow(tall(1), small('prey')), true);
  assert.equal(huntRate(tall(1), small('prey')), VORE_TUNING.huntRate.switch);
  assert.equal(voreStance(tall(0.3), small('prey')), 'prey', 'too hurt to take the lead');
  assert.equal(canSwallow(tall(0.3), small('prey')), false);
  assert.equal(voreStance(tall(1), small('predator')), 'prey', 'a predator makes a switch prey');
  assert.equal(canSwallow(fighter('predator', 4), tall(0.3)), true);
  assert.equal(voreStance(tall(1), small('none')), null);

  const ahead = fighter('switch', 3, 0.9);
  const behind = fighter('switch', 1.5, 0.4);
  const level = fighter('switch', 1.5, 0.85);
  assert.equal(voreStance(ahead, behind), 'predator');
  assert.equal(voreStance(behind, ahead), 'prey');
  assert.equal(canSwallow(ahead, behind), true);
  assert.equal(canSwallow(behind, ahead), false);
  assert.equal(voreStance(ahead, level), null, 'neither is overpowering the other');
  assert.equal(canSwallow(ahead, level), false);
});

test('the way of swallowing follows the profile weights', () => {
  setRandomSource(() => 0);
  assert.equal(pickVoreType(undefined), 'oral');
  setRandomSource(() => 0.99);
  assert.equal(pickVoreType(undefined), 'breast');
  const profile = (types) => ({ role: 'predator', anySize: false, capacity: 1, types });
  assert.equal(pickVoreType(profile({ anal: 1 })), 'anal');
  assert.equal(pickVoreType(profile({ cock: 3, breast: 1 })), 'breast');
  setRandomSource(() => 0.5);
  assert.equal(pickVoreType(profile({ cock: 3, breast: 1 })), 'cock');
});

// --- Swallowing and being inside -----------------------------------------------------------------

test('swallowed prey leave the floor but stay in the facility, riding along with the predator', () => {
  const { world, hall, annex, logs, pred, meal } = duel();
  assert.equal(world.vore.swallow(pred, meal, 'oral'), true);
  assert.equal(meal.swallowed, true);
  assert.equal(world.agents.includes(meal), false);
  assert.equal(world.everyone().includes(meal), true);
  assert.equal(world.isPresent('meal'), true);
  assert.deepEqual(world.actorsIn(hall), [pred], 'prey have no sprite of their own');
  assert.deepEqual(world.swallowedIn(hall), [meal]);
  assert.equal(meal.statuses.has('acid'), true);
  assert.equal(meal.activity, 'Struggling inside pred');
  assert.equal(meal.exposed, false, 'not on the floor where others could get at them');
  assert.ok(logs.some(({ text, tone }) => text === 'pred swallowed meal whole (oral vore) in the hall!' && tone === 'alert'));

  pred.x = 150;
  pred.y = 90;
  pred.facing = 'left';
  world.update(1);
  assert.deepEqual([meal.x, meal.y, meal.facing, meal.room], [150, 90, 'left', hall]);
  assert.equal(meal.stats.hp.current, 100 - VORE_TUNING.acidDps, 'acid works on them every second');
  pred.alpha = 0.6;
  pred.layer = 'inside';
  world.vore.sync();
  assert.deepEqual([meal.alpha, meal.layer], [0.6, 'inside'], 'they fade and ride along through doorways and elevators');
  pred.alpha = 1;
  pred.layer = 'room';
  pred.room = annex;
  world.update(0.1);
  assert.equal(meal.room, annex);
  assert.deepEqual(world.swallowedIn(hall), []);
  assert.deepEqual(world.swallowedIn(annex), [meal]);
});

test('cameras follow swallowed prey through their predator', () => {
  const { world, annex, pred, meal } = duel();
  world.vore.swallow(pred, meal, 'oral');
  pred.room = annex;
  world.update(0.1);
  assert.equal(followCameraRoom(world, meal), annex);
  world.isRiding = (agent) => agent === pred;
  assert.equal(followCameraRoom(world, pred), null, 'a predator off camera');
  assert.equal(followCameraRoom(world, meal), null, 'takes whoever is inside it off camera too');
  world.isRiding = () => false;
  world.remove(pred, 'door');
  assert.equal(followCameraRoom(world, meal), annex, 'spat back out where the predator was');
  assert.equal(followCameraRoom(world, pred), null);
});

test('eligibility covers roles, sizes, rooms and anyone who cannot be reached', () => {
  const { world, hall, annex, pred, meal } = duel();
  assert.equal(world.vore.eligible(pred, meal), true);
  assert.equal(world.vore.eligible(meal, pred), false);
  assert.equal(world.vore.eligible(pred, pred), false);
  for (const [change, undo] of [
    [() => { meal.room = annex; }, () => { meal.room = pred.room; }],
    [() => { meal.held = true; }, () => { meal.held = false; }],
    [() => { meal.alpha = 0.5; }, () => { meal.alpha = 1; }],
    [() => { pred.alpha = 0.5; }, () => { pred.alpha = 1; }],
    [() => { meal.vore.safeFor = 5; }, () => { meal.vore.safeFor = 0; }],
  ]) {
    change();
    assert.equal(world.vore.eligible(pred, meal), false);
    undo();
    assert.equal(world.vore.eligible(pred, meal), true);
  }
  meal.statuses.apply('dead');
  assert.equal(world.vore.eligible(pred, meal), false, 'the dead are not swallowed');

  const ghost = standing(world, hall, person('boo', ['Prey'], '1.7 m', 'Ghost'), { x: 108, y: 100 });
  assert.equal(ghost.ghost, true);
  assert.equal(world.vore.eligible(pred, ghost), false, 'ghosts slip through');
  const guise = person('guise', ['Prey']);
  const disguised = world.spawn(guise, hall, { x: 112, y: 100 }, { id: 'guise', name: 'Guise', nickname: 'G', href: '', weight: 1, stats: guise.stats });
  assert.equal(world.vore.eligible(pred, disguised), false, 'a disguise is not a meal');
});

test('staff may swallow staff or security only as an unwitnessed, substantially larger Predator and Prey', () => {
  const { world, hall, annex, pred, meal } = duel({ predatorHeight: '5.1 m' });
  assert.equal(world.vore.eligible(pred, meal), true, 'exactly three times as tall is enough');
  pred.character.heightMeters = 5.09;
  pred.character.vore.anySize = true;
  assert.equal(world.vore.eligible(pred, meal), false, 'any-size profiles do not bypass the staff size rule');
  pred.character.heightMeters = 5.1;
  for (const [hunterRole, targetRole] of [
    ['switch', 'prey'], ['prey', 'prey'], ['predator', 'switch'], ['predator', 'none'],
  ]) {
    pred.character.vore.role = hunterRole;
    meal.character.vore.role = targetRole;
    assert.equal(world.vore.eligible(pred, meal), false, `${hunterRole} cannot take ${targetRole}`);
  }
  pred.character.vore.role = 'predator';
  meal.character.vore.role = 'prey';
  meal.security = { post: hall, relieved: false };
  assert.equal(world.vore.eligible(pred, meal), true, 'the same exception applies to a guard');

  const witness = standing(world, hall, person('witness', ['None']), { x: 120, y: 100 });
  witness.security = { post: hall, relieved: false };
  assert.equal(world.vore.eligible(pred, meal), false, 'a guard in the room witnesses it');
  assert.equal(world.vore.swallow(pred, meal, 'oral'), false);
  witness.security = undefined;
  assert.equal(world.vore.eligible(pred, meal), false, 'ordinary staff also witness it');
  witness.room = annex;
  addCreature(world, hall, beast('creature', ['None']), { x: 140, y: 100 });
  assert.equal(world.vore.eligible(pred, meal), true, 'other rooms and creatures do not count as staff witnesses');
  const decimal = duel({ predatorHeight: '0.3 m', preyHeight: '0.1 m' });
  assert.equal(decimal.world.vore.eligible(decimal.pred, decimal.meal), true, 'decimal heights at the exact 3:1 boundary qualify');
});

test('a staff hunt stops when a witness arrives and can resume only after the room is private', () => {
  const { world, hall, annex, pred, meal } = duel();
  meal.x = 200;
  VORE_TUNING.huntRate.predator = 1000;
  world.update(0.1);
  assert.equal(pred.activity, 'Stalking meal');
  const witness = standing(world, hall, person('witness', ['None']), { x: 160, y: 100 });
  step(world, 4);
  assert.equal(meal.swallowed, false);
  assert.equal(world.vore.active.length, 0);
  witness.room = annex;
  step(world, 4);
  assert.equal(meal.swallowed, true);
});

test('a switch only swallows while it is healthy', () => {
  const { world, hall } = setup();
  const pred = standing(world, hall, person('pred', ['Switch'], '2.4 m'), { x: 100, y: 100 });
  const meal = addCreature(world, hall, beast('meal', ['Prey'], { height: '1.7 m' }), { x: 104, y: 100 });
  assert.equal(world.vore.eligible(pred, meal), true);
  pred.stats.hp.current = 20;
  assert.equal(world.vore.eligible(pred, meal), false);
  assert.equal(world.vore.eligible(meal, pred), false);
});

test('predators hold as many prey as their size allows, and nobody gets nested', () => {
  const { world, hall } = setup();
  const pred = standing(world, hall, person('pred', ['Predator'], '3.2 m'), { x: 100, y: 100 });
  const meal = addCreature(world, hall, beast('meal', ['Prey'], { height: '1 m' }), { x: 104, y: 100 });
  const second = addCreature(world, hall, beast('second', ['Prey'], { height: '1 m' }), { x: 110, y: 100 });
  const third = addCreature(world, hall, beast('third', ['Prey'], { height: '1 m' }), { x: 116, y: 100 });
  assert.equal(pred.character.vore.capacity, 2);
  assert.equal(world.vore.swallow(pred, meal, 'oral'), true);
  assert.equal(world.vore.swallow(pred, second, 'oral'), true);
  assert.equal(world.vore.swallow(pred, third, 'oral'), false, 'full');
  assert.deepEqual(world.swallowedIn(hall), [meal, second]);

  const giant = addCreature(world, hall, beast('giant', ['Predator'], { height: '9 m' }), { x: 90, y: 100 });
  assert.equal(world.vore.eligible(giant, meal), false, 'already inside someone');
  const holder = addCreature(world, hall, beast('holder', ['Switch'], { height: '2.5 m' }), { x: 120, y: 100 });
  assert.equal(world.vore.eligible(giant, holder), true);
  assert.equal(world.vore.swallow(holder, third, 'oral'), true);
  assert.equal(world.vore.eligible(giant, holder), false, 'busy holding prey');
});

test('struggling can make the predator spit its prey back out', () => {
  const { world, hall, logs, pred, meal } = duel();
  world.vore.swallow(pred, meal, 'anal');
  const { action } = meal.vore.inside;
  assert.equal(action.id, 'struggle');
  assert.ok(action.escapeChance > 0 && action.escapeChance <= 0.1, 'a low chance');

  world.vore.update(action.remaining + 0.1);
  assert.equal(meal.swallowed, true, 'unlucky: another go');
  assert.notEqual(meal.vore.inside.action, action);

  setRandomSource(() => 0);
  world.time = 30;
  world.vore.update(meal.vore.inside.action.remaining + 0.1);
  assert.equal(meal.swallowed, false);
  assert.equal(world.vore.active.length, 0);
  assert.equal(pred.vore.contents.length, 0);
  assert.equal(world.agents.includes(meal), true);
  assert.equal(meal.room, hall);
  assert.equal(meal.alpha, 1);
  assert.equal(meal.enteredRoomAt, 30, 'counts as just having arrived');
  assert.ok(meal.shake > 0, 'shaken up');
  assert.notDeepEqual([meal.x, meal.y], [pred.x, pred.y], 'lands beside the predator');
  assert.equal(meal.statuses.has('acid'), false);
  assert.equal(meal.statuses.has('scared'), true);
  assert.equal(meal.activity, 'Recovering from pred');
  assert.ok(logs.some(({ text, tone }) => text === 'pred spat meal back out in the hall.' && tone === 'ok'));
  setRandomSource(() => 0.99);
  step(world, 1);
  assert.equal(meal.activity, 'Recovering from pred', 'too dazed to walk off straight away');
});

test('spat-out prey are safe from being swallowed again for a while', () => {
  const { world, pred, meal } = duel();
  world.vore.swallow(pred, meal, 'oral');
  assert.equal(world.vore.spitOut(meal), true);
  assert.equal(world.vore.spitOut(meal), false, 'nothing left to spit out');
  assert.equal(meal.vore.safeFor, VORE_TUNING.safeAfterSpit);
  assert.equal(world.vore.eligible(pred, meal), false);
  assert.equal(world.vore.swallow(pred, meal, 'oral'), false);
  world.vore.update(VORE_TUNING.safeAfterSpit + 1);
  assert.equal(world.vore.eligible(pred, meal), true);
});

// --- Digestion, absorption and remains ----------------------------------------------------------

test('oral and anal vore randomly leave bones or droppings', () => {
  setRandomSource(() => 0);
  assert.equal(pickRemainsLook('oral'), 'bones');
  assert.equal(pickRemainsLook('anal'), 'bones');

  setRandomSource(() => 0.99);
  assert.equal(pickRemainsLook('oral'), 'droppings');
  assert.equal(pickRemainsLook('anal'), 'droppings');
});

for (const [type, status, label, look] of [
  ['oral', 'digested', 'Digested', 'bones'],
  ['cock', 'cumified', 'Cumified', 'cum'],
  ['anal', 'digested', 'Digested', 'droppings'],
  ['breast', 'milkified', 'Milkified', 'milk'],
]) {
  test(`${type} vore digests prey`, () => {
    const { world, logs, pred, meal } = duel();
    Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 2 });
    assert.equal(world.vore.swallow(pred, meal, type), true);
    world.update(0.1);
    assert.ok(Math.abs(meal.stats.hp.current - 80) < 1e-9);
    assert.equal(meal.dead, false);
    world.update(0.6);
    assert.equal(meal.dead, true);
    assert.equal(meal.statuses.has(status), true);
    assert.equal(meal.statuses.has('acid'), false);
    assert.equal(world.vore.active[0].stage, 'absorbing');
    assert.equal(meal.activity, 'Being absorbed by pred');
    assert.equal(world.vore.spitOut(meal), false, 'too late to spit out');
    assert.deepEqual(statusPopups(meal.statuses.active).map(({ id }) => id), [status], 'it replaces the death popup');
    assert.ok(logs.some(({ text, tone }) => text === `meal was ${label.toLowerCase()} by pred.` && tone === 'warn'));

    world.update(2.1);
    const [remains] = pred.vore.remains;
    const expectedLooks = type === 'oral' || type === 'anal' ? ['bones', 'droppings'] : [look];
    assert.equal(remains.type, type);
    assert.ok(expectedLooks.includes(remains.look));
    assert.equal(remains.asset, `remains:${remains.look}`);
  });
}

test('absorbing digested prey heals the predator bit by bit', () => {
  const { world, pred, meal } = duel();
  Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 10 });
  pred.stats.hp.current = 20;
  world.vore.swallow(pred, meal, 'oral');
  world.update(0.6);
  assert.equal(pred.stats.hp.current, 20, 'nothing yet while the acid works');
  world.update(2);
  assert.ok(Math.abs(pred.stats.hp.current - 40) < 1e-9);
  world.update(2);
  assert.ok(Math.abs(pred.stats.hp.current - 60) < 1e-9);
  world.update(10);
  assert.equal(pred.stats.hp.current, 100, 'capped at their maximum');
  assert.equal(world.vore.active.length, 0);
});

test('absorbed agents stop being agents but leave their profile, items and name as remains', () => {
  const { world, logs, pred, meal } = duel();
  Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 2 });
  const removed = [];
  world.hooks.removed = (agent) => removed.push(agent);
  const can = Item.create('can');
  meal.receiveItem(can);
  const [card] = meal.inventory;
  world.vore.swallow(pred, meal, 'oral');
  world.update(0.6);
  assert.equal(meal.item, can, 'their belongings stay with them while they are digested');
  world.update(2.1);

  assert.equal(meal.removed, true);
  assert.equal(world.everyone().includes(meal), false);
  assert.equal(world.isPresent('meal'), false);
  assert.deepEqual(removed, [meal]);
  assert.equal(world.vore.consumed.has('meal'), true);
  assert.equal(meal.item, null);
  assert.equal(meal.inventory.length, 0);
  const [remains] = pred.vore.remains;
  assert.deepEqual([remains.id, remains.name, remains.kind], ['meal', 'meal', 'agent']);
  assert.equal(remains.character, meal.character);
  assert.deepEqual(remains.items, [can, card]);
  assert.ok(logs.some(({ text, tone }) => text === 'meal was absorbed by pred.' && tone === 'warn'));

  const other = person('other', ['Prey']);
  world.roster.push(meal.character);
  setRandomSource(() => 0);
  assert.equal(world.pickArrival(), undefined, 'absorbed characters never arrive again');
  world.roster.push(other);
  assert.equal(world.pickArrival(), other);
});

test('predators get rid of remains later, dropping a pile and everything the prey carried', () => {
  const { world, hall, logs, pred, meal } = duel();
  Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 1, disposalDelay: { min: 5, max: 5 } });
  const can = Item.create('can');
  meal.receiveItem(can);
  const [card] = meal.inventory;
  world.vore.swallow(pred, meal, 'cock');
  world.update(0.6);
  world.update(1.1);
  assert.equal(pred.vore.remains.length, 1);
  assert.equal(hall.remains.length, 0, 'kept for a while');
  world.update(3);
  assert.equal(pred.vore.remains.length, 1);
  world.update(1.5);

  assert.equal(pred.vore.remains.length, 0);
  assert.equal(hall.remains.length, 1);
  const [pile] = hall.remains;
  assert.equal(pile.id, 'meal');
  assert.deepEqual([pile.x, pile.y], [pred.x, pred.y], 'at the predator\'s feet');
  assert.equal(pile.items.length, 0, 'the items belong to the floor now');
  assert.equal(hall.items.length, 2);
  assert.ok(hall.items.includes(can) && hall.items.includes(card));
  assert.notDeepEqual([can.x, can.y], [card.x, card.y]);
  for (const item of hall.items) assert.ok(hall.isWalkable({ x: item.x + item.w / 2, y: item.y + item.h }));
  assert.ok(logs.some(({ text, tone }) => text === 'pred got rid of meal\'s remains in the hall.' && tone === 'muted'));
});

test('absorption hooks, inside actions and per-type multipliers are the places to customize', () => {
  const { world, pred, meal } = duel();
  const events = [];
  ABSORPTION_HOOKS.push((event) => events.push(event));
  INSIDE_ACTIONS.push({ id: 'plead', label: 'Pleading', weight: 1000, duration: { min: 2, max: 2 } });
  Object.assign(VORE_TUNING, { acidDps: 10, absorbSeconds: 4, healFraction: 0.5 });
  Object.assign(VORE_TYPES.breast, { digestion: 2, absorption: 2 });
  pred.stats.hp.current = 10;

  world.vore.swallow(pred, meal, 'breast');
  assert.equal(meal.activity, 'Pleading inside pred');
  world.update(1);
  assert.equal(meal.stats.hp.current, 80, 'twice the acid');
  meal.stats.hp.current = 0;
  world.update(0.1);
  world.update(1);
  assert.ok(Math.abs(pred.stats.hp.current - 35) < 1e-9, 'half the prey\'s health over half the time');
  assert.equal(events.length, 0);
  world.update(1.5);
  assert.ok(Math.abs(pred.stats.hp.current - 60) < 1e-9);
  assert.deepEqual(events, [{ predator: pred, prey: meal, type: 'breast' }]);
});

// --- Leaving, dying and other loose ends ---------------------------------------------------------

test('a predator that leaves or dies lets its prey go', () => {
  let scene = duel();
  scene.world.vore.swallow(scene.pred, scene.meal, 'oral');
  scene.world.remove(scene.pred, 'elevator');
  assert.equal(scene.meal.swallowed, false);
  assert.equal(scene.world.agents.includes(scene.meal), true);
  assert.equal(scene.meal.statuses.has('acid'), false);
  assert.equal(scene.world.vore.active.length, 0);

  scene = duel();
  scene.world.vore.swallow(scene.pred, scene.meal, 'oral');
  scene.pred.statuses.apply('dead');
  assert.equal(scene.world.vore.eligible(scene.pred, scene.meal), false);
  scene.world.update(0.1);
  assert.equal(scene.meal.swallowed, false);
  assert.equal(scene.world.agents.includes(scene.meal), true);

  scene = duel();
  Object.assign(VORE_TUNING, { acidDps: 200 });
  scene.world.vore.swallow(scene.pred, scene.meal, 'oral');
  scene.world.update(0.6);
  scene.world.remove(scene.pred, 'elevator');
  assert.equal(scene.meal.removed, true, 'the digested are absorbed on the way out');
  assert.equal(scene.hall.remains.length, 1, 'and their remains are dropped on the spot');
  assert.equal(scene.world.vore.consumed.has('meal'), true);

  scene = duel();
  Object.assign(VORE_TUNING, { absorbSeconds: 1, disposalDelay: { min: 600, max: 600 } });
  scene.world.vore.swallow(scene.pred, scene.meal, 'oral');
  scene.world.update(0.6);
  scene.world.update(1.1);
  assert.equal(scene.pred.vore.remains.length, 1, 'still waiting for a good moment');
  scene.pred.statuses.apply('dead');
  scene.world.update(0.1);
  assert.equal(scene.pred.vore.remains.length, 0, 'a predator that dies leaves the remains where it fell');
  assert.equal(scene.hall.remains.length, 1);
});

test('swallowing a guard has the post staffed again, and whoever they were escorting is let go', () => {
  const { world, hall } = setup();
  const pred = addCreature(world, hall, beast('pred', ['Predator']), { x: 100, y: 100 });
  const meal = standing(world, hall, person('guard', ['Prey']), { x: 104, y: 100 });
  const thing = addCreature(world, hall, beast('thing', ['None'], { height: '1 m' }), { x: 120, y: 100 });
  meal.security = { post: hall, relieved: false, target: thing };
  thing.escort = meal;
  const staffed = [];
  world.elevatorFor = () => ({});
  world.staffSecurityPost = (post) => staffed.push(post);
  assert.equal(world.vore.swallow(pred, meal, 'oral'), true);
  assert.deepEqual(staffed, [hall]);
  assert.equal(thing.escort, undefined);
  assert.equal(meal.security.target, undefined);
});

test('creature prey leave their cell until spat out, and are gone for good once absorbed', () => {
  const { world, hall, logs, pred } = duel();
  const creature = addCreature(world, hall, beast('thing', ['Prey'], { height: '1 m' }), { x: 110, y: 100 });
  Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 1 });
  assert.equal(world.vore.swallow(pred, creature, 'oral'), true);
  assert.equal(creature.swallowed, true);
  assert.equal(creature.onCamera, false);
  assert.equal(creature.contained, false);
  assert.deepEqual(world.creaturesIn(hall), []);
  assert.deepEqual(world.swallowedIn(hall), [creature]);
  world.recontain(creature);
  assert.ok(!logs.some(({ text }) => text.startsWith('Containment restored')), 'nobody can return what is inside someone');

  pred.alpha = 0.6;
  world.vore.sync();
  assert.equal(creature.alpha, 0.6, 'fades with its predator');
  assert.equal(world.vore.spitOut(creature), true);
  pred.alpha = 1;
  assert.equal(creature.alpha, 1, 'solid again once it is out');
  assert.equal(creature.swallowed, false);
  assert.deepEqual(world.creaturesIn(hall), [creature]);
  assert.equal(creature.vore.safeFor, VORE_TUNING.safeAfterSpit);

  creature.vore.safeFor = 0;
  world.vore.swallow(pred, creature, 'oral');
  world.update(0.6);
  assert.equal(creature.dead, true);
  assert.equal(creature.statuses.has('digested'), true);
  assert.equal(creature.activity, 'Being absorbed by pred');
  world.update(1.1);
  assert.equal(creature.consumed, true);
  assert.equal(creature.activity, 'Consumed');
  assert.equal(world.vore.consumed.has('thing'), true);
  const [remains] = pred.vore.remains;
  assert.equal(remains.id, 'thing');
  assert.equal(remains.kind, 'creature');
  assert.ok(['bones', 'droppings'].includes(remains.look));
  assert.deepEqual(world.creaturesIn(hall), []);
});

test('a creature absorbed by a predator no longer holds up a containment failure', () => {
  const { world, hall } = setup();
  const lost = addCreature(world, hall, beast('lost', ['Prey']), { x: 50, y: 80 });
  const kept = addCreature(world, hall, beast('kept', ['Prey']), { x: 60, y: 80 });
  lost.consumed = true;
  const level = world.level(3);
  level.startEvent('containment-failure');
  world.update(0.1);
  assert.equal(level.hasEvent('containment-failure'), true, 'the other resident still has to be returned');
  kept.consumed = true;
  world.update(0.1);
  assert.equal(level.hasEvent('containment-failure'), false);

  const empty = setup();
  addCreature(empty.world, empty.hall, beast('gone', ['Prey']), { x: 50, y: 80 }).consumed = true;
  const failure = empty.world.level(3);
  failure.startEvent('containment-failure');
  assert.equal(failure.hasEvent('containment-failure'), false, 'with nobody left to return, it is over before it starts');
});

// --- Hunting -------------------------------------------------------------------------------------

test('predators go after prey they could swallow, and swallow them once they are close', () => {
  const { world, logs, pred, meal } = duel();
  meal.x = 190;
  pred.character.vore.types = { anal: 1 };
  VORE_TUNING.huntRate.predator = 1000;
  world.update(0.1);
  assert.ok(logs.some(({ text, tone }) => text === 'pred is stalking meal in the hall.' && tone === 'warn'));
  assert.equal(pred.activity, 'Stalking meal');
  for (let i = 0; i < 100 && !meal.swallowed; i++) world.update(0.1);
  assert.equal(meal.swallowed, true);
  assert.equal(pred.vore.contents[0].type, 'anal', 'the way it picked when it set out');
  assert.ok(Math.hypot(pred.x - 190, pred.y - 100) <= VORE_TUNING.reach + 0.001, 'it walked over to them');
  world.update(0.1);
  assert.equal(pred.activity, 'Swallowing meal');
  assert.ok(pred.vore.cooldown >= VORE_TUNING.cooldown.min && pred.vore.cooldown <= VORE_TUNING.cooldown.max);
});

test('nobody hunts without the role and size to swallow', () => {
  for (const [hunter, target] of [
    [person('a', ['Predator'], '1.7 m'), person('b', ['Prey'], '1.9 m')],
    [person('a', ['Predator'], '2.4 m'), person('b', ['Predator'], '1.7 m')],
    [person('a', ['Predator'], '2.4 m'), person('b', ['None'], '1.7 m')],
    [person('a', ['None'], '2.4 m'), person('b', ['Prey'], '1.7 m')],
    [person('a', ['Prey'], '2.4 m'), person('b', ['Prey'], '1.7 m')],
    [person('a', ['Switch'], '2.4 m'), person('b', ['Switch'], '1.7 m')],
  ]) {
    const { world, hall, logs } = setup();
    VORE_TUNING.huntRate = { predator: 1000, switch: 1000, prey: 1000 };
    const first = standing(world, hall, hunter, { x: 100, y: 100 });
    const second = standing(world, hall, target, { x: 130, y: 100 });
    step(world, 3);
    assert.equal(world.vore.active.length, 0, `${hunter.vore.role} (${hunter.heightMeters} m) vs ${target.vore.role}`);
    assert.ok(!logs.some(({ text }) => text.includes('stalking')));
    assert.deepEqual([first.swallowed, second.swallowed], [false, false]);
  }
});

test('slimes and prey giants hunt as well, while the default rates keep it occasional', () => {
  const { world, hall, logs } = setup();
  const slime = addCreature(world, hall, beast('Slime', ['Predator'], { height: '0.5 m', species: 'Slime' }), { x: 100, y: 100 });
  const meal = standing(world, hall, person('meal', ['Prey'], '1.9 m'), { x: 120, y: 100 });
  step(world, 10);
  assert.equal(meal.swallowed, false, 'at 2%/s it hasn\'t decided yet');
  assert.equal(world.vore.eligible(slime, meal), true, 'but being small doesn\'t stop a slime');
  VORE_TUNING.huntRate.predator = 1000;
  step(world, 3);
  assert.equal(meal.swallowed, true);
  assert.ok(logs.some(({ text }) => text === 'Slime is stalking meal in the hall.'));

  const giant = addCreature(world, hall, beast('giant', ['Prey'], { height: '9.1 m' }), { x: 100, y: 120 });
  const tiny = standing(world, hall, person('tiny', ['Prey'], '1.5 m'), { x: 108, y: 120 });
  assert.equal(world.vore.eligible(giant, tiny), true);
  assert.equal(world.vore.eligible(tiny, giant), false);
});

test('swallowers wait out their cooldown between catches', () => {
  const { world, hall, logs, pred, meal } = duel();
  VORE_TUNING.cooldown = { min: 5, max: 5 };
  world.vore.swallow(pred, meal, 'oral');
  const second = standing(world, hall, person('second', ['Prey']), { x: 130, y: 100 });
  VORE_TUNING.huntRate.predator = 1000;
  step(world, 4.5);
  assert.equal(second.swallowed, false);
  assert.ok(!logs.some(({ text }) => text.includes('stalking')));
  step(world, 1);
  assert.ok(logs.some(({ text }) => text === 'pred is stalking second in the hall.'));
});

test('guards on duty never go hunting, and may once they are off it', () => {
  const { world, hall, pred, meal } = duel();
  VORE_TUNING.huntRate.predator = 1000;
  pred.security = { post: hall, relieved: false };
  step(world, 3);
  assert.equal(world.vore.active.length, 0);
  assert.equal(meal.swallowed, false);
  pred.security = undefined;
  step(world, 3);
  assert.equal(meal.swallowed, true);
});

test('prey across a gap in the floor are not hunted until they can be reached', () => {
  const { world, hall, logs } = setup(splitRoom('hall'));
  VORE_TUNING.huntRate.predator = 1000;
  const pred = standing(world, hall, person('pred', ['Predator'], '6 m'), { x: 50, y: 100 });
  const far = standing(world, hall, person('far', ['Prey']), { x: 190, y: 100 });
  step(world, 3);
  assert.equal(world.vore.eligible(pred, far), true, 'they are fair game, just out of reach');
  assert.ok(!logs.some(({ text }) => text.includes('stalking')));
  far.x = 80;
  step(world, 1);
  assert.ok(logs.some(({ text }) => text === 'pred is stalking far in the hall.'));
});

test('a stalker gives up when its prey can no longer be had', () => {
  const { world, pred, meal } = duel();
  meal.x = 200;
  pred.setPlan(world, [stalk(meal, 'oral'), wait(600, 'Standing')]);
  world.update(0.1);
  assert.equal(pred.activity, 'Stalking meal');
  meal.held = true;
  meal.x = pred.x + 5;
  world.update(0.1);
  meal.held = false;
  step(world, 2);
  assert.equal(meal.swallowed, false);
  assert.equal(world.vore.active.length, 0);
});

test('a creature stalker gives up when its prey can no longer be had, or it takes too long', () => {
  const { world, hall, meal } = duel();
  const maw = addCreature(world, hall, beast('maw', ['Predator']), { x: 10, y: 100 });
  meal.x = 230;
  maw.startHunt(meal, 'oral');
  world.update(0.1);
  assert.equal(maw.activity, 'Hunting meal');
  meal.held = true;
  world.update(0.1);
  assert.notEqual(maw.activity, 'Hunting meal', 'someone else got to them first');
  meal.held = false;

  VORE_TUNING.huntTimeout = 0.3;
  maw.startHunt(meal, 'oral');
  world.update(0.1);
  assert.equal(maw.activity, 'Hunting meal');
  step(world, 0.5);
  assert.notEqual(maw.activity, 'Hunting meal', 'they got away');
  assert.equal(meal.swallowed, false);
});

test('creature predators stalk their prey and swallow them', () => {
  const { world, hall, logs, meal } = duel();
  world.vore.eligible = world.vore.eligible.bind(world.vore);
  const maw = addCreature(world, hall, beast('maw', ['Predator'], { height: '4 m' }), { x: 40, y: 100 });
  meal.x = 140;
  maw.startHunt(meal, 'cock');
  assert.equal(maw.activity, 'Hunting meal');
  for (let i = 0; i < 150 && !meal.swallowed; i++) world.update(0.1);
  assert.equal(meal.swallowed, true);
  assert.equal(maw.vore.contents[0].type, 'cock');
  assert.ok(logs.some(({ text }) => text === 'maw swallowed meal whole (cock vore) in the hall!'));
  assert.deepEqual(world.actorsIn(hall).includes(meal), false);
  for (let i = 0; i < 20; i++) {
    world.update(0.1);
    assert.deepEqual([meal.x, meal.y], [maw.x, maw.y], 'prey stay put inside');
  }
});

// --- Display --------------------------------------------------------------------------------------

test('acid has a plain green popup, and the converted statuses replace the death popup', () => {
  const [acid] = statusPopups([{ id: 'acid', label: 'Acid', remaining: null }]);
  assert.equal(acid.color, '#3dff5a');
  assert.equal(acid.icon, undefined);
  const dead = { id: 'dead', label: 'Dead', remaining: null };
  assert.deepEqual(statusPopups([dead]).map(({ id }) => id), ['dead']);
  for (const id of ['digested', 'cumified', 'milkified']) {
    assert.deepEqual(statusPopups([dead, { id, label: id, remaining: null }]).map((popup) => popup.id), [id]);
  }
});

// --- A real room ---------------------------------------------------------------------------------

test('the whole lifecycle plays out in a real facility room', async () => {
  setRandomSource(() => 0.99);
  const room = new Room(await loadRoom('level-1-offices'));
  const world = new World({ rooms: [room], roster: [], creatureRoster: [], now: () => new Date(2026, 0, 1, 9) });
  world.arrive = () => undefined;
  const pred = standing(world, room, person('pred', ['Predator'], '6 m'), room.randomFloorPoint());
  const meal = standing(world, room, person('meal', ['Prey']), { x: pred.x + 6, y: pred.y });
  Object.assign(VORE_TUNING, { acidDps: 50, absorbSeconds: 4, disposalDelay: { min: 2, max: 2 } });
  assert.equal(world.vore.swallow(pred, meal, 'oral'), true);
  step(world, 20);
  assert.equal(meal.removed, true);
  assert.equal(room.remains.length, 1);
  const [pile] = room.remains;
  assert.ok(room.isWalkable(pile), 'the pile is dropped on open floor');
  assert.equal(room.items.length, 1, 'their access card was left beside it');
  assert.equal(world.vore.active.length, 0);
});
