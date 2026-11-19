import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { dropTarget, placeAgent } from '../src/lib/sim/agentDrag.ts';
import { nap, wait } from '../src/lib/sim/tasks.ts';
import { startConversation } from '../src/lib/sim/conversation.ts';
import { enterThroughDoor } from '../src/lib/sim/transport.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';
import { LIGHTS_OFF_SECONDS, Room } from '../src/lib/sim/room.ts';
import { World } from '../src/lib/sim/world.ts';
import { Prop } from '../src/lib/sim/prop.ts';

beforeEach((t) => t.mock.method(Prop.prototype, 'breakOnUse', () => false));

const character = (id) => ({
  id, name: id, href: `/Personnel/${id}`, tint: '#fff', scale: 1, position: 'Test', species: 'Test',
  accessLevel: '1', employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});

async function setup(destinationId) {
  const room = new Room(await loadRoom('level-1-offices'));
  const destination = destinationId ? new Room(await loadRoom(destinationId)) : undefined;
  const world = new World({ roster: [], rooms: destination ? [room, destination] : [room], now: () => new Date(2026, 0, 1, 9) });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text) => logs.push(text);
  const agent = world.spawn(character('a'), room, { x: 200, y: 180 });
  agent.setPlan(world, [wait(60, 'Original task')]);
  world.update(0.1);
  return { world, room, destination, agent, logs };
}

test('pickup freezes only the held agent and makes it unavailable to autonomous chats', async () => {
  const { world, room, agent } = await setup();
  const other = world.spawn(character('b'), room, { x: 240, y: 180 });
  agent.held = true;
  let heldTicks = 0;
  let otherTicks = 0;
  agent.update = () => heldTicks++;
  other.update = () => otherTicks++;
  world.update(1);
  assert.equal(heldTicks, 0);
  assert.equal(otherTicks, 1);
  assert.equal(agent.busy, true);
  assert.equal(world.findChatPartner(other), undefined);
});

test('open-floor drops reposition immediately without a selection ping', async () => {
  const { world, agent } = await setup();
  const target = dropTarget(world, agent, { x: 220, y: 180 });
  assert.equal(target.kind, 'floor');
  assert.equal(placeAgent(world, agent, target), true);
  assert.deepEqual([agent.x, agent.y], [220, 180]);
  world.update(0.1);
  assert.equal(agent.activity, 'Repositioned');
});

test('invalid drops retain the original task, position, and reservation and log the reason', async () => {
  const { world, room, agent, logs } = await setup();
  agent.spot = room.spots[0];
  const original = [agent.x, agent.y, agent.activity, agent.spot];
  for (const point of [{ x: -1, y: 100 }, { x: 100, y: -1 }, { x: room.width, y: 100 }, { x: 100, y: room.height }]) {
    const target = dropTarget(world, agent, point);
    assert.equal(target.kind, 'invalid');
    assert.equal(placeAgent(world, agent, target), false);
    assert.deepEqual([agent.x, agent.y, agent.activity, agent.spot], original);
  }
  assert.equal(logs.length, 4);
});

function fallingSetup(spans = (y) => y >= 100 ? [20, 180] : []) {
  const room = new Room({
    id: 'fall-test', name: 'Fall test', level: 0, camera: 'test', width: 200, height: 200,
    nav: { floor: Array.from({ length: 200 }, (_, y) => spans(y)), exits: [] },
    props: [], links: {},
  });
  const world = new World({ roster: [], rooms: [room] });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text) => logs.push(text);
  const agent = world.spawn(character('falling'), room, { x: 100, y: 150 });
  agent.setPlan(world, [wait(60, 'Original task')]);
  world.update(0);
  return { world, room, agent, logs };
}

