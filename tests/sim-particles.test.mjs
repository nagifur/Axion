import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { Particle, ParticleSystem, PARTICLE_SETS, MAX_PARTICLES, particleAsset, particleSet } from '../src/lib/sim/particles.ts';
import { Prop } from '../src/lib/sim/prop.ts';
import { drawParticle, loadAssets, PropEmissionSampler, Renderer } from '../src/lib/sim/render.ts';
import { Room } from '../src/lib/sim/room.ts';
import { loadRoom } from '../src/lib/sim/roomLoader.ts';
import { PROP_TYPES } from '../src/lib/sim/sprites.ts';
import { World } from '../src/lib/sim/world.ts';

const placed = (type, options = {}) => ({
  type, asset: type, x: 100, y: 50, w: 96, h: 96, flip: false, brokenLook: true, ...options,
});

const particleRoom = (width = 100, height = 200, spans = () => [0, width]) => new Room({
  id: 'particle-test', name: 'Particle test', level: 0, camera: 'test', width, height,
  nav: { width, height, floor: Array.from({ length: height }, (_, y) => spans(y)), exits: [] },
  props: [], links: {},
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

test('particle bursts sample opaque pixels in the current prop frame and skip transparent areas', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext() {
          let crop;
          return {
            drawImage(image, x, y, w, h) { crop = { image, x, y, w, h }; },
            getImageData() {
              const data = new Uint8ClampedArray(crop.w * crop.h * 4);
              for (let y = 0; y < crop.h; y++) {
                for (let x = 0; x < crop.w; x++) {
                  const source = ((crop.y + y) * crop.image.width + crop.x + x) * 4;
                  const target = (y * crop.w + x) * 4;
                  data[target + 3] = crop.image.pixels[source + 3];
                }
              }
              return { data };
            },
          };
        },
      };
      return canvas;
    },
  };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  const image = {
    width: 3, height: 2,
    pixels: Uint8ClampedArray.from([
      0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0,
      0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  };
  const prop = new Prop(placed('emitter_test', { asset: 'emitter_test', x: 10, y: 20, w: 3, h: 2 }));
  const area = { x: 10, y: 20, w: 3, h: 2 };
  const sampler = new PropEmissionSampler({ emitter_test: image });
  const points = sampler.sample(prop, area, 0);
  assert.deepEqual(points, [{ x: 11.5, y: 20.5 }, { x: 10.5, y: 21.5 }]);

  const system = new ParticleSystem();
  system.setEmissionSampler(sampler.sample);
  const emitted = system.burst(particleRoom(), 'glass', area, 22, prop);
  assert.equal(emitted.length, 13);
  assert.ok(emitted.every((particle) => points.some((point) => point.x === particle.x && point.y === particle.y)));

  const emptyArea = { x: 12, y: 20, w: 1, h: 2 };
  assert.deepEqual(sampler.sample(prop, emptyArea, 0), []);
  assert.deepEqual(system.burst(particleRoom(), 'glass', emptyArea, 22, prop), [],
    'transparent regions do not fall back to their bounding box');

  prop.flip = true;
  assert.deepEqual(sampler.sample(prop, { x: 11, y: 20, w: 2, h: 2 }, 0), [
    { x: 11.5, y: 20.5 }, { x: 12.5, y: 21.5 },
  ]);
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
  assert.equal(world.particles.in(room).length, 13, 'breaking in the editor previews the particles');
  world.particles.clear();
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

test('vending machine breakage throws glass once and keeps sparking until repaired', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = new Room(await loadRoom('level-0-mainEntrance'));
  const world = new World({ roster: [], rooms: [room] });
  world.arrive = () => undefined;
  const machine = new Prop(placed('vending_machine'));
  room.setProps([machine]);

  world.update(0);
  assert.equal(world.particles.particles.length, 0);
  assert.equal(machine.break(), true);
  assert.equal(machine.break(), false);
  world.update(0);
  const debris = world.particles.in(room);
  assert.equal(debris.filter((particle) => particle.set === PARTICLE_SETS.glass).length, 13);
  assert.equal(debris.filter((particle) => particle.set === PARTICLE_SETS.sparks).length, 4);
  assert.ok(debris.every((particle) =>
    particle.x >= machine.x && particle.x <= machine.x + machine.w
    && particle.y >= machine.y && particle.y <= machine.y + machine.h
    && particle.depth >= machine.y + machine.h));
  world.update(0);
  assert.equal(world.particles.in(room).length, 17, 'paused updates do not repeat emissions');
  world.update(0.9);
  assert.equal(world.particles.in(room).length, 13, 'spark pulses leave a quiet gap');
  world.update(1.21);
  assert.equal(world.particles.in(room).length, 17, 'the next pulse adds sparks without more glass');
  machine.repair();
  world.update(0.4);
  assert.equal(world.particles.in(room).length, 13, 'repair stops new sparks, not existing glass');
  machine.break();
  world.update(0);
  assert.equal(world.particles.in(room).length, 30, 'repair allows another mixed burst');
});

test('electric classification is explicit and independent of switching and breakability', (t) => {
  PROP_TYPES.electric_test = { asset: 'electric_test', electric: true };
  t.after(() => { delete PROP_TYPES.electric_test; });
  for (const type of ['light', 'vending_machine', 'electric_test']) {
    assert.equal(new Prop(placed(type)).electric, true, type);
  }
  for (const type of ['chair', 'table', 'glass', 'unknown']) {
    const prop = new Prop(placed(type, { switchable: true, start: { broken: true } }));
    assert.equal(prop.electric, false, type);
    assert.equal(prop.sparkArea, null, 'switching and broken artwork do not imply electrical equipment');
  }
  const prop = new Prop(placed('electric_test', { brokenLook: false }));
  assert.equal(prop.switchable, false);
  assert.equal(prop.breakable, false);
  assert.equal(prop.break(), false);
  assert.equal(prop.sparkArea, null, 'intact electrical equipment does not spark');
});

test('broken electrical props spark repeatedly off camera, even initially broken and switched off', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = particleRoom(300);
  const other = particleRoom(300);
  const light = new Prop(placed('light', { start: { broken: true, on: false } }));
  const chair = new Prop(placed('chair', { start: { broken: true } }));
  room.setProps([light, chair]);
  const world = new World({ roster: [], rooms: [room, other] });
  world.arrive = () => undefined;
  const burst = t.mock.method(world.particles, 'burst');

  world.update(0);
  assert.equal(burst.mock.callCount(), 1, 'initial broken electrical props start sparking');
  assert.equal(world.particles.in(other).length, 0);
  assert.ok(world.particles.in(room).every((particle) => particle.set === PARTICLE_SETS.sparks));
  for (let i = 0; i < 10; i++) world.update(0);
  assert.equal(burst.mock.callCount(), 1, 'pause does not advance the emitter');
  world.update(2.09);
  assert.equal(burst.mock.callCount(), 1);
  world.update(0.02);
  assert.equal(burst.mock.callCount(), 2, 'emission uses elapsed simulation time');
  world.update(10);
  assert.equal(burst.mock.callCount(), 3, 'a long frame does not replay missed bursts');
  assert.equal(world.particles.in(room).length, 4, 'old particles expire while new sparks remain');

  light.repair();
  world.update(0.9);
  assert.equal(burst.mock.callCount(), 3);
  assert.equal(world.particles.particles.length, 0);
  light.break();
  world.update(0);
  assert.equal(burst.mock.callCount(), 4, 'breaking again restarts the emitter immediately');
  room.setProps([chair]);
  world.update(0.9);
  assert.equal(burst.mock.callCount(), 4, 'removed props no longer emit');
  assert.equal(world.particles.particles.length, 0);
});

