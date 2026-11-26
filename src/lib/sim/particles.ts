// Short-lived sprites thrown into a room (such as glass shards and blood drops). They fall, bounce on the
// nav-map floor below their emission area, settle, then fade out. Pure simulation: render.ts draws them.

import type { Rect } from './navMap.ts';
import type { Prop } from './prop.ts';
import type { Room } from './room.ts';
import { chance, random, range } from './random.ts';

export type ParticleEmissionSampler = (prop: Prop, area: Rect, time: number) => readonly { x: number; y: number }[];

/** How one kind of particle looks and moves. Several prop types can share one set. */
export interface ParticleSet {
  /** File names in src/sim_assets/particles/ without ".png"; each particle picks one. */
  sprites: readonly string[];
  /** Particles per burst, inclusive. */
  count: readonly [number, number];
  /** Largest sideways launch speed, in room pixels per second (either direction). */
  spreadSpeed: number;
  /** Extra launch speed range toward a burst's `direction`, in room pixels per second. */
  forwardSpeed?: readonly [number, number];
  /** Upward launch speed range, in room pixels per second. */
  upSpeed: readonly [number, number];
  /** Midair angular speed magnitude, in radians per second; direction is random. */
  spinSpeed: readonly [number, number];
  /** Downward acceleration, in room pixels per second squared. */
  gravity: number;
  /** Share of the vertical speed kept on each bounce (0 to 1). */
  bounce: number;
  /** How quickly sideways speed dies out while sliding on the floor, per second. */
  friction: number;
  /** Seconds each particle lasts, inclusive range. */
  lifetime: readonly [number, number];
  /** Seconds at the end of the lifetime spent fading out. */
  fade: number;
  /** Minimum extra distance below the emitting area before particles can land, in room pixels. */
  scatter: number;
  /** Optional soft halo; color includes opacity and radius is in room pixels. */
  glow?: { color: string; radius: number };
}

/** Downward acceleration shared by debris and falling agents, in room pixels per second squared. */
export const GRAVITY = 420;

/** Particle sets for events such as prop breakage and creature attacks. */
export const PARTICLE_SETS: Record<string, ParticleSet> = {
  rock: {
    sprites: ['rock_1', 'rock_2', 'rock_3'],
    count: [1, 3],
    spreadSpeed: 12,
    upSpeed: [0, 0],
    spinSpeed: [2, 5],
    gravity: GRAVITY,
    bounce: 0.2,
    friction: 8,
    lifetime: [3, 5],
    fade: 1,
    scatter: 0,
  },
  glass: {
    sprites: ['glass_1', 'glass_2', 'glass_3'],
    count: [10, 16],
    spreadSpeed: 45,
    upSpeed: [15, 70],
    spinSpeed: [3, 9],
    gravity: GRAVITY,
    bounce: 0.35,
    friction: 5,
    lifetime: [2.5, 4],
    fade: 0.8,
    scatter: 5,
  },
  sparks: {
    sprites: ['spark_1', 'spark_2', 'spark_3'],
    count: [4, 7],
    spreadSpeed: 90,
    upSpeed: [35, 95],
    spinSpeed: [6, 14],
    gravity: GRAVITY,
    bounce: 0.7,
    friction: 8,
    lifetime: [0.15, 1.2],
    fade: 0.3,
    scatter: 5,
    glow: { color: 'rgba(255, 190, 65, 0.35)', radius: 7 },
  },
  blood: {
    sprites: ['blood_1', 'blood_2', 'blood_3'],
    count: [8, 15],
    spreadSpeed: 42,
    upSpeed: [5, 25],
    spinSpeed: [2, 6],
    gravity: GRAVITY,
    bounce: 0,
    friction: 16,
    lifetime: [6, 12],
    fade: 0.65,
    scatter: 0,
  },
  cum: {
    sprites: ['cum_1', 'cum_2', 'cum_3'],
    count: [3, 6],
    spreadSpeed: 12,
    forwardSpeed: [55, 120],
    upSpeed: [20, 60],
    spinSpeed: [1, 4],
    gravity: GRAVITY,
    bounce: 0,
    friction: 14,
    lifetime: [6, 10],
    fade: 0.8,
    scatter: 2,
  },
  pee: {
    sprites: ['pee_1', 'pee_2', 'pee_3'],
    count: [3, 6],
    spreadSpeed: 12,
    forwardSpeed: [55, 120],
    upSpeed: [20, 60],
    spinSpeed: [1, 4],
    gravity: GRAVITY,
    bounce: 0,
    friction: 14,
    lifetime: [5, 8],
    fade: 0.8,
    scatter: 2,
  },
  milk: {
    sprites: ['milk_1', 'milk_2', 'milk_3'],
    count: [1, 2],
    spreadSpeed: 5,
    forwardSpeed: [8, 25],
    upSpeed: [0, 10],
    spinSpeed: [0.5, 2],
    gravity: GRAVITY,
    bounce: 0,
    friction: 16,
    lifetime: [6, 10],
    fade: 0.8,
    scatter: 2,
  },
  poo: {
    sprites: ['poo_1', 'poo_2', 'poo_3'],
    count: [1, 2],
    spreadSpeed: 6,
    forwardSpeed: [10, 25],
    upSpeed: [0, 10],
    spinSpeed: [1, 3],
    gravity: GRAVITY,
    bounce: 0,
    friction: 18,
    lifetime: [6, 10],
    fade: 0.8,
    scatter: 2,
  },
  bone: {
    sprites: ['bone_1'],
    count: [1, 1],
    spreadSpeed: 6,
    forwardSpeed: [15, 35],
    upSpeed: [5, 20],
    spinSpeed: [3, 7],
    gravity: GRAVITY,
    bounce: 0.25,
    friction: 10,
    lifetime: [6, 10],
    fade: 0.8,
    scatter: 2,
  },
};

