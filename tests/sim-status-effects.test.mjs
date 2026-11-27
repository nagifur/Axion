import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/lib/sim/agent.ts';
import { Creature } from '../src/lib/sim/creature.ts';
import { PassageDoor } from '../src/lib/sim/door.ts';
import { Item } from '../src/lib/sim/item.ts';
import { Prop } from '../src/lib/sim/prop.ts';
import { Room } from '../src/lib/sim/room.ts';
import { bindDebugPanel } from '../src/lib/sim/monitorDebug.ts';
import { NAP_SECONDS, STATUS_EFFECTS } from '../src/lib/sim/statusEffects.ts';
import { rest, wait } from '../src/lib/sim/tasks.ts';
import { World } from '../src/lib/sim/world.ts';

const placed = (type) => ({ type, asset: type, x: 40, y: 40, w: 10, h: 10, flip: false });
const character = {
  id: 'tester', name: 'Tester', href: '/', tint: '#fff', scale: 1, accessLevel: 'Admin',
  traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
};

function register(t, id, definition) {
  assert.equal(Object.hasOwn(STATUS_EFFECTS, id), false);
  STATUS_EFFECTS[id] = { label: id, polarity: 'neutral', targets: ['agent', 'prop', 'item', 'door', 'panel'], ...definition };
  t.after(() => { delete STATUS_EFFECTS[id]; });
  return id;
}

function makeRoom(id = 'test', side = 'east', to) {
  return new Room({
    id, name: id, level: id === 'test' ? 0 : 1, camera: id, width: 140, height: 100,
    nav: {
      width: 140, height: 100,
      floor: Array.from({ length: 100 }, () => [0, 140]),
      exits: [{
        id: side, kind: 'door', side,
        bounds: { x: 100, y: 0, w: 26, h: 96 },
        threshold: { x: 110, y: 80 }, base: { x: 130, y: 80 },
      }],
    },
    props: [], links: to ? { [side]: to } : {}, doors: { [side]: { clearance: 1 } },
  });
}

test('effects have independent per-target state, snapshots, hooks and explicit removal', (t) => {
  const calls = [];
  const id = register(t, 'test-permanent', {
    onApply: (target) => calls.push(['apply', target.kind]),
    onUpdate: (target, world, dt) => calls.push(['update', target.kind, world.time, dt]),
    onRemove: (target, reason) => calls.push(['remove', target.kind, reason]),
  });
  const item = new Item(placed('test'));
  const other = new Item(placed('test'));
  assert.deepEqual(item.statuses.active, []);
  assert.equal(item.statuses.apply(id), true);
  assert.equal(item.statuses.apply(id), false, 'permanent effects do not stack or reapply hooks');
  assert.equal(other.statuses.has(id), false);
  assert.deepEqual(item.statuses.get(id), { id, label: id, polarity: 'neutral', remaining: null, duration: null });
  const snapshot = item.statuses.active;
  snapshot[0].remaining = 0;
  assert.equal(item.statuses.get(id).remaining, null, 'inspection cannot modify the live effect');
  item.statuses.update({ time: 10 }, 2);
  assert.equal(item.statuses.remove(id), true);
  assert.equal(item.statuses.remove(id), false);
  assert.equal(item.statuses.get(id), undefined);
  assert.deepEqual(calls, [
    ['apply', 'item'], ['update', 'item', 10, 2], ['remove', 'item', 'removed'],
  ]);
});

test('timed effects refresh without stacking, pause, and expire at their exact duration', (t) => {
  const updates = [];
  const removals = [];
  let applications = 0;
  const id = register(t, 'test-timed', {
    duration: 5,
    onApply: () => applications++,
    onUpdate: (target, world, dt) => updates.push(dt),
    onRemove: (target, reason) => removals.push(reason),
  });
  const { statuses } = new Item(placed('test'));
  const world = { time: 0 };
  statuses.apply(id);
  statuses.update(world, 4.5);
  assert.equal(statuses.get(id).remaining, 0.5);
  statuses.update(world, 0);
  assert.equal(statuses.get(id).remaining, 0.5);
  assert.deepEqual(updates, [4.5], 'paused updates do not call hooks');
  statuses.apply(id);
  assert.equal(statuses.active.length, 1);
  assert.equal(statuses.get(id).remaining, 5);
  assert.equal(applications, 1);
  statuses.update(world, 4.99);
  assert.equal(statuses.has(id), true);
  statuses.update(world, 10);
  assert.equal(statuses.has(id), false);
  assert.ok(Math.abs(updates.at(-1) - 0.01) < 1e-10, 'oversized frames only tick the remaining lifetime');
  assert.deepEqual(removals, ['expired']);
  statuses.apply(id, 2);
  assert.equal(statuses.get(id).duration, 2, 'snapshots report the current instance length, including overrides');
  statuses.update(world, 2);
  assert.equal(statuses.has(id), false, 'exact duration expires without an extra frame');
});

