import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/lib/sim/agent.ts';
import { walkTo } from '../src/lib/sim/tasks.ts';
import { planNext } from '../src/lib/sim/planning.ts';
import { LIGHTS_OFF_SECONDS, Room } from '../src/lib/sim/room.ts';
import { World } from '../src/lib/sim/world.ts';
import { Item, ITEM_TYPES } from '../src/lib/sim/item.ts';
import { statusPopups } from '../src/lib/sim/statusEffects.ts';

const light = (start) => ({ type: 'light', asset: 'light', x: 0, y: 0, w: 40, h: 17, flip: false, start });
const character = (clumsy = false) => ({
  id: 'test', name: 'Test', species: 'Human', scale: 1, accessLevel: '1',
  behavior: { speed: 1, napChance: 0, clumsy, social: 0, ghost: false },
});
const makeRoom = (level = 1, props = [], overrides = {}) => new Room({
  id: 'room', name: 'Test room', camera: 'Test', level, width: 120, height: 80,
  nav: { floor: Array.from({ length: 80 }, () => [0, 120]), exits: [] },
  props, links: {}, shafts: {}, ...overrides,
});

test('only unlit underground rooms are dark, including missing and broken lights', () => {
  for (let level = 0; level <= 5; level++) {
    const room = makeRoom(level);
    const unlit = level === 0 ? 0 : 1;
    assert.equal(room.darkness, unlit, `Level ${level} without lights`);
    room.setProps([light()]);
    assert.equal(room.darkness, 0);
    room.props[0].setOn(false);
    assert.equal(room.darkness, unlit);
    room.props[0].setOn(true);
    room.props[0].break();
    assert.equal(room.darkness, unlit);
    room.props[0].repair();
    assert.equal(room.darkness, 0);
    room.setProps([light({ on: false }), light({ broken: true }), light()]);
    assert.equal(room.darkness, 0, 'one working light is enough');
    room.setProps([]);
    assert.equal(room.darkness, unlit, 'editor removal takes effect immediately');
  }
});

test('darkness follows motion-sensor lighting without reviving broken lights', () => {
  const room = makeRoom(1, [light()]);
  room.updateLights(false, LIGHTS_OFF_SECONDS);
  assert.equal(room.darkness, 1);
  room.updateLights(true, 0.1);
  assert.equal(room.darkness, 0);
  room.props[0].break();
  room.updateLights(false, LIGHTS_OFF_SECONDS);
  room.updateLights(true, 0.1);
  assert.equal(room.darkness, 1);
});

test('dark walking adds trip risk while preserving clumsiness and impostor immunity', (t) => {
  const random = t.mock.method(Math, 'random', () => 0);
  const cases = [
    { level: 1, props: [light()], clumsy: false, rate: 0 },
    { level: 0, props: [], clumsy: false, rate: 0 },
    { level: 1, props: [light()], clumsy: true, rate: 0.006 },
    { level: 1, props: [], clumsy: false, rate: 0.012 },
    { level: 1, props: [light({ on: false })], clumsy: true, rate: 0.018 },
    { level: 1, props: [light({ broken: true })], clumsy: false, rate: 0.012 },
    { level: 1, props: [], clumsy: true, rate: 0, impostor: {} },
  ];
  for (const { level, props, clumsy, rate, impostor } of cases) {
    for (const below of [false, true]) {
      const room = makeRoom(level, props);
      const agent = new Agent(character(clumsy), room, { x: 20, y: 40 }, impostor);
      const world = { log() {}, achieve() {} };
      agent.setPlan(world, [walkTo({ x: 100, y: 40 })]);
      const dt = 0.5;
      random.mock.mockImplementation(() => Math.max(0, rate * dt + (below ? -0.00001 : 0.00001)));
      agent.update(world, dt);
      const trips = rate > 0 && below;
      assert.equal(agent.activity === 'Picking themselves up', trips, JSON.stringify({ level, clumsy, rate, below }));
      if (trips) {
        agent.update(world, 1.3);
        random.mock.mockImplementation(() => 0.99);
        agent.update(world, dt);
        assert.ok(agent.x > 20, 'walking resumes after a trip');
      }
    }
  }
});

