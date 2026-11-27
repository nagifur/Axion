import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { dropTarget, placeAgent } from '../src/lib/sim/agentDrag.ts';
import { startConversation } from '../src/lib/sim/conversation.ts';
import {
  checkElectricalApproach, SHOCK_APPROACH_CHANCE, SHOCK_INTERACTION_CHANCE,
  SHOCK_REACH, SHOCK_RECOVERY_SECONDS, tryElectricalShock,
} from '../src/lib/sim/electrical.ts';
import { Item, ITEM_TYPES } from '../src/lib/sim/item.ts';
import { getFromDispenser, useItem } from '../src/lib/sim/itemTasks.ts';
import { distanceToRect, segmentDistanceToRect } from '../src/lib/sim/navMap.ts';
import { planRepair, REPAIR_SECONDS } from '../src/lib/sim/repairs.ts';
import { Room } from '../src/lib/sim/room.ts';
import { PROP_TYPES } from '../src/lib/sim/sprites.ts';
import { SHOCK_SECONDS, STATUS_EFFECTS } from '../src/lib/sim/statusEffects.ts';
import { nap, wait, walkTo } from '../src/lib/sim/tasks.ts';
import { World } from '../src/lib/sim/world.ts';

beforeEach((t) => t.mock.method(Math, 'random', () => 0.99));

const staff = (id = 'tester', position = 'Researcher') => ({
  id, name: id, position, species: 'Human', employeeID: id, href: '/', tint: '#fff', scale: 1, accessLevel: 'Admin',
  traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});
const placed = (type = 'light', extra = {}) => ({
  type, asset: type, x: 80, y: 40, w: 20, h: 20, flip: false,
  start: { broken: true }, ...extra,
});

function setup(prop = placed(), character = staff()) {
  const room = new Room({
    id: 'test', name: 'Test', level: 0, camera: 'Test', width: 240, height: 160,
    nav: { floor: Array.from({ length: 160 }, () => [0, 240]), exits: [] },
    props: prop ? [prop] : [], links: {},
  });
  const world = new World({ rooms: [room], roster: [] });
  const agent = world.spawn(character, room, { x: 60, y: 65 });
  const logs = [];
  world.hooks.log = (text, tone) => logs.push({ text, tone });
  agent.setPlan(world, [wait(1000, 'Waiting')]);
  return { room, world, agent, prop: room.props[0], logs };
}

test('shocked blocks tasks, movement, dragging and item actions, then resumes the same task', () => {
  const { world, agent } = setup(null);
  let starts = 0;
  let progress = 0;
  let ends = 0;
  agent.setPlan(world, [{
    activity: 'Custom task', interruptible: true,
    start() { starts++; },
    update(_agent, _world, dt) { progress += dt; return progress >= 5; },
    end() { ends++; },
  }]);
  world.update(0.5);
  const inventory = agent.inventory[0];
  const hp = agent.stats.hp.current;
  assert.equal(agent.statuses.apply('shocked'), true);
  assert.equal(agent.activity, 'Shocked');
  assert.equal(agent.incapacitated, true);
  assert.equal(agent.busy, true);
  assert.equal(agent.draggable, false);
  assert.equal(agent.bubble, null, 'shock has its own status popup instead of replacing speech');
  assert.equal(agent.shake, SHOCK_SECONDS);
  assert.equal(agent.frame.name, 'idleFront1');
  const point = [agent.x, agent.y];
  assert.equal(agent.moveToward({ x: 100, y: 80 }, 1), false);
  assert.deepEqual([agent.x, agent.y], point);
  assert.throws(() => agent.retrieveItem(inventory), /incapacitation/);
  world.update(0);
  assert.equal(agent.statuses.get('shocked').remaining, SHOCK_SECONDS);
  world.update(SHOCK_SECONDS - 0.25);
  assert.equal(progress, 0.5);
  assert.equal(agent.statuses.has('shocked'), true);
  world.update(0.25);
  assert.equal(agent.incapacitated, false);
  assert.equal(progress, 0.5, 'the expiry frame must not count the stunned time toward the task');
  assert.equal(agent.activity, 'Custom task');
  assert.equal(agent.draggable, true);
  assert.equal(agent.stats.hp.current, hp, 'shock is paralysis, not HP damage');
  world.update(0.5);
  assert.equal(progress, 1);
  assert.deepEqual([starts, ends], [1, 0], 'the paused task was neither restarted nor cancelled');
});