test('permanent definitions never expire but can be removed, replaced and cleared', (t) => {
  const removals = [];
  const id = register(t, 'test-permanent-definition', {
    permanent: true,
    onRemove: (_target, reason) => removals.push(reason),
  });
  const replacement = register(t, 'test-replacement', { replaces: [id] });
  const { statuses } = new Item(placed('test'));
  statuses.apply(id);
  statuses.update({}, 10000);
  assert.equal(statuses.get(id).remaining, null);
  assert.throws(() => statuses.apply(id, 1), /permanent.*duration/);
  assert.equal(statuses.remove(id), true);
  statuses.apply(id);
  statuses.apply(replacement);
  assert.equal(statuses.has(id), false);
  statuses.apply(id);
  statuses.clear();
  assert.deepEqual(statuses.active, []);
  assert.deepEqual(removals, ['removed', 'removed', 'removed']);
});

test('DEBUG removes permanent death and remains statuses from the selected actor', (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { createElement: () => ({}) },
  });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  const room = makeRoom();
  const world = new World({ rooms: [room], roster: [] });
  const actor = world.spawn(character, room, { x: 30, y: 80 });
  const logs = [];
  const select = { value: '', replaceChildren() {} };
  let onClick;
  bindDebugPanel({
    querySelector: (selector) => selector === '[data-debug-status]' ? select : null,
    addEventListener: (_type, listener) => { onClick = listener; },
  }, {
    world, director: {}, currentRoom: () => room, selected: () => actor,
    log: (text) => logs.push(text),
  });
  const click = (debug) => onClick({ target: { closest: () => ({ dataset: { debug } }) } });
  for (const id of ['dead', 'bones']) {
    select.value = id;
    click('status-apply');
    assert.equal(actor.statuses.has(id), true);
    if (id === 'bones') {
      world.update(0.1);
      assert.equal(actor.removed, true);
      assert.equal(room.remains.length, 1);
    }
    click('status-remove');
    assert.equal(actor.statuses.has(id), false);
    assert.equal(logs.at(-1), `Debug: ${STATUS_EFFECTS[id].label} removed from Tester.`);
    if (id === 'dead') assert.equal(actor.stats.hp.current, actor.stats.hp.max);
    else {
      assert.equal(actor.removed, false);
      assert.equal(actor.dead, true);
      assert.deepEqual(room.remains, []);
      select.value = 'dead';
      click('status-remove');
      assert.equal(actor.stats.hp.current, actor.stats.hp.max);
    }
  }
});

test('unknown effects, invalid durations and invalid timesteps fail explicitly; eligibility is enforced', (t) => {
  const { statuses } = new Item(placed('test'));
  assert.throws(() => statuses.apply('missing'), /Unknown status effect/);
  assert.throws(() => statuses.apply('toString'), /Unknown status effect/);
  const id = register(t, 'test-validation', {});
  for (const duration of [0, -1, NaN, Infinity]) {
    assert.throws(() => statuses.apply(id, duration), /duration/);
  }
  assert.equal(statuses.has(id), false);
  register(t, 'test-invalid-default', { duration: -1 });
  assert.throws(() => statuses.apply('test-invalid-default'), /duration/);
  for (const dt of [-1, NaN, Infinity]) {
    assert.throws(() => statuses.update({}, dt), /timestep/);
  }
  register(t, 'test-agent-only', { targets: ['agent'] });
  assert.equal(statuses.apply('test-agent-only'), false);
  register(t, 'test-ineligible', { canApply: () => false });
  assert.equal(statuses.apply('test-ineligible'), false);
  assert.equal(statuses.apply('broken'), false, 'items have no broken behavior yet');
  assert.deepEqual(statuses.active, []);
});

