import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, leaveFacility, planNext } from '../src/lib/sim/agent.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadFacility } from '../src/lib/sim/roomLoader.ts';
import { DEFAULT_SCHEDULE, SCHEDULE_OVERRIDES, scheduleAt, scheduleFor } from '../src/lib/sim/schedule.ts';
import { World } from '../src/lib/sim/world.ts';

const at = (hour, minute = 0) => new Date(2026, 0, 1, hour, minute);
const character = (accessLevel = '3', id = 'staff') => ({
  id, name: id, species: 'Human', scale: 1, accessLevel, weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});
const makeRoom = (id, level, props = []) => new Room({
  id, name: id, camera: id, level, width: 120, height: 80,
  nav: { floor: Array.from({ length: 80 }, () => [0, 120]), exits: [] },
  props: [{ type: 'light', asset: 'light', x: 0, y: 0, w: 40, h: 17, flip: false }, ...props],
  links: {},
});
const connect = (from, to) => {
  const door = {
    id: `to-${to.id}`, side: 'east', inside: { x: 100, y: 40 }, outside: { x: 119, y: 40 },
    to: { room: to.id, door: `to-${from.id}` },
  };
  from.doors.push(door);
  to.doors.push({
    id: `to-${from.id}`, side: 'west', inside: { x: 20, y: 40 }, outside: { x: 0, y: 40 },
    to: { room: from.id, door: door.id },
  });
  return door;
};

test('shared routine covers work, exact break boundaries, lunch, and free time', () => {
  for (const [hour, minute, expected] of [
    [0, 0, 'free'], [7, 59, 'free'], [8, 0, 'work'], [9, 59, 'work'],
    [10, 0, 'break'], [10, 14, 'break'], [10, 15, 'work'],
    [11, 59, 'work'], [12, 0, 'lunch'], [12, 59, 'lunch'], [13, 0, 'work'],
    [15, 0, 'break'], [15, 14, 'break'], [15, 15, 'work'],
    [16, 59, 'work'], [17, 0, 'free'], [23, 59, 'free'],
  ]) assert.equal(scheduleAt(DEFAULT_SCHEDULE, at(hour, minute)), expected, `${hour}:${minute}`);
});

test('custom schedules cross midnight and first matching block takes priority', () => {
  const schedule = [
    { start: '02:00', end: '02:15', period: 'break' },
    { start: '22:00', end: '06:00', period: 'work' },
  ];
  for (const hour of [22, 23, 0, 1, 3, 5]) assert.equal(scheduleAt(schedule, at(hour)), 'work');
  assert.equal(scheduleAt(schedule, at(2)), 'break');
  assert.equal(scheduleAt(schedule, at(2, 15)), 'work');
  assert.equal(scheduleAt(schedule, at(6)), 'free');
  assert.equal(scheduleAt([], at(9)), 'free');
});

test('per-character overrides replace the shared routine without affecting others', (t) => {
  t.after(() => { delete SCHEDULE_OVERRIDES.staff; });
  SCHEDULE_OVERRIDES.staff = [{ start: '22:00', end: '06:00', period: 'work' }];
  assert.equal(scheduleFor(character(), at(9)), 'free');
  assert.equal(scheduleFor(character(), at(23)), 'work');
  assert.equal(scheduleFor(character('3', 'other'), at(9)), 'work');
  assert.equal(scheduleFor(character('3', 'constructor'), at(9)), 'work');
});

test('schedule mistakes fail explicitly, including mistakes in unmatched blocks', () => {
  for (const time of ['8:00', '24:00', '12:60', '-1:00', 'noon']) {
    assert.throws(() => scheduleAt([{ start: time, end: '17:00', period: 'work' }], at(23)), /Invalid schedule time/);
    assert.throws(() => scheduleAt([{ start: '08:00', end: time, period: 'work' }], at(23)), /Invalid schedule time/);
  }
  assert.throws(() => scheduleAt([{ start: '08:00', end: '08:00', period: 'work' }], at(9)), /nonzero duration/);
  assert.throws(() => scheduleAt(DEFAULT_SCHEDULE, new Date(NaN)), /invalid date/);
});

