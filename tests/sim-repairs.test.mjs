import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { planRepair, REPAIR_SECONDS } from '../src/lib/sim/repairs.ts';
import { planNext } from '../src/lib/sim/planning.ts';
import { Room } from '../src/lib/sim/room.ts';
import { wait, nap, trip } from '../src/lib/sim/tasks.ts';
import { exitThroughDoor } from '../src/lib/sim/transport.ts';
import { World } from '../src/lib/sim/world.ts';

beforeEach((t) => t.mock.method(Math, 'random', () => 0.5));

const staff = (id = 'worker', position = 'Maintenance', accessLevel = '1') => ({
  id, name: id, href: '', tint: '#fff', scale: 1, position, species: 'Human',
  accessLevel, employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});

function makeRoom(id = 'a', level = 1, props = [], linked = false) {
  return new Room({
    id, name: id, level, camera: id, width: 220, height: 140,
    nav: {
      floor: Array.from({ length: 140 }, () => [0, 220]),
      exits: [{
        id: 'north', kind: 'door', side: 'north',
        bounds: { x: 150, y: 0, w: 46, h: 69 },
        threshold: { x: 173, y: 85 }, base: { x: 173, y: 69 },
      }],
    },
    props, doors: { north: { clearance: 4 } },
    links: linked ? { north: { room: id === 'a' ? 'b' : 'a', door: 'north' } } : {},
  });
}

function setup(type = 'glass', level = 1, accessLevel = '1') {
  const room = makeRoom('a', level, type ? [{
    type, asset: type, x: 50, y: 35, w: 70, h: 40, flip: false,
    brokenLook: true, start: { broken: true, ...(type === 'light' ? { on: false } : {}) },
  }] : []);
  const world = new World({ rooms: [room], roster: [], now: () => new Date(2026, 0, 1, 23) });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text, tone) => logs.push({ text, tone });
  const agent = world.spawn(staff('worker', 'Maintenance', accessLevel), room, { x: 20, y: 110 });
  return { room, world, agent, prop: room.props[0], logs };
}

function arriveForRepair(agent, world) {
  agent.update(world, 0);
  for (let i = 0; i < 100 && !agent.activity.startsWith('Repairing'); i++) {
    agent.update(world, 1);
    agent.update(world, 0);
  }
  assert.match(agent.activity, /^Repairing/);
}

test('maintenance walks to any broken prop and repairs only after the full duration', () => {
  assert.equal(REPAIR_SECONDS, 12);
  for (const type of ['glass', 'chair', 'bench', 'table', 'light', 'vending_machine']) {
    const { world, agent, prop, logs } = setup(type);
    const before = prop.toData();
    agent.update(world, 0);
    assert.match(agent.activity, /^Going to repair/);
    assert.equal(prop.broken, true);
    assert.equal(agent.repairTarget.prop, prop);
    arriveForRepair(agent, world);
    assert.equal(prop.broken, true, 'walking time does not count toward repairs');
    agent.update(world, REPAIR_SECONDS - 0.25);
    assert.match(agent.activity, /^Repairing/);
    assert.equal(agent.moving, false);
    assert.equal(prop.broken, true);
    agent.update(world, 0.25);
    assert.equal(prop.broken, false);
    assert.equal(agent.repairTarget, undefined);
    assert.equal(prop.on, before.start.on ?? true, 'power state is preserved');
    assert.deepEqual(prop.toData(), before, 'starting configuration is unchanged');
    assert.equal(logs.filter(({ tone }) => tone === 'ok').length, 1);
  }
});

test('job title, not clearance, determines eligibility, at any time and on any floor', () => {
  const { world, room, agent } = setup('glass', 3, '3');
  agent.character.position = ' maintenance ';
  assert.match(planNext(agent, world)[0].activity, /^Going to repair/);
  agent.character.position = 'Researcher';
  assert.equal(planRepair(agent, world), undefined);
  agent.character.position = 'Maintenance Supervisor';
  assert.equal(planRepair(agent, world), undefined);
  agent.character.position = 'Maintenance';
  const impostor = world.spawn(staff('fake'), room, agent, { id: 'fake' });
  assert.equal(planRepair(impostor, world), undefined);
});

