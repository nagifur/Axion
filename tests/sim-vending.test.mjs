import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { dropTarget, placeAgent } from '../src/lib/sim/agentDrag.ts';
import { wait, walkTo } from '../src/lib/sim/tasks.ts';
import { getFromDispenser, useItem } from '../src/lib/sim/itemTasks.ts';
import { planNext } from '../src/lib/sim/planning.ts';
import { Item, ITEM_TYPES } from '../src/lib/sim/item.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';
import { Prop } from '../src/lib/sim/prop.ts';

beforeEach((t) => t.mock.method(Prop.prototype, 'breakOnUse', () => false));

const character = (id) => ({
  id, name: id, href: `/Personnel/${id}`, tint: '#fff', scale: 1, position: 'Test', species: 'Human',
  accessLevel: '1', employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});

async function setup(hour = 18) {
  const room = new Room(await loadRoom('level-2-lobby'));
  const world = new World({ roster: [], rooms: [room], now: () => new Date(2026, 0, 1, hour) });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text) => logs.push(text);
  const machine = room.props.find((prop) => prop.type === 'vending_machine');
  const stand = machine.standPoint(room);
  return { world, room, machine, stand, logs };
}

const drink = ITEM_TYPES.can.actions.find((action) => action.id === 'drink');
const run = (world, agent, seconds) => {
  for (let t = 0; t < seconds; t += 0.1) agent.update(world, 0.1);
};

test('the lobby vending machine dispenses cans only while it is on and working', async () => {
  const { room, machine, stand } = await setup();
  assert.equal(machine.kind.dispenses, 'can');
  assert.equal(machine.switchable, true, 'power switch comes from the sheet off row');
  assert.equal(machine.automaticPowerOff, false);
  assert.equal(machine.dispensing, 'can');
  assert.ok(room.isWalkable(stand));
  assert.ok(stand.y > machine.y + machine.h - 4 && Math.abs(stand.x - (machine.x + machine.w / 2)) < 8, 'stands in front');
  machine.setOn(false);
  assert.equal(machine.dispensing, null);
  machine.setOn(true);
  machine.broken = true;
  assert.equal(machine.dispensing, null);
  assert.equal(room.props.find((prop) => prop.type === 'bench').dispensing, null);
  assert.throws(() => getFromDispenser(room.props.find((prop) => prop.type === 'bench')), /does not dispense/);
});

test('an agent walks to the machine, gets a fresh can, then drinks it until it is destroyed', async () => {
  const { world, room, machine, stand, logs } = await setup();
  const agent = world.spawn(character('a'), room, { x: 300, y: 170 });
  agent.setPlan(world, [walkTo(stand, 'Heading to the vending machine'), getFromDispenser(machine)]);
  for (let t = 0; t < 60 && !agent.item; t += 0.1) agent.update(world, 0.1);
  assert.deepEqual([agent.x, agent.y], [stand.x, stand.y]);
  assert.equal(agent.item?.type, 'can');
  assert.equal(agent.item.asset, 'item:can');
  assert.deepEqual([agent.item.w, agent.item.h], [6, 10]);
  assert.deepEqual(room.items, [], 'the can goes straight into the hand');
  assert.ok(logs.includes(`a got a can from the vending machine in the ${room.name}.`));
  agent.setPlan(world, [useItem(drink)]);
  run(world, agent, drink.seconds + 0.2);
  assert.equal(agent.item, null);
  assert.deepEqual(room.items, []);
});

test('nothing comes out if the hand fills or the machine goes off or breaks meanwhile', async (t) => {
  t.mock.method(Math, 'random', () => 0.99);
  const { world, room, machine, stand, logs } = await setup();
  const agent = world.spawn(character('a'), room, stand);
  for (const spoil of [() => agent.receiveItem(Item.create('can')), () => machine.setOn(false), () => { machine.broken = true; }]) {
    // The trailing wait keeps the planner from picking a new task (e.g. a meow) that would replace the '?' bubble.
    agent.setPlan(world, [getFromDispenser(machine), wait(10, 'Waiting')]);
    agent.update(world, 0);
    assert.equal(agent.activity, 'Using the vending machine');
    assert.equal(agent.busy, true);
    assert.equal(agent.facing, 'back');
    spoil();
    const before = agent.item;
    run(world, agent, 3);
    assert.equal(agent.item, before, 'no new can');
    assert.equal(agent.bubble, '?');
    if (agent.item) agent.consumeItem();
    machine.setOn(true);
    machine.broken = false;
  }
  assert.equal(logs.filter((line) => line.includes("couldn't get a can")).length, 3);
  assert.throws(() => { agent.receiveItem(Item.create('can')); agent.receiveItem(Item.create('can')); }, /already carries/);
  assert.throws(() => Item.create('mystery'), /ITEM_SPRITES/);
});

test('the planner offers the vending machine only with empty hands and a working machine', async (t) => {
  const { world, room, machine } = await setup();
  t.mock.method(world, 'freeSpot', () => undefined);
  t.mock.method(world, 'findChatPartner', () => undefined);
  const random = t.mock.method(Math, 'random', () => 0);
  const agent = world.spawn(character('a'), room, { x: 300, y: 170 });
  const visits = () => {
    let count = 0;
    for (let i = 0; i < 200; i++) {
      random.mock.mockImplementation(() => (i + 0.5) / 200);
      const plan = planNext(agent, world);
      if (plan[1]?.activity === 'Using the vending machine') count++;
    }
    return count;
  };
  assert.ok(visits() > 0);
  machine.setOn(false);
  assert.equal(visits(), 0, 'switched off');
  machine.setOn(true);
  agent.receiveItem(Item.create('can'));
  assert.equal(visits(), 0, 'hand full');
});

test('dropping an agent on the vending machine gets a can; switched off it is turned on instead', async () => {
  const { world, room, machine, stand } = await setup();
  const agent = world.spawn(character('a'), room, { x: 300, y: 170 });
  const at = { x: machine.x + machine.w / 2, y: machine.y + machine.h / 2 };
  const target = dropTarget(world, agent, at, null, machine);
  assert.equal(target.kind, 'prop');
  assert.equal(target.label, 'Get a can from the vending_machine');
  assert.deepEqual(target.point, stand);
  assert.equal(placeAgent(world, agent, target), true);
  for (let t = 0; t < 3 && !agent.item; t += 0.1) agent.update(world, 0.1);
  assert.equal(agent.item?.type, 'can');
  assert.equal(machine.on, true, 'buying does not toggle the power');
  const full = dropTarget(world, agent, at, null, machine);
  assert.equal(full.kind, 'invalid');
  assert.match(full.label, /hand is already full/);

  agent.consumeItem();
  machine.setOn(false);
  const off = dropTarget(world, agent, at, null, machine);
  assert.equal(off.label, 'Switch vending_machine on');
  placeAgent(world, agent, off);
  agent.update(world, 0.1);
  assert.equal(machine.on, true);
  assert.equal(agent.item, null);
});