/** Live particles across all rooms; the oldest are dropped first beyond this. */
export const MAX_PARTICLES = 300;
/** Longest physics step; longer frames are split so bounces stay stable. */
const MAX_STEP = 1 / 60;
/** Upper bound on physics steps per update, so a huge frame can't stall the loop. */
const MAX_STEPS = 12;
/** Bounces slower than this (pixels per second) come to rest instead. */
const SETTLE_SPEED = 20;

/** Asset name a particle sprite is loaded under. */
export const particleAsset = (sprite: string) => `particle:${sprite}`;

export function particleSet(name: string): ParticleSet {
  const set = PARTICLE_SETS[name];
  if (!set) throw new Error(`Unknown particle set "${name}". Known: ${Object.keys(PARTICLE_SETS).join(', ')}.`);
  return set;
}

const between = ([min, max]: readonly [number, number]) => range(min, max);

export class Particle {
  readonly room: Room;
  readonly set: ParticleSet;
  readonly asset: string;
  readonly flip: boolean;
  /** Bottom-center of the rotated sprite's bounds, in room pixels. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle = 0;
  angularVelocity: number;
  /** Earliest landing line, updated to the actual green floor on impact. */
  floor: number;
  private readonly emissionDepth: number;
  readonly lifetime: number;
  age = 0;
  resting = false;

  constructor(room: Room, set: ParticleSet, at: { x: number; y: number }, floor: number, depth = floor, direction = 0) {
    this.room = room;
    this.set = set;
    this.asset = particleAsset(set.sprites[Math.min(set.sprites.length - 1, Math.floor(random() * set.sprites.length))]);
    this.flip = chance(0.5);
    this.x = at.x;
    this.y = Math.min(at.y, floor);
    this.floor = floor;
    this.emissionDepth = depth;
    this.vx = (random() * 2 - 1) * set.spreadSpeed + (direction && set.forwardSpeed ? direction * between(set.forwardSpeed) : 0);
    this.vy = -between(set.upSpeed);
    this.lifetime = between(set.lifetime);
    this.angularVelocity = between(set.spinSpeed) * (chance(0.5) ? -1 : 1);
  }

  get expired() {
    return this.age >= this.lifetime || this.y > this.room.height;
  }

  /** Keep debris in front of its emitter while following any lower landing floor. */
  get depth() {
    return Math.max(this.emissionDepth, this.floor, this.y);
  }