test('darkness increases room departures and removes the minimum stay', (t) => {
  const room = makeRoom(1, [light()]);
  const next = makeRoom(2, [], { id: 'next', name: 'Next room' });
  room.doors.push({
    id: 'east', side: 'east', inside: { x: 100, y: 40 }, outside: { x: 119, y: 40 },
    to: { room: next.id, door: 'west' },
  });
  const world = new World({ rooms: [room, next], roster: [character()], now: () => new Date(2026, 0, 1, 12) });
  t.mock.method(world, 'freeSpot', () => undefined);
  t.mock.method(world, 'findChatPartner', () => undefined);
  const random = t.mock.method(Math, 'random', () => 0);
  const agent = world.spawn({ ...character(), accessLevel: '5' }, room, { x: 20, y: 40 });
  const departures = (dark, inRoom) => {
    room.props[0].setOn(!dark);
    world.time = agent.arrivedAt = 30;
    agent.enteredRoomAt = world.time - inRoom;
    let count = 0;
    for (let i = 0; i < 1000; i++) {
      random.mock.mockImplementation(() => (i + 0.5) / 1000);
      agent.leaving = false;
      if (planNext(agent, world)[0].activity === 'Heading to the Next room') count++;
    }
    return count;
  };
  assert.equal(departures(false, 0), 0);
  assert.ok(departures(true, 0) > 400, 'dark-room plans can move on just after arrival');
  assert.ok(departures(true, 30) > departures(false, 30) + 150, 'darkness substantially increases room changes');

  agent.character.accessLevel = '1';
  room.props[0].setOn(false);
  random.mock.mockImplementation(() => 0.99);
  assert.notEqual(planNext(agent, world)[0].activity, 'Heading to the Next room', 'darkness does not bypass clearance');
});

test('darkness encourages elevator travel and leaving through outer doors', (t) => {
  const room = makeRoom(1, [light()]);
  const next = makeRoom(0, [], { id: 'surface' });
  room.elevator = { shaft: 'test', front: { x: 60, y: 40 } };
  next.elevator = { shaft: 'test', front: { x: 60, y: 40 } };
  const world = new World({ rooms: [room, next], roster: [character()], now: () => new Date(2026, 0, 1, 12) });
  t.mock.method(world, 'freeSpot', () => undefined);
  t.mock.method(world, 'findChatPartner', () => undefined);
  t.mock.method(Math, 'random', () => 0.7);
  const agent = world.spawn(character(), room, { x: 20, y: 40 });
  assert.notEqual(planNext(agent, world)[0].activity, 'Heading to the elevator');
  room.props[0].setOn(false);
  assert.equal(planNext(agent, world)[0].activity, 'Heading to the elevator');
  assert.equal(agent.leaving, false, 'moving floors need not leave the facility');

  room.elevator = undefined;
  room.doors.push({ id: 'west', side: 'west', inside: { x: 20, y: 40 }, outside: { x: 0, y: 40 } });
  t.mock.method(Math, 'random', () => 0.99);
  assert.equal(planNext(agent, world)[0].activity, 'Heading out');
  assert.equal(agent.leaving, true);

  const impostor = new Agent(character(), room, agent, {});
  assert.notEqual(planNext(impostor, world)[0].activity, 'Heading out', 'impostors still wait for the event director');
});

test('darkness is a visible debuff, removed by working or emergency lights but not visual flicker', () => {
  const room = makeRoom(1, [light({ broken: true })]);
  const world = new World({ rooms: [room], roster: [] });
  const agent = world.spawn(character(), room, { x: 20, y: 40 });
  assert.deepEqual(statusPopups(agent.statuses.active).map(({ id }) => id), ['darkness']);
  assert.equal(agent.statuses.get('darkness').polarity, 'negative');
  assert.equal(agent.statuses.tripChancePerSecond, 0.012);
  room.props[0].repair();
  world.update(0);
  assert.equal(agent.statuses.has('darkness'), false);
  Object.defineProperty(room.props[0], 'flickerOff', { get: () => true });
  assert.equal(room.visualDarkness, 1);
  world.update(0);
  assert.equal(agent.statuses.has('darkness'), false, 'flicker stays visual-only');
  world.level(1).startEvent('blackout');
  world.update(0);
  assert.equal(agent.statuses.has('darkness'), true);
  world.update(10);
  assert.equal(room.power, 'backup');
  assert.equal(agent.statuses.has('darkness'), false, 'emergency lighting prevents the debuff');
  room.props[0].break();
  world.update(0);
  assert.equal(agent.statuses.has('darkness'), true, 'backup without a working light is pure darkness');
  agent.room = makeRoom(0);
  agent.updateDarkness();
  assert.equal(agent.statuses.has('darkness'), false, 'surface rooms remain naturally lit');
});