test('lifecycle hooks can remove, refresh and add effects without double ticks or stale expiry', (t) => {
  const { statuses } = new Item(placed('test'));
  const ticks = [];
  const removed = [];
  register(t, 'test-new', { onUpdate: () => ticks.push('new') });
  register(t, 'test-later', { onUpdate: () => ticks.push('later') });
  register(t, 'test-mutating', {
    duration: 1,
    onUpdate: () => {
      ticks.push('mutating');
      statuses.remove('test-later');
      statuses.apply('test-new');
      statuses.apply('test-mutating', 3);
    },
    onRemove: (target, reason) => removed.push(reason),
  });
  statuses.apply('test-mutating');
  statuses.apply('test-later');
  statuses.update({}, 2);
  assert.deepEqual(ticks, ['mutating']);
  assert.equal(statuses.get('test-mutating').remaining, 3, 'a refreshed instance must not expire with the old one');
  assert.deepEqual(removed, []);
  statuses.remove('test-mutating');
  statuses.update({}, 1);
  assert.deepEqual(ticks, ['mutating', 'new']);
  assert.deepEqual(removed, ['removed']);
  statuses.clear();
  assert.deepEqual(statuses.active, []);
});

test('broken is the single source of prop damage and preserves starting state and break events', () => {
  const prop = new Prop(placed('light'));
  assert.equal(prop.statuses.apply('broken'), true);
  assert.equal(prop.broken, true);
  assert.equal(prop.lit, false);
  assert.equal(prop.look, 'broken');
  assert.equal(prop.takeBreaks(), 1);
  assert.equal(prop.break(), false);
  assert.equal(prop.statuses.apply('broken'), false);
  assert.equal(prop.takeBreaks(), 0);
  assert.equal(prop.repair(), true);
  assert.equal(prop.statuses.has('broken'), false);
  prop.broken = true;
  assert.equal(prop.statuses.has('broken'), true, 'legacy assignment goes through the status system');
  assert.equal(prop.takeBreaks(), 1);
  prop.statuses.remove('broken');
  assert.equal(prop.broken, false);
  assert.equal(prop.lit, true);
  assert.equal(prop.toData().start, undefined, 'runtime statuses never leak into placement exports');

  const starting = new Prop({ ...placed('light'), start: { broken: true } });
  assert.equal(starting.statuses.has('broken'), true);
  assert.equal(starting.takeBreaks(), 0, 'starting damage does not emit runtime break particles');
  starting.repair();
  assert.deepEqual(starting.toData().start, { broken: true });
  const decoration = new Prop(placed('plant'));
  assert.equal(decoration.statuses.apply('broken'), false);
  decoration.broken = true;
  assert.equal(decoration.broken, false);
});

test('door and panel broken statuses are independent and preserve their mechanical transitions', () => {
  const door = new PassageDoor(1);
  door.update(true, 1);
  assert.equal(door.open, 1);
  door.panelStatuses.apply('broken');
  assert.equal(door.panelBroken, true);
  assert.equal(door.unlocked, false);
  assert.equal(door.stuckOpen, true);
  assert.equal(door.broken, false);
  door.statuses.apply('broken');
  assert.equal(door.broken, true);
  assert.equal(door.open, 0);
  assert.equal(door.blocked, true);
  door.repair();
  assert.equal(door.statuses.has('broken'), false);
  assert.equal(door.panelBroken, true);
  door.panelStatuses.remove('broken');
  assert.equal(door.panelBroken, false);
  door.update(false, 0.5);
  assert.equal(door.open, 0, 'repair clears the old hold timer');
  door.broken = true;
  door.panelBroken = true;
  assert.equal(door.statuses.has('broken'), true);
  assert.equal(door.panelStatuses.has('broken'), true);
  door.broken = false;
  door.panelBroken = false;
  assert.equal(door.blocked, false);
});

