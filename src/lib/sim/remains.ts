import type { Item } from './item.ts';
import { DEFAULT_SCALE, type SimCharacter, type SimCreature } from './roster.ts';
import type { VoreActor, VoreType } from './vore.ts';

export interface RemainsData {
  /** Who this was; clicking the pile pulls up their file. */
  actor: VoreActor;
  kind: 'agent' | 'creature';
  type: VoreType;
  look: string;
  items: Item[];
  /** Seconds before the predator prioritizes getting rid of them. */
  wait: number;
}

/**
 * What is left of someone once they've been absorbed. No longer an agent or creature, but still the
 * same character profile (id, name, traits). The predator keeps it until it disposes of it, which
 * drops the pile on the floor with everything the prey was holding beside it.
 */
export class Remains {
  readonly actor: VoreActor;
  readonly character: SimCharacter | SimCreature;
  readonly kind: 'agent' | 'creature';
  readonly type: VoreType;
  /** Artwork name: src/sim_assets/remains/<look>.png */
  readonly look: string;
  /** Everything they were carrying or had stored; dropped next to the pile. */
  readonly items: Item[];
  wait: number;
  /** Where the pile lies (feet position) once disposed of. */
  x = 0;
  y = 0;

  constructor(data: RemainsData) {
    this.actor = data.actor;
    this.character = data.actor.character;
    this.kind = data.kind;
    this.type = data.type;
    this.look = data.look;
    this.items = data.items;
    this.wait = data.wait;
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
