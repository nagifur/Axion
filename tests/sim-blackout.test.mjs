import assert from 'node:assert/strict';
import test from 'node:test';
import { dropTarget } from '../src/lib/sim/agentDrag.ts';
import { getFromDispenser } from '../src/lib/sim/itemTasks.ts';
import { tryElectricalShock } from '../src/lib/sim/electrical.ts';
import { BLACKOUT_BACKUP_SECONDS, BLACKOUT_RESTORE_SECONDS } from '../src/lib/sim/levelEvents.ts';
import { bindDebugPanel } from '../src/lib/sim/monitorDebug.ts';
import { Room } from '../src/lib/sim/room.ts';
import { wait } from '../src/lib/sim/tasks.ts';
import { World } from '../src/lib/sim/world.ts';

const placed = (type, start) => ({
  type, asset: type, x: 40, y: 10, w: 40, h: 17, flip: false, switchable: true, start,
});
const character = {
  id: 'staff', name: 'Staff', scale: 1, species: 'Human', accessLevel: '5',
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
};
const makeRoom = (id, level, to) => new Room({
  id, level, name: id, camera: id, width: 160, height: 100,
  nav: {
    floor: Array.from({ length: 100 }, () => [0, 160]),
    exits: [{
      id: 'east', kind: 'door', side: 'east', bounds: { x: 100, y: 0, w: 26, h: 96 },
      threshold: { x: 110, y: 80 }, base: { x: 130, y: 80 },
    }],
  },
  doors: { east: { clearance: 2 } },
  links: to ? { east: { room: to, door: 'east' } } : {},
  props: [placed('light'), placed('light', { on: false }), placed('light', { broken: true }), placed('vending_machine')],
});
const setup = () => {
  const a = makeRoom('a', 2, 'b');
  const b = makeRoom('b', 2, 'a');
  const other = makeRoom('other', 4);
  const world = new World({ rooms: [a, b, other], roster: [] });
  world.arrive = () => undefined;
  return { world, a, b, other, level: world.level(2), panel: world.passageDoorFor(a.doors[0]) };
};

test('blackout is debug/manual-only and affects the entire floor immediately, then backs up after exactly 10 seconds', () => {
  const { world, a, b, other, level, panel } = setup();
  world.update(100);
  assert.equal(a.power, 'normal', 'no automatic triggers');
  assert.deepEqual(level.availableEvents, [
    { id: 'blackout', label: 'Blackout' },
    { id: 'containment-failure', label: 'Containment failure' },
  ]);
  for (const room of [a, b]) room.props[0].setOn(true);
  level.startEvent('blackout');
  for (const room of [a, b]) {
    assert.equal(room.power, 'off');
    assert.equal(room.darkness, 1);
    assert.equal(room.props[0].lit, false);
    assert.equal(room.props[0].on, true, 'physical switch is unchanged');
    assert.equal(room.props[3].dispensing, null);
    assert.equal(room.props[3].look, 'off');
  }
  assert.equal(panel.powered, false);
  assert.equal(panel.blocked, true);
  assert.equal(world.canUsePassage(character, a.doors[0]), false);
  assert.equal(other.power, 'normal');
  world.update(0);
  assert.equal(a.power, 'off', 'paused time does not start backup power');
  world.update(BLACKOUT_BACKUP_SECONDS - 1);
  assert.equal(a.power, 'off');
  assert.equal(level.startEvent('blackout'), false, 'retriggering does not reset the generator delay');
  world.update(1);
  for (const room of [a, b]) {
    assert.equal(room.power, 'backup');
    assert.equal(room.darkness, 0);
    assert.equal(room.props[0].emergency, true);
    assert.equal(room.props[1].lit, true, 'emergency lights override the normal switch');
    assert.equal(room.props[1].on, false);
    assert.equal(room.props[2].lit, false, 'backup cannot repair broken lights');
    assert.equal(room.props[3].dispensing, null, 'vending is not on the backup circuit');
  }
  assert.equal(panel.powered, true);
  assert.equal(world.canUsePassage(character, a.doors[0]), true);
  world.update(100);
  assert.equal(level.hasEvent('blackout'), true, 'backup lasts until manually ended');
  assert.equal(level.stopEvent('blackout'), true);
  assert.equal(a.power, 'normal');
  assert.equal(b.power, 'normal');
  assert.equal(a.props[1].on, false);
  assert.equal(a.props[2].broken, true);
  world.update(BLACKOUT_RESTORE_SECONDS);
  assert.equal(a.props[3].dispensing, 'can');
});

