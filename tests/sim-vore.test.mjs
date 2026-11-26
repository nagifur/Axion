import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { ATTACK_CHANCE, CREATURE_TUNING, Creature } from '../src/lib/sim/creature.ts';
import { Item } from '../src/lib/sim/item.ts';
import { MonitorFile } from '../src/lib/sim/monitorFile.ts';
import { followCameraRoom } from '../src/lib/sim/monitorFollow.ts';
import { setRandomSource } from '../src/lib/sim/random.ts';
import { Remains } from '../src/lib/sim/remains.ts';
import { planRemainsDisposal } from '../src/lib/sim/remainsDisposal.ts';
import { Renderer } from '../src/lib/sim/render.ts';
import { toSimCharacter, toSimCreature } from '../src/lib/sim/roster.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';
import { STATUS_EFFECTS, statusPopups } from '../src/lib/sim/statusEffects.ts';
import { wait, walkTo } from '../src/lib/sim/tasks.ts';
import {
  ABSORPTION_HOOKS, INSIDE_ACTIONS, VORE_PROFILE_RULES, VORE_STAFF_RULES, VORE_TUNING, VORE_TYPES, canSwallow, createVoreProfile, fighterOf, huntRate, parseVoreRole,
  pickInsideAction, pickRemainsOutcome, pickVoreType, voreStance,
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
  for (const [type, definition] of Object.entries(pristine.types)) Object.assign(VORE_TYPES[type], structuredClone(definition));
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

function holdRemains(predator, prey, type = 'oral', waitSeconds = 0) {
  const definition = VORE_TYPES[type];
  const outcome = definition.looks.find(({ converted }) => !converted);
  const remains = new Remains({
    actor: prey, kind: 'agent', type, look: outcome.look, label: outcome.label,
    disposal: outcome.disposal ?? definition.disposal, items: [], wait: waitSeconds,
  });
  predator.vore.remains.push(remains);
  return remains;
}

function connectedDisposalRooms({ restroom = true } = {}) {
  setRandomSource(() => 0.99);
  const data = (id, side, to, isRestroom = false) => ({
    id, name: id, camera: id, level: 3, width: 240, height: 160, restroom: isRestroom,
    nav: {
      floor: Array.from({ length: 160 }, () => [0, 240]),
      exits: [{
        id: side, kind: 'door', side,
        bounds: { x: side === 'east' ? 210 : 0, y: 30, w: 30, h: 80 },
        threshold: { x: side === 'east' ? 215 : 25, y: 100 },
        base: { x: side === 'east' ? 235 : 5, y: 100 },
      }],
    },
    props: [], links: { [side]: { room: to, door: side === 'east' ? 'west' : 'east' } },
  });
  const hall = new Room(data('hall', 'east', 'washroom'));
  const washroom = new Room(data('washroom', 'west', 'hall', restroom));
  const world = new World({ rooms: [hall, washroom], roster: [], creatureRoster: [] });
  world.arrive = () => undefined;
  return { world, hall, washroom };
}

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

test('profile defaults accept new size bands and species without changing the profile builder', (t) => {
  const original = structuredClone(VORE_PROFILE_RULES);
  t.after(() => Object.assign(VORE_PROFILE_RULES, original));
  VORE_PROFILE_RULES.capacityBands.push({ minHeight: 10, capacity: 5 });
  VORE_PROFILE_RULES.anySizeSpecies.push(/gelatinous/i);
  assert.equal(createVoreProfile('predator', { heightMeters: 12 }).capacity, 5);
  assert.equal(createVoreProfile('predator', { species: 'Gelatinous being' }).anySize, true);
  const types = { anal: 1 };
  const profile = createVoreProfile('prey', {}, { role: 'predator', types });
  profile.types.anal = 4;
  assert.equal(types.anal, 1, 'a profile owns its weights');
  assert.equal(profile.role, 'predator');
  for (const capacity of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => createVoreProfile('predator', {}, { capacity }), /capacity/);
  }
  for (const types of [{ oral: -1 }, { oral: Infinity }, { unknown: 1 }]) {
    assert.throws(() => createVoreProfile('predator', {}, { types }), /type weight/);
  }
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

test('disabling all types prevents swallowing instead of silently choosing oral', () => {
  const { world, pred, meal } = duel();
  pred.character.vore.types = { oral: 0 };
  assert.equal(canSwallow(fighterOf(pred), fighterOf(meal)), false);
  assert.equal(world.vore.eligible(pred, meal), false);
  assert.equal(world.vore.swallow(pred, meal), false);
  assert.equal(world.vore.active.length, 0);
  assert.equal(world.agents.includes(meal), true);
  assert.throws(() => pickVoreType(pred.character.vore), /positive weight/);
});

test('disabled inside actions fall back to waiting, not a zero-weight struggle', () => {
  INSIDE_ACTIONS[0].weight = 0;
  const action = pickInsideAction();
  assert.equal(action.id, 'idle');
  assert.equal(action.escapeChance ?? 0, 0);
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

test('direct agent updates cannot execute plans while swallowed', () => {
  const { world, pred, meal } = duel();
  world.vore.swallow(pred, meal, 'oral');
  meal.setPlan(world, [walkTo({ x: 200, y: 100 }, 'Walking')]);
  const before = [meal.x, meal.y];
  meal.update(world, 1);
  assert.deepEqual([meal.x, meal.y], before);
  assert.equal(meal.moving, false);
});

test('an older creature attack stops if another predator swallows its target', (t) => {
  const { world, hall, pred, meal } = duel();
  const attacks = { ...ATTACK_CHANCE };
  t.after(() => Object.assign(ATTACK_CHANCE, attacks));
  ATTACK_CHANCE.safe = 1;
  meal.x = 200;
  const attacker = addCreature(world, hall, beast('attacker', ['None']), { x: 30, y: 100 });
  attacker.update(world, 0.1);
  assert.equal(attacker.activity, 'Attacking meal');
  assert.equal(world.vore.swallow(pred, meal, 'oral'), true);
  attacker.x = pred.x;
  attacker.y = pred.y;
  attacker.update(world, 0.1);
  assert.equal(meal.stats.hp.current, meal.stats.hp.max, 'prey inside a predator cannot be hit from the floor');
  assert.notEqual(attacker.activity, 'Attacking meal');
});

test('creatures honor action-blocking statuses and only move for the unblocked part of a frame', (t) => {
  const { world, hall } = setup();
  const meal = standing(world, hall, person('meal', ['Prey']), { x: 220, y: 100 });
  const hunter = addCreature(world, hall, beast('hunter', ['Predator']), { x: 30, y: 100 });
  STATUS_EFFECTS['test-frozen'] = { label: 'Frozen', targets: ['creature'], blocksActions: true, duration: 1 };
  t.after(() => { delete STATUS_EFFECTS['test-frozen']; });
  hunter.startHunt(meal, 'oral');
  hunter.statuses.apply('test-frozen');
  assert.equal(hunter.incapacitated, true);
  assert.equal(hunter.exposed, true, 'blocking actions does not hide a creature from other actors');
  world.update(0.5);
  assert.equal(hunter.x, 30);
  world.update(0.75);
  assert.equal(hunter.statuses.has('test-frozen'), false);
  assert.equal(hunter.incapacitated, false);
  assert.ok(Math.abs(hunter.x - (30 + CREATURE_TUNING.dashSpeed * 0.25)) < 1e-9);
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

test('staff role and privacy restrictions can be configured independently of the encounter rules', (t) => {
  const original = structuredClone(VORE_STAFF_RULES);
  t.after(() => Object.assign(VORE_STAFF_RULES, original));
  const { world, hall, pred, meal } = duel({ predator: ['Switch'] });
  standing(world, hall, person('witness', ['None']), { x: 130, y: 100 });
  assert.equal(world.vore.eligible(pred, meal), false);
  VORE_STAFF_RULES.predatorRoles.push('switch');
  assert.equal(world.vore.eligible(pred, meal), false, 'privacy still applies');
  VORE_STAFF_RULES.requirePrivacy = false;
  assert.equal(world.vore.eligible(pred, meal), true);
  VORE_TUNING.staffSizeRatio = 1;
  pred.character.heightMeters = 2.4;
  assert.equal(world.vore.eligible(pred, meal), true);
  pred.stats.hp.current = 10;
  assert.equal(world.vore.eligible(pred, meal), false, 'a weakened switch still cannot hunt');
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

test('remains outcomes use configured weights and exact probability boundaries', () => {
  setRandomSource(() => 0);
  for (const [type, definition] of Object.entries(VORE_TYPES)) {
    assert.equal(pickRemainsOutcome(type), definition.looks[0]);
  }
  setRandomSource(() => 0.999);
  for (const [type, definition] of Object.entries(VORE_TYPES)) {
    assert.equal(pickRemainsOutcome(type), definition.looks.at(-1));
  }
  setRandomSource(() => 0.049999);
  assert.equal(pickRemainsOutcome('cock').look, 'pee');
  setRandomSource(() => 0.05);
  assert.equal(pickRemainsOutcome('cock').look, 'cum');
  let urine = 0;
  for (let i = 0; i < 1000; i++) {
    setRandomSource(() => i / 1000);
    if (pickRemainsOutcome('cock').look === 'pee') urine++;
  }
  assert.equal(urine, 50, 'urine is 5% and cum is 95%');

  VORE_TYPES.oral.looks[0].weight = 0;
  VORE_TYPES.oral.looks[1].weight = 0;
  assert.throws(() => pickRemainsOutcome('oral'), /at least one look must have a positive weight/);
});

for (const [type, status, label] of [
  ['oral', 'digested', 'Digested'],
  ['cock', 'cumified', 'Cumified'],
  ['anal', 'digested', 'Digested'],
  ['breast', 'milkified', 'Milkified'],
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
    assert.equal(remains.type, type);
    assert.ok(VORE_TYPES[type].looks.some(({ look }) => look === remains.look));
    assert.equal(remains.asset, `remains:${remains.look}`);
    assert.equal(followCameraRoom(world, meal), pred.room, 'following survives every kind of conversion');
  });
}

for (const kind of ['agent', 'creature']) {
  test(`following ${kind} prey tracks carried remains, disposal and relocation`, () => {
    const { world, hall, annex, pred, meal } = duel();
    const prey = kind === 'agent' ? meal
      : addCreature(world, hall, beast('followed-creature', ['Prey'], { height: '1 m' }), { x: 110, y: 100 });
    Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 1, disposalDelay: { min: 600, max: 600 } });
    assert.equal(world.vore.swallow(pred, prey, 'oral'), true);
    assert.equal(followCameraRoom(world, prey), hall);
    world.update(0.6);
    world.update(1.1);
    const [pile] = pred.vore.remains;
    assert.equal(pile.actor, prey);
    assert.equal(followCameraRoom(world, prey), hall);

    pred.room = annex;
    assert.equal(prey.room, hall, 'the old actor location is no longer synced');
    assert.equal(followCameraRoom(world, prey), annex, 'held remains follow their carrier');
    pred.removed = true;
    assert.equal(followCameraRoom(world, prey), null, 'held remains wait while their carrier is off camera');
    pred.removed = false;
    assert.equal(followCameraRoom(world, prey), annex);

    world.vore.release(pred);
    assert.deepEqual(annex.remains, [pile]);
    pred.room = hall;
    assert.equal(followCameraRoom(world, prey), annex, 'a dropped pile no longer follows the predator');
    annex.remains.splice(annex.remains.indexOf(pile), 1);
    hall.remains.push(pile);
    assert.equal(followCameraRoom(world, prey), hall, 'the current pile location wins over its disposal location');
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
  world.hooks.removed = (agent) => {
    removed.push(agent);
    assert.equal(world.vore.consumed.has(agent.character.id), true, 'the monitor can distinguish absorption from departure');
    assert.equal(followCameraRoom(world, agent), pred.room, 'remains are trackable before notifying the monitor');
  };
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
  assert.equal(remains.actor, meal, 'clicking the pile pulls up their file');
  assert.deepEqual(remains.items, [can, card]);
  assert.ok(logs.some(({ text, tone }) => text === 'meal was absorbed by pred.' && tone === 'warn'));

  const other = person('other', ['Prey']);
  world.roster.push(meal.character);
  setRandomSource(() => 0);
  assert.equal(world.pickArrival(), undefined, 'absorbed characters never arrive again');
  world.roster.push(other);
  assert.equal(world.pickArrival(), other);
});

test('item effects keep ticking exactly once while held inside remains', (t) => {
  const { world, pred, meal } = duel();
  Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 1, disposalDelay: { min: 600, max: 600 } });
  const ticks = [];
  STATUS_EFFECTS['test-item-timer'] = {
    label: 'Item timer', targets: ['item'], duration: 10,
    onUpdate: (_target, _world, dt) => ticks.push(dt),
  };
  t.after(() => { delete STATUS_EFFECTS['test-item-timer']; });
  const item = Item.create('can');
  item.statuses.apply('test-item-timer');
  meal.receiveItem(item);
  world.vore.swallow(pred, meal, 'oral');
  world.update(0.6);
  world.update(1.1);
  assert.ok(pred.vore.remains[0].items.includes(item));
  ticks.length = 0;
  world.update(2);
  assert.deepEqual(ticks, [2]);
  assert.ok(Math.abs(item.statuses.get('test-item-timer').remaining - 6.3) < 1e-9);
  world.vore.release(pred);
  ticks.length = 0;
  world.update(1);
  assert.deepEqual(ticks, [1], 'disposal keeps the same status owner');
});

test('monitor files show the actual remains for agents and creatures, both held and dropped', (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  const createElement = (tagName) => ({
    tagName, children: [], textContent: '', style: { setProperty() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement } });

  const cases = [
    { type: 'oral', roll: 0.1, status: 'Bones' },
    { type: 'oral', roll: 0.9, status: 'Scat' },
    { type: 'anal', roll: 0.1, status: 'Bones' },
    { type: 'anal', roll: 0.9, status: 'Scat' },
    { type: 'cock', roll: 0.9, status: 'Cum' },
    { type: 'cock', roll: 0.01, status: 'Urine', look: 'pee' },
    { type: 'breast', roll: 0.9, status: 'Milk' },
  ];
  for (const kind of ['agent', 'creature']) {
    for (const { type, roll, status, look = status.toLowerCase() } of cases) {
      const { world, hall, pred, meal } = duel();
      const prey = kind === 'agent'
        ? meal
        : addCreature(world, hall, beast('thing', ['Prey'], { height: '1 m' }), { x: 110, y: 100 });
      if (kind === 'creature') world.remove(meal, 'door');
      Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 1, disposalDelay: { min: 600, max: 600 } });
      const node = createElement('div');
      const file = new MonitorFile(node, world, () => {});
      const renderStatus = () => {
        file.render(prey, hall);
        const stats = node.children.find((child) => child.tagName === 'dl');
        return stats.children.find((row) => row.children[0].textContent === 'Status').children[1].textContent;
      };

      assert.equal(renderStatus(), prey.activity, `${kind}: normal activity is unchanged`);
      assert.equal(world.vore.swallow(pred, prey, type), true);
      assert.equal(renderStatus(), 'Struggling inside pred');
      setRandomSource(() => roll);
      world.update(0.6);
      assert.equal(renderStatus(), 'Being absorbed by pred');
      setRandomSource(() => 0.99);
      world.update(1.1);
      const [pile] = pred.vore.remains;
      assert.equal(pile.actor, prey);
      assert.equal(pile.look, look, `${kind}, ${type}: the chosen appearance`);
      assert.equal(renderStatus(), status, `${kind}, ${type}: held remains`);
      world.vore.release(pred);
      assert.ok(hall.remains.includes(pile));
      assert.equal(renderStatus(), status, `${kind}, ${type}: dropped remains`);
      file.render(null, hall);
      assert.equal(renderStatus(), status, `${kind}, ${type}: selecting the pile again`);
    }
  }

  const { world, hall, meal } = duel();
  world.remove(meal, 'door');
  const node = createElement('div');
  new MonitorFile(node, world, () => {}).render(meal, hall);
  const stats = node.children.find((child) => child.tagName === 'dl');
  assert.equal(stats.children.find((row) => row.children[0].textContent === 'Status').children[1].textContent, 'Off camera',
    'departed staff who were not absorbed remain off camera');
});

test('predators plan a timed disposal and drop the remains with everything the prey carried', () => {
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
  assert.equal(pred.vore.remains.length, 1, 'becoming ready does not instantly release the remains');
  step(world, 2);
  assert.equal(pred.activity, VORE_TYPES.cock.disposal.activity);
  step(world, Math.max(0, VORE_TYPES.cock.disposal.seconds - 4));
  assert.equal(pred.vore.remains.length, 1, 'the activity must finish');
  for (let i = 0; i < 50 && pred.vore.remains.length; i++) world.update(0.1);

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

for (const kind of ['staff', 'creature']) {
  test(`${kind} keeps the urine outcome through absorption and urinates to release it`, () => {
    const { world, hall, logs } = setup();
    const prey = standing(world, hall, person('meal', ['Prey']), { x: 104, y: 100 });
    const predator = kind === 'staff'
      ? standing(world, hall, person('pred', ['Predator'], '6 m'), { x: 100, y: 100 })
      : addCreature(world, hall, beast('pred', ['Predator']), { x: 100, y: 100 });
    Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 1, disposalDelay: { min: 600, max: 600 } });
    assert.equal(world.vore.swallow(predator, prey, 'cock'), true);

    setRandomSource(() => 0.01);
    world.update(0.6);
    assert.equal(prey.statuses.has('urine'), true);
    assert.equal(prey.statuses.has('cumified'), false);
    assert.equal(prey.statuses.remove('urine'), false, 'conversion is irreversible');
    assert.deepEqual(statusPopups(prey.statuses.active).map(({ id }) => id), ['urine']);
    assert.ok(logs.some(({ text }) => text === 'meal was turned into urine by pred.'));

    setRandomSource(() => 0.99);
    world.update(1.1);
    const [remains] = predator.vore.remains;
    assert.equal(remains.look, 'pee');
    assert.equal(remains.asset, 'remains:pee');
    assert.equal(remains.label, 'Urine');
    assert.equal(remains.disposal.activity, 'Urinating');
    remains.wait = 0;
    step(world, 1);
    assert.equal(predator.activity, 'Urinating');
    step(world, 6);
    const witness = standing(world, hall, person('witness', ['None']), { x: 110, y: 100 });
    step(world, 0.2);
    assert.ok(predator.vore.remains.includes(remains), 'a witness interrupts disposal');
    world.agents = world.agents.filter((actor) => actor !== witness);
    step(world, 6);
    assert.ok(predator.vore.remains.includes(remains), 'interrupted disposal must start over');
    for (let i = 0; i < 300 && !hall.remains.includes(remains); i++) world.update(0.1);
    assert.ok(hall.remains.includes(remains));
    assert.equal(predator.vore.remains.includes(remains), false);
  });
}

test('one predator disposes of different cock vore outcomes using their own activities', () => {
  const { world, hall, pred, meal } = duel();
  Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 1, disposalDelay: { min: 600, max: 600 } });
  world.vore.swallow(pred, meal, 'cock');
  setRandomSource(() => 0.01);
  world.update(0.6);
  setRandomSource(() => 0.99);
  const second = standing(world, hall, person('second', ['Prey']), { x: 104, y: 100 });
  assert.equal(world.vore.swallow(pred, second, 'cock'), true);
  world.update(0.6);
  world.update(1.1);
  const [urine, cum] = pred.vore.remains;
  assert.deepEqual([urine.look, cum.look], ['pee', 'cum']);
  urine.wait = 0;
  cum.wait = 0;
  step(world, 1);
  assert.equal(pred.activity, 'Urinating');
  step(world, 14);
  assert.ok(hall.remains.includes(urine));
  assert.ok(pred.vore.remains.includes(cum));
  assert.equal(pred.activity, 'Jerking Off');
  step(world, 21);
  assert.ok(hall.remains.includes(cum));
});