test('spark pulses are brief and choose a fresh random pause after each burst', (t) => {
  const random = t.mock.method(Math, 'random', () => 0);
  const room = particleRoom(300);
  room.setProps([new Prop(placed('light', { start: { broken: true } }))]);
  const world = new World({ roster: [], rooms: [room] });
  world.arrive = () => undefined;
  const burst = t.mock.method(world.particles, 'burst');
  world.update(0);
  assert.equal(world.particles.in(room).length, 3);
  assert.equal(world.particles.in(room)[0].lifetime, 0.15);
  world.update(0.36);
  assert.equal(world.particles.in(room).length, 0, 'the pulse ends well before the next one');
  world.update(0.83);
  assert.equal(burst.mock.callCount(), 1, 'minimum pause is 1.2 seconds');
  random.mock.mockImplementation(() => 0.999);
  world.update(0.02);
  assert.equal(burst.mock.callCount(), 2);
  assert.equal(world.particles.in(room).length, 5);
  assert.ok(world.particles.in(room).every((particle) => particle.lifetime <= 0.35));
  world.update(2.98);
  assert.equal(burst.mock.callCount(), 2, 'the next pause uses a fresh random duration');
  world.update(0.02);
  assert.equal(burst.mock.callCount(), 3, 'maximum pause is 3 seconds');
});

