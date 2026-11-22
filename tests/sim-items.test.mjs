import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Agent } from '../src/lib/sim/agent.ts';
import { Item } from '../src/lib/sim/item.ts';
import { PropEditor, itemsSnippet } from '../src/lib/sim/propEditor.ts';
import { drawItemSprite, loadAssets, Renderer } from '../src/lib/sim/render.ts';
import { Room } from '../src/lib/sim/room.ts';
import { itemPreview, loadRoom } from '../src/lib/sim/roomLoader.ts';
import { HOLD_ITEM_CYCLE, IDLE_CYCLES, ITEM_HAND_ANCHORS, SIT_CYCLES, TALK_RIGHT_CYCLE, TRIP_CYCLE, USE_ITEM_CYCLE, WALK_CYCLES, WALK_STRIDE, itemFrame } from '../src/lib/sim/sprites.ts';
import { World } from '../src/lib/sim/world.ts';
import { trip, wait, walkTo } from '../src/lib/sim/tasks.ts';
import { itemPickupPoint, pickUp, retrieveItem, setDownItem, storeItem, useItem } from '../src/lib/sim/itemTasks.ts';
import { ITEM_REACH } from '../src/lib/sim/item.ts';
import { planNext } from '../src/lib/sim/planning.ts';
import { ITEM_ACTIONS, itemActions } from '../src/lib/sim/item.ts';

const drink = ITEM_ACTIONS.can.find((action) => action.id === 'drink');
const logWorld = () => ({ lines: [], log(text) { this.lines.push(text); }, achieve() {} });

test('a carried can unlocks drinking, which uses it up and destroys it', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const item = can();
  room.items.push(item);
  const agent = new Agent({ ...character, name: 'Tester' }, room, { x: 200, y: 140 });
  assert.deepEqual(itemActions(agent.item), [], 'empty hands unlock nothing');
  agent.pickUpItem(item);
  assert.deepEqual(itemActions(agent.item), [drink]);
  const world = logWorld();
  agent.setPlan(world, [useItem(drink)]);
  agent.update(world, 0);
  assert.equal(agent.activity, 'Drinking a can');
  assert.equal(agent.busy, true, 'drinking cannot be interrupted by chats');
  assert.equal(agent.frame.name, 'useRight1');
  agent.update(world, drink.seconds - 0.5);
  assert.equal(agent.item, item, 'the can lasts until the drink finishes');
  agent.update(world, 0.5);
  assert.equal(agent.item, null);
  assert.equal(room.items.includes(item), false, 'a used-up item is not dropped on the floor');
  assert.deepEqual(world.lines, [`Tester finished a can in the ${room.name}.`]);
  assert.throws(() => agent.consumeItem(), /no item/);
});

test('item actions refuse to start without the item and stop if it is dropped', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const agent = new Agent(character, room, { x: 200, y: 140 });
  const world = logWorld();
  assert.throws(() => { agent.setPlan(world, [useItem(drink)]); agent.update(world, 0); }, /cannot "drink"/);
  const item = can();
  room.items.push(item);
  agent.setPlan(world, []);
  agent.pickUpItem(item);
  agent.setPlan(world, [useItem(drink)]);
  agent.update(world, 1);
  assert.ok(USE_ITEM_CYCLE.includes(agent.frame.name));
  agent.dropItem();
  assert.ok(agent.frame.name.startsWith('idle'), 'dropping the item immediately clears the use pose');
  const replacement = Item.create('can');
  agent.receiveItem(replacement);
  assert.ok(HOLD_ITEM_CYCLE.includes(agent.frame.name), 'a replacement item is not treated as the item being used');
  agent.update(world, drink.seconds);
  assert.equal(agent.item, replacement);
  assert.deepEqual(room.items, [item], 'a dropped can is not consumed');
  assert.deepEqual(world.lines, []);
});

test('the planner only offers item actions while carrying a matching item', async (t) => {
  const room = new Room(await loadRoom('level-1-offices'));
  const world = new World({ rooms: [room], roster: [], now: () => new Date(2026, 0, 1, 18) });
  t.mock.method(world, 'freeSpot', () => undefined);
  t.mock.method(world, 'findChatPartner', () => undefined);
  const random = t.mock.method(Math, 'random', () => 0);
  const agent = new Agent({ ...character, id: 'a', name: 'A', species: 'Human', accessLevel: '1' }, room, { x: 200, y: 140 });
  const drinks = () => {
    let count = 0;
    for (let i = 0; i < 200; i++) {
      random.mock.mockImplementation(() => (i + 0.5) / 200);
      if (planNext(agent, world)[0].activity === drink.activity) count++;
    }
    return count;
  };
  assert.equal(drinks(), 0);
  const item = can();
  room.items.push(item);
  agent.pickUpItem(item);
  assert.ok(drinks() > 0);
  agent.consumeItem();
  assert.equal(drinks(), 0);
});

