import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { TRIP_PROP_BREAK_CHANCE, TRIP_PROP_REACH, trip, wait, walkTo } from '../src/lib/sim/tasks.ts';
import { dropTarget, placeAgent } from '../src/lib/sim/agentDrag.ts';
import { Prop } from '../src/lib/sim/prop.ts';
import { Room } from '../src/lib/sim/room.ts';
import { PROP_TYPES, propCellOccupancy, propFrames } from '../src/lib/sim/sprites.ts';
import { World } from '../src/lib/sim/world.ts';

const character = (id = 'a') => ({
  id, name: id, href: `/Personnel/${id}`, tint: '#fff', scale: 1, position: 'Test', species: 'Human',
  accessLevel: '1', employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});

const prop = (type, x, y, w = 10, h = 10, options = {}) =>
  new Prop({ type, asset: type, x, y, w, h, flip: false, ...options });

function room(props = [], spans = () => [0, 200], id = 'test') {
  return new Room({
    id, name: id, level: 0, camera: id, width: 200, height: 200,
    nav: { width: 200, height: 200, floor: Array.from({ length: 200 }, (_, y) => spans(y)), exits: [] },
    props, links: {},
  });
}

function setup(props = [], point = { x: 100, y: 100 }, spans) {
  const current = room(props, spans);
  const world = new World({ roster: [], rooms: [current], now: () => new Date(2026, 0, 1, 12) });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text, tone) => logs.push({ text, tone });
  const agent = world.spawn(character(), current, point);
  return { room: current, world, agent, logs };
}

test('one trip gives the nearest prop exactly a 10% chance to break', (t) => {
  const table = prop('table', 100, 100);
  const { world, agent } = setup([table]);
  assert.equal(TRIP_PROP_BREAK_CHANCE, 0.1);
  let value = 0;
  const random = t.mock.method(Math, 'random', () => value);
  let breaks = 0;
  for (let i = 0; i < 1000; i++) {
    value = (i + 0.5) / 1000;
    agent.interrupt(world, trip());
    if (table.broken) breaks++;
    table.repair();
    agent.setPlan(world, []);
  }
  assert.equal(breaks, 100);
  assert.equal(random.mock.callCount(), 1000);
  value = TRIP_PROP_BREAK_CHANCE;
  agent.interrupt(world, trip());
  assert.equal(table.broken, false, 'the probability threshold is exclusive');
  assert.equal(table.toData().start, undefined, 'trip damage does not change the starting state');
});

test('trip damage chooses only the nearest intact breakable prop in the current room', (t) => {
  const decoration = prop('plant', 100, 100);
  const alreadyBroken = prop('table', 100, 100);
  alreadyBroken.break();
  const farther = prop('table', 109, 100);
  const nearest = prop('table', 104, 100);
  const distant = prop('table', 150, 100);
  const { room: current, world, agent, logs } = setup([decoration, alreadyBroken, farther, nearest, distant]);
  const elsewhere = prop('table', 100, 100);
  world.rooms.push(room([elsewhere], undefined, 'elsewhere'));
  const random = t.mock.method(Math, 'random', () => 0);
  const achievements = [];
  world.hooks.achieve = (id, inRoom) => achievements.push([id, inRoom]);

  agent.interrupt(world, trip());
  assert.equal(nearest.broken, true);
  assert.equal(farther.broken, false);
  assert.equal(distant.broken, false);
  assert.equal(decoration.broken, false);
  assert.equal(elsewhere.broken, false);
  assert.equal(random.mock.callCount(), 1);
  assert.equal(agent.bubble, '!');
  assert.ok(logs.some((entry) => entry.tone === 'warn' && entry.text.includes('broke the table when they tripped')));
  assert.deepEqual(achievements, [['watch-your-step', current]]);
});

test('trip reach measures Euclidean distance from the feet to the prop bounds', (t) => {
  const table = prop('table', 100, 100);
  const { world, agent } = setup([table]);
  assert.equal(TRIP_PROP_REACH, 12);
  const random = t.mock.method(Math, 'random', () => 0);
  for (const [x, y, expected] of [
    [88, 105, true], [87.999, 105, false],
    [105, 122, true], [105, 122.001, false],
    [94, 92, true], [92, 91, false],
  ]) {
    agent.x = x;
    agent.y = y;
    const calls = random.mock.callCount();
    agent.interrupt(world, trip());
    assert.equal(table.broken, expected, `(${x}, ${y})`);
    assert.equal(random.mock.callCount() - calls, expected ? 1 : 0, 'only nearby props get a roll');
    table.repair();
    agent.setPlan(world, []);
  }
});