test('new damage interrupts routine work but not protected tasks', () => {
  const { world, room, agent, prop } = setup();
  prop.repair();
  agent.setPlan(world, [wait(100, 'Working')]);
  agent.update(world, 0);
  prop.break();
  agent.update(world, 0);
  assert.match(agent.activity, /^Going to repair/);
  assert.equal(agent.repairTarget.prop, prop);

  for (const task of [nap(100, 'front'), trip(), exitThroughDoor(room.doors[0])]) {
    agent.setPlan(world, [task]);
    agent.update(world, 0);
    agent.update(world, 0);
    assert.equal(agent.repairTarget, undefined);
  }
  agent.setPlan(world, [wait(100, 'Talking')]);
  // Conversations own the participants' plans until the conversation ends.
  agent.conversation = { ended: false };
  agent.update(world, 0);
  agent.update(world, 0);
  assert.equal(agent.activity, 'Talking');
  assert.equal(agent.repairTarget, undefined);
});

test('repairs claim equipment while walking and release claims on cancellation or removal', () => {
  const { world, room, agent, prop } = setup();
  const other = world.spawn(staff('other'), room, { x: 30, y: 110 });
  agent.update(world, 0);
  assert.equal(planRepair(other, world), undefined);
  agent.setPlan(world, []);
  other.update(world, 0);
  assert.equal(other.repairTarget.prop, prop);
  world.remove(other, 'north');
  assert.equal(other.repairTarget, undefined);
  assert.ok(planRepair(agent, world));
});

test('door and panel damage repair independently from either side without clearance', () => {
  const a = makeRoom('a', 1, [], true);
  const b = makeRoom('b', 1, [], true);
  const world = new World({ rooms: [a, b], roster: [] });
  const agent = world.spawn(staff(), a, { x: 30, y: 110 });
  const other = world.spawn(staff('other'), b, { x: 30, y: 110 });
  const state = world.passageDoorFor(a.doors[0]);
  assert.equal(state, world.passageDoorFor(b.doors[0]));
  state.break();
  arriveForRepair(agent, world);
  assert.equal(agent.repairTarget.part, 'door');
  assert.equal(planRepair(other, world), undefined, 'both camera views share a claim');
  state.breakPanel();
  agent.update(world, REPAIR_SECONDS);
  assert.equal(state.broken, false);
  assert.equal(state.panelBroken, true, 'repairing the door does not fix its panel');
  arriveForRepair(other, world);
  assert.equal(other.repairTarget.part, 'panel');
  other.update(world, REPAIR_SECONDS);
  assert.equal(state.panelBroken, false);
  assert.equal(state.blocked, false);
});

test('repairs abort safely if the prop is removed, moved, or fixed by someone else', () => {
  for (const invalidate of [
    ({ room }) => room.setProps([]),
    ({ prop }) => prop.repair(),
    ({ prop }) => { prop.x += 50; },
    ({ agent }) => { agent.x = 20; agent.y = 110; },
  ]) {
    const context = setup();
    const { world, agent, prop, logs } = context;
    arriveForRepair(agent, world);
    agent.update(world, 3);
    invalidate(context);
    const broken = prop.broken;
    agent.update(world, REPAIR_SECONDS);
    assert.equal(agent.repairTarget, undefined);
    assert.equal(logs.some(({ tone }) => tone === 'ok'), false);
    assert.equal(prop.broken, broken, 'an abandoned repair does not change damage');
  }
});

test('only reachable damage in the current room is considered, preferring the nearest target', () => {
  const { world, room, agent, prop } = setup();
  room.setProps([prop, {
    type: 'glass', asset: 'glass', x: 160, y: 35, w: 30, h: 40, flip: false,
    brokenLook: true, start: { broken: true },
  }]);
  assert.equal(planRepair(agent, world)[0].repairTarget.prop, prop);
  const away = makeRoom('away', 1, [prop.toData()]);
  world.rooms.push(away);
  room.setProps([]);
  assert.equal(planRepair(agent, world), undefined, 'does not scan remote rooms');

  const divided = new Room({
    id: 'divided', name: 'divided', level: 1, camera: '', width: 220, height: 140,
    nav: { floor: Array.from({ length: 140 }, () => [0, 85, 135, 220]), exits: [] },
    props: [{ ...prop.toData(), x: 160, w: 30 }], links: {},
  });
  const stranded = world.spawn(staff('stranded'), divided, { x: 30, y: 100 });
  assert.equal(planRepair(stranded, world), undefined, 'does not walk across disconnected floor');
  stranded.character.behavior.ghost = true;
  assert.ok(planRepair(stranded, world), 'ghosts keep their existing ability to cross obstacles');
});
