import assert from 'node:assert/strict';
import test from 'node:test';
import { LIGHT_FLICKER, Prop } from '../src/lib/sim/prop.ts';
import { Room } from '../src/lib/sim/room.ts';
import { World } from '../src/lib/sim/world.ts';

const light = (start) => ({ type: 'light', asset: 'light', x: 0, y: 0, w: 40, h: 17, flip: false, start });
const makeRoom = (level = 1, props = []) => new Room({
  id: 'room', name: 'Test room', camera: 'Test', level, width: 120, height: 80,
  nav: { floor: Array.from({ length: 80 }, () => [0, 120]), exits: [] },
  props, links: {}, shafts: {},
});

test('a lit light strobes dark and bright for a bounded burst, then recovers', (t) => {
  t.mock.method(Math, 'random', () => 0); // always start, shortest duration and phases
  const prop = new Prop(light());
  prop.updateFlicker(0.1);
  assert.equal(prop.flickering, true);
  assert.equal(prop.flickerOff, true, 'a burst begins with a dark phase');
  assert.equal(prop.look, 'off', 'dark phases show the off-row artwork');
  assert.equal(prop.lit, true, 'flicker never changes lit');
  prop.updateFlicker(LIGHT_FLICKER.phase.min + 0.01);
  assert.equal(prop.flickerOff, false, 'phases alternate back to bright');
  assert.equal(prop.look, undefined);
  prop.updateFlicker(LIGHT_FLICKER.phase.min + 0.01);
  assert.equal(prop.flickerOff, true);
  prop.updateFlicker(LIGHT_FLICKER.duration.max);
  assert.equal(prop.flickering, false, 'the burst ends after its duration');
  assert.equal(prop.flickerOff, false);
  assert.equal(prop.look, undefined);
});

test('flicker starts are a small chance per second', (t) => {
  const dt = 0.5;
  const random = t.mock.method(Math, 'random', () => LIGHT_FLICKER.chance * dt);
  const prop = new Prop(light());
  for (let i = 0; i < 100; i++) prop.updateFlicker(dt);
  assert.equal(prop.flickering, false, 'rolls at or above the chance do not flicker');
  random.mock.mockImplementation(() => LIGHT_FLICKER.chance * dt - 1e-9);
  prop.updateFlicker(dt);
  assert.equal(prop.flickering, true);
});

test('only working lights on mains power flicker', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const cases = [
    { name: 'switched-off light', prop: new Prop(light({ on: false })) },
    { name: 'broken light', prop: new Prop(light({ broken: true })) },
    { name: 'non-light prop', prop: new Prop({ type: 'table', asset: 'table', x: 0, y: 0, w: 70, h: 40, flip: false, switchable: true }) },
    { name: 'vending machine', prop: new Prop({ type: 'vending_machine', asset: 'vending_machine', x: 0, y: 0, w: 40, h: 60, flip: false }) },
  ];
  const emergency = new Prop(light());
  emergency.setPowerSource(() => 'backup');
  cases.push({ name: 'emergency light', prop: emergency });
  for (const { name, prop } of cases) {
    prop.updateFlicker(1);
    assert.equal(prop.flickering, false, name);
    assert.equal(prop.flickerOff, false, name);
  }
});

test('losing light mid-burst clears the flicker', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const prop = new Prop(light());
  prop.updateFlicker(0.1);
  assert.equal(prop.flickerOff, true);
  prop.setOn(false);
  prop.updateFlicker(0.01);
  assert.equal(prop.flickering, false);
  assert.equal(prop.flickerOff, false);
});

test('flicker blacks out the camera without changing gameplay darkness', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const room = makeRoom(1, [light()]);
  const prop = room.props[0];
  prop.updateFlicker(0.1);
  assert.equal(prop.flickerOff, true);
  assert.equal(room.visualDarkness, 1, 'the camera dims while the light is flicker-dark');
  assert.equal(room.darkness, 0, 'gameplay darkness ignores flicker');
  prop.updateFlicker(LIGHT_FLICKER.phase.min + 0.01);
  assert.equal(room.visualDarkness, 0, 'bright phases restore the camera');
  assert.equal(room.visualDarkness, room.darkness, 'rooms agree outside dark phases');
});

test('the world update drives light flicker', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const room = makeRoom(1, [light()]);
  const world = new World({ rooms: [room], roster: [], now: () => new Date(2026, 0, 1, 12) });
  world.update(0.1);
  assert.equal(room.props[0].flickering, true);
});