test('only an active held light protects its owner, and expiry restores the debuff', (t) => {
  const room = makeRoom();
  const agent = new Agent(character(), room, { x: 20, y: 40 });
  const other = new Agent(character(), room, agent);
  const item = Item.create('glowstick');
  agent.receiveItem(item);
  assert.equal(agent.statuses.has('darkness'), true, 'unactivated items do not protect');
  item.activate();
  agent.updateDarkness();
  assert.equal(agent.statuses.has('darkness'), false);
  assert.equal(other.statuses.has('darkness'), true, 'personal lighting is not room lighting');
  assert.equal(room.darkness, 1);
  agent.storeItem();
  assert.equal(agent.statuses.has('darkness'), true, 'stored lights do not protect');
  agent.retrieveItem(item);
  assert.equal(agent.statuses.has('darkness'), false);
  agent.dropItem();
  assert.equal(agent.statuses.has('darkness'), true, 'floor lights do not protect nearby actors');
  agent.pickUpItem(item);
  item.update(180);
  agent.updateDarkness();
  assert.equal(agent.statuses.has('darkness'), true);

  // A future light uses the same capability without any glowstick-specific behavior.
  ITEM_TYPES.test_flashlight = { light: { color: '#fff', radius: 40 } };
  t.after(() => { delete ITEM_TYPES.test_flashlight; });
  agent.dropItem();
  const flashlight = new Item({ type: 'test_flashlight', asset: 'item:test_flashlight', x: 0, y: 0, w: 4, h: 12, flip: false });
  agent.receiveItem(flashlight);
  assert.equal(agent.statuses.has('darkness'), false);
  flashlight.update(1000);
  assert.ok(flashlight.light, 'an omitted lifetime means unlimited');
});

test('active held lights remove darkness trip risk but not clumsiness', (t) => {
  for (const clumsy of [false, true]) {
    for (const below of [false, true]) {
      const agent = new Agent(character(clumsy), makeRoom(), { x: 20, y: 40 });
      const item = Item.create('glowstick');
      item.activate();
      agent.receiveItem(item);
      const rate = clumsy ? 0.006 : 0;
      t.mock.method(Math, 'random', () => Math.max(0, rate * 0.5 + (below ? -0.00001 : 0.00001)));
      const world = { log() {}, achieve() {} };
      agent.setPlan(world, [walkTo({ x: 100, y: 40 })]);
      agent.update(world, 0.5);
      assert.equal(agent.activity === 'Picking themselves up', clumsy && below);
    }
  }
});

test('active held lights restore ordinary planning weights in a dark room', (t) => {
  const room = makeRoom(1, [light()]);
  const next = makeRoom(0, [], { id: 'surface' });
  room.elevator = next.elevator = { shaft: 'test', front: { x: 60, y: 40 } };
  const world = new World({ rooms: [room, next], roster: [], now: () => new Date(2026, 0, 1, 12) });
  t.mock.method(world, 'freeSpot', () => undefined);
  t.mock.method(world, 'findChatPartner', () => undefined);
  const random = t.mock.method(Math, 'random', () => 0);
  const agent = world.spawn(character(), room, { x: 20, y: 40 });
  const item = Item.create('glowstick');
  item.activate();
  agent.receiveItem(item);
  const plans = (dark) => {
    room.props[0].setOn(!dark);
    return Array.from({ length: 100 }, (_, i) => {
      random.mock.mockImplementation(() => (i + 0.5) / 100);
      agent.leaving = false;
      return planNext(agent, world)[0].activity;
    });
  };
  assert.deepEqual(plans(true), plans(false), 'personal light removes all darkness-related planning changes');
});
