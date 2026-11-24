import assert from 'node:assert/strict';
import test from 'node:test';
import { followCameraRoom } from '../src/lib/sim/monitorFollow.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';
import { World } from '../src/lib/sim/world.ts';
import { toSimCreature } from '../src/lib/sim/roster.ts';

const staff = (id) => ({
  id, name: id, href: '/', tint: '#fff', scale: 1, accessLevel: 'Admin',
  traits: [], weight: 1,
  behavior: { speed: 1, napChance: 0, clumsy: false, social: 0, ghost: false },
});

test('following staff tracks room changes and waits for elevator arrival', async () => {
  const from = new Room(await loadRoom('level-0-main-entrance'));
  const to = new Room(await loadRoom('level-3-main-entrance'));
  const world = new World({ rooms: [from, to], roster: [] });
  world.arrive = () => undefined;
  const agent = world.spawn(staff('followed'), from, from.randomFloorPoint());
  assert.equal(followCameraRoom(world, agent), from);

  agent.room = to;
  assert.equal(followCameraRoom(world, agent), to);
  agent.room = from;
  world.elevatorDeparted(agent, to);
  assert.equal(agent.room, to, 'destination is set before the ride completes');
  assert.equal(followCameraRoom(world, agent), null);
  for (let i = 0; i < 200 && world.isRiding(agent); i++) world.update(0.1);
  assert.equal(world.isRiding(agent), false);
  assert.equal(followCameraRoom(world, agent), to);

  world.remove(agent, 'door');
  assert.equal(followCameraRoom(world, agent), null);
});

test('following a creature uses its current camera and waits while it is absent', () => {
  const room = (id, cell = false) => new Room({
    id, name: id, camera: id, level: 3, width: 240, height: 160, containmentCell: cell,
    nav: { floor: Array.from({ length: 160 }, () => [0, 240]), exits: [] }, props: [], links: {},
  });
  const home = room('cell', true);
  const hall = room('hall');
  const creature = toSimCreature({
    id: 'creature.md',
    data: { title: 'Creature', nickname: 'Test', containmentClass: 'Containment', type: 'Creature', species: 'Test' },
  });
  const world = new World({ rooms: [home, hall], roster: [], creatureRoster: [creature] });
  const [actor] = world.creatures;
  assert.equal(followCameraRoom(world, actor), home);
  actor.room = hall;
  assert.equal(followCameraRoom(world, actor), hall);
  actor.escaped = true;
  assert.equal(followCameraRoom(world, actor), null);
  world.recontain(actor);
  assert.equal(followCameraRoom(world, actor), home);
  actor.away = true;
  assert.equal(followCameraRoom(world, actor), null);
  actor.away = false;
  assert.equal(followCameraRoom(world, actor), home);
});