test('world ticks agents, props, floor/carried/stored items, riders and linked door components exactly once', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const a = makeRoom('test', 'east', { room: 'other', door: 'west' });
  const b = makeRoom('other', 'west', { room: 'test', door: 'east' });
  const world = new World({ rooms: [a, b], roster: [] });
  const agent = world.spawn(character, a, { x: 30, y: 80 });
  const held = world.spawn({ ...character, id: 'held' }, a, { x: 30, y: 80 });
  const rider = world.spawn({ ...character, id: 'rider' }, a, { x: 30, y: 80 });
  world.elevatorDeparted(rider, b);
  held.held = true;
  agent.setPlan(world, [wait(1000, 'Waiting')]);
  const floor = Item.create('can');
  const carried = Item.create('can');
  const stored = agent.inventory[0];
  a.items.push(floor);
  agent.receiveItem(carried);
  const prop = new Prop(placed('light'));
  a.setProps([prop]);
  const door = world.passageDoorFor(a.doors[0]);
  assert.equal(door, world.passageDoorFor(b.doors[0]));
  const ticks = new Map();
  const id = register(t, 'test-world', {
    duration: 10,
    onUpdate: (target, currentWorld, dt) => {
      assert.equal(currentWorld, world);
      const key = target.kind === 'panel' ? door.panelStatuses : target.entity;
      ticks.set(key, (ticks.get(key) ?? 0) + dt);
    },
  });
  const targets = [agent, held, rider, floor, carried, stored, prop, door];
  for (const target of targets) target.statuses.apply(id);
  door.panelStatuses.apply(id);
  world.update(0);
  assert.equal(ticks.size, 0);
  world.update(0.5);
  for (const target of [...targets, door.panelStatuses]) assert.equal(ticks.get(target), 0.5);
  assert.equal(ticks.size, targets.length + 1);

  agent.storeItem();
  world.update(0.5);
  assert.equal(carried.statuses.get(id).remaining, 9, 'moving into storage neither resets nor double-ticks');
  agent.retrieveItem(carried);
  agent.dropItem();
  world.update(0.5);
  assert.equal(carried.statuses.get(id).remaining, 8.5, 'dropping preserves the same status instance');
  agent.pickUpItem(carried);
  agent.consumeItem();
  world.update(0.5);
  assert.equal(carried.statuses.get(id).remaining, 8.5, 'destroyed items no longer tick');
  world.remove(held, 'test');
  world.update(0.5);
  assert.equal(held.statuses.get(id).remaining, 8, 'removed agents no longer tick');
  assert.throws(() => world.update(-1), /timestep/);
});

test('all entity collections start empty, and item placement exports exclude live statuses', (t) => {
  const room = makeRoom();
  const agent = new Agent(character, room, { x: 30, y: 80 });
  const item = Item.create('can');
  const data = item.toData();
  const id = register(t, 'test-export', {});
  assert.deepEqual(agent.statuses.active, []);
  assert.deepEqual(new Prop(placed('light')).statuses.active, []);
  assert.deepEqual(new PassageDoor(1).statuses.active, []);
  item.statuses.apply(id);
  assert.deepEqual(item.toData(), data);
  assert.deepEqual(new Item(item.toData()).statuses.active, []);
});

test('zero and negative HP immediately kill staff and security permanently and release their plans', () => {
  for (const hp of [0, -5]) {
    const room = makeRoom();
    const world = new World({ rooms: [room], roster: [] });
    const agent = world.spawn(character, room, { x: 30, y: 80 });
    if (hp < 0) agent.security = { post: room, relieved: false };
    let updates = 0;
    let ends = 0;
    let cancellations = 0;
    agent.setPlan(world, [{
      activity: 'Working', interruptible: false,
      update: () => { updates++; return false; },
      end: () => { ends++; },
    }, {
      activity: 'Queued', interruptible: true, update: () => false,
      cancel: () => { cancellations++; },
    }]);
    agent.update(world, 0.1);
    agent.moving = true;
    agent.stats.hp.current = hp;
    assert.equal(agent.dead, true);
    assert.equal(agent.stats.hp.current, 0);
    assert.equal(agent.activity, 'Dead');
    assert.equal(agent.moving, false);
    assert.equal(agent.draggable, false);
    assert.deepEqual(agent.statuses.get('dead'), { id: 'dead', label: 'Dead', polarity: 'negative', remaining: null, duration: null });
    assert.throws(() => agent.statuses.apply('dead', 1), /permanent.*duration/);
    agent.stats.hp.current = 100;
    assert.equal(agent.stats.hp.current, 0, 'healing cannot revive a dead actor');
    const position = { x: agent.x, y: agent.y };
    assert.equal(agent.moveToward({ x: 70, y: 80 }, 1), false);
    agent.held = true;
    world.update(1);
    world.update(1);
    assert.deepEqual({ x: agent.x, y: agent.y }, position);
    assert.equal(updates, 1);
    assert.equal(ends, 1);
    assert.equal(cancellations, 1);
    assert.equal(agent.removed, false);
    assert.ok(world.actorsIn(room).includes(agent));
    assert.equal(agent.statuses.get('dead').remaining, null);
    assert.equal(agent.statuses.remove('dead'), true);
    assert.equal(agent.dead, false);
    assert.equal(agent.statuses.actionBlockRemaining, 0);
    assert.equal(agent.stats.hp.current, agent.stats.hp.max, 'removing death restores full HP');
    assert.equal(agent.statuses.apply('dead'), true);
    agent.statuses.clear();
    assert.equal(agent.dead, false);
    assert.equal(agent.stats.hp.current, agent.stats.hp.max);
  }
  assert.equal(Item.create('can').statuses.apply('dead'), false);
});