test('releasing an absorbing predator keeps its already selected urine outcome', () => {
  const { world, hall, pred, meal } = duel();
  Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 30 });
  world.vore.swallow(pred, meal, 'cock');
  setRandomSource(() => 0.01);
  world.update(0.6);
  setRandomSource(() => 0.99);
  world.vore.release(pred);
  assert.equal(meal.statuses.has('urine'), true);
  assert.equal(hall.remains[0].look, 'pee');
  assert.equal(hall.remains[0].disposal.activity, 'Urinating');
});

test('each remains type uses its configured activity and duration', () => {
  for (const type of Object.keys(VORE_TYPES)) {
    const { world, hall, pred, meal } = duel();
    world.agents = world.agents.filter((actor) => actor !== meal);
    const remains = holdRemains(pred, meal, type);
    VORE_TYPES[type].disposal.seconds = 3;
    step(world, 0.5);
    assert.equal(pred.activity, VORE_TYPES[type].disposal.activity, type);
    step(world, 2);
    assert.ok(pred.vore.remains.includes(remains), type);
    step(world, 2);
    assert.ok(hall.remains.includes(remains), type);
  }
});

test('staff and creatures seek an accessible empty restroom before a private current room', () => {
  for (const kind of ['staff', 'creature']) {
    const { world, hall, washroom } = connectedDisposalRooms();
    const prey = standing(world, hall, person('meal', ['Prey']), { x: 40, y: 100 });
    world.agents = world.agents.filter((actor) => actor !== prey);
    const predator = kind === 'staff'
      ? standing(world, hall, person('pred', ['Predator'], '6 m'), { x: 40, y: 100 })
      : addCreature(world, hall, beast('pred', ['Predator']), { x: 40, y: 100 });
    const remains = holdRemains(predator, prey, 'breast');
    step(world, 1);
    assert.equal(predator.disposalActivityTime, undefined, 'no relief effect while travelling');
    if (kind === 'creature') assert.equal(predator.exposed, true, 'walking toward a restroom is not an escape');
    step(world, 14);
    assert.equal(predator.room, washroom, kind);
    assert.equal(predator.activity, VORE_TYPES.breast.disposal.activity, kind);
    assert.ok(predator.vore.remains.includes(remains), 'travel is not disposal');
    step(world, 15);
    assert.ok(washroom.remains.includes(remains), kind);
    assert.equal(hall.remains.length, 0, kind);
  }
});