const character = { scale: 1, behavior: { speed: 1 } };
const can = (x = 197, y = 130) => new Item({ type: 'can', asset: 'item:can', x, y, w: 6, h: 10, flip: false });

test('every agent spawns with its own profile-level card in storage and an empty hand', () => {
  const room = { items: [] };
  for (let level = 0; level <= 5; level++) {
    const profile = { ...character, accessLevel: String(level) };
    const a = new Agent(profile, room, { x: 0, y: 0 });
    const b = new Agent(profile, room, { x: 0, y: 0 });
    assert.equal(a.item, null);
    assert.deepEqual(a.inventory.map((item) => item.type), [`card_level${level}`]);
    assert.notEqual(a.inventory[0], b.inventory[0]);
    for (let door = 0; door <= 6; door++) assert.equal(a.hasAccessCard(door), door <= level);
  }
  for (const accessLevel of ['Admin', ' admin ']) {
    const admin = new Agent({ ...character, accessLevel }, room, { x: 0, y: 0 });
    assert.equal(admin.inventory[0].type, 'card_admin');
    assert.equal(admin.hasAccessCard(999), true);
    assert.equal(admin.inventory[0].asset, 'item:card_admin');
  }
  for (const accessLevel of ['███', '', 'None', '-1', '3.5']) {
    const agent = new Agent({ ...character, accessLevel }, room, { x: 0, y: 0 });
    assert.equal(agent.inventory[0].type, 'card_level1');
  }
  assert.deepEqual(room.items, [], 'spawned inventory never appears on the floor');
});

test('starting items and storage preserve item identity without duplicating ownership', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const profile = { ...character, startingItems: ['can', 'can'] };
  const agent = new Agent(profile, room, { x: 200, y: 140 });
  const other = new Agent(profile, room, agent);
  const first = agent.inventory[1];
  assert.deepEqual(agent.inventory.map((item) => item.type), ['card_level1', 'can', 'can']);
  assert.notEqual(first, other.inventory[1]);
  assert.throws(() => agent.storeItem(), /no item/);
  assert.throws(() => agent.retrieveItem(other.inventory[1]), /not in.*inventory/);
  assert.throws(() => agent.receiveItem(first), /retrieveItem/);
  assert.throws(() => agent.receiveStoredItem(first), /already/);
  agent.retrieveItem(first);
  assert.equal(agent.item, first);
  assert.equal(agent.inventory.includes(first), false);
  assert.throws(() => agent.retrieveItem(agent.inventory[1]), /already carries/);
  assert.throws(() => agent.receiveStoredItem(first), /already/);
  assert.equal(agent.storeItem(), first);
  assert.equal(agent.item, null);
  assert.equal(agent.inventory.filter((item) => item === first).length, 1);
  agent.retrieveItem(first);
  agent.dropItem();
  assert.throws(() => agent.receiveStoredItem(first), /already/);
  assert.equal(agent.inventory.includes(first), false);
  agent.x = first.x + first.w / 2;
  agent.y = first.y + first.h;
  agent.pickUpItem(first);
  agent.storeItem();
  assert.equal(room.items.length, 0);
  agent.room = new Room(await loadRoom('level-1-offices'));
  agent.retrieveItem(first);
  assert.equal(agent.consumeItem(), first);
  assert.equal(agent.inventory.includes(first), false);
  assert.equal(agent.hasAccessCard(1), true, 'using a drink does not consume the card');
  assert.throws(() => new Agent({ ...character, startingItems: ['missing-item'] }, room, agent), /ITEM_SPRITES/);
});

test('storage transfers are forbidden during dragging, transport, removal and departure', () => {
  for (const state of [{ held: true }, { layer: 'inside' }, { alpha: 0.5 }, { leaving: true }, { removed: true }]) {
    const agent = new Agent(character, { items: [] }, { x: 0, y: 0 });
    const card = agent.inventory[0];
    Object.assign(agent, state);
    assert.throws(() => agent.retrieveItem(card), /cannot retrieve/);
    Object.assign(agent, { held: false, layer: 'room', alpha: 1, leaving: false, removed: false });
    agent.retrieveItem(card);
    Object.assign(agent, state);
    assert.throws(() => agent.storeItem(), /cannot store/);
    assert.equal(agent.item, card);
    assert.deepEqual(agent.inventory, []);
  }
  const agent = new Agent(character, { items: [] }, { x: 0, y: 0 });
  agent.setPlan({}, [{ activity: 'Transport', transport: true, update() { return false; } }]);
  agent.update({}, 0);
  assert.throws(() => agent.retrieveItem(agent.inventory[0]), /cannot retrieve/);
});

