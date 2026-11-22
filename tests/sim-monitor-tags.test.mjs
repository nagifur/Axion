import assert from 'node:assert/strict';
import test from 'node:test';
import { access } from 'node:fs/promises';
import { Agent } from '../src/lib/sim/agent.ts';
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
  const world = { agents: [agent], actorsIn() { return this.agents; } };
  let visible = true;
  const renderer = { isVisible: () => visible, headPosition: () => ({ x: 200, y: 50 }) };
  const state = { viewed: room, showAll: false, hovered: null, selected: null };
  const tags = new NameTags(layer, { select() {}, hover() {}, hovered: () => null });
  const sync = () => tags.sync(world, renderer, state);
  sync();
  const button = layer.children[0];
  return {
    agent, world, button, sync, state,
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