test('disposal relief shakes staff and creatures only during the stationary activity', () => {
  for (const kind of ['staff', 'creature']) {
    const { world, hall } = setup();
    const prey = standing(world, hall, person('meal', ['Prey']), { x: 100, y: 100 });
    world.agents = world.agents.filter((actor) => actor !== prey);
    const predator = kind === 'staff'
      ? standing(world, hall, person('pred', ['Predator'], '6 m'), { x: 100, y: 100 })
      : addCreature(world, hall, beast('pred', ['Predator']), { x: 100, y: 100 });
    holdRemains(predator, prey, 'oral', 1);
    step(world, 0.5);
    assert.equal(predator.disposalActivityTime, undefined, `${kind}: still waiting`);
    step(world, 2);
    assert.equal(typeof predator.disposalActivityTime, 'number', `${kind}: activity started`);

    const frame = { w: 96, h: 96, anchorX: 48 };
    const renderer = { sheet: () => ({ frames: new Proxy({}, { get: () => frame }) }) };
    const positions = new Set();
    for (let i = 0; i < 10; i++) {
      world.update(0.1);
      positions.add(Renderer.prototype.placement.call(renderer, predator).x);
    }
    assert.ok(positions.size > 1, `${kind}: the sprite visibly moves`);
    assert.ok([...positions].every((x) => Math.abs(x - (Math.round(predator.x) - frame.anchorX)) <= 1),
      `${kind}: the shake stays subtle`);

    const witness = standing(world, hall, person('witness', ['None']), { x: 110, y: 100 });
    world.update(0.1);
    assert.equal(predator.disposalActivityTime, undefined, `${kind}: interruption stops the effect`);
    world.agents = world.agents.filter((actor) => actor !== witness);
    step(world, 20);
    assert.equal(predator.disposalActivityTime, undefined, `${kind}: completion stops the effect`);
  }
});

