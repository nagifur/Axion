import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadFacility } from '../src/lib/sim/roomLoader.ts';
import { Room } from '../src/lib/sim/room.ts';
import { World } from '../src/lib/sim/world.ts';

const staff = (id, accessLevel = '3') => ({
  id, name: id, href: '', tint: '#fff', scale: 1, position: 'Test', species: 'Human',
  accessLevel, employeeID: id, traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});

test('ten independent cells share the template and connect to their matching doors', async () => {
  const data = await loadFacility();
  const cells = data.filter((room) => room.containmentCell);
  assert.equal(cells.length, 10);
  const rooms = data.map((room) => new Room(room));
  const world = new World({ rooms, roster: [] });
  const hall = world.room('level-3-heavy-containment-room');
  for (const [index, cellData] of cells.entries()) {
    const number = index + 1;
    const id = `level-3-heavy-cell-${String(number).padStart(2, '0')}`;
    const cell = world.room(id);
    const hallDoor = hall.doors.find((door) => door.id === `north-${number}`);
    const cellDoor = cell.doors.find((door) => door.id === 'south');
    assert.equal(cellData.templateId, 'level-3-heavy-cell');
    assert.equal(cellData.cameraGroup, 'Heavy Containment Cells');
    assert.equal(cellData.map, undefined);
    assert.deepEqual(hallDoor.to, { room: id, door: 'south' });
    assert.deepEqual(cellDoor.to, { room: hall.id, door: hallDoor.id });
    assert.equal(world.passageDoorFor(hallDoor), world.passageDoorFor(cellDoor));
    assert.deepEqual(cell.cell, { creatureId: null });
  }
  const first = world.room('level-3-heavy-cell-01');
  const second = world.room('level-3-heavy-cell-02');
  first.cell.creatureId = 'future-creature';
  assert.equal(second.cell.creatureId, null);
  world.passageDoorFor(first.doors[0]).break();
  assert.equal(world.passageDoorFor(second.doors[0]).broken, false);
  assert.notEqual(cells[0].nav, cells[1].nav);
  assert.equal(new Room(cells[0]).cell.creatureId, null, 'a new session starts unassigned');
});

test('identical props in different cell instances have independent seats', async () => {
  const cells = (await loadFacility()).filter((data) => data.containmentCell).map((data) => new Room(data));
  const [first, second] = cells;
  const chair = { type: 'chair', asset: 'chair', x: 150, y: 130, w: 59, h: 58, flip: false };
  first.setProps([chair]);
  second.setProps([chair]);
  const world = new World({ rooms: cells, roster: [] });
  const agent = world.spawn(staff('seated'), first, first.randomFloorPoint());
  agent.spot = first.spots[0];
  assert.equal(first.spots[0].id, second.spots[0].id);
  assert.equal(world.freeSpot(first, 'chair'), undefined);
  assert.equal(world.freeSpot(second, 'chair'), second.spots[0]);
});

test('cell doors enforce access and transfer in both directions', async () => {
  const world = new World({ rooms: (await loadFacility()).map((data) => new Room(data)), roster: [] });
  const hall = world.room('level-3-heavy-containment-room');
  const cell = world.room('level-3-heavy-cell-01');
  const door = hall.doors.find((candidate) => candidate.id === 'north-1');
  const denied = world.spawn(staff('denied', '2'), hall, door.inside);
  world.transfer(denied, door);
  assert.equal(denied.room, hall);
  const allowed = world.spawn(staff('allowed'), hall, door.inside);
  world.transfer(allowed, door);
  assert.equal(allowed.room, cell);
  world.transfer(allowed, cell.doors[0]);
  assert.equal(allowed.room, hall);
});

test('cells do not increase staff population or become initial work and spawn rooms', async () => {
  const rooms = (await loadFacility()).map((data) => new Room(data));
  const roster = Array.from({ length: 60 }, (_, i) => staff(`staff-${i}`));
  const now = () => new Date(2026, 0, 1, 12);
  const world = new World({ rooms, roster, now });
  const withoutCells = new World({ rooms: rooms.filter((room) => !room.cell), roster, now });
  assert.equal(world.targetPopulation(), withoutCells.targetPopulation());
  assert.ok(world.workRooms(roster[0]).every((room) => !room.cell));
  world.populate();
  assert.ok(world.agents.length);
  assert.ok(world.agents.every((agent) => !agent.room.cell));
});

test('instance configuration rejects duplicates and misplaced exits', async (t) => {
  const assets = await mkdtemp(path.join(tmpdir(), 'axion-cells-'));
  t.after(() => rm(assets, { recursive: true, force: true }));
  const folder = path.join(assets, 'rooms', 'template');
  await mkdir(folder, { recursive: true });
  for (const file of ['room.png', 'nav_map.png']) {
    await copyFile(path.join('src/sim_assets/rooms/level-3-heavy-cell', file), path.join(folder, file));
  }
  const json = {
    name: 'Cell', level: 3, camera: 'Template', cameraGroup: 'Cells',
    restroom: true,
    instances: [{ id: 'cell-01', name: 'Cell 01', camera: 'CAM 1' }],
  };
  const write = () => writeFile(path.join(folder, 'room.json'), JSON.stringify(json));
  await write();
  const data = await loadFacility(assets);
  assert.deepEqual(data.map((room) => room.id), ['cell-01']);
  assert.equal(new Room(data[0]).restroom, true);
  json.restroom = 'yes';
  await write();
  await assert.rejects(loadFacility(assets), /"restroom" must be true or false/);
  json.restroom = true;
  json.instances.push({ ...json.instances[0] });
  await write();
  await assert.rejects(loadFacility(assets), /Duplicate room ID "cell-01"/);
  json.instances.pop();
  json.exits = {};
  await write();
  await assert.rejects(loadFacility(assets), /put "exits" on each instance/);
  delete json.exits;
  delete json.cameraGroup;
  await write();
  await assert.rejects(loadFacility(assets), /non-empty array and a "cameraGroup"/);
});