test('air drops fall with gravity, can land on the first green pixel, and recover with a trip', (t) => {
  const { world, room, agent, logs } = fallingSetup();
  t.mock.method(Math, 'random', () => 0);
  const target = dropTarget(world, agent, { x: 100, y: 10 });
  assert.equal(target.kind, 'fall');
  assert.deepEqual([agent.x, agent.y], [100, 150], 'preview does not move the agent');
  assert.equal(placeAgent(world, agent, target), true);
  assert.deepEqual([agent.x, agent.y], [100, 10], 'paused drop remains at the release point');
  assert.equal(agent.draggable, false, 'queued falls cannot be interrupted by another drop');
  world.update(0);
  assert.equal(agent.activity, 'Falling');
  assert.equal(agent.busy, true);
  assert.equal(agent.sitting, false);
  world.update(0.1);
  const firstStep = agent.y - 10;
  assert.ok(firstStep > 0 && agent.y < 100);
  world.update(0.1);
  assert.ok(agent.y - 10 - firstStep > firstStep, 'the fall accelerates');
  const other = world.spawn(character('other'), room, { x: 130, y: 150 });
  assert.equal(world.findChatPartner(other), undefined);
  assert.equal(dropTarget(world, other, agent, agent).kind, 'invalid');
  world.update(1);
  assert.deepEqual([agent.x, agent.y], [100, 100]);
  assert.equal(agent.activity, 'Picking themselves up');
  assert.equal(agent.bubble, '!');
  assert.equal(agent.shake, 0.5);
  assert.ok(logs.some((text) => text.includes('fell and hit the floor')));
  assert.equal(logs.some((text) => text.includes('tripped over their own feet')), false);
  world.update(1.4);
  world.update(0);
  assert.notEqual(agent.activity, 'Picking themselves up');
});

test('fast falls cannot skip a single green pixel row or land on a lower floor first', () => {
  const { world, agent } = fallingSetup((y) => y === 80 || y >= 120 ? [20, 180] : []);
  placeAgent(world, agent, dropTarget(world, agent, { x: 100, y: 10 }));
  world.update(5);
  assert.deepEqual([agent.x, agent.y], [100, 80]);
  assert.equal(agent.activity, 'Picking themselves up');
});

test('air drops vary landing depth within the first 24 pixels of continuous green floor', (t) => {
  let roll = 0;
  t.mock.method(Math, 'random', () => roll);
  for (const [value, expectedY] of [[0, 100], [0.5, 112], [0.999, 124]]) {
    const { world, room, agent } = fallingSetup();
    roll = value;
    placeAgent(world, agent, dropTarget(world, agent, { x: 100, y: 10 }));
    world.update(5);
    assert.deepEqual([agent.x, agent.y], [100, expectedY]);
    assert.equal(room.isFloor(agent.x, agent.y), true);
    assert.equal(agent.activity, 'Picking themselves up');
  }
});

test('landing variation stays on a thin floor instead of crossing a gap', (t) => {
  const { world, agent } = fallingSetup((y) => (y >= 80 && y <= 84) || y >= 120 ? [20, 180] : []);
  t.mock.method(Math, 'random', () => 0.999);
  placeAgent(world, agent, dropTarget(world, agent, { x: 100, y: 10 }));
  world.update(5);
  assert.deepEqual([agent.x, agent.y], [100, 84]);
  assert.equal(agent.activity, 'Picking themselves up');
});

test('landing depth is chosen once and does not depend on frame size', (t) => {
  let roll = 0.999;
  t.mock.method(Math, 'random', () => roll);
  for (const dt of [0.01, 0.1, 5]) {
    const { world, agent } = fallingSetup();
    roll = 0.999;
    placeAgent(world, agent, dropTarget(world, agent, { x: 100, y: 10 }));
    for (let elapsed = 0; elapsed < 5; elapsed += dt) {
      world.update(dt);
      if (agent.y >= 100) roll = 0;
      if (agent.activity === 'Picking themselves up') break;
    }
    assert.deepEqual([agent.x, agent.y], [100, 124]);
    assert.equal(agent.activity, 'Picking themselves up');
  }
});