test('an occupied restroom falls back to a private room, then a corner', () => {
  const { world, hall, washroom } = connectedDisposalRooms();
  const prey = standing(world, hall, person('meal', ['Prey']), { x: 40, y: 100 });
  world.agents = world.agents.filter((actor) => actor !== prey);
  const pred = standing(world, hall, person('pred', ['Predator'], '6 m'), { x: 40, y: 100 });
  const witness = standing(world, washroom, person('witness', ['None']), { x: 70, y: 100 });
  const first = holdRemains(pred, prey);
  step(world, 16);
  assert.ok(hall.remains.includes(first), 'an occupied restroom does not provide privacy');

  witness.room = hall;
  witness.x = 100;
  witness.y = 100;
  const second = holdRemains(pred, prey);
  step(world, 30);
  assert.ok(washroom.remains.includes(second), 'an empty reachable restroom takes priority');

  witness.room = washroom;
  const otherWitness = standing(world, hall, person('other-witness', ['None']), { x: 100, y: 100 });
  pred.room = hall;
  pred.x = 120;
  pred.y = 80;
  pred.setPlan(world, []);
  const third = holdRemains(pred, prey);
  step(world, 30);
  assert.ok(hall.remains.includes(third), 'no private room is available');
  assert.ok(third.x < 20 || third.x > hall.width - 20);
  assert.ok(third.y < 15 || third.y > hall.height - 15, 'the fallback is a corner');
  assert.equal(otherWitness.room, hall);
});