test('access card art is tightly cropped and level zero reuses level-one artwork', async () => {
  for (const type of ['card_level0', 'card_level1', 'card_level2', 'card_level3', 'card_level4', 'card_level5', 'card_admin']) {
    const item = Item.create(type);
    const file = `src/sim_assets/items/${item.asset.slice(5)}.png`;
    const frame = itemFrame(type, await sharp(file).metadata());
    const { info } = await sharp(file).trim().toBuffer({ resolveWithObject: true });
    assert.deepEqual([frame.w, frame.h, item.w, item.h], [10, 8, 10, 8]);
    assert.deepEqual([info.width, info.height], [10, 8]);
    const preview = await itemPreview(type);
    const metadata = await sharp(Buffer.from(preview.split(',')[1], 'base64')).metadata();
    assert.deepEqual([metadata.width, metadata.height], [10, 8]);
  }
});

test('holding poses apply while standing or dragged without replacing walks, seats, or speaking', () => {
  for (const facing of ['right', 'left', 'front', 'back']) {
    const room = { name: 'Test', items: [], props: [] };
    const agent = new Agent(character, room, { x: 200, y: 140 });
    agent.receiveItem(Item.create('can'));
    agent.facing = facing;
    agent.setPlan({}, [wait(10, 'Holding')]);
    agent.update({}, 0);
    assert.deepEqual(agent.frame, { name: 'holdRight1', flip: facing === 'left' });
    agent.update({}, 0.61);
    assert.equal(agent.frame.name, 'holdRight2');

    agent.moving = true;
    agent.walkDistance = WALK_STRIDE;
    assert.equal(agent.frame.name, WALK_CYCLES[facing][1]);
    agent.moving = false;
    agent.setPlan({}, [{ activity: 'Resting', interruptible: true, sitting: true, update() { return false; } }]);
    agent.update({}, 0);
    assert.equal(agent.frame.name, SIT_CYCLES[facing][1]);
    agent.held = true;
    assert.ok(HOLD_ITEM_CYCLE.includes(agent.frame.name));
    agent.held = false;
    agent.setPlan({}, []);
    if (facing === 'left' || facing === 'right') {
      agent.conversation = { initiator: agent, partner: {}, started: true, ended: false, elapsed: 0 };
      assert.ok(TALK_RIGHT_CYCLE.includes(agent.frame.name), 'speakers keep their talking pose');
      agent.conversation = undefined;
    }
    agent.consumeItem();
    assert.equal(agent.frame.name, IDLE_CYCLES[facing][1]);
  }
});

test('item use starts at frame one, plays all six frames, loops, and respects facing', () => {
  for (const facing of ['right', 'left', 'front', 'back']) {
    const room = { name: 'Test', items: [], props: [] };
    const agent = new Agent({ ...character, name: 'Test' }, room, { x: 200, y: 140 });
    const world = logWorld();
    agent.receiveItem(Item.create('can'));
    agent.facing = facing;
    agent.setPlan(world, [wait(10, 'Holding')]);
    agent.update(world, 0.85);
    agent.setPlan(world, [useItem(drink)]);
    agent.update(world, 0);
    assert.deepEqual(agent.frame, { name: 'useRight1', flip: facing === 'left' });
    assert.equal(agent.facing, facing === 'left' ? 'left' : 'right');
    for (const name of USE_ITEM_CYCLE.slice(1)) {
      agent.update(world, 0.61);
      assert.equal(agent.frame.name, name);
    }
    agent.update(world, 0.61);
    assert.equal(agent.frame.name, 'useRight1', 'long actions loop the full sequence');
    agent.update(world, 0.35);
    assert.equal(agent.item, null);
    assert.ok(agent.frame.name.startsWith('idle'), 'the use pose ends when the action finishes');
  }
});

test('tripping overrides item use and the interrupted action resumes with its item', () => {
  const room = { name: 'Test', items: [], props: [] };
  const agent = new Agent({ ...character, name: 'Test' }, room, { x: 200, y: 140 });
  const world = logWorld();
  const item = Item.create('can');
  agent.receiveItem(item);
  agent.setPlan(world, [useItem(drink)]);
  agent.update(world, 0.7);
  assert.equal(agent.frame.name, 'useRight2');
  agent.held = true;
  assert.ok(HOLD_ITEM_CYCLE.includes(agent.frame.name), 'dragging shows the item being held');
  agent.held = false;
  assert.equal(agent.frame.name, 'useRight2', 'releasing a drag restores the paused use frame');
  agent.interrupt(world, trip());
  assert.equal(agent.frame.name, 'tripRight1');
  assert.equal(agent.item, item);
  agent.update(world, 0.61);
  assert.equal(agent.frame.name, 'tripRight2');
  agent.update(world, 0.7);
  assert.ok(HOLD_ITEM_CYCLE.includes(agent.frame.name));
  agent.update(world, 0);
  assert.equal(agent.frame.name, 'useRight1');
  agent.setPlan(world, []);
  assert.ok(HOLD_ITEM_CYCLE.includes(agent.frame.name), 'cancelling use restores the carry pose');
  assert.equal(agent.item, item);
});

