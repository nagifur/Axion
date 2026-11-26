import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/lib/sim/agent.ts';
import {
  readVitals, statusBadges, trailFraction, VitalsHud, TRAIL_HOLD_MS, TRAIL_CATCH_UP_PER_SECOND,
} from '../src/lib/sim/monitorVitals.ts';
import { STATUS_EFFECTS, STATUS_POLARITIES } from '../src/lib/sim/statusEffects.ts';

const room = { id: 'room', camera: 'CAM 1', width: 400, height: 200 };
const makeAgent = (name, stats) => new Agent({ name, tint: '#abc', scale: 1, behavior: { speed: 1 }, stats }, room, { x: 200, y: 120 });

/** Minimal DOM: enough element behaviour for the HUD, plus control over running animations. */
function fakeDocument(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  const running = { animations: [] };
  const createElement = () => {
    const node = {
      children: [], attributes: new Map(), properties: new Map(), classes: new Set(),
      textContent: '', hidden: false, offsetWidth: 0, parent: null,
      style: { setProperty(name, value) { node.properties.set(name, value); } },
      classList: {
        toggle(name, enabled) { if (enabled) node.classes.add(name); else node.classes.delete(name); },
        contains: (name) => node.classes.has(name),
      },
      append(...children) {
        for (const child of children) child.parent = node;
        node.children.push(...children);
      },
      replaceChildren(...children) {
        node.children = [];
        node.append(...children);
      },
      remove() {
        if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
        node.parent = null;
      },
      setAttribute(name, value) { node.attributes.set(name, value); },
      getAttribute(name) { return node.attributes.get(name) ?? null; },
      getAnimations: () => running.animations,
    };
    return node;
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement, createTextNode: (text) => ({ textContent: text }) },
  });
  return running;
}

function setup(t) {
  const running = fakeDocument(t);
  const root = document.createElement('div');
  const world = { isRiding: () => false, everyone: () => [], creatures: [], rooms: [room] };
  const hud = new VitalsHud(root, world);
  const statusList = root.children[2];
  return { running, root, hud, statusList };
}

test('health bar shifts green to orange to red, and mana only shows for magic users', () => {
  const agent = makeAgent('Tester', { hp: 100 });
  const health = () => readVitals(agent)[0];
  assert.equal(health().tier.color, '#4dff7c');
  agent.stats.hp.current = 59;
  assert.equal(health().tier.color, '#ffa23a');
  agent.stats.hp.current = 29;
  assert.equal(health().tier.color, '#ff4552');
  assert.equal(health().tier.critical, true);
  assert.deepEqual(readVitals(agent).map(({ definition }) => definition.stat), ['hp', 'stamina']);

  const mage = makeAgent('Mage', { magic: 40 });
  mage.stats.magic.current = 10;
  const mana = readVitals(mage).find(({ definition }) => definition.stat === 'magic');
  assert.equal(mana.fraction, 0.25);
});

test('the damage trail holds after a drop, then catches up without passing the fill', () => {
  assert.equal(trailFraction(0.5, 0.8, 0, 16), 0.8, 'healing moves the trail up at once');
  assert.equal(trailFraction(1, 0.4, TRAIL_HOLD_MS - 1, 16), 1, 'fresh damage stays visible');
  const step = trailFraction(1, 0.4, TRAIL_HOLD_MS, 100);
  assert.ok(Math.abs(step - (1 - TRAIL_CATCH_UP_PER_SECOND * 0.1)) < 1e-9);
  assert.equal(trailFraction(0.41, 0.4, TRAIL_HOLD_MS, 100), 0.4);
});

test('status badges carry polarity and time left, skip hidden effects, and fall back to polarity colours', (t) => {
  t.after(() => { delete STATUS_EFFECTS['test-boost']; });
  STATUS_EFFECTS['test-boost'] = { label: 'Boost', polarity: 'positive', targets: ['agent'], duration: 4 };
  const agent = makeAgent('Tester');
  agent.statuses.apply('test-boost');
  agent.statuses.update({}, 1);
  agent.statuses.apply('digested');
  agent.statuses.apply('dead');
  assert.deepEqual(statusBadges(agent.statuses.active).map(({ id }) => id), ['test-boost', 'digested'], 'digested replaces Dead');
  const [boost] = statusBadges(agent.statuses.active);
  assert.equal(boost.polarity, 'positive');
  assert.equal(boost.color, STATUS_POLARITIES.positive.color);
  assert.equal(boost.timeLeft, 0.75);
});

test('status rows slide out, slide back when reapplied, and reset for a new selection', async (t) => {
  const { running, root, hud, statusList } = setup(t);
  const agent = makeAgent('Tester');
  agent.statuses.apply('scared');
  hud.render(agent, room, 0);
  assert.equal(root.classes.has('is-shown'), true);
  const [row] = statusList.children;
  assert.equal(row.getAttribute('data-polarity'), 'negative');
  assert.equal(row.properties.get('--polarity-color'), STATUS_POLARITIES.negative.color);

  let finish;
  running.animations = [{ animationName: 'monitor-vitals-status-out', finished: new Promise((resolve) => { finish = resolve; }) }];
  agent.statuses.remove('scared');
  hud.render(agent, room, 16);
  assert.equal(row.classes.has('is-leaving'), true);
  assert.deepEqual(statusList.children, [row], 'the row stays while it slides out');
  agent.statuses.apply('scared');
  hud.render(agent, room, 32);
  assert.equal(row.classes.has('is-leaving'), false, 'a reapplied effect reuses its row');
  finish();
  await Promise.resolve();
  assert.deepEqual(statusList.children, [row], 'the cancelled slide-out does not remove it');

  running.animations = [];
  agent.statuses.remove('scared');
  hud.render(agent, room, 48);
  assert.deepEqual(statusList.children, [], 'without animations the row goes at once');

  agent.statuses.apply('scared');
  hud.render(agent, room, 64);
  const other = makeAgent('Other');
  other.statuses.apply('exhausted');
  hud.render(other, room, 80);
  assert.deepEqual(statusList.children.map((node) => node.getAttribute('data-status')), ['exhausted']);

  hud.render(null, room, 96);
  assert.equal(root.classes.has('is-shown'), false);
  assert.equal(statusList.children.length, 1, 'the last actor stays visible while the panel slides away');
});