  /** 1 while fully visible, falling to 0 over the set's fade time. */
  get alpha() {
    const left = this.lifetime - this.age;
    return Math.max(0, Math.min(1, this.set.fade > 0 ? left / this.set.fade : left > 0 ? 1 : 0));
  }

  step(dt: number) {
    const { gravity, bounce, friction } = this.set;
    let previousX = this.x;
    const previousY = this.y;
    if (this.resting) this.vx *= Math.max(0, 1 - friction * dt);
    this.x += this.vx * dt;
    if (this.x < 0 || this.x > this.room.width) {
      this.x = Math.max(0, Math.min(this.room.width, this.x));
      this.vx = -this.vx * bounce;
    }
    if (this.resting && !this.room.isFloor(this.x, this.y)) {
      this.resting = false;
      previousX = this.x;
    }
    if (!this.resting) {
      this.angle += this.angularVelocity * dt;
      this.vy += gravity * dt;
      this.y += this.vy * dt;
      if (this.vy > 0 && this.y >= this.floor) {
        const dx = this.x - previousX;
        const dy = this.y - previousY;
        const start = Math.max(0, (this.floor - previousY) / dy);
        const end = Math.min(1, (this.room.height - 1 - previousY) / dy);
        // Sample the swept path at pixel resolution so fast debris cannot skip thin floor.
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), dy) * (end - start)));
        for (let i = 0; i <= steps && end >= start; i++) {
          const t = start + (end - start) * i / steps;
          const x = previousX + dx * t;
          const y = previousY + dy * t;
          if (!this.room.isFloor(x, y)) continue;
          this.x = x;
          this.y = this.floor = y;
          this.angularVelocity = 0;
          if (this.vy * bounce > SETTLE_SPEED) {
            this.vy = -this.vy * bounce;
          } else {
            this.vy = 0;
            this.resting = true;
          }
          break;
        }
      }
    }
  }
}

export class ParticleSystem {
  particles: Particle[] = [];
  private emissionSampler?: ParticleEmissionSampler;

  setEmissionSampler(sampler: ParticleEmissionSampler) {
    this.emissionSampler = sampler;
  }

  /**
   * Throws one or more sets' particles from `area` (room pixels), using visible pixels when an emitter
   * and sampler are available. `floorY` can set a landing line below the area, before adding `scatter`.
   * `direction` (-1 left, 1 right) adds each set's `forwardSpeed` that way.
   */
  burst(
    room: Room, setName: string | readonly string[], area: Rect & { floorY?: number; direction?: -1 | 0 | 1 },
    depth = area.y + area.h, emitter?: Prop, time = 0,
  ): Particle[] {
    const sets = (typeof setName === 'string' ? [setName] : setName).map(particleSet);
    const bottom = area.y + area.h;
    const floor = Math.max(bottom, area.floorY ?? bottom);
    const origins = emitter && this.emissionSampler ? this.emissionSampler(emitter, area, time) : undefined;
    const added: Particle[] = [];
    for (const set of sets) {
      if (origins?.length === 0) continue;
      const count = Math.floor(set.count[0] + random() * (set.count[1] - set.count[0] + 1));
      for (let i = 0; i < count; i++) {
        const at = origins
          ? origins[Math.floor(random() * origins.length)]
          : { x: area.x + random() * area.w, y: area.y + random() * area.h };
        const scatter = random() * set.scatter;
        added.push(new Particle(room, set, at, floor + scatter, depth + scatter, area.direction));
      }
    }
    this.particles.push(...added);
    if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    return added;
  }

  update(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0 || !this.particles.length) return;
    const physicsTime = Math.min(dt, MAX_STEP * MAX_STEPS);
    const steps = Math.ceil(physicsTime / MAX_STEP);
    const step = physicsTime / steps;
    for (const particle of this.particles) {
      particle.age += dt;
      if (particle.expired) continue;
      for (let i = 0; i < steps; i++) particle.step(step);
    }
    this.particles = this.particles.filter((particle) => !particle.expired);
  }

  in(room: Room): Particle[] {
    return this.particles.filter((particle) => particle.room === room);
  }

  clear(room?: Room) {
    this.particles = room ? this.particles.filter((particle) => particle.room !== room) : [];
  }
}