test('falls with no green below leave the whole camera before respawning on nearby floor', () => {
  const { world, room, agent, logs } = fallingSetup();
  placeAgent(world, agent, dropTarget(world, agent, { x: 190, y: 10 }));
  world.update(1);
  assert.ok(agent.y > room.height);
  assert.ok(agent.y - agent.height <= room.height);
  assert.equal(agent.activity, 'Falling', 'wait until the whole sprite is out of view');
  world.update(1);
  assert.ok(room.isWalkable(agent));
  assert.notEqual(agent.x, 190);
  assert.equal(agent.activity, 'Picking themselves up');
  assert.ok(logs.some((text) => text.includes('fell out of view')));
});

test('green floor with insufficient walking clearance still rejects a direct drop', () => {
  const { world, agent } = fallingSetup();
  const target = dropTarget(world, agent, { x: 20, y: 150 });
  assert.equal(target.kind, 'invalid');
  assert.equal(placeAgent(world, agent, target), false);
  assert.deepEqual([agent.x, agent.y], [100, 150]);
  assert.equal(agent.activity, 'Original task');
});

test('cross-room air drops release reservations and conversations before falling in the destination', async (t) => {
  const { world, room, agent } = await setup();
  const destination = fallingSetup().room;
  world.rooms.push(destination);
  const partner = world.spawn(character('partner'), room, { x: 240, y: 180 });
  startConversation(agent, partner, world, true);
  agent.spot = room.spots[0];
  const target = dropTarget(world, agent, { x: 100, y: 10 }, null, null, destination);
  assert.equal(target.kind, 'fall');
  t.mock.method(Math, 'random', () => 0);
  placeAgent(world, agent, target);
  assert.equal(agent.room, destination);
  assert.equal(agent.spot, undefined);
  assert.equal(agent.conversation, undefined);
  assert.equal(partner.conversation, undefined);
  assert.equal(agent.enteredRoomAt, world.time);
  world.update(1);
  assert.deepEqual([agent.x, agent.y], [100, 100]);
  assert.equal(agent.activity, 'Picking themselves up');
});

test('seated drops use the closest free seat and release the old seat', async () => {
  const { world, room, agent } = await setup();
  const bench = room.props.find((prop) => prop.type === 'bench');
  const seats = room.spots.filter((spot) => spot.prop === bench);
  const other = world.spawn(character('b'), room, seats[0]);
  other.spot = seats[0];
  agent.spot = room.spots.find((spot) => spot.kind === 'chair');
  const target = dropTarget(world, agent, seats[0], null, bench);
  assert.equal(target.kind, 'seat');
  assert.equal(target.point, seats[1]);
  placeAgent(world, agent, target);
  assert.equal(agent.spot, seats[1]);
  assert.deepEqual([agent.x, agent.y], [seats[1].x, seats[1].y]);
  world.update(0.1);
  assert.equal(agent.sitting, true);
  assert.equal(agent.facing, seats[1].facing);
  bench.break();
  assert.equal(dropTarget(world, agent, seats[1], null, bench).kind, 'invalid');
});

test('occupied chairs reject drops, including a reservation while walking there', async () => {
  const { world, room, agent } = await setup();
  const seat = room.spots.find((spot) => spot.kind === 'chair');
  const other = world.spawn(character('b'), room, { x: 240, y: 180 });
  other.spot = seat;
  assert.equal(dropTarget(world, agent, seat, null, seat.prop).kind, 'invalid');
  other.spot = undefined;
  agent.spot = seat;
  assert.equal(dropTarget(world, agent, seat, null, seat.prop).kind, 'seat');
});

test('dropping on another agent starts a shared conversation and wakes sleeping partners', async () => {
  const { world, room, agent } = await setup();
  const other = world.spawn(character('b'), room, { x: 240, y: 180 });
  other.setPlan(world, [nap(60, 'front')]);
  world.update(0.1);
  assert.equal(other.napping, true);
  const target = dropTarget(world, agent, { x: 240, y: 160 }, other);
  assert.equal(target.kind, 'agent');
  placeAgent(world, agent, target);
  assert.equal(agent.conversation, other.conversation);
  assert.equal(other.napping, false);
  assert.equal(agent.x, other.x + 24);
  world.update(0.1);
  assert.equal(agent.activity, 'Chatting with b');
  assert.equal(other.activity, 'Chatting with a');
  agent.setPlan(world, [wait(5, 'Repositioned')]);
  assert.equal(agent.conversation, undefined);
  assert.equal(other.conversation, undefined);
  assert.equal(other.bubble, null);
});