test('large expiry frames grant only unstunned time and queued tasks do not start during paralysis', () => {
  const { world, agent } = setup(null);
  let starts = 0;
  let elapsed = 0;
  agent.setPlan(world, [{
    activity: 'Queued', interruptible: false,
    start() { starts++; },
    update(_agent, _world, dt) { elapsed += dt; return false; },
  }]);
  agent.statuses.apply('shocked');
  world.update(SHOCK_SECONDS);
  assert.deepEqual([starts, elapsed], [0, 0]);
  agent.statuses.apply('shocked');
  world.update(SHOCK_SECONDS + 0.25);
  assert.deepEqual([starts, elapsed], [1, 0.25]);
  assert.equal(agent.activity, 'Queued');
  assert.equal(agent.statuses.has('shocked'), false);
});

test('shocked agents cannot initiate or be invited into a conversation', () => {
  const { world, room, agent } = setup(null);
  const other = world.spawn(staff('other'), room, { x: 100, y: 80 });
  agent.statuses.apply('shocked');
  assert.equal(world.findChatPartner(other), undefined);
  assert.equal(startConversation(agent, other, world), null);
  assert.equal(startConversation(other, agent, world), null);
  assert.equal(agent.conversation, undefined);
  assert.equal(other.conversation, undefined);
});

test('shocked pauses item consumption and preserves a sleeping agent bubble on recovery', () => {
  const { world, agent } = setup(null);
  const item = Item.create('can');
  agent.receiveItem(item);
  const action = ITEM_TYPES.can.actions[0];
  agent.setPlan(world, [useItem(action), wait(1000, 'Finished')]);
  world.update(0.5);
  agent.statuses.apply('shocked');
  world.update(SHOCK_SECONDS);
  assert.equal(agent.item, item, 'stunned time does not consume the carried item');
  world.update(action.seconds - 0.75);
  assert.equal(agent.item, item);
  world.update(0.25);
  assert.equal(agent.item, null);
  agent.setPlan(world, [nap(10, 'front')]);
  world.update(0);
  agent.statuses.apply('shocked');
  world.update(SHOCK_SECONDS);
  assert.equal(agent.napping, true);
  assert.equal(agent.bubble, 'zZ');
  assert.equal(agent.item, null);
});

test('only broken electrical props in reach and in the current room shock on interaction', (t) => {
  for (const data of [placed('table'), placed('light', { start: {} }), placed('plant')]) {
    const { world, agent, prop } = setup(data);
    agent.x = 90;
    const roll = t.mock.method(Math, 'random', () => 0);
    assert.equal(tryElectricalShock(agent, world, prop), false);
    assert.equal(roll.mock.callCount(), 0, 'ineligible sources must not roll');
    roll.mock.restore();
  }
  const { world, agent, prop, room } = setup();
  agent.x = 90;
  const roll = t.mock.method(Math, 'random', () => 0);
  prop.setOn(false);
  assert.equal(tryElectricalShock(agent, world, prop), true, 'broken equipment sparks and shocks even when switched off');
  assert.equal(agent.statuses.has('shocked'), true);
  assert.equal(roll.mock.callCount(), 1);
  agent.statuses.remove('shocked');
  assert.equal(tryElectricalShock(agent, world, prop), false, 'cooldown prevents immediate reapplication');
  world.time += SHOCK_SECONDS + SHOCK_RECOVERY_SECONDS;
  agent.x = 0;
  assert.equal(tryElectricalShock(agent, world, prop), false, 'cannot interact from across the room');
  agent.x = 90;
  room.setProps([]);
  assert.equal(tryElectricalShock(agent, world, prop), false, 'removed or remote props cannot shock');
});

test('shock chance thresholds are exclusive and active shocks cannot be refreshed by exposure', (t) => {
  for (const [probability, encounter] of [
    [SHOCK_INTERACTION_CHANCE, (agent, world, prop) => tryElectricalShock(agent, world, prop)],
    [SHOCK_APPROACH_CHANCE, (agent, world) => checkElectricalApproach(agent, world, { x: 60, y: 65 })],
  ]) {
    for (const [roll, expected] of [[probability, false], [probability - 0.001, true]]) {
      const { world, agent, prop } = setup();
      agent.x = 90;
      const random = t.mock.method(Math, 'random', () => roll);
      encounter(agent, world, prop);
      assert.equal(agent.statuses.has('shocked'), expected);
      if (expected) {
        agent.statuses.update(world, 0.5);
        assert.equal(tryElectricalShock(agent, world, prop), false);
        assert.equal(agent.statuses.get('shocked').remaining, SHOCK_SECONDS - 0.5);
      }
      random.mock.restore();
    }
  }
});

