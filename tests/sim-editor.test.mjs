import assert from 'node:assert/strict';
import test from 'node:test';
import { PropEditor, propsSnippet } from '../src/lib/sim/propEditor.ts';
import { Room } from '../src/lib/sim/room.ts';
import { listPropTypes, loadRoom } from '../src/lib/sim/roomLoader.ts';
import { placeablePropTypes, propTypeOf } from '../src/lib/sim/sprites.ts';
import { World } from '../src/lib/sim/world.ts';
import { wait } from '../src/lib/sim/tasks.ts';

const prop = (type, x, y, flip = false) => ({ type, asset: type, x, y, w: 10, h: 10, flip });

test('the snippet matches the room.json props format and parses back', () => {
  const snippet = propsSnippet([prop('light', 83, 34), prop('chair', 415, 122, true)]);
  assert.equal(snippet, [
    '"props": [',
    '  { "type": "light", "x": 83, "y": 34 },',
    '  { "type": "chair", "x": 415, "y": 122, "flip": true }',
    ']',
  ].join('\n'));
  assert.deepEqual(JSON.parse(`{${snippet}}`).props, [
    { type: 'light', x: 83, y: 34 },
    { type: 'chair', x: 415, y: 122, flip: true },
  ]);
  assert.equal(propsSnippet([]), '"props": []');
});

test('the snippet reproduces a real room.json', async () => {
  const data = await loadRoom('level-1-offices');
  const props = JSON.parse(`{${propsSnippet(data.props)}}`).props;
  assert.deepEqual(props.map((p) => [p.type, p.x, p.y, !!p.flip]), data.props.map((p) => [p.type, p.x, p.y, p.flip]));
});

test('any image in props/ can be placed as decoration, except elevator parts', async () => {
  assert.deepEqual(placeablePropTypes(['plant', 'elevator_door', 'big_elevator_door', 'elevator_lights', 'bench']), [
    'bench', 'chair', 'glass', 'glass_angle', 'glass_half', 'light', 'plant', 'table', 'vending_machine',
  ]);
  assert.deepEqual(propTypeOf('plant'), { asset: 'plant' });
  assert.ok(propTypeOf('chair').seats);
  const types = await listPropTypes();
  assert.ok(types.includes('bench') && !types.includes('elevator_door'));
});

test('moving a prop live moves its seats and blocked floor too', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const chair = room.props.find((p) => p.type === 'chair' && !p.flip);
  const seat = room.spots.find((s) => s.kind === 'chair' && s.facing === 'right');
  const before = { x: seat.x, y: seat.y };
  const blockedBefore = room.blockedAreas.map((r) => ({ ...r }));

  chair.x += 20;
  chair.y += 5;
  room.setProps(room.props);

  const moved = room.spots.find((s) => s.kind === 'chair' && s.facing === 'right');
  assert.deepEqual({ x: moved.x, y: moved.y }, { x: before.x + 20, y: before.y + 5 });
  assert.equal(room.spots.length, 5, 'seats are rebuilt, not duplicated');
  assert.notDeepEqual(room.blockedAreas, blockedBefore);

  room.setProps(room.props.filter((p) => p !== chair));
  assert.equal(room.spots.length, 4);
});

test('seat reservations survive layout rebuilds and are released when the seat is removed', async () => {
  const room = new Room(await loadRoom('level-1-offices'));
  const world = new World({ roster: [], rooms: [room] });
  const character = {
    id: 'seat-test', name: 'Seat test', tint: '#fff', scale: 1, position: 'Test', species: 'Human',
    accessLevel: '1', employeeID: '1', traits: [], weight: 1, stats: {},
    behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
  };
  const seat = room.spots.find((spot) => spot.kind === 'chair');
  const agent = world.spawn(character, room, seat);
  agent.setPlan(world, [wait(1000, 'Sitting')]);
  agent.spot = seat;

  const light = room.props.find((prop) => prop.type === 'light');
  const editor = new PropEditor({}, room, () => {});
  editor.selected = light;
  editor.nudge(1, 0);
  assert.equal(agent.spot, seat);
  assert.notEqual(world.freeSpot(room, 'chair')?.prop, seat.prop, 'the occupied seat stays reserved');

  room.setProps(room.props.filter((prop) => prop !== seat.prop));
  world.update(0.1);
  assert.notEqual(agent.spot, seat, 'removing the seat releases the stale reservation');
  assert.ok(!agent.spot || room.spots.includes(agent.spot), 'an immediate new reservation belongs to the rebuilt room');
});