test('ending before backup cancels the pending generator and a later blackout gets a fresh delay', () => {
  const { world, a, level, panel } = setup();
  level.startEvent('blackout');
  world.update(5);
  panel.breakPanel();
  level.stopEvent('blackout');
  world.update(20);
  assert.equal(a.power, 'normal');
  assert.equal(panel.panelBroken, true, 'restoring power does not repair panels');
  level.startEvent('blackout');
  world.update(9);
  assert.equal(a.power, 'off');
  world.update(1);
  assert.equal(a.power, 'backup');
  assert.equal(panel.blocked, true, 'broken panels remain unusable on backup');
});

test('unpowered doors freeze safely, and editor-added props inherit the floor power state', () => {
  const { world, a, level, panel } = setup();
  panel.open = 1;
  level.startEvent('blackout');
  assert.equal(panel.stuckOpen, true);
  assert.equal(world.canUsePassage(character, a.doors[0]), true, 'an open door does not trap its occupants');
  world.update(1);
  assert.equal(panel.open, 1);
  panel.open = 0.5;
  world.update(1);
  assert.equal(panel.open, 0.5);
  assert.equal(panel.blocked, false);
  assert.equal(world.canUsePassage(character, a.doors[0]), true, 'a half-open unpowered door remains passable');
  panel.open = 0.49;
  world.update(1);
  assert.equal(panel.open, 0.49);
  assert.equal(panel.blocked, true);
  a.setProps([placed('light'), placed('vending_machine')]);
  assert.equal(a.props[0].lit, false);
  assert.equal(a.props[1].dispensing, null);
  a.updateLights(true, 100);
  assert.equal(a.props[0].lit, false, 'occupancy cannot restore mains power');
  world.update(8);
  a.updateLights(false, 100);
  assert.equal(a.props[0].lit, true, 'emergency lights stay on in empty rooms');
  level.stopEvent('blackout');
  world.update(BLACKOUT_RESTORE_SECONDS);
  assert.equal(a.props[1].dispensing, 'can');
});

test('blackout blocks drag/drop vending and manual lights, including a vending task already in progress', (t) => {
  t.mock.method(Math, 'random', () => 0.99);
  const { world, a, level } = setup();
  const machine = a.props[3];
  const agent = world.spawn(character, a, machine.standPoint(a));
  agent.setPlan(world, [getFromDispenser(machine), wait(100, 'Waiting')]);
  agent.update(world, 0);
  level.startEvent('blackout');
  const target = dropTarget(world, agent, agent, null, machine);
  assert.equal(target.kind, 'invalid');
  assert.match(target.label, /no power/);
  agent.update(world, 3);
  assert.equal(agent.item, null);
  world.update(10);
  assert.equal(dropTarget(world, agent, agent, null, machine).kind, 'invalid');
  assert.match(dropTarget(world, agent, agent, null, a.props[0]).label, /cannot be switched manually/);
  level.stopEvent('blackout');
  world.update(BLACKOUT_RESTORE_SECONDS);
  assert.equal(dropTarget(world, agent, agent, null, machine).kind, 'prop');
});