test('electrical emission areas reuse and mirror the break particle area', (t) => {
  PROP_TYPES.electric_test = {
    asset: 'electric_test', electric: true, breakable: true,
    breakParticles: { set: 'glass', area: { x: 5, y: 7, w: 10, h: 12 } },
  };
  t.after(() => { delete PROP_TYPES.electric_test; });
  const prop = new Prop(placed('electric_test', { flip: true, start: { broken: true } }));
  assert.deepEqual(prop.sparkArea, { x: 181, y: 57, w: 10, h: 12 });
  prop.repair();
  assert.equal(prop.sparkArea, null);
});

test('mixed bursts honor each set count and reject unknown sets before emitting', (t) => {
  const system = new ParticleSystem();
  const room = particleRoom(300);
  const area = { x: 10, y: 10, w: 10, h: 10 };
  for (const [random, glass, sparks] of [[0, 10, 3], [0.5, 13, 4], [0.999, 16, 5]]) {
    t.mock.method(Math, 'random', () => random);
    const added = system.burst(room, ['glass', 'sparks'], area);
    assert.equal(added.filter((particle) => particle.set === PARTICLE_SETS.glass).length, glass);
    assert.equal(added.filter((particle) => particle.set === PARTICLE_SETS.sparks).length, sparks);
    system.clear();
  }
  assert.throws(() => system.burst(room, ['glass', 'missing'], area), /Unknown particle set "missing"/);
  assert.equal(system.particles.length, 0);
});

test('particles launch, bounce, settle, slow down, fade and expire', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = particleRoom();
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

test('glass and sparks spin in either direction and freeze on first floor impact', (t) => {
  for (const set of [PARTICLE_SETS.glass, PARTICLE_SETS.sparks]) {
    for (const random of [0.25, 0.75]) {
      t.mock.method(Math, 'random', () => random);
      const system = new ParticleSystem();
      const particle = new Particle(particleRoom(), set, { x: 50, y: 10 }, 50);
      system.particles = [particle];
      const spin = particle.angularVelocity;
      assert.equal(Math.sign(spin), random < 0.5 ? -1 : 1);
      assert.ok(Math.abs(spin) >= set.spinSpeed[0] && Math.abs(spin) <= set.spinSpeed[1]);
      system.update(0);
      assert.equal(particle.angle, 0, 'pausing does not rotate particles');
      system.update(1 / 60);
      assert.ok(Math.abs(particle.angle - spin / 60) < 1e-10);

      particle.y = particle.floor - 1;
      particle.vy = 200;
      system.update(1 / 60);
      assert.equal(particle.angularVelocity, 0);
      assert.ok(particle.vy < 0, 'rotation stops even when the impact bounces');
      const landedAngle = particle.angle;
      particle.step(1 / 60);
      assert.equal(particle.angle, landedAngle, 'bouncing does not restart rotation');
      particle.y = particle.floor - 0.01;
      particle.vy = 0;
      particle.step(1 / 60);
      assert.equal(particle.resting, true);
      particle.vx = 20;
      particle.step(1 / 60);
      assert.equal(particle.angle, landedAngle, 'sliding does not restart rotation');
    }
  }
});

test('the particle system bounds work and separates and clears rooms', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = particleRoom();
  const other = particleRoom();
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

test('particles pass walls and land only on the green floor below their current path', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = particleRoom(100, 100, (y) => y >= 70 ? [0, 100] : y >= 40 ? [0, 50] : []);
  const particle = new Particle(room, { ...PARTICLE_SETS.glass, bounce: 0 }, { x: 45, y: 30 }, 40, 45);
  particle.vx = 600;
  particle.vy = 600;
  const spin = particle.angularVelocity;
  particle.step(1 / 60);
  assert.ok(particle.y > 40, 'crossing into a wall does not hit the old floor line');
  assert.equal(particle.resting, false);
  assert.equal(particle.angularVelocity, spin, 'walls do not stop rotation');
  particle.vx = 0;
  for (let i = 0; i < 60 && !particle.resting; i++) particle.step(1 / 60);
  assert.equal(particle.resting, true);
  assert.ok(room.isFloor(particle.x, particle.y));
  assert.equal(Math.round(particle.y), 70);
  assert.equal(particle.floor, particle.y);
  assert.equal(particle.depth, particle.y, 'depth follows the lower floor');
  assert.equal(particle.angularVelocity, 0);
});

test('fast falling particles cannot skip a single green row', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = particleRoom(100, 100, (y) => y === 60 ? [0, 100] : []);
  const particle = new Particle(room, { ...PARTICLE_SETS.glass, bounce: 0 }, { x: 50, y: 35 }, 40);
  particle.vy = 2000;
  particle.step(1 / 60);
  assert.equal(particle.resting, true);
  assert.ok(room.isFloor(particle.x, particle.y));
  assert.equal(Math.round(particle.y), 60);
});

