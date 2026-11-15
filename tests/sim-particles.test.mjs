import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { Particle, ParticleSystem, PARTICLE_SETS, MAX_PARTICLES, particleAsset, particleSet } from '../src/lib/sim/particles.ts';
import { Prop } from '../src/lib/sim/prop.ts';
import { drawParticle, loadAssets, Renderer } from '../src/lib/sim/render.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';
import { PROP_TYPES } from '../src/lib/sim/sprites.ts';
import { World } from '../src/lib/sim/world.ts';

const placed = (type, options = {}) => ({
  type, asset: type, x: 100, y: 50, w: 96, h: 96, flip: false, brokenLook: true, ...options,
});

test('all registered particle images exist and glass prop types share one set', async () => {
  for (const [name, set] of Object.entries(PARTICLE_SETS)) {
    assert.ok(set.sprites.length, `${name} must have sprites`);
    for (const sprite of set.sprites) {
      const metadata = await sharp(`src/sim_assets/particles/${sprite}.png`).metadata();
      assert.equal(metadata.format, 'png');
      assert.ok(metadata.width > 0 && metadata.height > 0);
    }
  }
  for (const type of ['glass', 'glassHalf', 'glassAngle']) {
    assert.equal(PROP_TYPES[type].breakParticles.set, 'glass');
  }
  assert.throws(() => particleSet('missing'), /Unknown particle set "missing"/);
});

test('runtime breakage emits once per break in the correct room, including shared future types', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  PROP_TYPES.glass_cup_test = { asset: 'glass_cup_test', breakable: true, breakParticles: { set: 'glass' } };
  t.after(() => { delete PROP_TYPES.glass_cup_test; });
  const room = new Room(await loadRoom('level-0-mainEntrance'));
  const other = new Room(await loadRoom('level-2-lobby'));
  const world = new World({ roster: [], rooms: [room, other] });
  world.arrive = () => undefined;
  const pane = room.props.find((prop) => prop.type === 'glass');
  const cup = new Prop(placed('glass_cup_test'));
  const prebroken = new Prop(placed('glass', { start: { broken: true } }));
  room.setProps([...room.props, cup, prebroken]);

  world.update(0);
  assert.equal(world.particles.particles.length, 0, 'initial broken state is not an event');
  prebroken.setStart({ broken: false });
  prebroken.setStart({ broken: true });
  world.update(0);
  assert.equal(world.particles.particles.length, 0, 'editing starting state is not runtime breakage');
  assert.equal(pane.break(), true);
  assert.equal(pane.break(), false);
  assert.equal(cup.break(), true);
  world.update(0);
  assert.equal(world.particles.in(room).length, 26);
  assert.equal(world.particles.in(other).length, 0);
  assert.ok(world.particles.in(room).every((particle) => particle.asset.startsWith('particle:glass_')));
  const first = world.particles.in(room)[0];
  assert.ok(first.x >= pane.x + 3 && first.x <= pane.x + 94);
  assert.ok(first.y >= pane.y + 30 && first.y <= pane.y + 67);
  assert.ok(first.depth >= pane.y + pane.h, 'shards draw in front of the pane, not its transparent padding');
  assert.equal(world.particles.in(room)[13].set, PARTICLE_SETS.glass);
  world.update(0);
  assert.equal(world.particles.in(room).length, 26, 'events are consumed');
  pane.repair();
  pane.break();
  pane.repair();
  pane.break();
  world.update(0);
  assert.equal(world.particles.in(room).length, 52, 'multiple transitions before a tick are preserved');
  world.update(5);
  assert.equal(world.particles.in(room).length, 0, 'world updates expire off-camera particles');
});

test('emission areas mirror with flipped props and default to the whole prop', () => {
  const angle = new Prop(placed('glassAngle', { flip: true, x: 10, y: 20 }));
  assert.deepEqual(angle.breakParticles, {
    set: 'glass', area: { x: 38, y: 32, w: 40, h: 74 }, depth: 116,
  });
  PROP_TYPES.glass_cup_test = { asset: 'glass_cup_test', breakParticles: { set: 'glass' } };
  try {
    assert.deepEqual(new Prop(placed('glass_cup_test', { flip: true })).breakParticles, {
      set: 'glass', area: { x: 100, y: 50, w: 96, h: 96 }, depth: 146,
    });
  } finally {
    delete PROP_TYPES.glass_cup_test;
  }
});

