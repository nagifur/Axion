import assert from 'node:assert/strict';
import test from 'node:test';
import { getFromDispenser, planNext, rest, wait, walkTo } from '../src/lib/sim/agent.ts';
import { dropTarget, placeAgent } from '../src/lib/sim/agentDrag.ts';
import { Item } from '../src/lib/sim/item.ts';
import { Prop, PROP_BREAK_CHANCE } from '../src/lib/sim/prop.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';

const character = (id, napChance = 0) => ({
  id, name: id, href: `/Personnel/${id}`, tint: '#fff', scale: 1, position: 'Test', species: 'Human',
  accessLevel: '1', employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance, clumsy: false, social: 0, ghost: false },
});
const placed = (type) => ({ type, asset: type, x: 0, y: 0, w: 10, h: 10, flip: false });

async function setup(id = 'level-1-offices', napChance = 0) {
  const room = new Room(await loadRoom(id));
  const world = new World({ roster: [], rooms: [room], now: () => new Date(2026, 0, 1, 12) });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text, tone) => logs.push({ text, tone });
  const agent = world.spawn(character('a', napChance), room, room.randomFloorPoint());
  return { room, world, agent, logs };
}

test('exactly 1% of use rolls break each breakable type, without changing starting state', (t) => {
  assert.equal(PROP_BREAK_CHANCE, 0.01);
  let roll = 0;
  t.mock.method(Math, 'random', () => roll);
  for (const type of ['chair', 'bench', 'table', 'light', 'vending_machine', 'glass']) {
    const prop = new Prop({ ...placed(type), ...(type === 'glass' ? { brokenLook: true } : {}) });
    let breaks = 0;
    for (let i = 0; i < 10000; i++) {
      roll = i / 10000;
      if (prop.breakOnUse()) breaks++;
      prop.repair();
    }
    assert.equal(breaks, 100, type);
    roll = PROP_BREAK_CHANCE;
    assert.equal(prop.breakOnUse(), false, 'threshold is exclusive');
    roll = 0;
    assert.equal(prop.breakOnUse(), true);
    assert.equal(prop.breakOnUse(), false, 'already broken');
    assert.equal(prop.toData().start, undefined, 'runtime state is not exported');
    prop.repair();
    assert.equal(prop.breakOnUse(), true, 'can break again after repair');
  }
});

test('decoration and already broken props do not roll', (t) => {
  const random = t.mock.method(Math, 'random', () => 0);
  const plant = new Prop(placed('plant'));
  const chair = new Prop(placed('chair'));
  chair.break();
  assert.equal(plant.breakOnUse(), false);
  assert.equal(chair.breakOnUse(), false);
  assert.equal(random.mock.callCount(), 0);
});

test('autonomous seated plans roll on arrival, not while walking or planning', async (t) => {
  const { world, room, agent, logs } = await setup();
  t.mock.method(world, 'findChatPartner', () => undefined);
  t.mock.method(room, 'route', (_from, to) => [to]);
  const random = t.mock.method(Math, 'random', () => 0.5);
  for (const kind of ['chair', 'bench']) {
    const spot = room.spots.find((spot) => spot.kind === kind);
    t.mock.method(world, 'freeSpot', (_room, requested) => requested === kind ? spot : undefined);
    let plan;
    for (let i = 0; i < 100 && !plan; i++) {
      random.mock.mockImplementation(() => (i + 0.5) / 100);
      const candidate = planNext(agent, world);
      if (candidate[1]?.sitting) plan = candidate;
    }
    assert.ok(plan, `planner offers ${kind}`);
    assert.equal(spot.prop.broken, false);
    agent.setPlan(world, plan);
    agent.spot = spot;
    random.mock.mockImplementation(() => 0);
    agent.update(world, 1000);
    assert.equal(spot.prop.broken, false, 'walking does not roll');
    agent.update(world, 0);
    assert.equal(spot.prop.broken, true);
    assert.equal(agent.sitting, false);
    assert.equal(agent.spot, undefined);
    assert.equal(agent.bubble, '!');
    world.freeSpot.mock.restore();
    assert.equal(world.freeSpot(room, kind)?.prop === spot.prop, false, 'broken prop is excluded');
  }
  assert.equal(logs.filter((entry) => entry.tone === 'warn' && entry.text.includes('broke')).length, 2);
});

test('seated use rolls once across ticks and interruption, including naps', async (t) => {
  const { world, room, agent } = await setup();
  t.mock.method(Math, 'random', () => 0.5);
  const spot = room.spots.find((spot) => spot.kind === 'bench');
  const task = rest(agent, spot, world, 'free');
  const roll = t.mock.method(spot.prop, 'breakOnUse', () => false);
  agent.setPlan(world, [task]);
  agent.spot = spot;
  agent.update(world, 0);
  for (let i = 0; i < 10; i++) agent.update(world, 0.1);
  agent.interrupt(world, wait(0.1, 'Interrupted'));
  agent.update(world, 0.1);
  agent.update(world, 0);
  assert.equal(roll.mock.callCount(), 1);
  assert.equal(agent.sitting, true);

  agent.character.behavior.napChance = 1;
  const sleeping = rest(agent, spot, world, 'free');
  roll.mock.mockImplementation(() => spot.prop.break());
  agent.setPlan(world, [sleeping]);
  agent.spot = spot;
  agent.update(world, 0);
  assert.equal(agent.napping, false, 'a broken seat cannot start a nap');
  assert.equal(agent.spot, undefined);
  assert.equal(agent.bubble, '!');
});

