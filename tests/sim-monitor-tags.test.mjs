import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { Agent } from '../src/lib/sim/agent.ts';
import { Creature } from '../src/lib/sim/creature.ts';
import { Room } from '../src/lib/sim/room.ts';
import { NameTags } from '../src/lib/sim/monitorTags.ts';
import { STATUS_EFFECTS } from '../src/lib/sim/statusEffects.ts';

function setup(t) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  const createElement = () => ({
    children: [], attributes: new Map(), properties: new Map(), classes: new Set(),
    textContent: '', hidden: false, offsetWidth: 80, offsetHeight: 40,
    classList: {
      toggle(name, enabled) {
        if (enabled) this.owner.classes.add(name);
        else this.owner.classes.delete(name);
      },
    },
    style: { setProperty(name, value) { this.owner.properties.set(name, value); } },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    remove() { this.removed = true; },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement() {
      const node = createElement();
      node.classList.owner = node;
      node.style.owner = node;
      return node;
    } },
  });
  const room = { width: 400, height: 200 };
  const layer = document.createElement('div');
  layer.clientWidth = 800;
  layer.clientHeight = 400;
  const agent = new Agent({
    name: 'Tester', tint: '#fff', scale: 1, behavior: { speed: 1 },
  }, room, { x: 200, y: 120 });
  const world = { agents: [agent], actorsIn() { return this.agents; }, swallowedIn() { return []; } };
  let visible = true;
  const renderer = { isVisible: () => visible, headPosition: () => ({ x: 200, y: 50 }) };
  const state = { viewed: room, showAll: false, hovered: null, selected: null };
  const tags = new NameTags(layer, { select() {}, hover() {}, hovered: () => null });
  const sync = () => tags.sync(world, renderer, state);
  sync();
  const button = layer.children[0];
  return {
    agent, world, button, sync, state, layer,
    statuses: button.children[0], bubble: button.children[1],
    hide: () => { visible = false; },
  };
}

test('shocked artwork exists and its popup follows refresh, pause, removal and expiry', async (t) => {
  await access(new URL(STATUS_EFFECTS.shocked.popup.icon));
  assert.equal(STATUS_EFFECTS.shocked.popup.color, '#ffbc00');
  const { agent, button, statuses, bubble, sync } = setup(t);
  assert.equal(statuses.children.length, 0);
  agent.say('?', 10);
  agent.statuses.apply('shocked', 4);
  sync();
  const popup = statuses.children[0];
  assert.equal(statuses.children.length, 1);
  assert.equal(popup.properties.get('--status-color'), '#ffbc00');
  assert.equal(popup.children[0].src, STATUS_EFFECTS.shocked.popup.icon);
  assert.equal(popup.children[0].alt, 'Shocked');
  assert.equal(popup.children[0].width, 16);
  assert.equal(popup.children[0].height, 16);
  assert.equal(bubble.textContent, '?', 'speech is independent of status artwork');
  assert.equal(button.getAttribute('aria-label'), 'Tester. Shocked. Open file');
  assert.equal(button.classes.has('is-quiet'), true, 'hover-only names do not hide the status row');
  agent.statuses.update({}, 3);
  sync();
  assert.equal(statuses.children[0], popup, 'unchanged artwork is not recreated every frame');
  agent.statuses.apply('shocked', 5);
  agent.statuses.update({}, 0);
  sync();
  assert.equal(statuses.children.length, 1, 'refresh never stacks popups');
  agent.statuses.update({}, 4);
  sync();
  assert.equal(statuses.children[0], popup, 'popup outlives the original shock duration');
  agent.statuses.update({}, 1);
  sync();
  assert.equal(statuses.children.length, 0);
  assert.equal(button.getAttribute('aria-label'), 'Tester. Open file');
  agent.statuses.apply('shocked');
  sync();
  agent.statuses.remove('shocked');
  sync();
  assert.equal(statuses.children.length, 0, 'explicit removal clears artwork immediately');
});

test('custom popup colors and multiple effects coexist; artless effects have no popup', (t) => {
  t.after(() => {
    delete STATUS_EFFECTS['test-popup'];
    delete STATUS_EFFECTS['test-no-popup'];
  });
  STATUS_EFFECTS['test-popup'] = {
    label: 'Custom', targets: ['agent'],
    popup: { icon: '/custom.svg', color: '#f00', background: '#123' },
  };
  STATUS_EFFECTS['test-no-popup'] = { label: 'Invisible', targets: ['agent'] };
  const { agent, statuses, sync } = setup(t);
  agent.statuses.apply('test-no-popup');
  sync();
  assert.equal(statuses.children.length, 0);
  agent.statuses.apply('shocked');
  agent.statuses.apply('test-popup');
  sync();
  assert.equal(statuses.children.length, 2);
  const custom = statuses.children[1];
  assert.equal(custom.properties.get('--status-color'), '#f00');
  assert.equal(custom.properties.get('--status-background'), '#123');
  assert.equal(custom.children[0].src, '/custom.svg');
  agent.statuses.remove('shocked');
  sync();
  assert.equal(statuses.children.length, 1);
  assert.equal(statuses.children[0].title, 'Custom');
});

test('exhausted popup is identified for its larger artwork', (t) => {
  const { agent, statuses, sync } = setup(t);
  agent.statuses.apply('exhausted');
  sync();
  assert.equal(statuses.children[0].getAttribute('data-status'), 'exhausted');
  assert.equal(statuses.children[0].children[0].src, STATUS_EFFECTS.exhausted.popup.icon);
});