test('urgent actions, fear and new witnesses interrupt disposal without releasing the remains', () => {
  const { world, hall, pred, meal } = duel();
  world.agents = world.agents.filter((actor) => actor !== meal);
  const remains = holdRemains(pred, meal, 'cock');
  pred.setPlan(world, [{ ...wait(20, 'Running away'), urgent: true }]);
  step(world, 3);
  assert.equal(pred.activity, 'Running away');
  assert.ok(pred.vore.remains.includes(remains));

  pred.setPlan(world, []);
  step(world, 3);
  assert.equal(pred.activity, VORE_TYPES.cock.disposal.activity);
  pred.statuses.apply('scared');
  step(world, 5);
  assert.ok(pred.vore.remains.includes(remains), 'fear interrupts the activity');
  pred.statuses.remove('scared');
  step(world, 3);
  const witness = standing(world, hall, person('witness', ['None']), { x: 110, y: 100 });
  step(world, 0.2);
  assert.ok(pred.vore.remains.includes(remains), 'a witness interrupts private disposal');
  world.agents = world.agents.filter((actor) => actor !== witness);
  step(world, 10);
  assert.ok(pred.vore.remains.includes(remains), 'interrupted progress was not completed');
  for (let i = 0; i < (VORE_TYPES.cock.disposal.seconds + 10) * 10 && !hall.remains.includes(remains); i++) {
    world.update(0.1);
  }
  assert.ok(hall.remains.includes(remains));
});

