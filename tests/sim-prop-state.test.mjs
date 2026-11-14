import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Prop } from '../src/lib/sim/prop.ts';
import { propsSnippet } from '../src/lib/sim/propEditor.ts';
import { LIGHTS_OFF_SECONDS, Room } from '../src/lib/sim/room.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';

const placed = (type, start) => ({ type, asset: type, x: 0, y: 0, w: 10, h: 10, flip: false, ...(start ? { start } : {}) });
const character = (id) => ({
  id, name: id, href: `/Personnel/${id}`, tint: '#fff', scale: 1, position: 'Test', species: 'Test',
  accessLevel: '1', employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});
const noon = () => new Date(2026, 0, 1, 12);

test('props start from room.json and only switch or break when their type allows it', () => {
  const light = new Prop(placed('light'));
  assert.deepEqual([light.on, light.broken, light.lit, light.look], [true, false, true, undefined]);
  assert.equal(light.setOn(false), true);
  assert.equal(light.setOn(false), false, 'no change');
  assert.equal(light.look, 'off');

  const broken = new Prop(placed('light', { broken: true }));
  assert.equal(broken.lit, false);
  assert.equal(broken.look, 'off', 'broken lights go dark until there is broken artwork');

  const chair = new Prop(placed('chair'));
  assert.equal(chair.setOn(false), false, 'chairs have no switch');
  assert.equal(chair.break(), true);
  assert.equal(chair.look, undefined, 'no broken chair artwork yet');
  assert.equal(chair.repair(), true);

  const plant = new Prop(placed('plant', { broken: true }));
  assert.equal(plant.broken, false, 'plain decoration never breaks');
  assert.equal(plant.break(), false);
});

test('editor starting state round-trips through the room.json snippet', () => {
  const light = new Prop(placed('light'));
  light.setStart({ on: false });
  assert.equal(light.on, false, 'applied straight away');
  const chair = new Prop(placed('chair'));
  chair.setStart({ broken: true });
  assert.equal(chair.broken, true);
  // Runtime-only changes don't leak into the snippet.
  const bench = new Prop(placed('bench'));
  bench.break();

  const snippet = propsSnippet([light, chair, bench]);
  assert.deepEqual(JSON.parse(`{${snippet}}`).props, [
    { type: 'light', x: 0, y: 0, on: false },
    { type: 'chair', x: 0, y: 0, broken: true },
    { type: 'bench', x: 0, y: 0 },
  ]);

  chair.setStart({ broken: false });
  assert.equal(chair.start, undefined, 'back to the defaults');
  assert.equal(chair.broken, false);
});

test('room.json can set a starting state, and mistakes are explained', async (t) => {
  const assets = await mkdtemp(path.join(os.tmpdir(), 'axion-props-'));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await cp('src/sim_assets/props', path.join(assets, 'props'), { recursive: true });
  await cp('src/sim_assets/rooms/level-1-offices', path.join(assets, 'rooms', 'offices'), { recursive: true });
  const file = path.join(assets, 'rooms', 'offices', 'room.json');
  const json = JSON.parse(await readFile(file, 'utf8'));
  const withProps = (props) => writeFile(file, JSON.stringify({ ...json, props }));

  await withProps([{ type: 'light', x: 1, y: 2, on: false }, { type: 'chair', x: 3, y: 4, broken: true }, { type: 'bench', x: 5, y: 6, broken: false }]);
  const data = await loadRoom('offices', assets);
  assert.deepEqual(data.props.map((p) => p.start), [{ on: false }, { broken: true }, undefined]);
  const room = new Room(data);
  assert.deepEqual(room.props.map((p) => [p.on, p.broken]), [[false, false], [true, true], [true, false]]);

  await withProps([{ type: 'chair', x: 1, y: 2, on: false }]);
  await assert.rejects(loadRoom('offices', assets), /chair\) can't have "on"/);
  await withProps([{ type: 'light', x: 1, y: 2, broken: 'yes' }]);
  await assert.rejects(loadRoom('offices', assets), /can't have "broken"/);
});

test('lights switch off a minute after the room empties and back on when someone comes in', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const lights = room.switchables;
  assert.ok(lights.length > 0);
  const lit = () => lights.every((light) => light.lit);
  const dark = () => lights.every((light) => !light.lit);

  room.updateLights(true, 1);
  room.updateLights(false, LIGHTS_OFF_SECONDS - 1);
  assert.ok(lit(), 'still on just before the minute is up');
  room.updateLights(false, 1);
  assert.ok(dark());
  room.updateLights(false, 120);
  assert.ok(dark());
  room.updateLights(true, 0.1);
  assert.ok(lit());

  // A broken light stays dark even when people are around.
  lights[0].break();
  room.updateLights(false, LIGHTS_OFF_SECONDS);
  room.updateLights(true, 0.1);
  assert.equal(lights[0].lit, false);
  assert.ok(lights.slice(1).every((light) => light.lit));
});

test('the world runs the lights from who is in each room', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const world = new World({ roster: [character('a')], rooms: [room], now: noon });
  world.arrive = () => undefined;

  for (let t = 0; t < LIGHTS_OFF_SECONDS + 1; t += 0.5) world.update(0.5);
  assert.ok(room.switchables.every((light) => !light.on), 'empty room goes dark');

  world.spawn(character('a'), room, room.randomFloorPoint());
  world.update(0.1);
  assert.ok(room.switchables.every((light) => light.on));
});

test('nobody picks a seat on a broken prop, and whoever sits on one gets up', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const world = new World({ roster: [character('a')], rooms: [room], now: noon });
  world.arrive = () => undefined;
  const log = [];
  world.hooks.log = (text) => log.push(text);

  for (const prop of room.props) if (prop.type === 'chair') prop.break();
  for (let i = 0; i < 50; i++) assert.equal(world.freeSpot(room, 'chair'), undefined);
  const benchSpot = world.freeSpot(room, 'bench');
  assert.ok(benchSpot);

  const agent = world.spawn(character('a'), room, benchSpot);
  agent.interrupt(world, { activity: 'Taking a break', interruptible: true, sitting: true, update: () => false });
  agent.spot = benchSpot;
  assert.ok(agent.sitting);

  benchSpot.prop.break();
  world.update(0.1);
  assert.notEqual(agent.spot?.prop, benchSpot.prop);
  assert.notEqual(agent.activity, 'Taking a break');
  assert.ok(log.some((line) => line.includes("a's bench broke")));
});