test('one item slot transfers ownership atomically and rejects invalid pickups', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const item = can();
  const second = can();
  room.items.push(item, second);
  const agent = new Agent(character, room, { x: 200, y: 140 });
  const other = new Agent(character, room, agent);
  assert.equal(agent.item, null);
  agent.pickUpItem(item);
  assert.equal(agent.item, item);
  assert.deepEqual(room.items, [second]);
  assert.throws(() => agent.pickUpItem(second), /already carries/);
  assert.throws(() => other.pickUpItem(item), /not loose/);
  assert.equal(agent.item, item);
  const distant = new Agent(character, room, { x: 250, y: 140 });
  assert.throws(() => distant.pickUpItem(second), /out of pickup reach/);
  assert.deepEqual(room.items, [second]);
  other.x = 212;
  other.pickUpItem(second);
  assert.equal(other.item, second, 'the 12px reach boundary is inclusive');
  assert.equal(room.items.length, 0);
});

test('carried items follow room changes and drop the same instance on open floor', async () => {
  const source = new Room(await loadRoom('level-1-offices'));
  const destination = new Room(await loadRoom('level-1-offices'));
  const item = can();
  source.items.push(item);
  const agent = new Agent(character, source, { x: 200, y: 140 });
  agent.pickUpItem(item);
  agent.moveToward({ x: 220, y: 140 }, 1);
  agent.room = destination;
  const point = destination.nearestWalkable(agent);
  assert.equal(agent.dropItem(), item);
  assert.equal(agent.item, null);
  assert.equal(source.items.length, 0);
  assert.deepEqual(destination.items, [item]);
  assert.deepEqual([item.x, item.y], [Math.round(point.x - 3), Math.round(point.y - 10)]);
  assert.throws(() => agent.dropItem(), /no item/);
  agent.x = item.x + 3;
  agent.y = item.y + 10;
  agent.pickUpItem(item);
  assert.equal(destination.items.length, 0);
});

test('dragging, transport, removal and departure cannot mutate item ownership', async () => {
  for (const state of [{ held: true }, { layer: 'inside' }, { alpha: 0.5 }, { leaving: true }, { removed: true }]) {
    const room = new Room(await loadRoom('level-1-offices'));
    const item = can();
    room.items.push(item);
    const agent = new Agent(character, room, { x: 200, y: 140 });
    Object.assign(agent, state);
    assert.throws(() => agent.pickUpItem(item), /cannot pick up/);
    Object.assign(agent, { held: false, layer: 'room', alpha: 1, leaving: false, removed: false });
    agent.pickUpItem(item);
    Object.assign(agent, state);
    assert.throws(() => agent.dropItem(), /cannot drop/);
    assert.equal(agent.item, item);
    assert.equal(room.items.length, 0);
  }
  const room = new Room(await loadRoom('level-1-offices'));
  const agent = new Agent(character, room, { x: 200, y: 140 });
  agent.setPlan({}, [{ activity: 'Transport', transport: true, update() { return false; } }]);
  agent.update({}, 0);
  const item = can();
  room.items.push(item);
  assert.throws(() => agent.pickUpItem(item), /cannot pick up/);
});

test('item room data and palette previews use the artwork crop, with explicit validation', async (t) => {
  const assetsDir = await mkdtemp(path.join(tmpdir(), 'axion-items-'));
  t.after(() => rm(assetsDir, { recursive: true, force: true }));
  const roomDir = path.join(assetsDir, 'rooms', 'test-room');
  await mkdir(roomDir, { recursive: true });
  await mkdir(path.join(assetsDir, 'items'));
  const original = 'src/sim_assets/rooms/level-1-offices';
  const json = JSON.parse(await readFile(`${original}/room.json`, 'utf8'));
  delete json.doors;
  json.props = [];
  json.items = [{ type: 'can', x: 197, y: 130, flip: true }];
  await Promise.all([
    copyFile(`${original}/room.png`, path.join(roomDir, 'room.png')),
    copyFile(`${original}/nav_map.png`, path.join(roomDir, 'nav_map.png')),
    copyFile('src/sim_assets/items/can.png', path.join(assetsDir, 'items', 'can.png')),
  ]);
  const load = async (items) => {
    json.items = items;
    await writeFile(path.join(roomDir, 'room.json'), JSON.stringify(json));
    return loadRoom('test-room', assetsDir);
  };
  const data = await load(json.items);
  assert.deepEqual(data.items, [{ ...can().toData(), flip: true }]);
  const room = new Room(data);
  assert.ok(room.items[0] instanceof Item);
  assert.deepEqual(JSON.parse(`{${itemsSnippet(room.items)}}`).items, json.items);
  const preview = await itemPreview('can', assetsDir);
  const image = await sharp(Buffer.from(preview.split(',')[1], 'base64')).metadata();
  assert.deepEqual([image.width, image.height], [6, 10]);
  await Promise.all(['card_level1', 'card_admin'].map((type) =>
    copyFile(`src/sim_assets/items/${type}.png`, path.join(assetsDir, 'items', `${type}.png`))));
  for (const type of ['card_level0', 'card_admin']) {
    const data = await load([{ type, x: 100, y: 100 }]);
    assert.deepEqual(data.items, [{ ...Item.create(type).toData(), x: 100, y: 100 }]);
  }
  await assert.rejects(load({}), /items.*must be an array/);
  await assert.rejects(load([{ type: 'missing', x: 0, y: 0 }]), /unknown type/);
  await assert.rejects(load([{ type: 'can', x: 0.5, y: 0 }]), /whole-number/);
  await assert.rejects(load([{ type: 'can', x: 0, y: 0, flip: 'yes' }]), /boolean/);
  assert.deepEqual((await load(undefined)).items, []);
});