test('dead creatures stop wandering, stay on camera, and release escort claims', () => {
  const home = makeRoom();
  const room = makeRoom('other');
  const creature = new Creature({
    id: 'resident', name: 'Resident', nickname: 'Test', containmentClass: 'Maximum Containment',
    tint: '#fff', scale: 1,
  }, home);
  const world = new World({ rooms: [home, room], roster: [] });
  world.creatures.push(creature);
  creature.room = room;
  const guard = world.spawn(character, room, { x: 30, y: 80 });
  guard.security = { post: room, relieved: false, target: creature };
  creature.escort = guard;
  creature.stats.hp.current = -1;
  assert.equal(creature.dead, true);
  assert.equal(creature.escort, undefined);
  assert.equal(guard.security.target, undefined);
  assert.equal(creature.loose, false);
  assert.equal(creature.escaping, false);
  assert.equal(creature.activity, 'Dead');
  const position = { x: creature.x, y: creature.y };
  const frame = creature.frame;
  guard.held = true;
  world.update(20);
  creature.hold(10, { x: 0, y: 0 });
  world.recontain(creature);
  assert.equal(creature.room, room);
  assert.deepEqual({ x: creature.x, y: creature.y }, position);
  assert.deepEqual(creature.frame, frame);
  assert.ok(world.actorsIn(room).includes(creature));
  creature.stats.hp.current = 100;
  assert.equal(creature.stats.hp.current, 0);
  assert.equal(creature.statuses.get('dead').remaining, null);
  creature.statuses.clear();
  assert.equal(creature.dead, false);
  assert.equal(creature.statuses.actionBlockRemaining, 0);
  assert.equal(creature.stats.hp.current, creature.stats.hp.max);
});

test('revived actors can die again and release new plans on subsequent deaths', () => {
  const room = makeRoom();
  const world = new World({ rooms: [room], roster: [] });
  const agent = world.spawn({ ...character, stats: { hp: 240 } }, room, { x: 30, y: 80 });
  for (let i = 0; i < 2; i++) {
    let ended = 0;
    agent.setPlan(world, [{ activity: 'Working', interruptible: true, update: () => false, end: () => ended++ }]);
    agent.update(world, 0.1);
    agent.stats.hp.current = 0;
    world.update(0.1);
    assert.equal(ended, 1);
    agent.statuses.remove('dead');
    assert.equal(agent.stats.hp.current, 240);
  }
});

test('napping is a wakeable action-blocking status that pauses tasks, wakes on ping, and respects eligibility', () => {
  const room = makeRoom();
  const world = new World({ rooms: [room], roster: [] });
  const achievements = [];
  world.hooks.achieve = (id) => achievements.push(id);
  const agent = world.spawn(character, room, { x: 30, y: 80 });
  let progress = 0;
  agent.setPlan(world, [{
    activity: 'Custom work', interruptible: true,
    update(_agent, _world, dt) { progress += dt; return false; },
  }]);
  world.update(0.5);
  assert.equal(progress, 0.5);

  assert.equal(agent.statuses.apply('napping'), true);
  assert.deepEqual(agent.statuses.get('napping'), {
    id: 'napping', label: 'Napping', polarity: 'neutral', remaining: NAP_SECONDS, duration: NAP_SECONDS,
  });
  assert.equal(agent.napping, true);
  assert.equal(agent.activity, 'Napping');
  assert.equal(agent.busy, true);
  assert.equal(agent.incapacitated, false, 'napping pauses actions without incapacitating against interaction');
  assert.equal(agent.draggable, true);
  const position = [agent.x, agent.y];
  assert.equal(agent.moveToward({ x: 90, y: 80 }, 1), false);
  assert.deepEqual([agent.x, agent.y], position);

  world.update(NAP_SECONDS + 0.25);
  assert.equal(agent.napping, false);
  assert.equal(agent.activity, 'Custom work');
  assert.ok(Math.abs(progress - 0.75) < 1e-9, 'expiry grants only the awake remainder of the frame');

  agent.statuses.apply('napping', 15);
  agent.statuses.apply('shocked');
  assert.equal(agent.activity, 'Shocked');
  assert.equal(world.interact(agent), null, 'cannot wake an agent while incapacitated by shock');
  agent.statuses.remove('shocked');
  assert.equal(world.interact(agent), 'woke');
  assert.equal(agent.napping, false);
  assert.equal(agent.bubble, '!');
  assert.deepEqual(achievements, ['rude-awakening']);

  agent.statuses.apply('napping', 15);
  agent.statuses.apply('acid');
  assert.equal(agent.napping, false, 'acid wakes napping prey');
  agent.statuses.remove('acid');

  agent.statuses.apply('napping', 15);
  agent.statuses.apply('dead');
  assert.equal(agent.napping, false, 'death clears napping');
  assert.equal(agent.statuses.apply('napping'), false, 'dead agents cannot nap');
  agent.statuses.remove('dead');

  agent.held = true;
  assert.equal(agent.statuses.apply('napping'), false, 'held agents cannot nap');
  agent.held = false;
  assert.equal(Item.create('can').statuses.apply('napping'), false);
});

