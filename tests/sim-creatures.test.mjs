import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { seededRandom, setRandomSource } from '../src/lib/sim/random.ts';
import { toSimCharacter, toSimCreature } from '../src/lib/sim/roster.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadFacility } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';
import { FacilityEventDirector } from '../src/lib/sim/facilityEvents.ts';
import { CHARACTER_FRAMES, frameWithIdleFallback } from '../src/lib/sim/sprites.ts';

const data = { title: 'C-100', nickname: 'Echo', containmentClass: 'Containment', type: 'Creature', species: 'Lizard' };
const profile = (id) => toSimCreature({ id, data });
const room = (id, cell = true, props = []) => new Room({
  id, name: id, camera: id, level: 3, width: 240, height: 160, containmentCell: cell,
  nav: { floor: Array.from({ length: 160 }, () => [0, 240]), exits: [] }, props, links: {},
});
const seed = (t, n) => {
  setRandomSource(seededRandom(n));
  t.after(() => setRandomSource(null));
};

test('entity eligibility uses profile type and containment class, independent of shapeshifting or wanted flags', () => {
  const convert = (changes) => toSimCreature({ id: 'custom.md', data: { ...data, ...changes } }, '/base', 'portrait.webp');
  assert.deepEqual(convert({ type: ' creature ', height: '1.9 m', colorTint: '#abcdef', wanted: { status: 'Escaped' } }), {
    id: 'custom', name: 'C-100', nickname: 'Echo', containmentClass: 'Containment', species: 'Lizard',
    href: '/base/Entities/custom', image: 'portrait.webp', tint: '#abcdef', scale: 1,
  });
  for (const containmentClass of ['Ally', ' A ', 'Class A', 'Class A - Ally']) assert.equal(convert({ containmentClass }), null);
  for (const type of ['Artifact', 'Plant']) assert.equal(convert({ type }), null);
});

test('assignments sample both lists without replacement, only once per world', (t) => {
  seed(t, 482);
  const roster = ['one', 'two', 'three'].map(profile);
  const make = (count) => new World({ rooms: [room('hall', false), ...Array.from({ length: count }, (_, i) => room(`cell-${i}`))],
    roster: [], creatureRoster: roster });
  assert.deepEqual(make(0).creatures, []);
  const full = make(5);
  assert.equal(full.creatures.length, 3);
  const snapshot = full.rooms.map((r) => r.cell?.creatureId);
  full.populate();
  full.populate();
  assert.deepEqual(full.rooms.map((r) => r.cell?.creatureId), snapshot);
  assert.equal(snapshot.filter((id) => id === null).length, 2);
  assert.equal(full.presentCount(), 0);
  assert.equal(full.targetPopulation(), 0);
  assert.deepEqual(full.everyone(), []);

  const draws = new Set();
  for (let session = 0; session < 30; session++) {
    const limited = make(2);
    const ids = limited.rooms.filter((r) => r.cell).map((r) => {
      const [resident] = limited.actorsIn(r);
      assert.deepEqual(limited.agentsIn(r), []);
      assert.equal(resident.room, r);
      assert.equal(resident.character.id, r.cell.creatureId);
      return r.cell.creatureId;
    });
    assert.equal(new Set(ids).size, 2);
    draws.add(ids.join(','));
  }
  assert.ok(draws.size > 3, 'both the subset and its room order can change');
  assert.deepEqual(roster.map(({ id }) => id), ['one', 'two', 'three']);
});

