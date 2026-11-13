import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { Agent, enterThroughDoor, wait } from '../src/lib/sim/agent.ts';
import { CHARACTER_FRAMES, IDLE_CYCLES, IDLE_FRAME_SECONDS, WALK_CYCLES, WALK_STRIDE } from '../src/lib/sim/sprites.ts';

function agentAt(x = 0, y = 0) {
  return new Agent({ scale: 1, behavior: { speed: 1 } }, {}, { x, y });
}

test('all 18 frames occupy populated 96x96 cells in the new sheet', async () => {
  const { data, info } = await sharp(new URL('../src/sim_assets/characters/char_spritesheet.png', import.meta.url).pathname)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = [WALK_CYCLES.front, WALK_CYCLES.back, WALK_CYCLES.right, IDLE_CYCLES.right, IDLE_CYCLES.front, IDLE_CYCLES.back];
  assert.equal(Object.keys(CHARACTER_FRAMES).length, 18);
  rows.forEach((names, row) => names.forEach((name, column) => {
    const frame = CHARACTER_FRAMES[name];
    assert.deepEqual(frame, { x: column * 96, y: row * 96, w: 96, h: 96, anchorX: 48 });
    assert.ok(frame.x + frame.w <= info.width && frame.y + frame.h <= info.height);
    let opaque = 0;
    for (let y = frame.y; y < frame.y + frame.h; y++) {
      for (let x = frame.x; x < frame.x + frame.w; x++) {
        if (data[(y * info.width + x) * 4 + 3]) opaque++;
      }
    }
    assert.ok(opaque > 0 && opaque < 96 * 96, `${name} contains art and transparent padding`);
  }));
});

test('walking uses four directional frames and mirrors only left', () => {
  for (const [facing, cycle] of Object.entries(WALK_CYCLES)) {
    const agent = agentAt();
    agent.facing = facing;
    agent.moving = true;
    for (let i = 0; i < 8; i++) {
      agent.walkDistance = i * WALK_STRIDE;
      assert.deepEqual(agent.frame, { name: cycle[i % 4], flip: facing === 'left' });
    }
  }
});

test('walking advances frames every 4.5 room pixels', () => {
  const agent = agentAt();
  agent.moveToward({ x: 100, y: 0 }, 4 / 28);
  assert.equal(agent.frame.name, 'walkRight1');
  agent.moveToward({ x: 100, y: 0 }, 0.5 / 28);
  assert.equal(agent.frame.name, 'walkRight2');
});

test('movement picks the dominant direction, including short arrival steps', () => {
  const targets = [
    [{ x: 20, y: 1 }, 'right'],
    [{ x: -20, y: 1 }, 'left'],
    [{ x: 1, y: -20 }, 'back'],
    [{ x: 1, y: 20 }, 'front'],
  ];
  for (const [target, facing] of targets) {
    const agent = agentAt();
    assert.equal(agent.moveToward(target, 0.1), false);
    assert.equal(agent.facing, facing);
    assert.ok(agent.moving);
    assert.ok(Math.abs(agent.walkDistance - 2.8) < 1e-9);
  }
  const agent = agentAt();
  assert.equal(agent.moveToward({ x: 0, y: -1 }, 0.1), true);
  assert.equal(agent.walkDistance, 1);
  assert.equal(agent.facing, 'back');
  assert.ok(agent.moving);
});

test('stationary and zero-time movement do not advance the walk cycle', () => {
  const agent = agentAt();
  assert.equal(agent.moveToward({ x: 0, y: 0 }, 0.1), true);
  assert.equal(agent.moveToward({ x: 10, y: 0 }, 0), false);
  assert.equal(agent.moveToward({ x: 10, y: 0 }, -1), false);
  assert.equal(agent.walkDistance, 0);
  assert.equal(agent.moving, false);
  assert.equal(agent.facing, 'front');
});

test('idle animations alternate, loop, and reset after walking', () => {
  for (const [facing, cycle] of Object.entries(IDLE_CYCLES)) {
    const agent = agentAt();
    agent.setPlan({}, [wait(10, 'Idle', facing)]);
    agent.update({}, 0);
    assert.deepEqual(agent.frame, { name: cycle[0], flip: facing === 'left' });
    agent.update({}, IDLE_FRAME_SECONDS);
    assert.equal(agent.frame.name, cycle[1]);
    agent.update({}, IDLE_FRAME_SECONDS);
    assert.equal(agent.frame.name, cycle[0]);
    agent.update({}, IDLE_FRAME_SECONDS);
    agent.setPlan({}, [{ activity: 'Walking', interruptible: true, update(a, _world, dt) { a.moveToward({ x: 100, y: 0 }, dt); } }]);
    agent.update({}, 0.1);
    assert.ok(agent.moving);
    agent.setPlan({}, [wait(10, 'Idle', facing)]);
    agent.update({}, 0);
    assert.equal(agent.frame.name, cycle[0]);
  }
});

test('north and south doorways retain directional walking even on diagonal entry', () => {
  for (const [side, facing] of [['north', 'front'], ['south', 'back']]) {
    const agent = agentAt();
    const door = { side, outside: { x: 0, y: 0 }, inside: { x: 100, y: side === 'north' ? 10 : -10 } };
    const task = enterThroughDoor(door);
    assert.equal(task.update(agent, {}, 0.1), false);
    assert.ok(agent.moving);
    assert.equal(agent.facing, facing);
    assert.ok(WALK_CYCLES[facing].includes(agent.frame.name));
    assert.equal(agent.frame.flip, false);
  }
});
