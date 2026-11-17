import type { Agent } from './agent.ts';
import type { Direction, Point, Room } from './room.ts';
import type { World } from './world.ts';
import { chance } from './random.ts';

export interface ElevatorRequest {
  type: 'depart' | 'arrive';
  agent: Agent;
  /** Which way the car is travelling, shown on the arrow lights. */
  direction: Direction;
  /** Floor on camera the rider is going to; unset means off camera. */
  destination?: Room;
  /** Doors are open and the rider can move. */
  board: boolean;
  /** Rider is fully in (depart) or out (arrive); doors may close. */
  ready: boolean;
  /** The rider changed plans before boarding; the car leaves without them. */
  cancelled: boolean;
  /** Assigned standing position in a multi-person car. */
  inside?: Point;
}

const ELEVATOR_SECONDS = {
  /** Car travelling to this floor before the doors open. */
  arriving: 1.4,
  /** Doors opening or closing fully. */
  doors: 0.7,
  /** Longest the doors wait for arriving riders to step out. */
  arrivalHold: 12,
  /** Car pulling away with the riders inside. */
  leaving: 1.2,
};
/** Standing positions inside a big car, in room pixels. */
const CAR_LAYOUT = { columns: 5, margin: 12, rowSpacing: 10 };

/** The doors, lights and queue of one elevator stop. */
export class Elevator {
  /** 0 = closed, 1 = fully open. */
  open = 0;
  phase: 'idle' | 'arriving' | 'opening' | 'holding' | 'closing' | 'leaving' = 'idle';
  light: Direction | null = null;
  private timer = 0;
  private queue: ElevatorRequest[] = [];
  private current: ElevatorRequest[] = [];
  readonly capacity: number;

  constructor(capacity = 1) {
    this.capacity = capacity;
  }

  request(type: ElevatorRequest['type'], agent: Agent, options: { direction?: Direction; destination?: Room } = {}): ElevatorRequest {
    const request: ElevatorRequest = {
      type, agent, board: false, ready: false, cancelled: false,
      destination: options.destination,
      direction: options.direction ?? (chance(0.5) ? 'up' : 'down'),
    };
    this.queue.push(request);
    return request;
  }

  get busy() {
    return this.phase !== 'idle' || this.queue.length > 0;
  }

  update(world: World, dt: number) {
    const current = this.current;
    if (this.phase === 'arriving' || this.phase === 'opening' || this.phase === 'holding') this.addRiders();
    switch (this.phase) {
      case 'idle': {
        this.light = null;
        this.queue = this.queue.filter((request) => !request.cancelled && !request.agent.removed);
        const next = this.queue.shift();
        if (!next) return;
        this.current = [next];
        this.assignSpot(next, 0);
        this.addRiders();
        this.phase = 'arriving';
        this.timer = ELEVATOR_SECONDS.arriving;
        this.light = next.direction;
        return;
      }
      case 'arriving':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.light = null;
          if (current.some((request) => !request.agent.removed && !request.cancelled)) this.phase = 'opening';
          else this.finish();
        }
        return;
      case 'opening':
        this.open = Math.min(1, this.open + dt / ELEVATOR_SECONDS.doors);
        if (this.open >= 1) {
          this.phase = 'holding';
          this.timer = ELEVATOR_SECONDS.arrivalHold;
          for (const request of current) request.board = true;
        }
        return;
      case 'holding': {
        this.timer -= dt;
        // Departing riders are always waited for (unless they change plans); arrivals have a safety timeout.
        const timedOut = this.timer <= 0 && current[0]?.type === 'arrive';
        if (current.every((request) => request.ready || request.cancelled || request.agent.removed) || timedOut) this.phase = 'closing';
        return;
      }
      case 'closing':
        this.open = Math.max(0, this.open - dt / ELEVATOR_SECONDS.doors);
        if (this.open > 0) return;
        const departing = current.find((request) => request.type === 'depart' && request.ready && !request.cancelled && !request.agent.removed);
        if (departing) {
          this.phase = 'leaving';
          this.timer = ELEVATOR_SECONDS.leaving;
          this.light = departing.direction;
        } else {
          this.finish();
        }
        return;
      case 'leaving':
        this.timer -= dt;
        if (this.timer <= 0) {
          for (const request of current) {
            if (request.ready && !request.cancelled && !request.agent.removed) world.elevatorDeparted(request.agent, request.destination);
          }
          this.finish();
        }
        return;
    }
  }

  private addRiders() {
    const first = this.current.find((request) => !request.cancelled && !request.agent.removed);
    if (!first) return;
    this.queue = this.queue.filter((request) => !request.cancelled && !request.agent.removed);
    for (let i = 0; i < this.queue.length && this.current.length < this.capacity;) {
      const request = this.queue[i];
      if (request.type !== first.type || request.direction !== first.direction || request.destination !== first.destination) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.assignSpot(request, this.current.length);
      request.board = this.phase === 'holding';
      this.current.push(request);
    }
  }

  private assignSpot(request: ElevatorRequest, index: number) {
    if (this.capacity === 1) return;
    const opening = request.agent.room.elevator!;
    request.inside = {
      x: Math.round(opening.x + CAR_LAYOUT.margin + (index % CAR_LAYOUT.columns) * (opening.w - CAR_LAYOUT.margin * 2) / (CAR_LAYOUT.columns - 1)),
      y: opening.inside.y - Math.floor(index / CAR_LAYOUT.columns) * CAR_LAYOUT.rowSpacing,
    };
    if (request.type === 'arrive') {
      request.agent.x = request.inside.x;
      request.agent.y = request.inside.y;
    }
  }

  private finish() {
    this.current = [];
    this.phase = 'idle';
    this.light = null;
  }
}