test('seated rest naps finish when napping expires or is woken, and wake if the seat breaks', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const room = makeRoom();
  const bench = new Prop({ type: 'bench', asset: 'bench', x: 40, y: 60, w: 30, h: 20, flip: false });
  room.setProps([bench]);
  const spot = { id: 'bench:0', kind: 'bench', facing: 'front', x: 55, y: 78, propDepth: 80, prop: bench };
  room.spots.push(spot);
  const world = new World({ rooms: [room], roster: [] });
  world.arrive = () => undefined;
  const sleeper = world.spawn({ ...character, behavior: { ...character.behavior, napChance: 1 } }, room, spot);
  t.mock.method(bench, 'breakOnUse', () => false);

  sleeper.setPlan(world, [rest(sleeper, spot, world, 'free')]);
  sleeper.spot = spot;
  world.update(0);
  assert.equal(sleeper.napping, true);
  assert.equal(sleeper.sitting, true);
  assert.equal(sleeper.activity, 'Napping');

  // Expiring the nap ends the seated rest cleanly on the next awake tick.
  const remaining = sleeper.statuses.get('napping').remaining;
  world.update(remaining);
  assert.equal(sleeper.napping, false);
  world.update(0);
  assert.equal(sleeper.sitting, false);

  // Waking via camera ping ends the seated rest on the next tick too.
  sleeper.setPlan(world, [rest(sleeper, spot, world, 'free')]);
  sleeper.spot = spot;
  world.update(0);
  assert.equal(sleeper.napping, true);
  assert.equal(world.interact(sleeper), 'woke');
  assert.equal(sleeper.napping, false);
  world.update(0);
  assert.equal(sleeper.sitting, false);

  // Breaking the seat mid-nap wakes the agent and releases the spot.
  sleeper.setPlan(world, [rest(sleeper, spot, world, 'free')]);
  sleeper.spot = spot;
  world.update(0);
  assert.equal(sleeper.napping, true);
  bench.break();
  world.update(0.1);
  assert.equal(sleeper.napping, false);
  assert.equal(sleeper.spot, undefined);
});

test('custom wakeable and activity-priority definitions drive waking and activity labels generically', (t) => {
  const daydream = register(t, 'test-daydream', {
    targets: ['agent'],
    blocksActions: true,
    wakeable: true,
    activity: { label: 'Daydreaming', priority: 10 },
  });
  const trance = register(t, 'test-trance', {
    targets: ['agent'],
    blocksActions: true,
    wakeable: true,
    activity: { label: 'In a trance', priority: 30 },
  });
  const room = makeRoom();
  const world = new World({ rooms: [room], roster: [] });
  const agent = world.spawn(character, room, { x: 30, y: 80 });
  agent.statuses.apply(daydream);
  assert.equal(agent.activity, 'Daydreaming');
  assert.equal(agent.incapacitated, false);
  assert.equal(agent.busy, true);
  agent.statuses.apply(trance);
  assert.equal(agent.activity, 'In a trance');
  assert.equal(world.interact(agent), 'woke');
  assert.equal(agent.statuses.has(daydream), false);
  assert.equal(agent.statuses.has(trance), false);
});