test('work floors use available clearance levels, including unknown and Admin clearances', () => {
  const rooms = [makeRoom('surface', 0), makeRoom('one', 1), makeRoom('three', 3), makeRoom('five', 5)];
  const world = new World({ rooms, roster: [] });
  for (const [clearance, ids] of [
    ['0', ['surface']], ['2', ['one']], ['3', ['three']], ['99', ['five']],
    ['redacted', ['one']], [' admin ', rooms.map((room) => room.id)],
  ]) assert.deepEqual(world.workRooms(character(clearance)).map((room) => room.id), ids);
  assert.deepEqual(new World({ rooms: [rooms[2]], roster: [] }).workRooms(character('1')), []);
});

test('work routing finds multi-hop door and elevator routes without crossing restricted rooms', () => {
  const rooms = [makeRoom('surface', 0), makeRoom('corridor', 1), makeRoom('work', 3), makeRoom('restricted', 5)];
  const [surface, corridor, work, restricted] = rooms;
  const first = connect(surface, corridor);
  corridor.elevator = { shaft: 'staff' };
  work.elevator = { shaft: 'staff' };
  const world = new World({ rooms, roster: [] });
  assert.equal(world.stepTowardWork(character(), surface), first);
  assert.equal(world.stepTowardWork(character(), corridor), work);
  assert.equal(world.stepTowardWork(character(), work), undefined);
  assert.equal(world.stepTowardWork(character('Admin'), surface), undefined);
  corridor.elevator = undefined;
  connect(surface, restricted);
  connect(restricted, work);
  assert.equal(world.stepTowardWork(character(), surface), undefined, 'no clearance-safe route exists');
});

test('work plans mostly work locally, and strongly prefer returning from another floor', (t) => {
  const home = makeRoom('work', 3);
  const away = makeRoom('away', 1);
  connect(away, home);
  const world = new World({ rooms: [away, home], roster: [], now: () => at(9) });
  const random = t.mock.method(Math, 'random', () => 0);
  const agent = world.spawn(character(), home, { x: 20, y: 40 });
  world.time = 30;
  agent.arrivedAt = 30;
  const countPlans = (room, hour) => {
    agent.room = room;
    world.now = () => at(hour);
    let work = 0;
    let travel = 0;
    for (let i = 0; i < 1000; i++) {
      random.mock.mockImplementation(() => (i + 0.5) / 1000);
      const task = planNext(agent, world)[0];
      if (task.activity === 'Working') work++;
      if (task.activity === 'Heading to the work' || task.activity === 'Heading to the away') travel++;
    }
    return { work, travel };
  };
  assert.ok(countPlans(home, 9).work > 800, 'over 80% of local work plans choose a work task');
  assert.ok(countPlans(away, 9).travel > 800, 'over 80% of off-floor plans return toward work');
  assert.equal(countPlans(home, 18).work, 0, 'no work tasks during free time');
  assert.ok(countPlans(home, 18).travel > countPlans(home, 9).travel * 5, 'free time enables much more wandering');
});

test('chairs use schedule-specific activities and hold their reservation until the plan ends', (t) => {
  const chair = { type: 'chair', asset: 'chair', x: 50, y: 20, w: 25, h: 40, flip: false };
  const room = makeRoom('work', 3, [chair]);
  const world = new World({ rooms: [room], roster: [], now: () => at(9) });
  const agent = world.spawn(character(), room, { x: 20, y: 40 });
  t.mock.method(Math, 'random', () => 0.75);
  for (const [hour, expected] of [[9, 'Working at the table'], [10, 'Taking a break'], [12, 'Having lunch'], [18, 'Relaxing at the table']]) {
    world.now = () => at(hour);
    const tasks = planNext(agent, world);
    assert.equal(tasks[0].activity, 'Grabbing a chair');
    const spot = agent.spot;
    assert.ok(spot);
    assert.equal(world.freeSpot(room, 'chair'), undefined);
    agent.setPlan(world, tasks);
    agent.spot = spot;
    for (let i = 0; i < 600 && !agent.sitting; i++) agent.update(world, 0.1);
    assert.equal(agent.activity, expected);
    assert.equal(agent.sitting, true);
    agent.setPlan(world, []);
    assert.ok(world.freeSpot(room, 'chair'));
  }
});