test('status tags share character visibility, dragging and removed-agent cleanup', (t) => {
  const { agent, world, button, statuses, sync, hide } = setup(t);
  agent.statuses.apply('shocked');
  sync();
  assert.equal(button.hidden, false);
  assert.equal(statuses.children.length, 1);
  hide();
  sync();
  assert.equal(button.hidden, true, 'off-camera characters have no visible status popup');
  agent.held = true;
  sync();
  assert.equal(button.classes.has('is-held'), true, 'status artwork follows held-tag visibility');
  world.agents = [];
  sync();
  assert.equal(button.removed, true);
});

test('Dead artwork and accessible popup persist for both staff and creatures', async (t) => {
  await access(new URL(STATUS_EFFECTS.dead.popup.icon));
  const { agent, world, button, statuses, sync, layer } = setup(t);
  agent.stats.hp.current = 0;
  sync();
  assert.equal(statuses.children[0].children[0].src, STATUS_EFFECTS.dead.popup.icon);
  assert.equal(statuses.children[0].children[0].alt, 'Dead');
  assert.equal(statuses.children[0].properties.get('--status-color'), '#ff4545');
  assert.equal(statuses.children[0].properties.get('--status-background'), 'rgba(80, 8, 13, 0.92)');
  assert.equal(button.getAttribute('aria-label'), 'Tester. Dead. Open file');
  const room = new Room({
    id: 'cell', name: 'Cell', camera: 'cell', level: 0, width: 140, height: 100,
    nav: { floor: Array.from({ length: 100 }, () => [0, 140]), exits: [] }, props: [], links: {},
  });
  const creature = new Creature({ name: 'Resident', tint: '#fff', scale: 1 }, room);
  creature.stats.hp.current = -5;
  world.agents = [creature];
  sync();
  assert.equal(button.removed, true);
  const creatureButton = layer.children.at(-1);
  assert.equal(creatureButton.children[0].children[0].children[0].src, STATUS_EFFECTS.dead.popup.icon);
  assert.equal(creatureButton.getAttribute('aria-label'), 'Resident. Dead. Open file');
  creature.statuses.update({}, 100);
  sync();
  assert.equal(creatureButton.children[0].children.length, 1);
});

test('creature tags show the nickname, falling back to the ID without one', (t) => {
  const { world, layer, sync } = setup(t);
  const room = new Room({
    id: 'cell', name: 'Cell', camera: 'cell', level: 0, width: 140, height: 100,
    nav: { floor: Array.from({ length: 100 }, () => [0, 140]), exits: [] }, props: [], links: {},
  });
  const named = new Creature({ name: 'S-552', nickname: 'Sprouty', tint: '#fff', scale: 1 }, room);
  const unnamed = new Creature({ name: 'C-100', nickname: '█████', tint: '#fff', scale: 1 }, room);
  world.agents = [named, unnamed];
  sync();
  const [sprouty, fallback] = layer.children.slice(-2);
  assert.equal(sprouty.getAttribute('aria-label'), 'Sprouty. Open file');
  assert.equal(fallback.getAttribute('aria-label'), 'C-100. Open file');
});

test('swallowed prey keep a tag with an artless acid popup until they are out', (t) => {
  const { agent, world, layer, sync } = setup(t);
  const prey = new Agent({ name: 'Meal', tint: '#fff', scale: 1, behavior: { speed: 1 } }, agent.room, { x: 200, y: 120 });
  prey.statuses.apply('acid');
  world.swallowedIn = () => [prey];
  sync();
  const tag = layer.children[1];
  assert.equal(tag.getAttribute('aria-label'), 'Meal. Acid. Open file');
  const popup = tag.children[0].children[0];
  assert.equal(popup.properties.get('--status-color'), STATUS_EFFECTS.acid.popup.color);
  assert.equal(popup.properties.get('--status-background'), STATUS_EFFECTS.acid.popup.background);
  assert.equal(popup.children.length, 1);
  assert.equal(popup.children[0].className, 'monitor-tag-status-mark', 'a plain colored mark until it gets artwork');
  assert.equal(popup.children[0].src, undefined);
  world.swallowedIn = () => [];
  sync();
  assert.equal(tag.removed, true);
});

test('the death skull renders white and fills the 16px popup icon without clipping', async () => {
  const svg = await readFile(new URL(STATUS_EFFECTS.dead.popup.icon));
  const { data, info } = await sharp(svg).resize(16, 16).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const xs = [];
  const ys = [];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset + 3] < 128) continue;
      assert.deepEqual([...data.subarray(offset, offset + 3)], [255, 255, 255]);
      xs.push(x);
      ys.push(y);
    }
  }
  assert.ok(xs.length > 0, 'skull artwork is visible');
  assert.ok(Math.max(...xs) - Math.min(...xs) + 1 >= 14, 'skull spans at least 14px horizontally');
  assert.ok(Math.max(...ys) - Math.min(...ys) + 1 >= 14, 'skull spans at least 14px vertically');
  assert.ok(Math.min(...xs) > 0 && Math.max(...xs) < 15, 'horizontal edges have clear padding');
  assert.ok(Math.min(...ys) > 0 && Math.max(...ys) < 15, 'vertical edges have clear padding');
});
