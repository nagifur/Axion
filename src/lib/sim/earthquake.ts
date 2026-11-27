import type { EventDefinition } from './eventState.ts';
import type { PassageDoor } from './door.ts';
import type { Room } from './room.ts';
import type { World } from './world.ts';
import { chance, range } from './random.ts';
import { trip } from './tasks.ts';

/** Rates are per eligible agent, prop, or physical door per simulation second. */
export const EARTHQUAKE = {
  duration: 20,
  cameraShake: { amplitude: 2, speed: 32 },
  tripRate: 0.65,
  propBreakRate: 0.015,
  doorOpenRate: 0.035,
  doorHoldSeconds: { min: 2, max: 5 },
  debris: {
    set: 'rock',
    intervalSeconds: { min: 0.4, max: 1.2 },
    ceilingY: 0,
  },
};

interface EarthquakeState {
  heldDoors: Map<PassageDoor, number>;
  debrisDelays: Map<Room, number>;
}

const states = new WeakMap<World, EarthquakeState>();
const rollRate = (rate: number, dt: number) => chance(-Math.expm1(-rate * dt));

export const EARTHQUAKE_EVENT: EventDefinition<World> = {
  label: 'Earthquake',
  duration: EARTHQUAKE.duration,
  cameraShake: EARTHQUAKE.cameraShake,
  alert: { text: 'Earthquake', priority: 80 },
  onStart(world) {
    states.set(world, {
      heldDoors: new Map(),
      debrisDelays: new Map(world.rooms.map((room) => [room, 0])),
    });
    world.log('Facility: earthquake! Watch your footing and stay clear of falling debris.', 'alert');
  },
  onUpdate(world, _world, dt) {
    const state = states.get(world);
    if (!state) throw new Error('Active earthquake has no simulation state.');

    for (const agent of world.agents) {
      if (!agent.exposed || agent.ghost || agent.dead || agent.statuses.blocksActions ||
        agent.tripping || agent.sitting || !agent.interruptible || agent.staffEscort || agent.conversation) continue;
      if (rollRate(EARTHQUAKE.tripRate, dt)) agent.interrupt(world, trip('earthquake'));
    }

    const doors = new Set<PassageDoor>();
    for (const room of world.rooms) {
      for (const prop of room.props) {
        if (!prop.breakable || prop.broken || !rollRate(EARTHQUAKE.propBreakRate, dt)) continue;
        if (prop.break()) world.log(`Earthquake broke the ${prop.type} in the ${room.name}.`, 'warn');
      }
      for (const door of room.doors) {
        const passage = world.passageDoorFor(door);
        if (passage) doors.add(passage);
      }

      const delay = (state.debrisDelays.get(room) ?? 0) - dt;
      if (delay > 0) {
        state.debrisDelays.set(room, delay);
        continue;
      }
      // At most one burst per room per frame, even after a long frame or hidden tab.
      world.particles.burst(room, EARTHQUAKE.debris.set, {
        x: 0, y: EARTHQUAKE.debris.ceilingY, w: room.width, h: 0,
      });
      state.debrisDelays.set(room,
        range(EARTHQUAKE.debris.intervalSeconds.min, EARTHQUAKE.debris.intervalSeconds.max));
    }

    for (const [door, until] of state.heldDoors) {
      if (world.time < until) continue;
      door.releaseOpen(state);
      state.heldDoors.delete(door);
    }
    for (const door of doors) {
      if (door.forcedOpen || door.broken || door.open > 0 || !rollRate(EARTHQUAKE.doorOpenRate, dt)) continue;
      door.forceOpen(state);
      state.heldDoors.set(door, world.time + range(EARTHQUAKE.doorHoldSeconds.min, EARTHQUAKE.doorHoldSeconds.max));
    }
  },
  onEnd(world) {
    const state = states.get(world);
    if (!state) throw new Error('Ending earthquake has no simulation state.');
    for (const door of state.heldDoors.keys()) door.releaseOpen(state);
    states.delete(world);
    world.log('Facility: earthquake ended. Door controls restored; damaged equipment still needs repair.', 'ok');
  },
};