test('without an accessible restroom, staff and creatures find an empty reachable room', () => {
  for (const kind of ['staff', 'creature']) {
    const { world, hall, washroom } = connectedDisposalRooms({ restroom: false });
    const unreachable = new Room({
      id: 'unreachable', name: 'unreachable', camera: 'unreachable', level: 3, width: 240, height: 160,
      restroom: true, nav: { floor: Array.from({ length: 160 }, () => [0, 240]), exits: [] }, props: [], links: {},
    });
    world.rooms.push(unreachable);
    const prey = standing(world, hall, person('meal', ['Prey']), { x: 40, y: 100 });
    world.agents = world.agents.filter((actor) => actor !== prey);
    standing(world, hall, person('witness', ['None']), { x: 100, y: 100 });
    const predator = kind === 'staff'
      ? standing(world, hall, person('pred', ['Predator'], '6 m'), { x: 40, y: 100 })
      : addCreature(world, hall, beast('pred', ['Predator']), { x: 40, y: 100 });
    const remains = holdRemains(predator, prey);
    step(world, 30);
    assert.ok(washroom.remains.includes(remains), `${kind}: use the private room, not the inaccessible restroom`);
    assert.equal(unreachable.remains.length, 0);
  }
});

test('staff can reach an accessible restroom on another floor by elevator', () => {
  setRandomSource(() => 0.99);
  const floor = (id, level, restroom = false) => new Room({
    id, name: id, camera: id, level, width: 240, height: 160, restroom,
    nav: {
      floor: Array.from({ length: 160 }, () => [0, 240]),
      exits: [{
        id: 'elevator', kind: 'elevator', bounds: { x: 100, y: 15, w: 40, h: 40 },
        threshold: { x: 120, y: 67 }, base: { x: 120, y: 55 },
      }],
    },
    elevator: { shaft: 'staff', big: false }, props: [], links: {},
  });
  const hall = floor('hall', 1);
  const restroom = floor('restroom', 3, true);
  const world = new World({ rooms: [hall, restroom], roster: [] });
  world.arrive = () => undefined;
  const prey = standing(world, hall, person('meal', ['Prey']), { x: 60, y: 100 });
  world.agents = world.agents.filter((actor) => actor !== prey);
  const predator = standing(world, hall, person('pred', ['Predator'], '6 m'), { x: 60, y: 100 });
  const remains = holdRemains(predator, prey);
  step(world, 60);
  assert.ok(restroom.remains.includes(remains));
  assert.equal(hall.remains.length, 0);
});