test('particles launch, bounce, settle, slow down, fade and expire', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = { width: 100 };
  const system = new ParticleSystem();
  const [particle] = system.burst(room, 'glass', { x: 40, y: 5, w: 10, h: 10 });
  const initialY = particle.y;
  system.update(0.1);
  assert.ok(particle.y < initialY, 'launch moves upward');
  particle.y = particle.floor - 1;
  particle.vy = 100;
  particle.vx = 30;
  system.update(1 / 60);
  assert.ok(particle.vy < 0, 'impact bounces upward');
  for (let i = 0; i < 100 && !particle.resting; i++) system.update(1 / 60);
  assert.equal(particle.resting, true);
  assert.equal(particle.y, particle.floor);
  const speed = particle.vx;
  system.update(0.1);
  assert.ok(particle.vx < speed, 'friction slows settled particles');
  particle.age = particle.lifetime - particle.set.fade / 2;
  assert.ok(Math.abs(particle.alpha - 0.5) < 1e-10);
  system.update(particle.set.fade);
  assert.equal(system.particles.includes(particle), false);
});

test('the particle system bounds work and separates and clears rooms', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = { width: 100 };
  const other = { width: 100 };
  const system = new ParticleSystem();
  const area = { x: 10, y: 10, w: 10, h: 10 };
  for (let i = 0; i < 30; i++) system.burst(room, 'glass', area);
  assert.equal(system.particles.length, MAX_PARTICLES);
  system.burst(other, 'glass', area);
  assert.equal(system.in(other).length, 13);
  assert.equal(system.particles.length, MAX_PARTICLES);
  const particle = system.in(other)[0];
  let steps = 0;
  t.mock.method(particle, 'step', (dt) => {
    assert.ok(dt <= 1 / 60 + 1e-12);
    steps++;
  });
  system.update(1);
  assert.equal(steps, 12);
  assert.equal(particle.age, 1, 'lifetime uses the full elapsed time');
  system.update(NaN);
  system.update(-1);
  assert.equal(particle.age, 1);
  system.clear(room);
  assert.equal(system.in(room).length, 0);
  assert.equal(system.in(other).length, 13);
  system.clear();
  assert.equal(system.particles.length, 0);
});

test('particle images load independently of prop sheet validation', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Image', original);
    else delete globalThis.Image;
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      width = 193;
      height = 288;
      set src(_url) { this.onload(); }
    },
  });
  assert.ok((await loadAssets({ [particleAsset('glass_1')]: '/glass_1.png' }))['particle:glass_1']);
});

test('particles render faded, mirrored, and in front of their emitting prop', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const calls = [];
  const ctx = {
    globalAlpha: 1,
    drawImage(image) { calls.push(['draw', image, this.globalAlpha]); },
    getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() {}, setTransform() {}, fillRect() {}, save() { this.savedAlpha = this.globalAlpha; },
    restore() { this.globalAlpha = this.savedAlpha; },
    translate(x, y) { calls.push(['translate', x, y]); },
    scale(x, y) { calls.push(['scale', x, y]); },
  };
  const canvas = { getContext: () => ctx };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { createElement: () => ({ ...canvas, width: 0, height: 0 }) },
  });
  const room = { id: 'test', width: 300, height: 200, darkness: 0, props: [new Prop(placed('glass'))] };
  const system = new ParticleSystem();
  const [particle] = system.burst(room, 'glass', { x: 110, y: 80, w: 10, h: 10 }, 146);
  system.particles = [particle];
  particle.age = particle.lifetime - particle.set.fade / 2;
  const image = { width: 4, height: 3 };
  const pane = { width: 96, height: 96 };
  const backdrop = {};
  const assets = { character: { width: 1, height: 1 }, glass: pane, [particle.asset]: image, 'room:test': backdrop };
  const renderer = new Renderer(canvas, assets, room);
  calls.length = 0;
  renderer.draw({ particles: system, agentsIn: () => [], elevatorFor: () => undefined, time: 0 }, new Map());
  const draws = calls.filter((entry) => entry[0] === 'draw');
  assert.deepEqual(draws.map((entry) => entry[1]), [backdrop, pane, image]);
  assert.ok(Math.abs(draws[2][2] - 0.5) < 1e-10);
  assert.equal(ctx.globalAlpha, 1);

  const flipped = new Particle(room, PARTICLE_SETS.glass, { x: 20, y: 30 }, 50);
  Object.defineProperty(flipped, 'flip', { value: true });
  calls.length = 0;
  drawParticle(ctx, image, flipped);
  assert.deepEqual(calls.slice(0, 2), [['translate', 22, 27], ['scale', -1, 1]]);
});
