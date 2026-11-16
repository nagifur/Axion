import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { enterThroughDoor, exitThroughDoor, wait } from '../src/lib/sim/agent.ts';
import {
  DOOR_PANEL_FRAME_SECONDS, PASSAGE_DOOR_HOLD_SECONDS, PASSAGE_DOOR_RANGE, PASSAGE_DOOR_SECONDS,
  PassageDoor, doorAppearance, passageDoorFrame, passagePanelFrame,
} from '../src/lib/sim/door.ts';
import { Renderer } from '../src/lib/sim/render.ts';
import { Room } from '../src/lib/sim/room.ts';
import { linkRooms, listPropTypes, loadFacility, loadRoom } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';

const staff = (accessLevel = '1', id = 'staff', behavior = {}) => ({
  id, name: id, href: '', tint: '#fff', scale: 1, position: 'Test', species: 'Human',
  accessLevel, employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false, ...behavior },
});

function roomData(id, level, side, clearance, to) {
  const east = side === 'east';
  return {
    id, name: id, level, camera: id, width: 140, height: 100,
    nav: {
      width: 140, height: 100,
      floor: Array.from({ length: 100 }, () => [0, 140]),
      exits: [{
        id: side, kind: 'door', side,
        bounds: { x: east ? 100 : 15, y: 0, w: 26, h: 96 },
        threshold: { x: east ? 110 : 30, y: 80 },
        base: { x: east ? 130 : 10, y: 80 },
      }],
    },
    props: [], links: to ? { [side]: to } : {},
    doors: clearance === undefined ? {} : { [side]: { clearance } },
  };
}

function connectedRooms(clearance = 2) {
  const a = new Room(roomData('a', 0, 'east', clearance, { room: 'b', door: 'west' }));
  const b = new Room(roomData('b', 1, 'west', clearance, { room: 'a', door: 'east' }));
  const world = new World({ rooms: [a, b], roster: [], now: () => new Date(2026, 0, 1, 12) });
  return { world, a, b, east: a.doors[0], west: b.doors[0] };
}

function stay(world, character, room, point, impostor) {
  const agent = world.spawn(character, room, point, impostor);
  agent.setPlan(world, [wait(1000, 'Standing')]);
  return agent;
}

test('configured level 0 and 1 passages have matching doors; open exits and other levels remain doorless', async () => {
  const rooms = (await loadFacility()).map((data) => new Room(data));
  const world = new World({ rooms, roster: [] });
  let count = 0;
  for (const room of rooms) {
    for (const door of room.doors) {
      if (room.level <= 1) {
        if (!door.appearance) {
          assert.equal(world.passageDoorFor(door), undefined, `${room.id}/${door.id} stays open`);
          continue;
        }
        count++;
        assert.equal(door.appearance.clearance, room.level, `${room.id}/${door.id}`);
        assert.equal(door.appearance.asset, `door_angle_level${room.level}`);
        assert.equal(door.appearance.panelAsset, 'door_panel_angle');
        assert.ok(world.passageDoorFor(door));
        if (door.to) {
          const other = world.room(door.to.room).doors.find((candidate) => candidate.id === door.to.door);
          assert.equal(world.passageDoorFor(door), world.passageDoorFor(other), 'both cameras share one state');
        }
      } else {
        assert.equal(door.appearance, undefined);
        assert.equal(world.passageDoorFor(door), undefined);
      }
    }
  }
  assert.equal(count, 10);
  const palette = await listPropTypes();
  for (const asset of ['door_level0', 'door_level1', 'door_angle_level0', 'door_angle_level1', 'door_panel', 'door_panel_angle']) {
    assert.ok(!palette.includes(asset), `${asset} is a passage assembly, not an ordinary prop`);
  }
});