test('a creature does not interrupt a hunt to dispose of remains', () => {
  const { world, hall } = setup();
  const predator = addCreature(world, hall, beast('pred', ['Predator']), { x: 30, y: 100 });
  const target = standing(world, hall, person('target', ['Prey']), { x: 210, y: 100 });
  const remains = holdRemains(predator, target);
  predator.startHunt(target, 'oral');
  step(world, 1);
  assert.equal(predator.activity, 'Hunting target');
  assert.ok(predator.vore.remains.includes(remains));
  assert.equal(hall.remains.length, 0);
});

test('a creature uses a reachable corner when no private room is available', () => {
  const { world, hall } = setup();
  const prey = standing(world, hall, person('meal', ['Prey']), { x: 120, y: 80 });
  world.agents = world.agents.filter((actor) => actor !== prey);
  standing(world, hall, person('witness', ['None']), { x: 100, y: 100 });
  const predator = addCreature(world, hall, beast('pred', ['Predator']), { x: 120, y: 80 });
  const remains = holdRemains(predator, prey, 'anal');
  step(world, 30);
  assert.ok(hall.remains.includes(remains));
  assert.ok(remains.x < 20 || remains.x > hall.width - 20);
  assert.ok(remains.y < 15 || remains.y > hall.height - 15);
});