test('manual previews never roll; seating, inspecting and switching roll on task start', async (t) => {
  const { world, room, agent, logs } = await setup();
  t.mock.method(Math, 'random', () => 0);
  for (const type of ['chair', 'bench', 'table', 'light']) {
    const prop = room.props.find((prop) => prop.type === type);
    const point = { x: prop.x + prop.w / 2, y: prop.y + prop.h / 2 };
    const target = dropTarget(world, agent, point, null, prop);
    assert.notEqual(target.kind, 'invalid');
    assert.equal(prop.broken, false);
    placeAgent(world, agent, target);
    assert.equal(prop.broken, false, 'paused placement is not use');
    agent.update(world, 0);
    assert.equal(prop.broken, true, type);
    assert.equal(agent.bubble, '!');
    assert.equal(dropTarget(world, agent, point, null, prop).kind, 'invalid');
    if (type === 'light') assert.equal(prop.on, true, 'failed switch does not toggle power');
  }
  assert.equal(logs.filter((entry) => entry.tone === 'warn').length, 4);
});

test('a dispenser rolls only on valid completion, and breakage gives no item', async (t) => {
  const { world, room, agent, logs } = await setup('level-2-lobby');
  const machine = room.props.find((prop) => prop.type === 'vending_machine');
  t.mock.method(Math, 'random', () => 0);
  const roll = t.mock.method(machine, 'breakOnUse', () => machine.break());
  agent.setPlan(world, [walkTo(machine.standPoint(room)), getFromDispenser(machine)]);
  agent.update(world, 1000);
  agent.update(world, 2.4);
  assert.equal(roll.mock.callCount(), 0);
  agent.update(world, 0.2);
  assert.equal(roll.mock.callCount(), 1);
  assert.equal(machine.broken, true);
  assert.equal(machine.dispensing, null);
  assert.equal(agent.item, null);
  assert.equal(agent.bubble, '!');
  assert.ok(logs.some((entry) => entry.tone === 'warn' && entry.text.includes('vending machine')));

  machine.repair();
  for (const spoil of [
    () => agent.receiveItem(Item.create('can')),
    () => machine.setOn(false),
    () => machine.break(),
    () => room.setProps(room.props.filter((prop) => prop !== machine)),
  ]) {
    agent.setPlan(world, [getFromDispenser(machine)]);
    agent.update(world, 0);
    spoil();
    agent.update(world, 3);
    assert.equal(roll.mock.callCount(), 1, 'invalid attempts do not roll');
    if (agent.item) agent.consumeItem();
    machine.repair();
    machine.setOn(true);
  }
});

test('dragging onto a working vending machine shares the failed-use behavior', async (t) => {
  const { world, room, agent } = await setup('level-2-lobby');
  const machine = room.props.find((prop) => prop.type === 'vending_machine');
  t.mock.method(Math, 'random', () => 0);
  const target = dropTarget(world, agent, { x: machine.x + machine.w / 2, y: machine.y + machine.h / 2 }, null, machine);
  placeAgent(world, agent, target);
  agent.update(world, 3);
  assert.equal(machine.broken, true);
  assert.equal(agent.item, null);
  assert.equal(agent.bubble, '!');
});

test('inspecting a glass pane can break it without introducing a power switch', async (t) => {
  const { world, room, agent, logs } = await setup('level-0-mainEntrance');
  const pane = room.props.find((prop) => prop.type === 'glass');
  assert.deepEqual([pane.breakable, pane.switchable, pane.broken], [true, false, false]);
  t.mock.method(Math, 'random', () => 0);
  const point = { x: pane.x + pane.w / 2, y: pane.y + pane.h / 2 };
  const target = dropTarget(world, agent, point, null, pane);
  assert.equal(target.kind, 'prop');
  assert.equal(target.label, 'Inspect glass');
  placeAgent(world, agent, target);
  assert.equal(pane.broken, false, 'placement alone does not roll');
  agent.update(world, 0);
  assert.deepEqual([pane.broken, pane.look, pane.on], [true, 'broken', true]);
  world.update(0);
  assert.equal(world.particles.in(room).filter((particle) => particle.asset.startsWith('particle:glass_')).length,
    10, 'glass breakage through agent use emits shards independently of nearby electrical sparks');
  assert.equal(agent.bubble, '!');
  assert.ok(logs.some((entry) => entry.tone === 'warn' && entry.text.includes('glass')));
  assert.equal(dropTarget(world, agent, point, null, pane).kind, 'invalid');
  pane.repair();
  assert.equal(pane.setOn(false), false);
  assert.deepEqual([pane.broken, pane.look, pane.on], [false, undefined, true]);
});