test('power returns to equipment one piece at a time after a blackout ends', (t) => {
  const { world, a, level } = setup();
  level.startEvent('blackout');
  world.update(BLACKOUT_BACKUP_SECONDS);
  // Restore moments consumed per electric prop in room order: a gets 0.2/0.4/0.6/0.8 of the window.
  const rolls = [0.2, 0.4, 0.6, 0.8];
  let index = 0;
  t.mock.method(Math, 'random', () => rolls[index++ % rolls.length]);
  level.stopEvent('blackout');
  assert.equal(a.power, 'normal', 'mains power is back on the floor immediately');
  assert.equal(a.props[0].on, true, 'the switch itself is untouched');
  assert.equal(a.props[0].lit, false, 'equipment stays dead until its own restore moment');
  assert.equal(a.props[0].emergency, false, 'the emergency circuit is no longer supplying it');
  assert.equal(a.props[3].dispensing, null);
  world.update(0.2 * BLACKOUT_RESTORE_SECONDS + 0.5);
  assert.equal(a.props[0].lit, true, 'the first light pops back on');
  assert.equal(a.props[3].dispensing, null, 'the vending machine is still waiting its turn');
  world.update(0.6 * BLACKOUT_RESTORE_SECONDS);
  assert.equal(a.props[3].dispensing, 'can', 'the last machine comes back within the restore window');
});

test('the debug event picker triggers and ends the selected event on the currently viewed floor', (t) => {
  const { world, a, other } = setup();
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({}) } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });

  test('unpowered electrical equipment cannot spark or shock, and backup restores only the light circuit', (t) => {
    t.mock.method(Math, 'random', () => 0);
    const { world, a, level } = setup();
    const machine = a.props[3];
    machine.break();
    const light = a.props[2];
    const agent = world.spawn(character, a, machine.standPoint(a));
    agent.setPlan(world, [wait(100, 'Waiting')]);
    level.startEvent('blackout');
    assert.equal(machine.sparkArea, null);
    assert.equal(light.sparkArea, null);
    assert.equal(tryElectricalShock(agent, world, machine), false);
    world.update(10);
    assert.equal(machine.sparkArea, null);
    assert.notEqual(light.sparkArea, null, 'broken lights are electrically supplied again on backup');
    assert.equal(tryElectricalShock(agent, world, machine), false);
    level.stopEvent('blackout');
    assert.notEqual(machine.sparkArea, null);
    assert.equal(tryElectricalShock(agent, world, machine), true);
  });
  let viewed = a;
  const select = { value: '', replaceChildren(...options) { this.options = options; this.value = options[0]?.value ?? ''; } };
  const floor = {};
  const listeners = {};
  const panel = {
    querySelector(selector) {
      return selector === '[data-debug-event]' ? select : selector === '[data-debug-event-floor]' ? floor : null;
    },
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const refresh = bindDebugPanel(panel, {
    world, director: {}, log() {}, currentRoom: () => viewed, onCamera: () => [],
  });
  select.value = 'blackout';
  const click = (debug) => listeners.click({ target: { closest: () => ({ dataset: { debug } }) } });
  click('event-start');
  assert.equal(a.power, 'off');
  assert.equal(other.power, 'normal');
  assert.equal(select.options.find(({ value }) => value === 'blackout').textContent, 'Blackout (active)');
  viewed = other;
  refresh();
  assert.equal(floor.textContent, 'Level 4');
  assert.equal(select.options.find(({ value }) => value === 'blackout').textContent, 'Blackout');
  click('event-start');
  assert.equal(other.power, 'off');
  click('event-stop');
  assert.equal(other.power, 'normal');
  assert.equal(a.power, 'off', 'ending one floor does not end another floor');
  select.value = 'facility:earthquake';
  click('event-start');
  assert.equal(world.events.hasEvent('earthquake'), true);
  viewed = a;
  refresh();
  assert.equal(select.value, 'facility:earthquake', 'facility selection survives a camera/floor switch');
  assert.match(select.options.find(({ value }) => value === 'facility:earthquake').textContent, /facility-wide.*active/);
  click('event-stop');
  assert.equal(world.events.hasEvent('earthquake'), false, 'any camera can end a facility event');
});