test('trip impact bounds exclude padded glass and mirror with flipped props', (t) => {
  const pane = prop('glassHalf', 100, 40, 96, 96, { brokenLook: true });
  const { world, agent } = setup([pane], { x: 112, y: 100 });
  const random = t.mock.method(Math, 'random', () => 0);
  assert.deepEqual(pane.impactBounds, { x: 125, y: 70, w: 46, h: 37 });
  agent.interrupt(world, trip());
  assert.equal(pane.broken, false, 'transparent padding is not treated as the pane');
  assert.equal(random.mock.callCount(), 0);
  agent.setPlan(world, []);
  agent.x = 113;
  agent.interrupt(world, trip());
  assert.equal(pane.broken, true, 'the pane is in reach at the edge');

  const chair = prop('chair', 100, 100, 59, 58);
  const second = setup([chair], { x: 102, y: 120 });
  assert.deepEqual(chair.impactBounds, { x: 120, y: 100, w: 34, h: 55 });
  second.agent.interrupt(second.world, trip());
  assert.equal(chair.broken, false);
  chair.flip = true;
  assert.deepEqual(chair.impactBounds, { x: 105, y: 100, w: 34, h: 55 });
  second.agent.setPlan(second.world, []);
  second.agent.interrupt(second.world, trip());
  assert.equal(chair.broken, true);
});