test('linked door configuration propagates to the other view and rejects mismatched clearance', () => {
  const loaded = (id, side, doors, exits = {}) => ({
    data: { id, level: 1, links: {}, doors, nav: { exits: [{ id: side, kind: 'door', side }] } },
    exits: new Map(Object.entries(exits).map(([door, room]) => [door, { room }])),
  });
  const a = loaded('a', 'east', { east: { clearance: 1, panelOffset: { x: 4, y: 5 } } }, { east: 'b' });
  const b = loaded('b', 'west', {});
  linkRooms([a, b]);
  assert.deepEqual(b.data.doors, { west: { clearance: 1 } }, 'view-specific offsets are not copied');

  const c = loaded('c', 'east', { east: { clearance: 0 } }, { east: 'd' });
  const d = loaded('d', 'west', { west: { clearance: 1 } });
  assert.throws(() => linkRooms([c, d]), /need the same clearance/);
});

test('door configuration and missing or incomplete artwork report useful errors', async (t) => {
  const assets = await mkdtemp(path.join(tmpdir(), 'axion-doors-'));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await mkdir(path.join(assets, 'rooms'), { recursive: true });
  await cp('src/sim_assets/rooms/level-1-offices', path.join(assets, 'rooms', 'test'), { recursive: true });
  await cp('src/sim_assets/props', path.join(assets, 'props'), { recursive: true });
  const file = path.join(assets, 'rooms', 'test', 'room.json');
  const json = JSON.parse(await readFile(file, 'utf8'));
  json.props = [];
  const load = async (doors) => {
    json.doors = doors;
    await writeFile(file, JSON.stringify(json));
    return loadRoom('test', assets);
  };
  assert.equal((await load({ west: { clearance: 1 } })).doors.west.clearance, 1);
  await assert.rejects(load([]), /"doors" must be an object/);
  await assert.rejects(load({ north: { clearance: 1 } }), /passage "north".*navMap.png/);
  for (const value of [-1, 1.5, '1', null]) {
    await assert.rejects(load({ west: { clearance: value } }), /non-negative whole-number "clearance"/);
  }
  await assert.rejects(load({ west: { clearance: 1, panelOffset: { x: 2 } } }), /"panelOffset".*whole-number/);
  await assert.rejects(load({ west: { clearance: 1, offset: { x: 2, y: 3, z: 4 } } }), /"offset".*whole-number/);
  await assert.rejects(load({ west: { clearance: 1, colour: 'red' } }), /unknown property "colour"/);
  await assert.rejects(load({ west: { clearance: 99 } }), /needs sim_assets\/props\/door_angle_level99.png/);
  await sharp({ create: { width: 96, height: 96, channels: 4, background: '#ff0000' } })
    .png().toFile(path.join(assets, 'props', 'door_panel_angle.png'));
  await assert.rejects(load({ west: { clearance: 1 } }), /two red and two green panel frames/);
});

test('door artwork aligns with openings and offsets move the door and panel independently', () => {
  const bounds = { x: 20, y: 30, w: 26, h: 96 };
  const base = doorAppearance('west', bounds, { clearance: 1 });
  const adjusted = doorAppearance('west', bounds, {
    clearance: 1, offset: { x: 3, y: -4 }, panelOffset: { x: -5, y: 8 },
  });
  assert.deepEqual([adjusted.x, adjusted.y], [base.x + 3, base.y - 4]);
  assert.deepEqual(adjusted.panel, { x: base.panel.x - 2, y: base.panel.y + 4 });
  assert.equal(doorAppearance('east', bounds, { clearance: 0 }).flip, true);
  assert.equal(doorAppearance('north', bounds, { clearance: 0 }).asset, 'door_level0');
  assert.equal(doorAppearance('north', bounds, { clearance: 0 }).panelAsset, 'door_panel');
});

