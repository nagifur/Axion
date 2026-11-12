import assert from 'node:assert/strict';
import test from 'node:test';
import { propsSnippet } from '../src/lib/sim/propEditor.ts';
import { Room } from '../src/lib/sim/room.ts';
import { listPropTypes, loadRoom } from '../src/lib/sim/roomLoader.ts';
import { placeablePropTypes, propTypeOf } from '../src/lib/sim/sprites.ts';

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
  assert.deepEqual(placeablePropTypes(['plant', 'elevator_door', 'elevator_lights', 'bench']), ['bench', 'chair', 'light', 'plant', 'table']);
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