test('replacing an approaching conversation releases both agents before talk has started', async () => {
  const { world, room, agent } = await setup();
  const other = world.spawn(character('b'), room, { x: 240, y: 180 });
  const tasks = startConversation(agent, other, world);
  assert.ok(tasks);
  assert.equal(agent.conversation.started, false);
  placeAgent(world, agent, dropTarget(world, agent, { x: 220, y: 180 }));
  assert.equal(agent.conversation, undefined);
  assert.equal(other.conversation, undefined);
});

test('lights toggle on task start and other props are inspected without changing their state', async () => {
  const { world, room, agent } = await setup();
  const light = room.props.find((prop) => prop.type === 'light');
  room.updateLights(true, 0);
  const target = dropTarget(world, agent, { x: light.x + 10, y: light.y + 5 }, null, light);
  assert.equal(target.kind, 'prop');
  placeAgent(world, agent, target);
  assert.equal(light.on, true, 'paused drop has not started the task');
  world.update(0.1);
  assert.equal(light.on, false);
  const table = room.props.find((prop) => prop.type === 'table');
  const inspect = dropTarget(world, agent, { x: table.x + 10, y: table.y + 5 }, null, table);
  assert.equal(inspect.kind, 'prop');
  placeAgent(world, agent, inspect);
  world.update(0.1);
  assert.equal(agent.activity, 'Inspect table');
  assert.equal(agent.bubble, '?');
  assert.equal(table.broken, false);
});

test('agents in transitions, leaving, removed, or inside the elevator cannot be picked up', async () => {
  const { world, room, agent } = await setup();
  assert.equal(agent.draggable, true);
  agent.setPlan(world, [enterThroughDoor(room.doors[0])]);
  agent.update(world, 0);
  assert.equal(agent.draggable, false);
  agent.setPlan(world, [wait(60, 'Standing')]);
  agent.update(world, 0);
  agent.leaving = true;
  assert.equal(agent.draggable, false);
  agent.leaving = false;
  agent.layer = 'inside';
  assert.equal(agent.draggable, false);
  agent.layer = 'room';
  agent.removed = true;
  assert.equal(agent.draggable, false);
});

test('previewing other floors leaves the agent in the source room until a valid drop', async () => {
  const { world, room, destination, agent } = await setup('level-3-checkpoint');
  const seat = room.spots[0];
  agent.spot = seat;
  agent.held = true;
  destination.updateLights(true, 0);
  destination.updateLights(false, LIGHTS_OFF_SECONDS);
  assert.equal(destination.darkness, 1);
  const original = [agent.room, agent.x, agent.y, agent.spot, agent.enteredRoomAt];
  const target = dropTarget(world, agent, { x: 220, y: 250 }, null, null, destination);
  assert.equal(target.kind, 'floor');
  assert.equal(target.room, destination);
  assert.deepEqual([agent.room, agent.x, agent.y, agent.spot, agent.enteredRoomAt], original);
  assert.equal(world.agentsIn(room).includes(agent), true);
  world.update(5);
  agent.held = false;
  assert.equal(placeAgent(world, agent, target), true);
  assert.equal(agent.room, destination, 'explicit player transfers can cross clearance levels');
  assert.equal(agent.enteredRoomAt, world.time);
  assert.equal(destination.darkness, 0, 'physical placement triggers the destination motion sensor even while paused');
  assert.equal(agent.spot, undefined, 'source seat is released');
  assert.deepEqual([agent.x, agent.y], [220, 250]);
  assert.equal(world.agentsIn(room).includes(agent), false);
  assert.equal(world.agentsIn(destination).includes(agent), true);
  assert.equal(world.agents.filter((other) => other === agent).length, 1, 'transfer does not duplicate the agent');
  world.update(0.1);
  assert.equal(agent.activity, 'Repositioned');
});