test('panel frames use red and green rows and animate without using the broken or off rows', async () => {
  for (const [side, asset] of [['west', 'door_panel_angle'], ['north', 'door_panel']]) {
    const { data, info } = await sharp(`src/sim_assets/props/${asset}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const unlocked of [false, true]) {
      for (const column of [0, 1]) {
        const frame = passagePanelFrame(side, unlocked, column * DOOR_PANEL_FRAME_SECONDS);
        assert.equal(Math.floor(frame.x / 96), column);
        assert.equal(Math.floor(frame.y / 96), unlocked ? 3 : 0);
        let colored = 0;
        for (let y = frame.y; y < frame.y + frame.h; y++) {
          for (let x = frame.x; x < frame.x + frame.w; x++) {
            const i = (y * info.width + x) * 4;
            const [r, g, b, a] = data.subarray(i, i + 4);
            if (a && (unlocked ? g > r * 1.35 && g > b * 1.1 && g > 150 : r > g * 1.35 && r > b * 1.1 && r > 150)) colored++;
          }
        }
        assert.ok(colored > 20, `${asset} contains the ${unlocked ? 'green' : 'red'} indicator in frame ${column}`);
      }
    }
  }
});

test('authorized proximity opens and holds one shared door, then it closes and relocks', () => {
  const { world, a, b, east, west } = connectedRooms();
  const state = world.passageDoorFor(east);
  assert.equal(state, world.passageDoorFor(west));
  const denied = stay(world, staff('1', 'denied'), a, east.inside);
  world.update(0.1);
  assert.deepEqual([state.unlocked, state.open], [false, 0], 'insufficient clearance does not unlock');

  const allowed = stay(world, staff('2', 'allowed'), a, { x: east.inside.x - PASSAGE_DOOR_RANGE - 1, y: east.inside.y });
  world.update(0.1);
  assert.equal(state.unlocked, false);
  allowed.x = east.inside.x - PASSAGE_DOOR_RANGE;
  world.update(PASSAGE_DOOR_SECONDS / 2);
  assert.equal(state.unlocked, true);
  assert.ok(Math.abs(state.open - 0.5) < 1e-9);
  allowed.room = b;
  allowed.x = west.inside.x;
  allowed.y = west.inside.y;
  world.update(PASSAGE_DOOR_SECONDS / 2);
  assert.equal(state.open, 1, 'the other camera keeps the same door open');
  assert.equal(world.canAgentUsePassage(denied, east), false, 'a green panel does not authorize bystanders');

  allowed.x = west.inside.x + PASSAGE_DOOR_RANGE + 1;
  world.update(PASSAGE_DOOR_HOLD_SECONDS);
  assert.equal(state.unlocked, false);
  assert.equal(state.open, 1, 'the hold time elapses before closing starts');
  world.update(PASSAGE_DOOR_SECONDS);
  assert.equal(state.open, 0);
});

test('held agents do not activate panels; Admin, impostors, and exits follow existing clearance exceptions', () => {
  const { world, a, east } = connectedRooms();
  const state = world.passageDoorFor(east);
  const admin = stay(world, staff('Admin', 'admin'), a, east.inside);
  admin.held = true;
  world.update(0.2);
  assert.equal(state.unlocked, false);
  admin.held = false;
  world.update(0.2);
  assert.equal(state.unlocked, true);
  assert.equal(world.canAgentUsePassage(admin, east), true);

  const low = stay(world, staff('0', 'low'), a, east.inside);
  assert.equal(world.canAgentUsePassage(low, east), false);
  low.leaving = true;
  assert.equal(world.canAgentUsePassage(low, east), true, 'exits remain available');
  low.leaving = false;
  const mimic = stay(world, staff('0', 'mimic'), a, east.inside, { id: 'fake', name: 'Fake', nickname: '', href: '', weight: 1 });
  assert.equal(world.canAgentUsePassage(mimic, east), true, 'impostors retain their existing bypass');
});

test('crossing waits for the door to open and shares its state with the arrival view', () => {
  const { world, a, b, east, west } = connectedRooms();
  const agent = world.spawn(staff('2'), a, east.inside);
  agent.setPlan(world, [exitThroughDoor(east)]);
  const state = world.passageDoorFor(east);
  world.update(0.1);
  assert.ok(state.open > 0 && state.open < 1);
  assert.equal(agent.alpha, 1);
  assert.equal(agent.room, a);
  world.update(0.1);
  assert.equal(agent.alpha, 1, 'the agent waits at the threshold');
  for (let i = 0; i < 50 && agent.room !== b; i++) world.update(0.1);
  assert.equal(agent.room, b);
  assert.equal(state, world.passageDoorFor(west));
  assert.equal(state.open, 1);
  for (let i = 0; i < 20 && agent.alpha < 1; i++) world.update(0.1);
  assert.equal(agent.alpha, 1, 'the agent finishes stepping into the other room');
});

test('a low-clearance agent cannot follow someone through an open door, and work routing avoids it', () => {
  const { world, a, b, east } = connectedRooms();
  const high = stay(world, staff('2', 'high'), a, east.inside);
  world.update(PASSAGE_DOOR_SECONDS);
  assert.equal(world.passageDoorFor(east).open, 1);
  const low = world.spawn(staff('1', 'low'), a, east.inside);
  const warnings = [];
  world.hooks.log = (message, tone) => warnings.push({ message, tone });
  low.setPlan(world, [exitThroughDoor(east)]);
  world.update(0.1);
  world.update(0.1);
  assert.equal(low.room, a);
  assert.equal(low.alpha, 1);
  assert.ok(warnings.some(({ message, tone }) => tone === 'warn' && message.includes('Access denied')));
  assert.equal(world.stepTowardWork(low.character, a), undefined);
  assert.equal(world.stepTowardWork(high.character, a), east);

  world.transfer(low, east);
  assert.equal(low.room, a, 'direct transfers also respect a physical lock');
  assert.notEqual(low.room, b);
});

test('a clearance change during crossing returns the agent to the threshold visibly', () => {
  const { world, a, east } = connectedRooms();
  const agent = world.spawn(staff('2'), a, east.inside);
  const warnings = [];
  world.hooks.log = (message) => warnings.push(message);
  agent.setPlan(world, [exitThroughDoor(east)]);
  world.update(PASSAGE_DOOR_SECONDS);
  world.update(0.1);
  assert.ok(agent.alpha < 1);
  agent.character.accessLevel = '0';
  world.update(0.1);
  assert.deepEqual({ x: agent.x, y: agent.y, alpha: agent.alpha }, { ...east.inside, alpha: 1 });
  assert.ok(warnings.some((message) => message.includes('Access denied')));
});

test('off-camera arrivals wait for an authorized door and do not bypass locked entrances', () => {
  const room = new Room(roomData('entry', 0, 'west', 2));
  const world = new World({ rooms: [room], roster: [] });
  const door = room.doors[0];
  const low = staff('1', 'low');
  const warnings = [];
  world.hooks.log = (message, tone) => warnings.push({ message, tone });
  assert.throws(() => world.arriveByDoor(low, room, door), /insufficient clearance/);
  assert.equal(world.arrive(low), undefined);
  assert.equal(world.agents.length, 0);
  assert.ok(warnings.some(({ message, tone }) => tone === 'warn' && message.includes('clearance')));

  const agent = world.arriveByDoor(staff('2', 'high'), room, door);
  world.update(0.1);
  assert.equal(agent.alpha, 0, 'arrival stays outside while the door opens');
  for (let i = 0; i < 30 && agent.alpha < 1; i++) world.update(0.1);
  assert.equal(agent.alpha, 1);
  assert.ok(room.isWalkable(agent));

  const denied = world.spawn(low, room, door.outside);
  denied.alpha = 0;
  denied.setPlan(world, [enterThroughDoor(door)]);
  world.update(0.1);
  assert.equal(denied.removed, true, 'a directly scripted unauthorized arrival is rejected');
});

test('an elevator arrival redirected before its first update can open an exit door', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const world = new World({ rooms: [room], roster: [] });
  const agent = world.arriveByElevator(staff('1'), room, {
    id: 'fake', name: 'Fake', nickname: '', href: '', weight: 1,
  });
  const elevator = world.elevatorFor(room);
  assert.equal(agent.layer, 'inside');
  assert.equal(elevator.busy, true);
  assert.equal(world.interact(agent), 'revealed');
  assert.equal(agent.layer, 'room', 'replacing the queued arrival releases the elevator layer');
  world.update(0.1);
  assert.equal(elevator.busy, false, 'the unstarted elevator request was cancelled');
  for (let i = 0; i < 600 && !agent.removed; i++) world.update(0.1);
  assert.equal(agent.removed, true);
});

test('a doorless passage still transfers without waiting for a physical door', () => {
  const a = new Room(roomData('a', 0, 'east', undefined, { room: 'b', door: 'west' }));
  const b = new Room(roomData('b', 0, 'west', undefined, { room: 'a', door: 'east' }));
  const world = new World({ rooms: [a, b], roster: [] });
  const door = a.doors[0];
  assert.equal(world.passageDoorFor(door), undefined);
  const agent = world.spawn(staff('0'), a, door.inside);
  agent.setPlan(world, [exitThroughDoor(door)]);
  for (let i = 0; i < 20 && agent.room !== b; i++) world.update(0.1);
  assert.equal(agent.room, b);
});

test('renderer slides the door within its silhouette and selects the panel state', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  const canvases = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const draws = [];
        const gradients = [];
        const ctx = {
          drawImage(...args) { draws.push(args); },
          getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
          putImageData() {}, clearRect() {}, setTransform() {}, fillRect() {},
          save() {}, restore() {}, translate() {}, scale() {},
          createRadialGradient() {
            const stops = [];
            gradients.push(stops);
            return { addColorStop(...args) { stops.push(args); } };
          },
        };
        const canvas = { width: 0, height: 0, draws, gradients, getContext() { return ctx; } };
        canvases.push(canvas);
        return canvas;
      },
    },
  });
  const room = new Room(roomData('entry', 0, 'west', 0));
  const world = new World({ rooms: [room], roster: [] });
  const door = room.doors[0];
  const image = { width: 192, height: 384 };
  const panel = { width: 192, height: 384 };
  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas, {
    character: { width: 576, height: 864 }, 'room:entry': {}, door_angle_level0: image, door_panel_angle: panel,
  }, room);
  const mask = canvases.find((candidate) => candidate.width === 96 && candidate.height === 96);
  renderer.draw(world, new Map());
  const frame = passageDoorFrame('west');
  assert.deepEqual(mask.draws[0], [image, frame.x, frame.y, frame.w, frame.h, 0, -0, frame.w, frame.h]);
  assert.deepEqual(mask.draws[1], [image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h], 'closed silhouette masks the moving panel');
  assert.deepEqual(canvas.draws.find((draw) => draw[0] === panel).slice(1, 5), [39, 0, 17, 84]);
  assert.ok(canvas.gradients[0][0][1].includes('255, 35, 65'), 'locked panel glows red');

  const state = world.passageDoorFor(door);
  state.update(true, PASSAGE_DOOR_SECONDS / 2);
  world.time = DOOR_PANEL_FRAME_SECONDS;
  renderer.draw(world, new Map());
  assert.equal(mask.draws[2][6], -48, 'half-open door slides upward');
  assert.deepEqual(canvas.draws.filter((draw) => draw[0] === panel).at(-1).slice(1, 5), [135, 288, 17, 84]);
  assert.ok(canvas.gradients.at(-1)[0][1].includes('40, 255, 115'), 'unlocked panel glows green');
});

test('door hold time is independent of update step size', () => {
  const state = new PassageDoor(1);
  state.update(true, PASSAGE_DOOR_SECONDS);
  state.update(false, PASSAGE_DOOR_HOLD_SECONDS + PASSAGE_DOOR_SECONDS / 2);
  assert.equal(state.unlocked, false);
  assert.ok(Math.abs(state.open - 0.5) < 1e-9);
});