test('configured impact areas match the visible artwork across normal animation frames', async () => {
  for (const type of ['chair', 'vending_machine', 'glass', 'glassHalf', 'glassAngle']) {
    const { data, info } = await sharp(`src/sim_assets/props/${type}.png`)
      .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const image = { width: info.width, height: info.height };
    image.propCells = propCellOccupancy(image, data);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (const frame of propFrames(type, image)) {
      for (let y = 0; y < frame.h; y++) {
        for (let x = 0; x < frame.w; x++) {
          if (!data[((frame.y + y) * info.width + frame.x + x) * 4 + 3]) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    assert.deepEqual(PROP_TYPES[type].impactArea, {
      x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1,
    }, type);
  }
});

test('automatically breakable props use their frame when no impact area is configured', (t) => {
  const automatic = prop('new_decoration', 100, 100, 10, 10, { brokenLook: true });
  const { world, agent } = setup([automatic], { x: 88, y: 105 });
  t.mock.method(Math, 'random', () => 0);
  assert.deepEqual(automatic.impactBounds, { x: 100, y: 100, w: 10, h: 10 });
  agent.interrupt(world, trip());
  assert.equal(automatic.broken, true);
});

test('each trip rolls once, even across recovery ticks and interruption', (t) => {
  const table = prop('table', 100, 100);
  const { world, agent } = setup([table]);
  const random = t.mock.method(Math, 'random', () => 0.5);
  agent.interrupt(world, trip());
  assert.equal(random.mock.callCount(), 1);
  for (let i = 0; i < 4; i++) agent.update(world, 0.1);
  agent.interrupt(world, wait(0.1, 'Interrupted'));
  agent.update(world, 0.1);
  agent.update(world, 0.1);
  assert.equal(agent.activity, 'Picking themselves up');
  assert.equal(random.mock.callCount(), 1);
  assert.equal(table.broken, false);
});

test('a natural walking trip can break a prop and then resumes the original walk', (t) => {
  const table = prop('table', 110, 90);
  const { room: current, world, agent, logs } = setup([table]);
  agent.character.behavior.clumsy = true;
  t.mock.method(current, 'route', (_from, to) => [to]);
  const random = t.mock.method(Math, 'random', () => 0);
  agent.setPlan(world, [walkTo({ x: 150, y: 100 }, 'Original walk')]);
  world.update(0.1);
  assert.equal(table.broken, true);
  assert.equal(agent.activity, 'Picking themselves up');
  assert.equal(agent.x, 100);
  assert.ok(logs.some((entry) => entry.tone === 'warn' && entry.text.includes('when they tripped')));
  random.mock.mockImplementation(() => 0.99);
  world.update(1.3);
  world.update(0.1);
  assert.equal(agent.activity, 'Original walk');
  assert.ok(agent.x > 100);
});

test('trip damage disables lights and dispensers and emits their usual debris', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const light = prop('light', 100, 100);
  const lightSetup = setup([light]);
  assert.equal(light.lit, true);
  lightSetup.agent.interrupt(lightSetup.world, trip());
  assert.equal(light.broken, true);
  assert.equal(light.lit, false);

  const machine = prop('vending_machine', 60, 60, 96, 96, { switchable: true });
  const machineSetup = setup([machine]);
  assert.equal(machine.dispensing, 'can');
  machineSetup.agent.interrupt(machineSetup.world, trip());
  assert.equal(machine.broken, true);
  assert.equal(machine.dispensing, null);
  machineSetup.world.update(0);
  const particles = machineSetup.world.particles.in(machineSetup.room);
  assert.equal(particles.filter((particle) => particle.asset.startsWith('particle:glass_')).length, 10);
  assert.equal(particles.filter((particle) => particle.asset.startsWith('particle:spark_')).length, 6);
});

test('falling only rolls on landing, damages the destination prop, and emits particles', (t) => {
  const sourceProp = prop('table', 100, 100);
  const { room: source, world, agent, logs } = setup([sourceProp], { x: 100, y: 150 });
  const pane = prop('glassHalf', 76, 34, 96, 96, { brokenLook: true });
  const destination = room([pane], (y) => y >= 100 ? [20, 180] : [], 'destination');
  world.rooms.push(destination);
  agent.setPlan(world, [wait(60, 'Original task')]);
  const random = t.mock.method(Math, 'random', () => 0);
  const target = dropTarget(world, agent, { x: 100, y: 10 }, null, null, destination);
  assert.equal(target.kind, 'fall');
  assert.equal(random.mock.callCount(), 0, 'preview does not roll');
  placeAgent(world, agent, target);
  assert.equal(agent.room, destination);
  assert.equal(pane.broken, false, 'placement does not roll while paused');
  world.update(0.1);
  world.update(0.5);
  assert.ok(agent.y > pane.impactBounds.y, 'the agent has passed alongside the pane');
  assert.equal(agent.activity, 'Falling');
  assert.equal(pane.broken, false, 'midair proximity does not roll');
  assert.equal(random.mock.callCount(), 0);
  world.update(0.1);
  assert.equal(agent.y, 100);
  assert.equal(agent.activity, 'Picking themselves up');
  assert.equal(pane.broken, true);
  assert.equal(sourceProp.broken, false);
  assert.equal(world.particles.in(source).length, 0);
  assert.equal(world.particles.in(destination).length, 10);
  assert.ok(logs.some((entry) => entry.tone === 'warn' && entry.text.includes('when they fell')));
});

test('falling out of view also uses the trip impact at the respawn point', (t) => {
  const { room: current, world, agent } = setup([], { x: 100, y: 150 }, (y) => y >= 100 ? [20, 180] : []);
  const respawn = current.nearestWalkable({ x: 190, y: current.height - 1 });
  const nearby = prop('new_decoration', respawn.x, respawn.y - 5, 10, 10, { brokenLook: true });
  current.setProps([nearby]);
  t.mock.method(Math, 'random', () => 0);
  placeAgent(world, agent, dropTarget(world, agent, { x: 190, y: 10 }));
  world.update(2);
  assert.deepEqual({ x: agent.x, y: agent.y }, respawn);
  assert.equal(agent.activity, 'Picking themselves up');
  assert.equal(nearby.broken, true);
});

test('breaking a reserved seat lets the trip finish, then cancels its old plan', (t) => {
  const bench = prop('bench', 100, 80, 71, 37);
  const { room: current, world, agent } = setup([bench], { x: 115, y: 120 });
  const spot = current.spots[0];
  const occupant = world.spawn(character('occupant'), current, current.spots[1]);
  occupant.setPlan(world, [{ activity: 'Seated', interruptible: false, sitting: true, update: () => false }]);
  occupant.spot = current.spots[1];
  occupant.update(world, 0);
  assert.equal(occupant.sitting, true);

  agent.character.behavior.clumsy = true;
  t.mock.method(current, 'route', (_from, to) => [to]);
  const random = t.mock.method(Math, 'random', () => 0);
  let cancelled = 0;
  agent.setPlan(world, [walkTo(spot, 'Heading to the bench'), {
    ...wait(60, 'Reserved seat'),
    cancel() { cancelled++; },
  }]);
  agent.spot = spot;
  world.update(0.1);
  assert.equal(bench.broken, true);
  assert.equal(agent.activity, 'Picking themselves up');
  assert.equal(occupant.spot, undefined, 'other occupants give up their broken seat');
  random.mock.mockImplementation(() => 0.99);
  world.update(0.6);
  world.update(0.6);
  assert.equal(agent.activity, 'Picking themselves up');
  assert.equal(agent.spot, spot, 'the recovery is not interrupted by seat cleanup');
  world.update(0.2);
  world.update(0.01);
  assert.equal(agent.spot, undefined);
  assert.equal(cancelled, 1, 'the interrupted seat plan does not resume');
  assert.notEqual(agent.activity, 'Heading to the bench');
});