test('editor places, drags, nudges, flips, removes and resets items without affecting props', async (t) => {
  canvasEnvironment(t);
  const room = new Room(await loadRoom('level-1-offices'));
  const props = room.props.slice();
  const blocked = room.blockedAreas.map((rect) => ({ ...rect }));
  const editor = new PropEditor({ 'item:can': { width: 96, height: 96 } }, room, () => {});
  editor.add('item:can');
  editor.pointerDown({ x: 200, y: 140 });
  const item = editor.selected;
  assert.ok(item instanceof Item);
  assert.deepEqual(item.toData(), can().toData());
  editor.nudge(2, 3);
  editor.flip();
  editor.toggleBroken();
  editor.toggleOff();
  assert.deepEqual(JSON.parse(`{${editor.snippet()}}`).items, [{ type: 'can', x: 199, y: 133, flip: true }]);
  editor.pointerDown({ x: item.x + 1, y: item.y + 2 });
  editor.pointerMove({ x: 210, y: 150 });
  editor.pointerUp();
  assert.deepEqual([item.x, item.y], [209, 148]);
  assert.equal(editor.isEdited(), true);
  assert.deepEqual(room.props, props);
  assert.deepEqual(room.blockedAreas, blocked);
  editor.remove();
  assert.equal(room.items.length, 0);
  assert.equal(editor.isEdited(), false);
  editor.add('item:can');
  editor.pointerDown({ x: 200, y: 140 });
  editor.reset();
  assert.equal(room.items.length, 0);
  assert.equal(editor.selected, null);
  assert.equal(editor.isEdited(), false);
});

test('runtime items do not change authored editor state or appear in its export', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const editor = new PropEditor({ 'item:can': { width: 96, height: 96 } }, room, () => {});
  const runtimeItem = can();
  room.items.push(runtimeItem);
  assert.equal(editor.isEdited(), false);
  assert.deepEqual(JSON.parse(`{${editor.snippet()}}`).items, []);

  editor.add('item:can');
  editor.pointerDown({ x: 200, y: 140 });
  assert.equal(editor.isEdited(), true);
  assert.deepEqual(JSON.parse(`{${editor.snippet()}}`).items, [{ type: 'can', x: 197, y: 130 }]);
  editor.reset();
  assert.deepEqual(room.items, [runtimeItem], 'reset restores the layout without deleting runtime items');
  assert.equal(editor.isEdited(), false);
});

test('elevator travel retains the carried item and leaving takes it off camera', async () => {
  const data = await loadRoom('level-1-offices');
  const source = new Room(data);
  const destination = new Room({ ...data, id: 'destination', level: 2 });
  // The lifecycle being tested only needs the elevator's inside and front positions.
  const opening = { inside: { x: 200, y: 100 }, front: { x: 200, y: 140 }, thresholdY: 110 };
  Object.defineProperty(source, 'elevator', { value: opening });
  Object.defineProperty(destination, 'elevator', { value: opening });
  const world = new World({ rooms: [source, destination], roster: [] });
  const item = can();
  const agent = new Agent({ ...character, id: 'carrier', name: 'Carrier' }, source, { x: 200, y: 140 });
  const card = agent.inventory[0];
  const stored = Item.create('can');
  agent.receiveStoredItem(stored);
  source.items.push(item);
  world.agents.push(agent);
  agent.pickUpItem(item);
  world.elevatorDeparted(agent, destination);
  assert.equal(world.agents.includes(agent), false);
  assert.equal(agent.item, item);
  assert.equal(agent.room, destination);
  assert.deepEqual(agent.inventory, [card, stored]);
  world.deliver(world.rides[0]);
  assert.equal(world.agents.includes(agent), true);
  assert.equal(agent.item, item);
  assert.equal(agent.layer, 'inside');
  assert.deepEqual(agent.inventory, [card, stored]);
  assert.equal(source.items.length + destination.items.length, 0);
  world.remove(agent, 'elevator');
  assert.equal(agent.removed, true);
  assert.equal(agent.item, item);
  assert.deepEqual(agent.inventory, [card, stored]);
  assert.equal(source.items.length + destination.items.length, 0);
});