test('a new security call interrupts disposal before dispatching to another room', () => {
  const { world, hall, washroom } = connectedDisposalRooms({ restroom: false });
  const prey = standing(world, hall, person('meal', ['Prey']), { x: 40, y: 100 });
  world.agents = world.agents.filter((actor) => actor !== prey);
  const guard = standing(world, hall, person('guard', ['Predator'], '6 m'), { x: 40, y: 100 });
  guard.security = { post: hall, relieved: false };
  const remains = holdRemains(guard, prey);
  guard.setPlan(world, planRemainsDisposal(guard, world));
  step(world, 2);
  assert.equal(guard.activity, VORE_TYPES.oral.disposal.activity);
  const creature = addCreature(world, hall, beast('escapee', ['None']), { x: 120, y: 100 });
  creature.room = washroom;
  step(world, 0.2);
  assert.equal(guard.security.target, creature);
  assert.match(guard.activity, /Pursuing escapee/);
  assert.ok(guard.vore.remains.includes(remains));
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
  assert.ok(['bones', 'scat'].includes(remains.look));
  assert.deepEqual(world.creaturesIn(hall), []);
});

for (const recontained of [false, true]) {
  test(`a breach reports the escapee absorbing staff ${recontained ? 'after recontainment' : 'while still loose'}`, () => {
    const { world, hall, annex } = setup();
    const pred = addCreature(world, annex, beast('pred', ['Predator']), { x: 100, y: 100 });
    const meal = standing(world, hall, person('meal', ['Prey']), { x: 104, y: 100 });
    pred.emerge(hall, { x: 100, y: 100 });
    const breach = world.incidents.record('escaped', { creature: pred, room: hall });

    Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 1 });
    assert.equal(world.vore.swallow(pred, meal, 'oral'), true);
    world.update(0.6);
    const containedAt = world.time;
    if (recontained) world.recontain(pred);
    world.update(1.1);
    assert.equal(meal.removed, true);

    assert.deepEqual(breach.steps.map(({ id }) => id), recontained
      ? ['escaped', 'swallowed-someone', 'recontained', 'absorbed-someone']
      : ['escaped', 'swallowed-someone', 'absorbed-someone']);
    const last = breach.steps.at(-1);
    assert.equal(last.text, 'pred absorbed meal.');
    assert.equal(last.room, recontained ? annex : hall);
    assert.equal(breach.resolvedAt, recontained ? containedAt : undefined);
    assert.equal(breach.outcome, recontained ? 'Contained' : undefined);
    assert.equal(world.incidents.incidents.length, 1);
  });
}

for (const shared of [false, true]) {
  test(`absorption settles the creature prey and is reported once in ${shared ? 'a shared incident' : 'each separate breach'}`, () => {
    const { world, hall, annex } = setup();
    const pred = addCreature(world, annex, beast('pred', ['Predator']), { x: 100, y: 100 });
    const meal = addCreature(world, annex, beast('meal', ['Prey'], { height: '1 m' }), { x: 104, y: 100 });
    pred.emerge(hall, { x: 100, y: 100 });
    meal.emerge(hall, { x: 104, y: 100 });
    if (shared) world.level(hall.level).startEvent('containment-failure');
    const predatorIncident = world.incidents.record('escaped', { creature: pred, room: hall });
    const preyIncident = world.incidents.record('escaped', { creature: meal, room: hall });

    Object.assign(VORE_TUNING, { acidDps: 200, absorbSeconds: 1 });
    assert.equal(world.vore.swallow(pred, meal, 'oral'), true);
    world.update(0.6);
    world.update(1.1);
    assert.equal(meal.consumed, true);

    assert.deepEqual(preyIncident.steps.slice(-2).map(({ id }) => id), ['swallowed', 'absorbed']);
    assert.equal(preyIncident.pending.has(meal), false);
    assert.equal(predatorIncident.pending.has(pred), true);
    assert.equal(predatorIncident.resolvedAt, undefined);
    if (shared) {
      assert.equal(preyIncident, predatorIncident);
      assert.equal(preyIncident.steps.some(({ id }) => id === 'swallowed-someone' || id === 'absorbed-someone'), false);
    } else {
      assert.equal(preyIncident.resolvedAt, world.time);
      assert.equal(preyIncident.outcome, 'Subject absorbed');
      assert.deepEqual(predatorIncident.steps.slice(-2).map(({ id }) => id), ['swallowed-someone', 'absorbed-someone']);
    }
  });
}

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
  for (const id of ['digested', 'cumified', 'urine', 'milkified']) {
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
