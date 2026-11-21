import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { wait } from '../src/lib/sim/tasks.ts';
import { enterThroughDoor, exitThroughDoor, leaveFacility } from '../src/lib/sim/transport.ts';
import { planNext } from '../src/lib/sim/planning.ts';
import {
  DOOR_PANEL_FRAME_SECONDS, PASSAGE_DOOR_HOLD_SECONDS, PASSAGE_DOOR_RANGE, PASSAGE_DOOR_SECONDS,
  PassageDoor, doorAppearance, passageDoorFrame, passagePanelFrame, passagePartBounds,
} from '../src/lib/sim/door.ts';
import { PropEditor } from '../src/lib/sim/propEditor.ts';
import { Renderer } from '../src/lib/sim/render.ts';
import { Room } from '../src/lib/sim/room.ts';
import { linkRooms, listPropTypes, loadFacility, loadRoom } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';
import { Item } from '../src/lib/sim/item.ts';

beforeEach((t) => {
  t.mock.method(Math, 'random', () => 0.5);
});

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

test('broken electrical panels keep sparking in both camera views until repaired', (t) => {
  const { world, a, b, east, west } = connectedRooms();
  world.arrive = () => undefined;
  const state = world.passageDoorFor(east);
  const burst = t.mock.method(world.particles, 'burst');
  state.break();
  world.update(0);
  assert.equal(burst.mock.callCount(), 0, 'a broken mechanical door alone does not spark');

  state.breakPanel();
  world.update(0);
  assert.equal(burst.mock.callCount(), 2);
  for (const [room, door] of [[a, east], [b, west]]) {
    const bounds = passagePartBounds(door.side, door.appearance);
    const particles = world.particles.in(room);
    assert.equal(particles.length, 6);
    assert.ok(particles.every((particle) =>
      particle.asset.startsWith('particle:spark_')
      && particle.x >= bounds.panel.x && particle.x <= bounds.panel.x + bounds.panel.w
      && particle.y >= bounds.panel.y && particle.y <= bounds.panel.y + bounds.panel.h
      && particle.depth >= bounds.door.y + bounds.door.h));
  }
  world.update(0);
  assert.equal(burst.mock.callCount(), 2, 'pause does not repeat panel sparks');
  world.update(2.11);
  assert.equal(burst.mock.callCount(), 4, 'both camera views keep emitting');
  state.repair();
  world.update(2.11);
  assert.equal(burst.mock.callCount(), 6, 'repairing the door does not repair its panel');
  state.repairPanel();
  world.update(0.9);
  assert.equal(burst.mock.callCount(), 6);
  assert.equal(world.particles.particles.length, 0, 'remaining sparks fade after panel repair');
  state.breakPanel();
  world.update(0);
  assert.equal(burst.mock.callCount(), 8);
});

test('every configured passage has matching floor-level door artwork', async () => {
  const facility = await loadFacility();
  const rooms = facility.map((data) => new Room(data));
  const world = new World({ rooms, roster: [] });
  let count = 0;
  for (const [index, room] of rooms.entries()) {
    for (const door of room.doors) {
      if (!facility[index].doors?.[door.id]) {
        assert.equal(door.appearance, undefined, `${room.id}/${door.id} is an open passage`);
        assert.equal(world.passageDoorFor(door), undefined);
        continue;
      }
      count++;
      assert.ok(door.appearance, `${room.id}/${door.id} has a physical door`);
      assert.equal(door.appearance.clearance, room.level, `${room.id}/${door.id}`);
      const angled = door.side === 'west' || door.side === 'east';
      assert.equal(door.appearance.big, facility[index].doors[door.id].big ?? false);
      assert.equal(door.appearance.asset, `${door.appearance.big ? 'big_' : ''}door_${angled ? 'angle_' : ''}level${room.level}${door.side === 'east' ? '_east' : ''}`);
      assert.equal(door.appearance.panelAsset, `door_panel${angled ? '_angle' : ''}`);
      const { panel } = passagePartBounds(door.side, door.appearance);
      assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.w <= room.width && panel.y + panel.h <= room.height,
        `${room.id}/${door.id} panel fits in the camera`);
      assert.ok(world.passageDoorFor(door));
      if (door.to) {
        const other = world.room(door.to.room).doors.find((candidate) => candidate.id === door.to.door);
        assert.equal(world.passageDoorFor(door), world.passageDoorFor(other), 'both cameras share one state');
      }
    }
  }
  assert.equal(count, 22);
  const palette = await listPropTypes();
  const passageAssets = Array.from({ length: 6 }, (_, level) => [
    `door_level${level}`,
    `door_angle_level${level}`,
    `door_angle_level${level}_east`,
  ]).flat().concat(['door_panel', 'door_panel_angle', 'big_door_angle_level3', 'big_door_angle_level3_east']);
  for (const asset of passageAssets) {
    assert.ok(!palette.includes(asset), `${asset} is a passage assembly, not an ordinary prop`);
  }
});