function canvasEnvironment(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  const createElement = () => {
    const draws = [], transforms = [];
    const ctx = {
      drawImage(...args) { draws.push(args); },
      getImageData(_x, _y, w, h) { return { data: new Uint8ClampedArray(w * h * 4).fill(255) }; },
      putImageData() {}, setTransform() {}, fillRect() {}, save() {}, restore() {}, clearRect() {},
      translate(...args) { transforms.push(['translate', ...args]); },
      scale(...args) { transforms.push(['scale', ...args]); },
    };
    return { width: 0, height: 0, draws, transforms, getContext() { return ctx; } };
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement } });
}

test('items render at hand anchors for every facing, scale, walk, sit and drag pose', async (t) => {
  canvasEnvironment(t);
  const room = new Room(await loadRoom('level-1-offices'));
  const image = { width: 96, height: 96 };
  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas, { character: { width: 576, height: 1152 }, 'item:can': image }, room);
  for (const scale of [0.75, 1, 1.2]) {
    const agent = new Agent({ ...character, scale }, room, { x: 200, y: 140 });
    const item = can();
    room.items.push(item);
    agent.pickUpItem(item);
    for (const facing of Object.keys(ITEM_HAND_ANCHORS)) {
      agent.facing = facing;
      for (const pose of ['idle', 'walk', 'sit', 'held']) {
        agent.setPlan({}, pose === 'sit' ? [{ activity: 'Sit', sitting: true, update() { return false; } }] : []);
        if (pose === 'sit') agent.update({}, 0);
        agent.moving = pose === 'walk';
        agent.held = pose === 'held';
        canvas.draws.length = 0;
        canvas.transforms.length = 0;
        renderer.drawAgent(agent);
        const hand = pose === 'idle' || pose === 'held'
          ? { x: facing === 'left' ? -17 : 17, y: agent.frame.name === 'holdRight2' ? -47 : -46, behind: false }
          : ITEM_HAND_ANCHORS[facing];
        assert.equal(canvas.draws[hand.behind ? 0 : 1][0], image);
        const draw = canvas.draws.find((args) => args[0] === image);
        const w = Math.round(6 * scale), h = Math.round(10 * scale);
        assert.deepEqual(draw.slice(1), [45, 43, 6, 10, 0, 0, w, h]);
        const x = 200 + Math.round(hand.x * scale) - Math.round(w / 2) + (facing === 'left' ? w : 0);
        const y = 140 + Math.round(hand.y * scale) - h;
        assert.ok(canvas.transforms.some((transform) => transform.join() === ['translate', x, y].join()));
        if (pose === 'held') {
          const before = [agent.x, agent.y];
          renderer.drawHeld(agent, { x: 250, y: 160 }, true);
          assert.deepEqual([agent.x, agent.y], before);
          assert.equal(agent.item, item);
        }
      }
    }
  }
});

test('items follow every trip, carry, and use hand frame at different scales and facings', async (t) => {
  canvasEnvironment(t);
  const room = new Room(await loadRoom('level-1-offices'));
  const world = logWorld();
  const image = { width: 96, height: 96 };
  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas, { character: { width: 576, height: 1152 }, 'item:can': image }, room);
  const poses = [
    { names: TRIP_CYCLE, hands: [[44, -9], [44, -11]], task: () => ({ activity: 'Trip', tripping: true, update() { return false; } }) },
    { names: HOLD_ITEM_CYCLE, hands: [[17, -46], [17, -47]], task: () => wait(10, 'Holding') },
    { names: USE_ITEM_CYCLE, hands: [[17, -46], [23, -50], [26, -53], [26, -53], [23, -50], [17, -46]], task: () => useItem(drink) },
  ];
  for (const scale of [0.75, 1, 1.2]) {
    for (const facing of ['right', 'left', 'front', 'back']) {
      for (const pose of poses) {
        const agent = new Agent({ ...character, name: 'Test', scale }, room, { x: 200, y: 140 });
        agent.receiveItem(Item.create('can'));
        agent.facing = facing;
        agent.setPlan(world, [pose.task()]);
        agent.update(world, 0);
        for (const [index, name] of pose.names.entries()) {
          assert.equal(agent.frame.name, name);
          canvas.draws.length = 0;
          canvas.transforms.length = 0;
          renderer.drawAgent(agent);
          assert.equal(canvas.draws[1][0], image, 'the item is in front of the side-facing hand');
          const [handX, handY] = pose.hands[index];
          const flip = facing === 'left';
          const width = Math.round(6 * scale), height = Math.round(10 * scale);
          const x = 200 + Math.round((flip ? -handX : handX) * scale) - Math.round(width / 2) + (flip ? width : 0);
          const y = 140 + Math.round(handY * scale) - height;
          assert.ok(canvas.transforms.some((transform) => transform.join() === ['translate', x, y].join()), `${name}, ${facing}, scale ${scale}`);
          if (index < pose.names.length - 1) agent.update(world, 0.61);
        }
      }
    }
  }
});