test('period changes wait for the current plan; the next decision uses the new period', (t) => {
  const room = makeRoom('work', 3);
  let date = at(9, 59);
  const world = new World({ rooms: [room], roster: [], now: () => date });
  const agent = world.spawn(character(), room, { x: 20, y: 40 });
  t.mock.method(Math, 'random', () => 0.9);
  agent.update(world, 0);
  assert.equal(agent.activity, 'Working');
  date = at(10);
  agent.update(world, 1);
  assert.equal(agent.activity, 'Working');
  agent.update(world, 60);
  agent.update(world, 0);
  assert.equal(agent.activity, 'Taking a break');
});

test('initial population and arrivals favor work floors but remain varied in free time', (t) => {
  const rooms = Array.from({ length: 4 }, (_, level) => makeRoom(`level-${level}`, level));
  for (const room of rooms) room.doors.push({
    id: 'outer', side: 'west', inside: { x: 20, y: 40 }, outside: { x: 0, y: 40 },
  });
  const roster = Array.from({ length: 100 }, (_, i) => character('3', `staff-${i}`));
  const world = new World({ rooms, roster, now: () => at(9) });
  t.mock.method(Math, 'random', () => 0.5);
  world.populate();
  assert.ok(world.agents.length > 1);
  assert.ok(world.agents.every((agent) => agent.room.level === 3));
  world.agents = [];
  assert.equal(world.arrive(roster[0]).room.level, 3);
  world.agents = [];
  world.now = () => at(18);
  assert.equal(world.arrive(roster[0]).room.level, 1);
});

test('staff spend most of a simulated work period on their work floors in the real facility', async (t) => {
  const facility = await loadFacility();
  let seed = 12345;
  t.mock.method(Math, 'random', () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  });
  const occupancy = (hour) => {
    seed = 12345;
    const roster = Array.from({ length: 18 }, (_, i) => ({
      ...character(String(i % 6), `staff-${i}`),
      behavior: { speed: 1, napChance: 0.08, clumsy: false, social: 0.4, ghost: false },
    }));
    const world = new World({ rooms: facility.map((data) => new Room(data)), roster, now: () => at(hour) });
    world.populate();
    let onWorkFloor = 0;
    let samples = 0;
    for (let step = 0; step < 4500; step++) {
      world.update(0.2);
      if (world.time < 300) continue;
      for (const agent of world.agents) {
        if (agent.leaving) continue;
        samples++;
        if (world.workRooms(agent.character).includes(agent.room)) onWorkFloor++;
      }
    }
    assert.ok(samples > 10000, 'measure actual room occupancy after five minutes of warm-up');
    return onWorkFloor / samples;
  };
  const work = occupancy(9);
  const free = occupancy(18);
  assert.ok(work > 0.7, `work-floor occupancy ${(work * 100).toFixed(1)}% must exceed 70%`);
  assert.ok(work > free + 0.25, `work ${work.toFixed(2)} must exceed free-time ${free.toFixed(2)} by 25 points`);
});

test('impostors and emergency exits are not redirected to work floors', (t) => {
  const away = makeRoom('away', 1);
  const work = makeRoom('work', 3);
  connect(away, work);
  away.doors.push({ id: 'outer', side: 'west', inside: { x: 20, y: 40 }, outside: { x: 0, y: 40 } });
  const world = new World({ rooms: [away, work], roster: [], now: () => at(9) });
  t.mock.method(Math, 'random', () => 0.5);
  const impostor = new Agent(character(), away, { x: 20, y: 40 }, {});
  assert.notEqual(planNext(impostor, world)[0].activity, 'Working');
  assert.notEqual(planNext(impostor, world)[0].activity, 'Heading to the work');
  const staff = world.spawn(character(), away, impostor);
  const tasks = leaveFacility(staff, world, true);
  assert.equal(tasks[0].activity, 'Heading out');
  assert.equal(staff.leaving, true);
});
