import type { Item } from './item.ts';
import { GRAVITY } from './particles.ts';
import type { Room } from './room.ts';
import { DEFAULT_SCALE } from './roster.ts';
import type { VoreActor, VoreOutcome, VoreType } from './vore.ts';

interface RemainsData {
  /** Who this was; clicking the pile pulls up their file. */
  actor: VoreActor;
  type: VoreType;
  outcome: Pick<VoreOutcome, 'look' | 'label' | 'disposal'>;
  items: Item[];
  /** Seconds before the predator prioritizes getting rid of them. */
  wait: number;
}

/** Landing bounces slower than this (pixels per second) settle the pile. */
const REMAINS_SETTLE_SPEED = 20;

/**
 * What is left of someone once they've been absorbed. No longer an agent or creature, but still the
 * same character profile (id, name, traits). The predator keeps it until it disposes of it, which
 * drops the pile on the floor with everything the prey was holding beside it.
 */
export class Remains {
  readonly actor: VoreActor;
  readonly type: VoreType;
  /** Artwork name: src/sim_assets/remains/<look>.png */
  readonly look: string;
  readonly label: string;
  readonly disposal: VoreOutcome['disposal'];
  /** Everything they were carrying or had stored; dropped next to the pile. */
  readonly items: Item[];
  wait: number;
  /** Where the pile lies (feet position) once disposed of. */
  x = 0;
  y = 0;
  /** While tossed: height above the floor line `y`, its velocities, and its draw depth (beside the thrower) until it lands. */
  flight: { lift: number; vx: number; vlift: number; bounce: number; depth: number } | null = null;

  constructor(data: RemainsData) {
    const { look, label, disposal } = data.outcome;
    this.actor = data.actor;
    this.type = data.type;
    this.look = look;
    const name = look.replaceAll('_', ' ');
    this.label = label ?? name.slice(0, 1).toUpperCase() + name.slice(1);
    this.disposal = disposal;
    this.items = data.items;
    this.wait = data.wait;
  }

  /** Throws the pile from `lift` pixels above its floor point; it slides only across walkable floor. */
  toss(lift: number, vx: number, vlift: number, bounce: number, depth: number) {
    this.flight = { lift: Math.max(0, lift), vx, vlift, bounce, depth };
  }

  step(room: Room, dt: number) {
    const flight = this.flight;
    if (!flight || dt <= 0) return;
    const x = this.x + flight.vx * dt;
    if (room.isWalkable({ x, y: this.y })) this.x = x;
    else flight.vx = 0;
    flight.vlift -= GRAVITY * dt;
    flight.lift += flight.vlift * dt;
    if (flight.lift > 0) return;
    flight.lift = 0;
    flight.vx *= 0.5;
    flight.vlift = -flight.vlift * flight.bounce;
    if (flight.vlift < REMAINS_SETTLE_SPEED) this.flight = null;
  }

  get character() {
    return this.actor.character;
  }

  get id() {
    return this.character.id;
  }

  get name() {
    return this.character.name;
  }

  /** Larger prey leave larger piles: artwork is authored for an average-height character. */
  get scale() {
    return (this.character.scale ?? DEFAULT_SCALE) / DEFAULT_SCALE;
  }

  get asset() {
    return `remains:${this.look}`;
  }
}