test('debris sliding off green floor resumes falling to the next green floor', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = particleRoom(100, 100, (y) => y >= 80 ? [0, 100] : y >= 40 ? [0, 50] : []);
  const particle = new Particle(room, { ...PARTICLE_SETS.glass, bounce: 0 }, { x: 49, y: 40 }, 40);
  particle.resting = true;
  particle.vy = 0;
  particle.vx = 120;
  particle.angularVelocity = 0;
  particle.angle = 1;
  particle.step(1 / 60);
  assert.ok(particle.x > 50);
  assert.equal(particle.resting, false);
  assert.ok(particle.y > 40);
  particle.vx = 0;
  for (let i = 0; i < 60 && !particle.resting; i++) particle.step(1 / 60);
  assert.equal(particle.resting, true);
  assert.equal(Math.round(particle.y), 80);
  assert.ok(room.isFloor(particle.x, particle.y));
  assert.equal(particle.angle, 1, 'falling again preserves the stopped rotation');
});

test('particles with no green floor below fall offscreen and are removed', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const room = particleRoom(100, 100, (y) => y >= 40 ? [0, 30] : []);
  const system = new ParticleSystem();
  const particle = new Particle(room, { ...PARTICLE_SETS.glass, lifetime: [10, 10] }, { x: 75, y: 20 }, 40);
  system.particles = [particle];
  particle.vy = 100;
  for (let i = 0; i < 120 && system.particles.length; i++) system.update(1 / 60);
  assert.equal(system.particles.length, 0);
  assert.ok(particle.y > room.height);
  assert.ok(particle.age < particle.lifetime, 'offscreen removal does not wait for lifetime');
  assert.equal(particle.resting, false);
  assert.notEqual(particle.angularVelocity, 0, 'no false floor impact');
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
    rotate(angle) { calls.push(['rotate', angle]); },
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
  assert.deepEqual(calls.slice(0, 3), [['translate', 20, 28.5], ['rotate', 0], ['scale', -1, 1]]);
});

