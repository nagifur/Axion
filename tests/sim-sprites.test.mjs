import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { Agent, enterThroughDoor, nap, trip, wait } from '../src/lib/sim/agent.ts';
import { CHARACTER_FRAMES, IDLE_CYCLES, IDLE_FRAME_SECONDS, SIT_CYCLES, TALK_RIGHT_CYCLE, WALK_CYCLES, WALK_STRIDE } from '../src/lib/sim/sprites.ts';

function agentAt(x = 0, y = 0) {
  return new Agent({ scale: 1, behavior: { speed: 1 } }, {}, { x, y });
}

test('all 24 frames occupy populated 96x96 cells in the sheet', async () => {
  const { data, info } = await sharp(new URL('../src/sim_assets/characters/char_spritesheet.png', import.meta.url).pathname)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = [WALK_CYCLES.front, WALK_CYCLES.back, WALK_CYCLES.right, IDLE_CYCLES.right, IDLE_CYCLES.front, IDLE_CYCLES.back, SIT_CYCLES.right, SIT_CYCLES.front, TALK_RIGHT_CYCLE];
  assert.equal(Object.keys(CHARACTER_FRAMES).length, 24);
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

test('walking advances frames every 8 room pixels', () => {
  const agent = agentAt();
  agent.moveToward({ x: 100, y: 0 }, 7.5 / 28);
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

function activityWorld(spot, partner) {
  return {
    time: 0,
    freeSpot(_room, kind) { return spot?.kind === kind ? spot : undefined; },
    findChatPartner() { return partner; },
    presentCount() { return 1; },
    targetPopulation() { return 1; },
    elevatorStops() { return []; },
    isNight() { return false; },
    now() { return new Date(2026, 0, 1, 12); },
    log() {},
    achieve() {},
  };
}

function activityAgent(x = 0, napChance = 0) {
  const agent = agentAt(x);
  agent.character.name = 'Test';
  agent.character.species = 'Human';
  Object.assign(agent.character.behavior, { napChance, social: 1, clumsy: false });
  agent.room = {
    name: 'Test room',
    linkedDoors: [],
    route(_agent, target) { return [target]; },
    isWalkable() { return true; },
  };
  return agent;
}

test('bench and mirrored chair rests sit only after reaching their reserved spot', (t) => {
  t.mock.method(Math, 'random', () => 0.75);
  for (const [kind, facing, expected, flip] of [
    ['bench', 'front', 'sitFront1', false],
    ['chair', 'right', 'sitRight1', false],
    ['chair', 'left', 'sitRight1', true],
  ]) {
    const spot = { id: kind, kind, facing, x: 28, y: 0, propDepth: 3 };
    const world = activityWorld(spot);
    const agent = activityAgent();
    agent.update(world, 0.5);
    assert.equal(agent.spot, spot);
    assert.ok(agent.frame.name.startsWith('walk'), 'remains walking on the way');
    agent.update(world, 0.5);
    assert.ok(agent.frame.name.startsWith('walk'), 'arrival step still walks');
    agent.update(world, 0);
    assert.deepEqual(agent.frame, { name: expected, flip });
    agent.update(world, IDLE_FRAME_SECONDS);
    assert.equal(agent.frame.name, expected.replace('1', '2'));
    agent.interrupt(world, trip());
    assert.ok(agent.frame.name.startsWith('idle'), 'interrupted task stops sitting');
    agent.update(world, 1.3);
    agent.update(world, 0);
    assert.ok(agent.frame.name.startsWith('sit'), 'resumed rest sits again');
    agent.setPlan(world, []);
    assert.ok(agent.frame.name.startsWith('idle'), 'leaving the seat stops sitting');
  }
});

test('naps at seats use sitting poses but debug naps away from seats do not', (t) => {
  t.mock.method(Math, 'random', () => 0.75);
  const spot = { id: 'bench', kind: 'bench', facing: 'front', x: 28, y: 0, propDepth: 3 };
  const world = activityWorld(spot);
  const agent = activityAgent(0, 1);
  agent.update(world, 1);
  agent.update(world, 0);
  assert.equal(agent.napping, true);
  assert.equal(agent.frame.name, 'sitFront1');
  agent.setPlan(world, [nap(20, 'front')]);
  agent.update(world, 0);
  assert.equal(agent.napping, true);
  assert.equal(agent.frame.name, 'idleFront1');
  agent.setPlan(world, []);
  assert.equal(agent.napping, false);
});

test('conversation uses talking frames only for the current speaker', (t) => {
  t.mock.method(Math, 'random', () => 0.8);
  const initiator = activityAgent();
  const partner = activityAgent(40);
  partner.room = initiator.room;
  const world = activityWorld(undefined, partner);
  initiator.update(world, 0);
  partner.update(world, 0);
  assert.ok(partner.frame.name.startsWith('idle'), 'listener waits while the speaker approaches');
  initiator.update(world, 1);
  assert.ok(initiator.frame.name.startsWith('walk'));
  initiator.update(world, 0);
  assert.deepEqual(initiator.frame, { name: 'talkRight1', flip: false });
  assert.ok(partner.frame.name.startsWith('idle'));
  initiator.update(world, IDLE_FRAME_SECONDS);
  assert.equal(initiator.frame.name, 'talkRight2');
  initiator.update(world, 1);
  partner.update(world, 0);
  assert.ok(initiator.frame.name.startsWith('idle'), 'first speaker is now listening');
  assert.ok(TALK_RIGHT_CYCLE.includes(partner.frame.name));
  assert.equal(partner.frame.flip, true);
  initiator.setPlan(world, []);
  partner.update(world, 0);
  assert.ok(partner.frame.name.startsWith('idle'), 'ending the conversation clears the talking pose');
});

test('facings without sitting or talking art use their idle animations', () => {
  const agent = activityAgent();
  agent.facing = 'back';
  agent.setPlan({}, [{ activity: 'Resting', interruptible: true, sitting: true, update() { return false; } }]);
  agent.update({}, 0);
  assert.equal(agent.frame.name, 'idleBack1');

  agent.setPlan({}, []);
  agent.facing = 'front';
  agent.conversation = { initiator: agent, partner: activityAgent(), started: true, ended: false, elapsed: 0 };
  assert.equal(agent.frame.name, 'idleFront1');
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