test('loose item drawing and pixel picking use the same cropped footprint', async (t) => {
  canvasEnvironment(t);
  const room = new Room(await loadRoom('level-1-offices'));
  const image = { width: 96, height: 96 };
  const item = can();
  room.items.push(item);
  const editor = new PropEditor({ 'item:can': image }, room, () => {});
  editor.pointerDown({ x: 200, y: 135 });
  assert.equal(editor.selected, item);
  editor.pointerDown({ x: 210, y: 135 });
  assert.equal(editor.selected, null);
  const canvas = document.createElement('canvas');
  drawItemSprite(canvas.getContext(), image, item);
  assert.deepEqual(canvas.draws[0].slice(1), [45, 43, 6, 10, 0, 0, 6, 10]);
  assert.deepEqual(canvas.transforms, [['translate', 197, 130]]);
  assert.throws(() => itemFrame('can', { width: 10, height: 10 }), /invalid crop/);
  assert.deepEqual(itemFrame('other', { width: 8, height: 12 }), { x: 0, y: 0, w: 8, h: 12 });
});

test('asset loading validates items separately from prop power sheets', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Image', original);
    else delete globalThis.Image;
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      width = 96;
      height = 96;
      set src(value) {
        if (value === 'invalid') this.width = 1;
        queueMicrotask(() => this.onload());
      }
    },
  });
  assert.ok((await loadAssets({ 'item:can': 'valid' }))['item:can']);
  await assert.rejects(loadAssets({ 'item:can': 'invalid' }), /Item sprite.*invalid crop/);
});

const person = (id) => ({
  id, name: id, href: `/Personnel/${id}`, tint: '#fff', scale: 1, position: 'Test', species: 'Human',
  accessLevel: '1', employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});

async function curiousSetup(t) {
  const room = new Room(await loadRoom('level-1-offices'));
  const world = new World({ rooms: [room], roster: [], now: () => new Date(2026, 0, 1, 18) });
  world.arrive = () => undefined;
  const logs = [];
  world.hooks.log = (text) => logs.push(text);
  t.mock.method(world, 'freeSpot', () => undefined);
  t.mock.method(world, 'findChatPartner', () => undefined);
  const random = t.mock.method(Math, 'random', () => 0);
  const curious = (agent) => {
    const plans = [];
    for (let i = 0; i < 200; i++) {
      random.mock.mockImplementation(() => (i + 0.5) / 200);
      const plan = planNext(agent, world);
      if (plan[1]?.activity === 'Picking up a can') plans.push(plan);
      agent.curiousAbout = undefined;
    }
    random.mock.mockImplementation(() => 0);
    return plans;
  };
  return { room, world, logs, curious, random };
}

test('agents get curious about loose items, walk over and pick them up', async (t) => {
  const { room, world, logs, curious } = await curiousSetup(t);
  const agent = world.spawn(person('a'), room, { x: 300, y: 170 });
  assert.equal(curious(agent).length, 0, 'nothing on the floor');
  const item = can(297, 170);
  room.items.push(item);
  const plans = curious(agent);
  assert.ok(plans.length > 0);
  const [walk] = plans[0];
  assert.equal(walk.activity, 'Checking out a can');
  const stand = itemPickupPoint(room, item);
  assert.ok(stand && Math.hypot(item.x + item.w / 2 - stand.x, item.y + item.h - stand.y) <= ITEM_REACH);

  agent.setPlan(world, plans[0]);
  agent.curiousAbout = item;
  for (let s = 0; s < 60 && !agent.item; s += 0.1) agent.update(world, 0.1);
  assert.equal(agent.item, item);
  assert.deepEqual(room.items, []);
  assert.equal(agent.curiousAbout, undefined);
  assert.ok(logs.includes(`a picked up a can in the ${room.name}.`));
  assert.equal(curious(agent).length, 0, 'full hands are not curious');
});

