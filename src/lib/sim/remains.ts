import type { Item } from './item.ts';
import type { SimCharacter, SimCreature } from './roster.ts';
import type { VoreType } from './vore.ts';

export interface RemainsData {
  character: SimCharacter | SimCreature;
  kind: 'agent' | 'creature';
  type: VoreType;
  look: string;
  items: Item[];
  /** Seconds before the predator gets rid of them. */
  wait: number;
}

/**
 * What is left of someone once they've been absorbed. No longer an agent or creature, but still the
 * same character profile (id, name, traits). The predator keeps it until it disposes of it, which
 * drops the pile on the floor with everything the prey was holding beside it.
 */
export class Remains {
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
    this.character = data.character;
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

  get asset() {
    return `remains:${this.look}`;
  }
}