test('linked door configuration propagates to the other view and rejects mismatched clearance', () => {
  const loaded = (id, side, doors, exits = {}) => ({
    data: { id, level: 1, links: {}, doors, nav: { exits: [{ id: side, kind: 'door', side }] } },
    exits: new Map(Object.entries(exits).map(([door, room]) => [door, { room }])),
  });
  const a = loaded('a', 'east', { east: { clearance: 1, big: true, panelOffset: { x: 4, y: 5 } } }, { east: 'b' });
  const b = loaded('b', 'west', {});
  linkRooms([a, b]);
  assert.deepEqual(b.data.doors, { west: { clearance: 1, big: true } }, 'size is inherited but view-specific offsets are not copied');

  const small = loaded('small', 'east', { east: { clearance: 1, big: false } }, { east: 'large' });
  const large = loaded('large', 'west', { west: { clearance: 1, big: true } });
  linkRooms([small, large]);
  assert.equal(small.data.doors.east.big, false, 'explicit camera-specific artwork is preserved');

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
  await assert.rejects(load({ north: { clearance: 1 } }), /passage "north".*nav_map.png/);
  for (const value of [-1, 1.5, '1', null]) {
    await assert.rejects(load({ west: { clearance: value } }), /non-negative whole-number "clearance"/);
  }
  await assert.rejects(load({ west: { clearance: 1, panelOffset: { x: 2 } } }), /"panelOffset".*whole-number/);
  await assert.rejects(load({ west: { clearance: 1, offset: { x: 2, y: 3, z: 4 } } }), /"offset".*whole-number/);
  await assert.rejects(load({ west: { clearance: 1, colour: 'red' } }), /unknown property "colour"/);
  for (const big of [null, 1, 'true', {}]) {
    await assert.rejects(load({ west: { clearance: 1, big } }), /"big" must be true or false/);
  }
  assert.equal((await load({ west: { clearance: 1, big: false } })).doors.west.big, false);
  await assert.rejects(load({ west: { clearance: 1, big: true } }), /needs sim_assets\/props\/big_door_angle_level1.png/);
  const bigFile = path.join(assets, 'props', 'big_door_angle_level1.png');
  await cp(path.join(assets, 'props', 'big_door_angle_level3.png'), bigFile);
  assert.equal((await load({ west: { clearance: 1, big: true } })).doors.west.big, true);
  const bigPixels = await sharp(bigFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  bigPixels.data[3] = 255;
  await sharp(bigPixels.data, { raw: bigPixels.info }).png().toFile(bigFile);
  await assert.rejects(load({ west: { clearance: 1, big: true } }), /visible artwork at \(0, 0\) in row 1, outside crop/);
  await cp(path.join('src/sim_assets/props/big_door_angle_level3.png'), bigFile);
  const cleanBigPixels = await sharp(bigFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  cleanBigPixels.data.fill(0, 384 * cleanBigPixels.info.width * 4);
  await sharp(cleanBigPixels.data, { raw: cleanBigPixels.info }).png().toFile(bigFile);
  await assert.rejects(load({ west: { clearance: 1, big: true } }), /complete 192px cells.*broken frame in the third row/);
  await sharp({ create: { width: 96, height: 576, channels: 4, background: '#ff0000' } }).png().toFile(bigFile);
  await assert.rejects(load({ west: { clearance: 1, big: true } }), /complete 192px cells/);
  await assert.rejects(load({ west: { clearance: 99 } }), /needs sim_assets\/props\/door_angle_level99.png/);
  assert.equal((await load({ east: { clearance: 1 } })).doors.east.clearance, 1);
  const eastFile = path.join(assets, 'props', 'door_angle_level1_east.png');
  await rm(eastFile);
  await assert.rejects(load({ east: { clearance: 1 } }), /needs sim_assets\/props\/door_angle_level1_east.png/);
  await sharp({ create: { width: 96, height: 96, channels: 4, background: '#ff0000' } })
    .png().toFile(eastFile);
  await assert.rejects(load({ east: { clearance: 1 } }), /broken frame in the third row/);
  const panelFile = path.join(assets, 'props', 'door_panel_angle.png');
  const panelPixels = await sharp(panelFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  panelPixels.data.fill(0, 192 * panelPixels.info.width * 4, 288 * panelPixels.info.width * 4);
  await sharp(panelPixels.data, { raw: panelPixels.info }).png().toFile(panelFile);
  await assert.rejects(load({ west: { clearance: 1 } }), /broken frame in the third row/);
  await sharp({ create: { width: 96, height: 96, channels: 4, background: '#ff0000' } })
    .png().toFile(panelFile);
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
  assert.equal(doorAppearance('east', bounds, { clearance: 0 }).panelFlip, true);
  assert.equal(doorAppearance('west', bounds, { clearance: 0 }).panelFlip, false);
  assert.equal(doorAppearance('east', bounds, { clearance: 0 }).asset, 'door_angle_level0_east');
  assert.equal(doorAppearance('west', bounds, { clearance: 0 }).asset, 'door_angle_level0');
  assert.equal(doorAppearance('north', bounds, { clearance: 0 }).asset, 'door_level0');
  assert.equal(doorAppearance('north', bounds, { clearance: 0 }).panelAsset, 'door_panel');
});

for (const side of ['north', 'south', 'west', 'east']) test(`${side} big door bounds and panel placement match its larger crop`, () => {
  const bounds = { x: 100, y: 120, w: 100, h: 180 };
  const art = doorAppearance(side, bounds, { clearance: 3, big: true });
  const frame = passageDoorFrame(side, false, true);
  const broken = passageDoorFrame(side, true, true);
  assert.deepEqual(broken, { ...frame, y: frame.y + 384 });
  assert.equal(art.big, true);
  assert.equal(art.asset, `big_door_${side === 'west' || side === 'east' ? 'angle_' : ''}level3${side === 'east' ? '_east' : ''}`);
  const parts = passagePartBounds(side, art);
  assert.deepEqual(parts.door, { x: Math.round(bounds.x + (bounds.w - frame.w) / 2), y: 300 - frame.h, w: frame.w, h: frame.h });
  assert.deepEqual({ w: parts.panel.w, h: parts.panel.h }, side === 'west' || side === 'east' ? { w: 17, h: 84 } : { w: 20, h: 69 });
  assert.equal(parts.panel.x, side === 'south' ? art.x - parts.panel.w - 3 : art.x + frame.w + 3);
  assert.equal(parts.panel.y, 300 - parts.panel.h + (side === 'west' ? -frame.w - 4 : side === 'east' ? parts.panel.w + 2 : 0));
  const moved = doorAppearance(side, bounds, { clearance: 3, big: true, offset: { x: 3, y: -4 }, panelOffset: { x: -5, y: 8 } });
  assert.deepEqual(moved.panel, { x: art.panel.x - 2, y: art.panel.y + 4 });
});

test('big angled door crops contain all supplied artwork in the closed and broken rows', async () => {
  for (const side of ['west', 'east']) {
    const asset = `big_door_angle_level3${side === 'east' ? '_east' : ''}`;
    const { data, info } = await sharp(`src/sim_assets/props/${asset}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width % 192, 0);
    assert.equal(info.height, 576);
    for (const broken of [false, true]) {
      const frame = passageDoorFrame(side, broken, true);
      assert.deepEqual(frame, { x: 53, y: (broken ? 384 : 0) + 22, w: 86, h: 160 });
      let pixels = 0;
      for (let y = broken ? 384 : 0; y < (broken ? 576 : 192); y++) {
        for (let x = 0; x < 192; x++) {
          if (!data[(y * info.width + x) * 4 + 3]) continue;
          assert.ok(x >= frame.x && x < frame.x + frame.w && y >= frame.y && y < frame.y + frame.h, `${asset} artwork is not clipped`);
          pixels++;
        }
      }
      assert.ok(pixels > 0);
    }
  }
});

for (const { side, door, panel, flip } of [
  { side: 'north', door: { x: 100, y: 147 }, panel: { x: 149, y: 147 }, flip: false },
  { side: 'south', door: { x: 100, y: 147 }, panel: { x: 77, y: 147 }, flip: false },
  { side: 'west', door: { x: 110, y: 120 }, panel: { x: 139, y: 102 }, flip: false },
  { side: 'east', door: { x: 110, y: 120 }, panel: { x: 139, y: 151 }, flip: true },
]) test(`${side} door panel sits on an approaching character's right`, () => {
  const bounds = { x: 100, y: 120, w: 46, h: 96 };
  const art = doorAppearance(side, bounds, { clearance: 1 });
  assert.deepEqual({ x: art.x, y: art.y }, door, `${side} door stays aligned with its opening`);
  assert.deepEqual(art.panel, panel, `${side} panel follows the wall on the character's right`);
  assert.equal(art.panelFlip, flip, `${side} panel keeps its wall perspective`);
  const frame = passagePanelFrame(side, false, 0);
  assert.deepEqual(passagePartBounds(side, art).panel, { ...panel, w: frame.w, h: frame.h });

  const adjusted = doorAppearance(side, bounds, {
    clearance: 1, offset: { x: 3, y: -4 }, panelOffset: { x: -5, y: 8 },
  });
  assert.deepEqual({ x: adjusted.x, y: adjusted.y }, { x: door.x + 3, y: door.y - 4 });
  assert.deepEqual(adjusted.panel, { x: panel.x - 2, y: panel.y + 4 });
});

test('all east-facing door sheets fit the closed and broken door crops', async () => {
  for (let level = 0; level <= 5; level++) {
    const asset = `door_angle_level${level}_east`;
    const { data, info } = await sharp(`src/sim_assets/props/${asset}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width % 96, 0, asset);
    assert.ok(info.height >= 288 && info.height % 96 === 0, asset);
    for (const broken of [false, true]) {
      const frame = passageDoorFrame('east', broken);
      let pixels = 0;
      for (let y = frame.y; y < frame.y + frame.h; y++) {
        for (let x = 0; x < 96; x++) {
          if (!data[(y * info.width + x) * 4 + 3]) continue;
          assert.ok(x >= frame.x && x < frame.x + frame.w, `${asset} artwork is clipped outside the door crop`);
          pixels++;
        }
      }
      assert.ok(pixels > 0, `${asset} has ${broken ? 'broken' : 'closed'} artwork`);
    }
  }
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

test('big doors take two seconds to open and close without changing the hold time', () => {
  const state = new PassageDoor(1, true);
  assert.equal(state.motionSeconds, 2);
  state.update(true, 1);
  assert.equal(state.open, 0.5);
  state.update(true, 1);
  assert.equal(state.open, 1);
  state.update(false, PASSAGE_DOOR_HOLD_SECONDS);
  assert.equal(state.open, 1);
  assert.equal(state.unlocked, false);
  state.update(false, 1);
  assert.equal(state.open, 0.5);
  state.update(false, 1);
  assert.equal(state.open, 0);

  const normal = new PassageDoor(1);
  assert.equal(normal.motionSeconds, 0.7);
  normal.update(true, 0.7);
  assert.equal(normal.open, 1);
  normal.update(false, PASSAGE_DOOR_HOLD_SECONDS + 0.7);
  assert.equal(normal.open, 0);
});

test('linked doors use the slower timing if either camera has big artwork, regardless of room order', () => {
  for (const [eastBig, westBig] of [[true, false], [false, true], [true, true]]) {
    for (const reversed of [false, true]) {
      const aData = roomData('a', 0, 'east', 2, { room: 'b', door: 'west' });
      const bData = roomData('b', 1, 'west', 2, { room: 'a', door: 'east' });
      aData.doors.east.big = eastBig;
      bData.doors.west.big = westBig;
      const a = new Room(aData);
      const b = new Room(bData);
      const world = new World({ rooms: reversed ? [b, a] : [a, b], roster: [] });
      const east = a.doors[0];
      const west = b.doors[0];
      const state = world.passageDoorFor(east);
      assert.equal(state, world.passageDoorFor(west));
      assert.equal(state.motionSeconds, 2);
      const agent = stay(world, staff('2'), a, east.inside);
      world.update(1);
      assert.equal(state.open, 0.5);
      agent.room = b;
      agent.x = west.inside.x;
      agent.y = west.inside.y;
      world.update(1);
      assert.equal(state.open, 1, 'the other camera continues the same two-second animation');
    }
  }
});

test('each issued card opens exactly its level and lower door panels, including level zero', () => {
  for (let card = 0; card <= 5; card++) {
    for (let clearance = 0; clearance <= 5; clearance++) {
      const { world, a, east } = connectedRooms(clearance);
      const agent = stay(world, staff(String(card)), a, east.inside);
      assert.equal(world.canAgentUsePassage(agent, east), clearance <= card);
      world.update(PASSAGE_DOOR_SECONDS);
      assert.equal(world.passageDoorFor(east).open, clearance <= card ? 1 : 0,
        `card ${card}, door ${clearance}`);
    }
  }
  const { world, a, east } = connectedRooms(6);
  const admin = stay(world, staff('Admin'), a, east.inside);
  assert.equal(admin.inventory[0].type, 'card_admin');
  world.update(PASSAGE_DOOR_SECONDS);
  assert.equal(world.passageDoorFor(east).open, 1, 'Admin is not limited to level 5');
});

test('held agents do not activate panels; only Admin and impostors bypass clearance', () => {
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
  assert.equal(world.canAgentUsePassage(low, east), false, 'departure intent does not grant access');
  low.leaving = false;
  const mimic = stay(world, staff('0', 'mimic'), a, east.inside, { id: 'fake', name: 'Fake', nickname: '', href: '', weight: 1 });
  assert.equal(world.canAgentUsePassage(mimic, east), true, 'impostors retain their existing bypass');
});

test('a level-3 agent placed in the level-4 Trophy Room cannot open its door to leave', async () => {
  const rooms = (await loadFacility()).map((data) => new Room(data));
  const world = new World({ rooms, roster: [] });
  const room = world.room('level-4-trophy-room');
  const door = room.linkedDoors[0];
  const agent = stay(world, staff('3'), room, door.inside);
  const state = world.passageDoorFor(door);
  for (const hurry of [false, true]) {
    const plan = leaveFacility(agent, world, hurry);
    assert.equal(plan[0].activity, 'Waiting for an exit');
    agent.setPlan(world, plan);
    for (let i = 0; i < 10; i++) world.update(0.1);
    assert.equal(agent.room, room);
    assert.equal(agent.alpha, 1);
    assert.equal(agent.removed, false);
    assert.equal(state.open, 0);
    assert.equal(state.unlocked, false);
    assert.equal(agent.leaving, false, 'waiting for a permitted exit is not an active departure');
    assert.equal(agent.draggable, true, 'the player can rescue an agent with no exit route');
  }
  agent.setPlan(world, [exitThroughDoor(door)]);
  for (let i = 0; i < 10; i++) world.update(0.1);
  assert.equal(agent.room, room, 'an explicitly queued crossing cannot bypass access either');
  assert.equal(state.open, 0);
});

test('a departure interrupted by a relocked door restores pickup and cancels queued movement', () => {
  const { world, a, b, east } = connectedRooms(4);
  const state = world.passageDoorFor(east);
  state.update(true, PASSAGE_DOOR_SECONDS);
  state.breakPanel();
  const agent = stay(world, staff('3'), a, east.inside);
  const warnings = [];
  world.hooks.log = (message) => warnings.push(message);
  agent.leaving = true;
  agent.setPlan(world, [exitThroughDoor(east), exitThroughDoor(east)]);
  world.update(0.1);
  world.update(0.1);
  assert.ok(agent.alpha < 1, 'the agent has started crossing the stuck-open door');
  assert.equal(agent.draggable, false);
  state.repairPanel();
  state.open = 0.5;
  world.update(0.1);
  assert.equal(agent.room, a);
  assert.notEqual(agent.room, b);
  assert.deepEqual({ x: agent.x, y: agent.y, alpha: agent.alpha }, { ...east.inside, alpha: 1 });
  assert.equal(agent.leaving, false);
  assert.equal(agent.draggable, true, 'a failed departure must release the pickup lock');
  assert.ok(warnings.some((message) => message.includes('Access denied')));
  world.update(0.1);
  assert.equal(agent.draggable, true, 'queued transport must not restart after cancellation');
});

test('a door breaking during a planned departure releases the departure state', () => {
  const { world, a, east } = connectedRooms(4);
  const agent = stay(world, staff('4'), a, east.inside);
  const state = world.passageDoorFor(east);
  state.update(true, PASSAGE_DOOR_SECONDS);
  agent.leaving = true;
  agent.setPlan(world, [exitThroughDoor(east)]);
  world.update(0.1);
  world.update(0.1);
  assert.ok(agent.alpha < 1);
  state.break();
  world.update(0.1);
  assert.equal(agent.room, a);
  assert.equal(agent.alpha, 1);
  assert.equal(agent.leaving, false);
  assert.equal(agent.draggable, true);
});

test('a door closing in front of a crossing agent returns them to the threshold until it reopens', () => {
  const { world, a, b, east } = connectedRooms();
  const agent = world.spawn(staff('2', 'nagi', { speed: 0.2 }), a, east.inside);
  const state = world.passageDoorFor(east);
  agent.setPlan(world, [exitThroughDoor(east)]);
  for (let i = 0; i < 20 && agent.alpha === 1; i++) world.update(0.1);
  assert.ok(agent.alpha < 1, 'the agent has started crossing');
  state.open = 0.5;
  world.update(0);
  assert.deepEqual({ x: agent.x, y: agent.y, alpha: agent.alpha }, { ...east.inside, alpha: 1 },
    'nobody stays half-faded in a closing doorway');
  for (let i = 0; i < 300 && agent.room !== b; i++) world.update(0.1);
  assert.equal(agent.room, b, 'the authorized agent reopens the door and finishes crossing');
});

test('authorized agents walking through the doorway keep the door open behind the threshold', () => {
  const { world, a, east } = connectedRooms();
  east.outside = { x: east.inside.x + PASSAGE_DOOR_RANGE * 3, y: east.inside.y };
  const agent = stay(world, staff('2'), a, { x: east.inside.x + PASSAGE_DOOR_RANGE * 2, y: east.inside.y });
  world.update(PASSAGE_DOOR_SECONDS + PASSAGE_DOOR_HOLD_SECONDS + 1);
  assert.equal(world.passageDoorFor(east).open, 1);
  assert.equal(agent.room, a);
});

test('a door that never reopens makes the agent give up and become pickable again', (t) => {
  const { world, a, east } = connectedRooms();
  const agent = world.spawn(staff('2', 'nagi'), a, east.inside);
  const state = world.passageDoorFor(east);
  t.mock.method(state, 'update', () => undefined);
  const warnings = [];
  world.hooks.log = (message) => warnings.push(message);
  agent.leaving = true;
  agent.setPlan(world, [exitThroughDoor(east), exitThroughDoor(east)]);
  world.update(0.1);
  assert.equal(agent.draggable, false);
  for (let i = 0; i < 60; i++) world.update(0.1);
  assert.equal(agent.room, a);
  assert.equal(agent.alpha, 1);
  assert.equal(agent.leaving, false);
  assert.equal(agent.draggable, true, 'the stalled crossing releases the pickup lock');
  assert.ok(warnings.some((message) => message.includes('gave up waiting')));
});

test('a stranded agent waits by the door and slips out when someone else opens it', async (t) => {
  const rooms = (await loadFacility()).map((data) => new Room(data));
  const world = new World({ rooms, roster: [], now: () => new Date(2026, 0, 1, 19) });
  const trophy = world.room('level-4-trophy-room');
  const gallery = world.room('level-4-gallery');
  const door = trophy.linkedDoors[0];
  const nagi = world.spawn(staff('3', 'Nagi'), trophy, trophy.randomFloorPoint());
  const random = t.mock.method(Math, 'random', () => 0.5);
  const activities = () => new Set(Array.from({ length: 100 }, (_, i) => {
    random.mock.mockImplementation(() => (i + 0.5) / 100);
    const plan = planNext(nagi, world);
    nagi.leaving = false;
    return plan[0].activity;
  }));
  assert.ok(activities().has('Waiting for someone to open the door'));
  assert.ok(![...activities()].some((activity) => activity.startsWith('Heading')));

  const opener = stay(world, staff('4', 'Opener'), gallery, gallery.doors.find((d) => d.to?.room === trophy.id).inside);
  world.update(PASSAGE_DOOR_SECONDS);
  assert.equal(world.passageDoorFor(door).open, 1);
  random.mock.mockImplementation(() => 0.5);
  const plan = planNext(nagi, world);
  assert.equal(plan[0].activity, `Heading to the ${gallery.name}`);
  nagi.setPlan(world, plan);
  for (let i = 0; i < 200 && nagi.room === trophy; i++) world.update(0.1);
  assert.equal(nagi.room, gallery, 'Nagi used the open door');
  assert.equal(nagi.leaving, true, 'and keeps heading out of the facility');
  assert.ok(opener);
});

test('departure routing skips a locked shortcut and checks the final outer door', () => {
  const data = (id, links) => {
    const room = roomData(id, 0, 'west', undefined);
    room.nav.exits = Object.keys(links).map((id) => ({
      ...room.nav.exits[0], id,
    }));
    room.links = Object.fromEntries(Object.entries(links)
      .filter(([, { to }]) => to).map(([id, { to }]) => [id, to]));
    room.doors = Object.fromEntries(Object.entries(links).map(([id, { clearance }]) => [id, { clearance }]));
    return new Room(room);
  };
  const start = data('start', {
    shortcut: { clearance: 4, to: { room: 'exit', door: 'shortcut' } },
    detour: { clearance: 3, to: { room: 'detour', door: 'back' } },
  });
  const detour = data('detour', {
    back: { clearance: 3, to: { room: 'start', door: 'detour' } },
    onward: { clearance: 3, to: { room: 'exit', door: 'detour' } },
  });
  const exit = data('exit', {
    shortcut: { clearance: 4, to: { room: 'start', door: 'shortcut' } },
    detour: { clearance: 3, to: { room: 'detour', door: 'onward' } },
    outside: { clearance: 3 },
  });
  const world = new World({ rooms: [start, detour, exit], roster: [] });
  const agent = stay(world, staff('3'), start, start.doors[0].inside);
  for (const hurry of [false, true]) {
    assert.equal(leaveFacility(agent, world, hurry)[0].activity, 'Heading to the detour');
  }
  world.passageDoorFor(exit.outerDoors[0]).break();
  assert.equal(leaveFacility(agent, world)[0].activity, 'Waiting for an exit',
    'a route must end at a usable exit');
});

test('outer-door departures require an access card and authorized departures still work', () => {
  for (const level of ['3', '4']) {
    const room = new Room(roomData('exit', 4, 'west', 4));
    const world = new World({ rooms: [room], roster: [] });
    const door = room.outerDoors[0];
    const agent = stay(world, staff(level), room, door.inside);
    const plan = leaveFacility(agent, world);
    assert.equal(plan[0].activity, level === '3' ? 'Waiting for an exit' : 'Heading out');
    agent.setPlan(world, plan);
    for (let i = 0; i < 30 && !agent.removed; i++) world.update(0.1);
    assert.equal(agent.removed, level === '4');
    if (level === '3') assert.equal(world.passageDoorFor(door).open, 0);
  }
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

test('a low-clearance agent can slip through a door someone else opened, but not a closed one', () => {
  const { world, a, b, east } = connectedRooms();
  const state = world.passageDoorFor(east);
  const low = world.spawn(staff('1', 'low'), a, east.inside);
  const warnings = [];
  world.hooks.log = (message, tone) => warnings.push({ message, tone });
  low.setPlan(world, [exitThroughDoor(east)]);
  world.update(0.1);
  world.update(0.1);
  assert.equal(low.room, a);
  assert.equal(low.alpha, 1);
  assert.ok(warnings.some(({ message, tone }) => tone === 'warn' && message.includes('Access denied')));
  assert.equal(state.open, 0, 'a low card never opens the door itself');

  const high = stay(world, staff('2', 'high'), a, east.inside);
  world.update(PASSAGE_DOOR_SECONDS);
  assert.equal(state.open, 1);
  assert.equal(world.canAgentUsePassage(low, east), false, 'an open door does not authorize opening it');
  assert.equal(world.canAgentCross(low, east), true);
  low.setPlan(world, [exitThroughDoor(east)]);
  for (let i = 0; i < 50 && low.room !== b; i++) world.update(0.1);
  assert.equal(low.room, b, 'the low-clearance agent tailgates through');
  assert.equal(world.stepTowardWork(low.character, a), undefined, 'planned work routes still need a card');
  assert.equal(world.stepTowardWork(high.character, a), east);

  world.remove(high, 'test');
  for (let i = 0; i < 60 && (state.open > 0 || low.alpha < 1); i++) world.update(0.1);
  assert.equal(state.open, 0);
  low.room = a;
  low.leaving = true;
  world.transfer(low, east);
  assert.equal(low.room, a, 'direct transfers also respect a physical lock');
  assert.notEqual(low.room, b);
  assert.equal(low.leaving, false, 'a rejected direct transfer also clears departure intent');
  assert.equal(low.draggable, true);
});

test('the door does not close on someone in the doorway, even after they lose their card', () => {
  const { world, a, b, east } = connectedRooms();
  const agent = world.spawn(staff('2', 'slow', { speed: 0.05 }), a, east.inside);
  const state = world.passageDoorFor(east);
  agent.retrieveItem(agent.inventory[0]);
  agent.setPlan(world, [exitThroughDoor(east)]);
  world.update(PASSAGE_DOOR_SECONDS);
  world.update(0.1);
  assert.ok(agent.alpha < 1);
  agent.consumeItem();
  world.update(PASSAGE_DOOR_HOLD_SECONDS + PASSAGE_DOOR_SECONDS);
  assert.equal(state.open, 1, 'a body in the doorway holds it open');
  assert.equal(state.unlocked, false, 'without a card nearby the panel still relocks');
  for (let i = 0; i < 400 && agent.room !== b; i++) world.update(0.1);
  assert.equal(agent.room, b);
});

test('door access follows the best stored or held card, not the current profile', () => {
  const { world, a, east } = connectedRooms(3);
  const agent = world.spawn(staff('1'), a, east.inside);
  assert.equal(world.canAgentUsePassage(agent, east), false);
  const card = Item.create('card_level3');
  agent.receiveStoredItem(card);
  assert.equal(world.canAgentUsePassage(agent, east), true);
  assert.equal(world.stepTowardWork(agent.character, a, agent), east);
  agent.retrieveItem(card);
  assert.equal(world.canAgentUsePassage(agent, east), true);
  agent.dropItem();
  assert.equal(world.canAgentUsePassage(agent, east), false);
  assert.equal(world.stepTowardWork(agent.character, a, agent), undefined);
  agent.character.accessLevel = '5';
  assert.equal(world.canAgentUsePassage(agent, east), false, 'editing a profile does not mint a new card');
  agent.x = card.x + card.w / 2;
  agent.y = card.y + card.h;
  agent.pickUpItem(card);
  assert.equal(world.canAgentUsePassage(agent, east), true);
});

test('spawn loadouts authorize arrivals and lost cards stop proximity activation and direct transfers', () => {
  const room = new Room(roomData('entry', 0, 'west', 3));
  const world = new World({ rooms: [room], roster: [] });
  const door = room.doors[0];
  const agent = world.arriveByDoor({ ...staff('1'), startingItems: ['card_level3'] }, room, door);
  assert.deepEqual(agent.inventory.map((item) => item.type), ['card_level1', 'card_level3']);
  assert.equal(world.canAgentUsePassage(agent, door), true);

  const { world: connected, a, b, east } = connectedRooms(3);
  const high = stay(connected, staff('3'), a, east.inside);
  high.retrieveItem(high.inventory[0]);
  high.dropItem();
  connected.update(0.1);
  assert.equal(connected.passageDoorFor(east).unlocked, false);
  connected.transfer(high, east);
  assert.equal(high.room, a);
  assert.notEqual(high.room, b);
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

  world.remove(agent, 'test');
  for (let i = 0; i < 60 && world.passageDoorFor(door).open > 0; i++) world.update(0.1);
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

for (const big of [false, true]) for (const side of ['north', 'south', 'west', 'east']) test(`${side} ${big ? 'big ' : ''}renderer slides the door and selects the panel state`, (t) => {
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
        const drawFlips = [];
        const drawAlphas = [];
        const drawOrigins = [];
        const gradients = [];
        const gradientCenters = [];
        const stack = [];
        let flipped = false;
        let originX = 0;
        let originY = 0;
        const ctx = {
          globalAlpha: 1,
          drawImage(...args) {
            draws.push(args);
            drawFlips.push(flipped);
            drawAlphas.push(this.globalAlpha);
            drawOrigins.push([originX, originY]);
          },
          getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4).fill(255) }; },
          putImageData() {}, clearRect() {}, setTransform() {}, fillRect() {},
          save() { stack.push({ flipped, alpha: this.globalAlpha, originX, originY }); },
          restore() {
            const state = stack.pop();
            flipped = state.flipped;
            this.globalAlpha = state.alpha;
            originX = state.originX;
            originY = state.originY;
          },
          translate(x, y) { originX += x; originY += y; },
          scale(x) { if (x < 0) flipped = !flipped; },
          createRadialGradient(x, y) {
            const stops = [];
            gradients.push(stops);
            gradientCenters.push([x, y]);
            return { addColorStop(...args) { stops.push(args); } };
          },
        };
        const canvas = { width: 0, height: 0, draws, drawFlips, drawAlphas, drawOrigins, gradients, gradientCenters, getContext() { return ctx; } };
        canvases.push(canvas);
        return canvas;
      },
    },
  });
  const data = roomData('entry', 0, side, 0);
  data.doors[side].big = big;
  const room = new Room(data);
  const world = new World({ rooms: [room], roster: [] });
  const door = room.doors[0];
  const agent = stay(world, staff('0'), room, { x: 30, y: 80 });
  const image = { width: big ? 384 : 192, height: big ? 768 : 384 };
  const panel = { width: 192, height: 384 };
  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas, {
    character: { width: 576, height: 1152 }, 'room:entry': {},
    [door.appearance.asset]: image, [door.appearance.panelAsset]: panel,
  }, room);
  const mask = canvases.find((candidate) => candidate.width === 96 && candidate.height === 96);
  renderer.draw(world, new Map());
  const frame = passageDoorFrame(side, false, big);
  const sideWall = side === 'west' || side === 'east';
  const panelFrame = passagePanelFrame(side, false, 0);
  const doorIndex = canvas.draws.findIndex((draw) => draw[0] === mask);
  const panelIndex = canvas.draws.findIndex((draw) => draw[0] === panel);
  const characterIndex = canvas.draws.findIndex((draw) => draw[0] === renderer.sheet(1).normal);
  assert.ok(characterIndex >= 0);
  assert.equal(doorIndex > characterIndex, side === 'south', 'only south doors cover characters');
  assert.equal(panelIndex > characterIndex, side === 'south', 'panels follow the same layering as their door');
  assert.equal(canvas.drawAlphas[doorIndex], side === 'south' ? 0.35 : 1);
  assert.equal(canvas.drawAlphas[panelIndex], side === 'south' ? 0.35 : 1);
  assert.equal(canvas.drawAlphas[characterIndex], 1, 'door transparency does not leak to characters');
  assert.equal(canvas.getContext().globalAlpha, 1, 'door and glow opacity are restored');
  assert.equal(renderer.hitTest(world, agent.x, agent.y - 20), agent, 'characters remain selectable through foreground doors');
  assert.deepEqual(mask.draws[0], [image, frame.x, frame.y, frame.w, frame.h, 0, -0, frame.w, frame.h]);
  assert.deepEqual(mask.draws[1], [image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h], 'closed silhouette masks the moving panel');
  assert.deepEqual(canvas.draws[panelIndex].slice(1, 5), [panelFrame.x, panelFrame.y, panelFrame.w, panelFrame.h]);
  const panelPosition = side === 'east' ? [0, 0] : [door.appearance.panel.x, door.appearance.panel.y];
  assert.deepEqual(canvas.draws[panelIndex].slice(5), [...panelPosition, panelFrame.w, panelFrame.h], 'panel artwork uses the configured position');
  assert.deepEqual(canvas.drawOrigins[panelIndex], side === 'east'
    ? [door.appearance.panel.x + panelFrame.w, door.appearance.panel.y] : [0, 0], 'the mirrored panel is anchored at the configured position');
  assert.equal(canvas.drawFlips[canvas.draws.findIndex((draw) => draw[0] === mask)], false, 'door artwork is never mirrored');
  assert.equal(canvas.drawFlips[canvas.draws.findIndex((draw) => draw[0] === panel)], side === 'east', 'only the east panel is mirrored');
  assert.deepEqual(canvas.gradientCenters[0], [
    door.appearance.panel.x + (sideWall ? side === 'east' ? 9 : 8 : 9.5),
    door.appearance.panel.y + (sideWall ? 17 : 9.5),
  ], 'the indicator glow follows the panel orientation');
  assert.ok(canvas.gradients[0][0][1].includes('255, 35, 65'), 'locked panel glows red');

  const state = world.passageDoorFor(door);
  state.update(true, state.motionSeconds / 2);
  world.time = DOOR_PANEL_FRAME_SECONDS;
  renderer.draw(world, new Map());
  assert.equal(mask.draws[2][6], -Math.round(frame.h / 2), 'half-open door slides upward');
  assert.deepEqual(canvas.draws.filter((draw) => draw[0] === panel).at(-1).slice(1, 5), [135, sideWall ? 288 : 302, panelFrame.w, panelFrame.h]);
  assert.ok(canvas.gradients.at(-1)[0][1].includes('40, 255, 115'), 'unlocked panel glows green');

  state.breakPanel();
  const glows = canvas.gradients.length;
  renderer.draw(world, new Map());
  assert.deepEqual(canvas.draws.filter((draw) => draw[0] === panel).at(-1).slice(1, 5), [39, sideWall ? 192 : 206, panelFrame.w, panelFrame.h]);
  assert.equal(canvas.gradients.length, glows, 'a broken panel does not emit a working indicator glow');
  assert.equal(mask.draws.at(-2)[6], -Math.round(frame.h / 2), 'panel damage preserves the door position');

  state.break();
  renderer.draw(world, new Map());
  const brokenFrame = passageDoorFrame(side, true, big);
  assert.deepEqual(mask.draws.at(-2), [image, brokenFrame.x, brokenFrame.y, frame.w, frame.h, 0, -0, frame.w, frame.h]);
  assert.equal(canvas.drawFlips[canvas.draws.findLastIndex((draw) => draw[0] === mask)], false, 'broken artwork is not mirrored');
});

for (const big of [false, true]) test(`${big ? 'big ' : ''}door hold time is independent of update step size`, () => {
  const state = new PassageDoor(1, big);
  state.update(true, state.motionSeconds);
  state.update(false, PASSAGE_DOOR_HOLD_SECONDS + state.motionSeconds / 2);
  assert.equal(state.unlocked, false);
  assert.ok(Math.abs(state.open - 0.5) < 1e-9);
});

test('doors and panels each have an independent, exclusive 1% break-on-use chance', (t) => {
  const state = new PassageDoor(1);
  let roll = 0;
  t.mock.method(Math, 'random', () => roll);
  const counts = { door: 0, panel: 0 };
  for (let i = 0; i < 10000; i++) {
    roll = i / 10000;
    for (const component of state.breakOnUse()) counts[component]++;
    state.repair();
    state.repairPanel();
  }
  assert.deepEqual(counts, { door: 100, panel: 100 });
  roll = 0.01;
  assert.deepEqual(state.breakOnUse(), []);
  roll = 0;
  assert.deepEqual(state.breakOnUse(), ['panel', 'door']);
  const random = t.mock.method(Math, 'random', () => assert.fail('broken assemblies do not roll'));
  assert.deepEqual(state.breakOnUse(), []);
  assert.equal(random.mock.callCount(), 0);
});

test('broken panels freeze the exact door position and door damage always forces it closed', () => {
  for (const open of [0, 0.5, 1]) {
    const state = new PassageDoor(1);
    state.update(true, open * PASSAGE_DOOR_SECONDS);
    assert.equal(state.breakPanel(), true);
    assert.equal(state.breakPanel(), false);
    for (const nearby of [true, false]) state.update(nearby, 100);
    assert.equal(state.open, open);
    assert.equal(state.unlocked, false);
    assert.equal(state.blocked, open < 1);
    assert.equal(state.stuckOpen, open === 1);
    assert.equal(state.break(), true);
    assert.equal(state.open, 0);
    state.update(true, 100);
    assert.equal(state.open, 0);
    assert.equal(state.stuckOpen, false);
    state.repairPanel();
    state.update(true, 100);
    assert.equal(state.open, 0, 'panel repair does not repair the door');
    state.breakPanel();
    state.repair();
    state.update(true, 100);
    assert.equal(state.open, 0, 'door repair does not repair the panel');
    state.repairPanel();
    state.update(true, PASSAGE_DOOR_SECONDS);
    assert.equal(state.open, 1);
  }
});

test('each authorized approach rolls once, not every tick or on crossing between cameras', (t) => {
  const { world, a, b, east, west } = connectedRooms();
  const state = world.passageDoorFor(east);
  const use = t.mock.method(state, 'breakOnUse', () => []);
  const agent = stay(world, staff('2'), a, east.inside);
  for (let i = 0; i < 10; i++) world.update(0.1);
  assert.equal(use.mock.callCount(), 1);
  agent.room = b;
  agent.x = west.inside.x;
  agent.y = west.inside.y;
  world.update(0.1);
  assert.equal(use.mock.callCount(), 1);
  agent.x += PASSAGE_DOOR_RANGE + 1;
  world.update(0.1);
  agent.x = west.inside.x;
  world.update(0.1);
  assert.equal(use.mock.callCount(), 2);
  stay(world, staff('0', 'denied'), a, east.inside);
  world.update(0.1);
  assert.equal(use.mock.callCount(), 2, 'unauthorized approaches do not use the panel');
});

test('an approaching agent can break an open panel, allowing unauthorized crossing in either direction', (t) => {
  const { world, a, b, east, west } = connectedRooms();
  stay(world, staff('2', 'high'), a, east.inside);
  world.update(PASSAGE_DOOR_SECONDS);
  const state = world.passageDoorFor(east);
  assert.equal(state.open, 1);
  const logs = [];
  world.hooks.log = (text, tone) => logs.push({ text, tone });
  let roll = 0;
  t.mock.method(Math, 'random', () => roll++ === 0 ? 0 : 0.5);
  const other = stay(world, staff('2', 'other'), b, west.inside);
  world.update(0.1);
  assert.equal(state.panelBroken, true);
  assert.equal(state.broken, false);
  assert.equal(state.open, 1);
  assert.equal(other.bubble, '!');
  assert.ok(logs.some(({ text, tone }) => tone === 'warn' && text.includes('panel')));
  const low = world.spawn(staff('0', 'low'), a, east.inside);
  assert.equal(world.canAgentUsePassage(low, east), true);
  assert.equal(world.canUsePassage(low.character, west), true);
  for (const [door, destination] of [[east, b], [west, a]]) {
    low.setPlan(world, [exitThroughDoor(door)]);
    for (let i = 0; i < 50 && low.room !== destination; i++) world.update(0.1);
    assert.equal(low.room, destination);
    for (let i = 0; i < 20 && low.alpha < 1; i++) world.update(0.1);
    assert.equal(low.alpha, 1);
  }
});

test('broken doors block transfer, routing, arrivals, and clearance bypasses in both views', () => {
  const { world, a, b, east, west } = connectedRooms();
  const state = world.passageDoorFor(east);
  state.update(true, PASSAGE_DOOR_SECONDS);
  state.break();
  assert.equal(world.passageDoorFor(west).broken, true);
  const agent = world.spawn(staff('Admin'), a, east.inside, { id: 'fake' });
  agent.leaving = true;
  assert.equal(world.canAgentUsePassage(agent, east), false);
  assert.equal(world.canUsePassage(agent.character, west), false);
  world.transfer(agent, east);
  assert.equal(agent.room, a);
  assert.equal(world.stepTowardWork(staff('2'), a), undefined);
  assert.throws(() => world.arriveByDoor(staff('Admin'), b, west, { id: 'fake' }), /blocked/);
  agent.setPlan(world, [exitThroughDoor(east)]);
  for (let i = 0; i < 20; i++) world.update(0.1);
  assert.equal(agent.room, a);
  assert.equal(agent.alpha, 1);
  assert.equal(state.open, 0);
});

test('voluntary plans allow unauthorized wandering through a panel stuck open', (t) => {
  const { world, a, east } = connectedRooms();
  const agent = stay(world, staff('0'), a, east.inside);
  const state = world.passageDoorFor(east);
  world.time = 30;
  const random = t.mock.method(Math, 'random', () => 0.5);
  const canChooseCrossing = () => {
    for (let i = 0; i < 100; i++) {
      random.mock.mockImplementation(() => (i + 0.5) / 100);
      if (planNext(agent, world).some((task) => task.transport)) return true;
    }
    return false;
  };
  assert.equal(canChooseCrossing(), false);
  state.update(true, PASSAGE_DOOR_SECONDS);
  state.breakPanel();
  assert.equal(canChooseCrossing(), true, 'the destination floor check does not override the failed panel');
  state.break();
  assert.equal(canChooseCrossing(), false);
});

test('blocked outer exits are avoided without allowing staff to escape through walls', () => {
  const room = new Room(roomData('entry', 0, 'west', 2));
  const world = new World({ rooms: [room], roster: [] });
  const door = room.doors[0];
  world.passageDoorFor(door).break();
  const agent = stay(world, staff('2'), room, door.inside);
  const plan = leaveFacility(agent, world);
  assert.equal(plan[0].activity, 'Waiting for an exit');
  agent.setPlan(world, plan);
  world.update(0.1);
  assert.equal(agent.removed, false);
  assert.equal(agent.alpha, 1);
  assert.equal(world.doorTowardExit(room), null);
});

test('broken artwork uses third-row crops and only populated panel columns', async () => {
  for (const [side, asset] of [['west', 'door_panel_angle'], ['north', 'door_panel']]) {
    const { propCellOccupancy } = await import('../src/lib/sim/sprites.ts');
    const { data, info } = await sharp(`src/sim_assets/props/${asset}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const image = { ...info, propCells: propCellOccupancy(info, data) };
    const populated = image.propCells[2].flatMap((filled, column) => filled ? [column] : []);
    assert.ok(populated.length < image.propCells[2].length, `${asset} has an empty broken column to skip`);
    for (let i = 0; i < 4; i++) {
      const frame = passagePanelFrame(side, true, i * DOOR_PANEL_FRAME_SECONDS, true, image);
      assert.equal(Math.floor(frame.y / 96), 2);
      assert.equal(Math.floor(frame.x / 96), populated[i % populated.length]);
    }
    assert.equal(Math.floor(passageDoorFrame(side, true).y / 96), 2);
  }
});

test('debug editor selects passage doors and panels and breaks or repairs them live in both views', () => {
  const { world, a, b, east, west } = connectedRooms();
  const changes = [];
  const editor = new PropEditor({}, a, () => changes.push(1), (door) => world.passageDoorFor(door));
  const state = world.passageDoorFor(east);
  const bounds = passagePartBounds(east.side, east.appearance);
  const centre = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

  editor.pointerDown(centre(bounds.panel));
  assert.equal(editor.selected, null);
  assert.deepEqual([editor.selectedDoor?.door, editor.selectedDoor?.part], [east, 'panel']);
  assert.equal(editor.key({ key: 'b' }), true);
  assert.equal(state.panelBroken, true);
  assert.equal(state.broken, false);
  editor.toggleBroken();
  assert.equal(state.panelBroken, false);

  editor.pointerDown(centre(bounds.door));
  assert.equal(editor.selectedDoor?.part, 'door');
  editor.toggleBroken();
  assert.equal(state.broken, true);
  assert.equal(world.passageDoorFor(west).broken, true);
  assert.equal(editor.isEdited(), false);
  assert.match(editor.snippet(), /"props": \[\]/);

  editor.setRoom(b);
  assert.equal(editor.selectedDoor, null);
  editor.pointerDown(centre(passagePartBounds(west.side, west.appearance).door));
  editor.toggleBroken();
  assert.equal(state.broken, false);

  editor.pointerDown({ x: 70, y: 99 });
  assert.equal(editor.selectedDoor, null);
  assert.ok(changes.length > 0);
});