test('electrical exposure cannot shock again until the full post-stun recovery grace ends', (t) => {
  const { world, agent, prop } = setup();
  agent.x = 90;
  t.mock.method(Math, 'random', () => 0);
  assert.equal(tryElectricalShock(agent, world, prop), true);
  world.update(SHOCK_SECONDS);
  assert.equal(agent.incapacitated, false);
  assert.equal(tryElectricalShock(agent, world, prop), false);
  world.update(SHOCK_RECOVERY_SECONDS - 0.25);
  assert.equal(tryElectricalShock(agent, world, prop), false);
  world.update(0.25);
  assert.equal(tryElectricalShock(agent, world, prop), true, 'exposure is eligible again at the exact grace boundary');
});

test('shock reach uses visible impact bounds and mirrors them for flipped props', (t) => {
  PROP_TYPES.test_shock_bounds = {
    asset: 'test_shock_bounds', electric: true, breakable: true,
    impactArea: { x: 20, y: 10, w: 10, h: 20 },
  };
  t.after(() => { delete PROP_TYPES.test_shock_bounds; });
  t.mock.method(Math, 'random', () => 0);
  const { world, agent, prop } = setup(placed('test_shock_bounds', { w: 96, h: 96, flip: true }));
  agent.x = 100;
  agent.y = 60;
  assert.equal(tryElectricalShock(agent, world, prop), false, 'transparent padding is not an electrical surface');
  agent.x = 145;
  assert.equal(tryElectricalShock(agent, world, prop), true, 'the mirrored visible area is hazardous');
});

test('walking through the danger radius shocks, including a swept pass with both endpoints far away', (t) => {
  const { world, agent, logs } = setup();
  t.mock.method(Math, 'random', () => 0);
  agent.x = 30;
  agent.setPlan(world, [walkTo({ x: 160, y: 65 }), wait(1000, 'Arrived')]);
  world.update(0);
  assert.equal(agent.statuses.has('shocked'), false, 'paused planning never rolls exposure');
  world.update(10);
  assert.equal(agent.statuses.has('shocked'), true, 'a long frame cannot jump over the hazard');
  assert.equal(agent.moving, false);
  const position = [agent.x, agent.y];
  world.update(1);
  assert.deepEqual([agent.x, agent.y], position);
  assert.ok(logs.some(({ text, tone }) => tone === 'warn' && text.includes('shocked by the broken light')));
});

test('approach rolls happen only on entry, use accurate bounds, and reset after walking away', (t) => {
  const { world, agent, prop } = setup();
  const roll = t.mock.method(Math, 'random', () => 0.99);
  agent.x = 90;
  agent.y = 60 + SHOCK_REACH;
  checkElectricalApproach(agent, world, { x: 40, y: agent.y });
  assert.equal(roll.mock.callCount(), 1, 'radius boundary is included');
  checkElectricalApproach(agent, world, { x: 85, y: agent.y });
  assert.equal(roll.mock.callCount(), 1, 'walking within the same radius does not roll every frame');
  agent.x = 140;
  checkElectricalApproach(agent, world, { x: 90, y: agent.y });
  assert.equal(roll.mock.callCount(), 1);
  agent.x = 90;
  checkElectricalApproach(agent, world, { x: 140, y: agent.y });
  assert.equal(roll.mock.callCount(), 2);
  agent.y += 0.001;
  checkElectricalApproach(agent, world, { x: 40, y: agent.y });
  assert.equal(roll.mock.callCount(), 2, 'just outside the radius does not roll');
  prop.repair();
  checkElectricalApproach(agent, world, agent);
  assert.equal(roll.mock.callCount(), 2);
});

test('held, fading, inside-elevator, removed and stationary agents do not receive approach shocks', (t) => {
  for (const state of [{ held: true }, { alpha: 0.5 }, { layer: 'inside' }, { removed: true }]) {
    const { world, agent, prop } = setup();
    Object.assign(agent, { x: 90 }, state);
    t.mock.method(Math, 'random', () => 0);
    checkElectricalApproach(agent, world, { x: 40, y: 65 });
    assert.equal(tryElectricalShock(agent, world, prop), false);
    assert.equal(agent.statuses.has('shocked'), false);
  }
  const { world, agent } = setup();
  agent.x = 90;
  t.mock.method(Math, 'random', () => 0);
  world.update(0.1);
  assert.equal(agent.statuses.has('shocked'), false, 'standing still nearby is not an approach');
});