test('residents pace around furniture, rest and observe, without using staff tasks or exits', (t) => {
  seed(t, 222);
  const home = room('cell', true, [
    { type: 'chair', asset: 'chair', x: 100, y: 65, w: 59, h: 58, flip: false },
    { type: 'light', asset: 'light', x: 0, y: 0, w: 40, h: 17, flip: false, start: { on: false } },
  ]);
  home.doors.push({ id: 'south', side: 'south', inside: { x: 120, y: 156 }, outside: { x: 120, y: 190 } });
  const world = new World({ rooms: [home], roster: [], creatureRoster: [profile('one')] });
  const [resident] = world.creatures;
  const start = [resident.x, resident.y];
  const activities = new Set();
  let moved = false;
  for (let i = 0; i < 1800; i++) {
    world.update(0.1);
    assert.ok(home.isWalkable(resident));
    assert.equal(resident.room, home);
    moved ||= Math.hypot(resident.x - start[0], resident.y - start[1]) > 5;
    activities.add(resident.activity);
  }
  assert.deepEqual(activities, new Set(['Pacing the cell', 'Resting', 'Watching the cell']));
  assert.ok(moved);
  assert.equal(home.darkness, 0, 'a resident keeps occupancy-controlled lights on');
  assert.deepEqual(world.agents, []);
});

for (const sheet of ['creatures/creature', 'characters/security']) test(`missing poses fall back to painted pixels in the ${sheet} sheet`, async () => {
  const { data, info: { width } } = await sharp(`src/sim_assets/${sheet}_spritesheet.png`)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const painted = ({ x, y, w, h }) => {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) if (data[(row * width + col) * 4 + 3]) return true;
    }
    return false;
  };
  for (const [name, cell] of Object.entries(CHARACTER_FRAMES)) {
    const frame = frameWithIdleFallback(name, painted);
    assert.ok(painted(frame), name);
    if (painted(cell)) assert.equal(frame, cell);
  }
  const only = (...frames) => (frame) => frames.includes(frame);
  const { idleRight2, idleFront1, walkRight4 } = CHARACTER_FRAMES;
  assert.equal(frameWithIdleFallback('walkRight4', only(idleFront1, idleRight2)), idleRight2);
  assert.equal(frameWithIdleFallback('walkRight4', only(idleFront1, idleRight2, walkRight4)), walkRight4);
});

test('a failed impostor arrival does not vacate the cell or spawn an extra employee', () => {
  const world = new World({ rooms: [room('home'), room('sealed', false)], roster: [], creatureRoster: [profile('shape')] });
  const employee = { id: 'test', position: '', behavior: {}, accessLevel: '3' };
  assert.equal(world.arrive(employee, { ...profile('shape'), weight: 1 }), undefined);
  assert.equal(world.creatures[0].away, false);
  assert.deepEqual(world.agents, []);
});

test('a disguised shapeshifter vacates its reserved cell, including between floors, and returns on removal', async (t) => {
  seed(t, 60);
  const residentProfile = profile('shape');
  const rooms = (await loadFacility()).map((data) => new Room(data));
  const world = new World({ rooms, roster: [], creatureRoster: [residentProfile] });
  const [original] = world.creatures;
  const home = original.room;
  const hall = world.room('level-3-main-entrance');
  const employee = toSimCharacter({ id: 'employee', data: {
    title: 'Employee', species: 'Human', height: '', position: '', accessLevel: '3', employeeID: '1',
    positiveTraits: [], negativeTraits: [],
  } });
  const director = new FacilityEventDirector([{ ...residentProfile, weight: 1 }]);
  world.spawn(employee, hall, hall.randomFloorPoint());
  assert.ok(director.triggerImpostor(world));
  const disguise = world.agents.find((agent) => agent.impostor);
  assert.equal(disguise.impostor.id, home.cell.creatureId);
  assert.deepEqual(world.actorsIn(home), []);
  assert.equal(original.activity, 'Away from cell');
  const destination = world.room(disguise.room === hall ? 'level-0-main-entrance' : hall.id);
  world.elevatorDeparted(disguise, destination);
  assert.ok(world.isRiding(disguise));
  assert.deepEqual(world.actorsIn(home), []);
  assert.equal(director.triggerImpostor(world), false, 'cannot spawn another impostor during a ride');
  world.update(20);
  assert.equal(world.isRiding(disguise), false);
  assert.ok(world.actorsIn(destination).includes(disguise));
  assert.deepEqual(world.actorsIn(home), []);
  world.remove(disguise, 'elevator');
  assert.deepEqual(world.actorsIn(home), [original]);
  assert.equal(original.room.cell.creatureId, residentProfile.id);
  assert.notEqual(original.activity, 'Away from cell');
});