test('rotated particles draw around their center without extending below the floor', () => {
  const image = { width: 8, height: 3 };
  const particle = new Particle({ width: 100 }, PARTICLE_SETS.glass, { x: 20, y: 30 }, 30);
  for (const flip of [false, true]) {
    Object.defineProperty(particle, 'flip', { value: flip, configurable: true });
    for (const angle of [0, Math.PI / 2, -Math.PI / 4, Math.PI]) {
      particle.angle = angle;
      const calls = [];
      const ctx = {
        globalAlpha: 1, save() {}, restore() {},
        translate(x, y) { calls.push(['translate', x, y]); },
        rotate(value) { calls.push(['rotate', value]); },
        scale(x, y) { calls.push(['scale', x, y]); },
        drawImage(...args) { calls.push(['draw', ...args]); },
      };
      drawParticle(ctx, image, particle);
      assert.deepEqual(calls[1], ['rotate', angle]);
      assert.deepEqual(calls.at(-1), ['draw', image, -4, -1.5]);
      assert.equal(calls.some((call) => call[0] === 'scale'), flip);
      const centerY = calls[0][2];
      const cornersY = [-4, 4].flatMap((x) => [-1.5, 1.5].map((y) =>
        centerY + (flip ? -x : x) * Math.sin(angle) + y * Math.cos(angle)));
      assert.ok(Math.abs(Math.max(...cornersY) - particle.floor) < 1e-10);
    }
  }
});

test('optional particle glow is subtle, centered, faded, and isolated from the sprite and canvas state', () => {
  assert.equal(PARTICLE_SETS.glass.glow, undefined, 'ordinary debris does not glow');
  assert.deepEqual(PARTICLE_SETS.sparks.glow, { color: 'rgba(255, 190, 65, 0.35)', radius: 7 });
  const particle = new Particle(particleRoom(), PARTICLE_SETS.sparks, { x: 20, y: 30 }, 50);
  particle.age = particle.lifetime - particle.set.fade / 2;
  particle.angle = Math.PI / 2;
  Object.defineProperty(particle, 'flip', { value: true });
  const calls = [];
  const states = [];
  const gradient = { addColorStop(...args) { calls.push(['stop', ...args]); } };
  const ctx = {
    globalAlpha: 0.8, globalCompositeOperation: 'source-over', fillStyle: '#123456',
    save() {
      states.push({
        globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation,
        fillStyle: this.fillStyle,
      });
    },
    restore() { Object.assign(this, states.pop()); },
    translate(...args) { calls.push(['translate', ...args]); },
    rotate(...args) { calls.push(['rotate', ...args]); },
    scale(...args) { calls.push(['scale', ...args]); },
    createRadialGradient(...args) { calls.push(['gradient', ...args]); return gradient; },
    fillRect(...args) {
      calls.push(['halo', ...args, this.globalAlpha, this.globalCompositeOperation, this.fillStyle]);
    },
    drawImage(...args) {
      calls.push(['sprite', ...args, this.globalAlpha, this.globalCompositeOperation]);
    },
  };
  const image = { width: 4, height: 2 };
  drawParticle(ctx, image, particle);
  assert.deepEqual(calls.slice(0, 3), [
    ['translate', 20, 28], ['rotate', Math.PI / 2], ['scale', -1, 1],
  ]);
  assert.deepEqual(calls.slice(3, 6), [
    ['gradient', 0, 0, 0, 0, 0, 7],
    ['stop', 0, 'rgba(255, 190, 65, 0.35)'],
    ['stop', 1, 'rgba(0, 0, 0, 0)'],
  ]);
  const halo = calls[6];
  assert.deepEqual(halo.slice(0, 5), ['halo', -7, -7, 14, 14]);
  assert.ok(Math.abs(halo[5] - 0.4) < 1e-10, 'halo follows particle and caller alpha');
  assert.deepEqual(halo.slice(6), ['screen', gradient]);
  const sprite = calls[7];
  assert.deepEqual(sprite.slice(0, 4), ['sprite', image, -2, -1]);
  assert.ok(Math.abs(sprite[4] - 0.4) < 1e-10);
  assert.equal(sprite[5], 'source-over', 'only the halo uses screen blending');
  assert.equal(ctx.globalAlpha, 0.8);
  assert.equal(ctx.globalCompositeOperation, 'source-over');
  assert.equal(ctx.fillStyle, '#123456');
  assert.equal(states.length, 0);

  calls.length = 0;
  particle.age = particle.lifetime;
  drawParticle(ctx, image, particle);
  assert.deepEqual(calls, [], 'expired particles draw neither a halo nor a sprite');
});