test('manual hazard previews are side-effect-free, while an actual inspection risks shock only once', (t) => {
  const { world, agent, prop } = setup();
  const roll = t.mock.method(Math, 'random', () => 0);
  const target = dropTarget(world, agent, { x: 90, y: 50 }, null, prop);
  assert.equal(target.kind, 'prop');
  assert.match(target.label, /shock risk/);
  assert.equal(roll.mock.callCount(), 0);
  assert.equal(placeAgent(world, agent, target), true);
  assert.equal(agent.statuses.has('shocked'), false);
  world.update(0);
  assert.equal(agent.statuses.has('shocked'), false);
  world.update(0.1);
  assert.equal(agent.statuses.has('shocked'), true);
  assert.equal(dropTarget(world, agent, agent).kind, 'invalid');
  assert.equal(placeAgent(world, agent, target), false, 'an old drop target cannot bypass paralysis');
  world.update(SHOCK_SECONDS + SHOCK_RECOVERY_SECONDS + 1);
  assert.equal(agent.statuses.has('shocked'), false, 'the same inspection does not shock again after recovery');
  assert.equal(prop.broken, true);
});

test('trying a broken dispenser can shock but never dispense, and maintenance resumes a claimed repair', (t) => {
  const vending = setup(placed('vending_machine', { w: 96, h: 96 }));
  Object.assign(vending.agent, vending.prop.standPoint(vending.room));
  t.mock.method(Math, 'random', () => 0);
  vending.agent.setPlan(vending.world, [getFromDispenser(vending.prop), wait(1000, 'Done')]);
  vending.world.update(0.1);
  assert.equal(vending.agent.statuses.has('shocked'), true);
  assert.equal(vending.agent.item, null);
  vending.world.update(SHOCK_SECONDS);
  vending.world.update(3);
  assert.equal(vending.agent.item, null);
  assert.equal(vending.agent.statuses.has('shocked'), false);

  const { world, agent, room, prop } = setup(placed(), staff('maintenance', 'Maintenance'));
  Object.assign(agent, prop.standPoint(room));
  agent.setPlan(world, planRepair(agent, world));
  world.update(0);
  world.update(0.1);
  assert.equal(agent.statuses.has('shocked'), true);
  assert.equal(agent.repairTarget.prop, prop, 'paralysis retains the repair claim');
  const other = world.spawn(staff('other', 'Maintenance'), room, { x: 20, y: 100 });
  assert.equal(planRepair(other, world), undefined);
  world.update(SHOCK_SECONDS);
  assert.equal(prop.broken, true);
  world.update(REPAIR_SECONDS - 0.25);
  assert.equal(prop.broken, true, 'stunned time must not count toward the repair duration');
  world.update(0.25);
  assert.equal(prop.broken, false);
  assert.equal(agent.repairTarget, undefined);
});

test('shock is agent-only and action blocking composes with other timed or permanent effects', (t) => {
  const { world, agent, prop } = setup();
  assert.equal(prop.statuses.apply('shocked'), false);
  assert.equal(Item.create('can').statuses.apply('shocked'), false);
  STATUS_EFFECTS['test-blocker'] = { label: 'Blocked', targets: ['agent'], blocksActions: true };
  t.after(() => { delete STATUS_EFFECTS['test-blocker']; });
  agent.statuses.apply('shocked');
  agent.statuses.apply('test-blocker', SHOCK_SECONDS + 1);
  assert.equal(agent.statuses.actionBlockRemaining, SHOCK_SECONDS + 1);
  world.update(SHOCK_SECONDS);
  assert.equal(agent.incapacitated, true);
  agent.statuses.apply('test-blocker');
  assert.equal(agent.statuses.actionBlockRemaining, Infinity);
  agent.statuses.remove('test-blocker');
  assert.equal(agent.incapacitated, false);
});

test('distance helpers handle corners, intersections, parallel sweeps and zero-length movement', () => {
  const rect = { x: 10, y: 10, w: 10, h: 10 };
  assert.equal(distanceToRect({ x: 15, y: 15 }, rect), 0);
  assert.equal(distanceToRect({ x: 7, y: 6 }, rect), 5);
  assert.equal(segmentDistanceToRect({ x: 0, y: 15 }, { x: 30, y: 15 }, rect), 0);
  assert.equal(segmentDistanceToRect({ x: 15, y: 0 }, { x: 15, y: 30 }, rect), 0);
  assert.equal(segmentDistanceToRect({ x: 0, y: 5 }, { x: 30, y: 5 }, rect), 5);
  assert.equal(segmentDistanceToRect({ x: 0, y: 0 }, { x: 7, y: 6 }, rect), 5);
  assert.equal(segmentDistanceToRect({ x: 7, y: 6 }, { x: 7, y: 6 }, rect), 5);
  assert.equal(segmentDistanceToRect({ x: 15, y: 15 }, { x: 15, y: 15 }, rect), 0);
  assert.equal(segmentDistanceToRect({ x: 0, y: 0 }, { x: 30, y: 30 }, rect), 0);
  assert.equal(segmentDistanceToRect({ x: 15, y: 5 }, { x: 25, y: 15 }, rect), 0);
});