test('only one agent goes for each item, and late arrivals find nothing', async (t) => {
  const { room, world, curious } = await curiousSetup(t);
  const a = world.spawn(person('a'), room, { x: 300, y: 170 });
  const b = world.spawn(person('b'), room, { x: 320, y: 170 });
  const item = can(297, 170);
  room.items.push(item);
  a.curiousAbout = item;
  assert.equal(curious(b).length, 0, 'claimed by someone else');
  a.setPlan(world, []);
  assert.ok(curious(b).length > 0, 'setPlan releases the claim');

  const stand = itemPickupPoint(room, item);
  b.x = stand.x; b.y = stand.y;
  b.setPlan(world, [pickUp(item)]);
  b.update(world, 0);
  room.items = [];
  b.update(world, 1.1);
  assert.equal(b.item, null);
  assert.equal(b.bubble, '?');
});

test('impostors and unreachable items do not trigger curiosity', async (t) => {
  const { room, world, curious } = await curiousSetup(t);
  room.items.push(can(5, 2));
  assert.equal(itemPickupPoint(room, room.items[0]), undefined);
  const agent = world.spawn(person('a'), room, { x: 300, y: 170 });
  assert.equal(curious(agent).length, 0);
  room.items = [can(297, 170)];
  const impostor = world.spawn(person('a'), room, { x: 300, y: 170 }, { id: 'fake', name: 'Fake', nickname: '', href: '', weight: 1 });
  assert.equal(curious(impostor).length, 0);
});

test('agents occasionally carry an item somewhere and set it down', async (t) => {
  const { room, world, logs, random } = await curiousSetup(t);
  const agent = world.spawn(person('a'), room, { x: 300, y: 170 });
  const item = can();
  agent.receiveItem(item);

  let setDownPlans = 0;
  for (let i = 0; i < 200; i++) {
    random.mock.mockImplementation(() => (i + 0.5) / 200);
    const plan = planNext(agent, world);
    if (plan.length === 2 && plan[1]?.activity === 'Putting down a can') {
      setDownPlans++;
      assert.equal(plan[0].activity, 'Finding a place for the can');
    }
  }
  assert.ok(setDownPlans > 0, 'the low-weight set-down option is sometimes selected');

  const destination = { x: 410, y: 170 };
  room.randomFloorPoint = () => destination;
  agent.setPlan(world, [walkTo(destination), setDownItem(item)]);
  for (let s = 0; s < 20 && agent.item; s += 0.1) agent.update(world, 0.1);
  assert.equal(agent.item, null);
  assert.deepEqual(room.items, [item]);
  assert.ok(Math.hypot(item.x + item.w / 2 - destination.x, item.y + item.h - destination.y) <= 1);
  assert.ok(logs.includes(`a set down a can in the ${room.name}.`));
});

test('agents stash held items and retrieve stored items for later use without randomly taking out cards', async (t) => {
  const { room, world, random, logs } = await curiousSetup(t);
  const agent = world.spawn(person('inventory'), room, { x: 200, y: 140 });
  const item = Item.create('can');
  agent.receiveItem(item);
  const findPlan = (activity) => {
    for (let i = 0; i < 1000; i++) {
      random.mock.mockImplementation(() => (i + 0.5) / 1000);
      const plan = planNext(agent, world);
      if (plan[0].activity === activity) return plan;
    }
    assert.fail(`Planner never offered ${activity}`);
  };
  agent.setPlan(world, findPlan('Storing a can'));
  agent.update(world, 0);
  assert.equal(agent.item, null);
  assert.ok(agent.inventory.includes(item));
  agent.setPlan(world, findPlan('Retrieving a can'));
  agent.update(world, 0);
  assert.equal(agent.item, item);
  assert.equal(agent.inventory.includes(item), false);
  agent.setPlan(world, [useItem(drink)]);
  agent.update(world, drink.seconds);
  assert.equal(agent.item, null);
  for (let i = 0; i < 1000; i++) {
    random.mock.mockImplementation(() => (i + 0.5) / 1000);
    assert.ok(!planNext(agent, world)[0].activity.startsWith('Retrieving'), 'cards stay safely stored');
  }
  assert.deepEqual(logs.filter((line) => !line.includes('meowed')), [
    'inventory stored a can.', 'inventory retrieved a can.', `inventory finished a can in the ${room.name}.`,
  ]);
});

test('inventory tasks show confusion rather than transferring a missing or replaced item', () => {
  const agent = new Agent(character, { items: [] }, { x: 0, y: 0 });
  const item = Item.create('can');
  const world = logWorld();
  agent.setPlan(world, [retrieveItem(item)]);
  agent.update(world, 0);
  assert.equal(agent.item, null);
  assert.equal(agent.bubble, '?');
  agent.receiveItem(Item.create('can'));
  agent.setPlan(world, [storeItem(item)]);
  agent.update(world, 0);
  assert.ok(agent.item);
  assert.equal(agent.inventory.length, 1);
  assert.deepEqual(world.lines, []);
});