test('invalid drops in differently sized destination rooms preserve source task and reservation', async () => {
  const { world, room, destination, agent } = await setup('level-3-checkpoint');
  agent.spot = room.spots[0];
  const original = [agent.room, agent.x, agent.y, agent.spot, agent.enteredRoomAt];
  assert.ok(room.width > destination.width);
  const target = dropTarget(world, agent, { x: destination.width + 1, y: 180 }, null, null, destination);
  assert.equal(target.kind, 'invalid');
  assert.equal(placeAgent(world, agent, target), false);
  assert.deepEqual([agent.room, agent.x, agent.y, agent.spot, agent.enteredRoomAt], original);
  assert.equal(agent.activity, 'Original task');
});

test('destination seats respect local reservations and free the source seat on transfer', async () => {
  const { world, room, destination, agent } = await setup('level-2-lobby');
  const seats = destination.spots;
  const other = world.spawn(character('b'), destination, seats[0]);
  other.spot = seats[0];
  agent.spot = room.spots[0];
  const target = dropTarget(world, agent, seats[0], null, seats[0].prop, destination);
  assert.equal(target.kind, 'seat');
  assert.equal(target.point, seats[1]);
  placeAgent(world, agent, target);
  assert.equal(agent.room, destination);
  assert.equal(agent.spot, seats[1]);
  world.update(0.1);
  assert.equal(agent.sitting, true);
});

test('cross-room conversations release source partners and start with the destination agent', async () => {
  const { world, room, destination, agent } = await setup('level-2-lobby');
  const sourcePartner = world.spawn(character('source'), room, { x: 240, y: 180 });
  startConversation(agent, sourcePartner, world, true);
  world.update(0.1);
  const destinationPartner = world.spawn(character('destination'), destination, { x: 240, y: 180 });
  const target = dropTarget(world, agent, { x: 240, y: 160 }, destinationPartner, null, destination);
  assert.equal(target.kind, 'agent');
  placeAgent(world, agent, target);
  assert.equal(sourcePartner.conversation, undefined);
  assert.equal(agent.room, destination);
  assert.equal(agent.conversation.partner, destinationPartner);
  assert.equal(agent.conversation, destinationPartner.conversation);
  world.update(0.1);
  assert.equal(agent.activity, 'Chatting with destination');
});

test('cross-room prop interactions affect only the destination prop', async () => {
  const { world, room, destination, agent } = await setup('level-2-lobby');
  const sourceLight = room.switchables[0];
  const light = destination.switchables[0];
  const point = { x: light.x + 10, y: light.y + 5 };
  const target = dropTarget(world, agent, point, null, light, destination);
  assert.equal(target.kind, 'prop');
  placeAgent(world, agent, target);
  world.update(0.1);
  assert.equal(agent.room, destination);
  assert.equal(light.on, false);
  assert.equal(sourceLight.on, true);
  assert.equal(dropTarget(world, agent, point, null, sourceLight, destination).kind, 'invalid');
});

test('a queued light switch keeps the drop intent when entering a dark room turns the light on', async () => {
  const { world, destination, agent } = await setup('level-2-lobby');
  destination.updateLights(true, 0);
  destination.updateLights(false, LIGHTS_OFF_SECONDS);
  const light = destination.switchables[0];
  const target = dropTarget(world, agent, { x: light.x + 10, y: light.y + 5 }, null, light, destination);
  assert.equal(target.label, 'Switch light on');
  placeAgent(world, agent, target);
  assert.equal(light.on, true, 'placement turns on motion-sensor lights immediately');
  world.update(0.1);
  assert.equal(light.on, true, 'queued switch-on must not toggle the newly lit light off');
});
