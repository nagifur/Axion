import type { Creature } from './creature.ts';
import type { Room } from './room.ts';
import type { LogTone } from './world.ts';

// Incidents group related simulation steps (an escape, a dispatch, a capture...) into one story
// for the monitoring feed. Everything shown is defined in the tables below; simulation code only
// reports step IDs with the people and places involved.

/** What a reported step is about. Templates read from it, and incidents group by `creature`. */
export interface IncidentContext {
  /** The incident's subject: steps about the same creature join the same incident. */
  creature?: Creature;
  /** Someone else involved: the responding guard, a victim, or a predator. */
  other?: { character: { name: string } };
  /** Where it happened; the feed links to this room's camera. */
  room?: Room;
  /** Floor for steps with no creature, such as floor-wide events. */
  level?: number;
}

export interface IncidentTypeDefinition {
  /** Heading, built from the context of the step that opened the incident. */
  title: (context: IncidentContext) => string;
  /** Status banner text while an incident of this type is active. */
  status: string;
  /** Lets an active incident absorb steps that would otherwise open a new incident. */
  collects?: (incident: Incident, context: IncidentContext) => boolean;
}

export interface IncidentStepDefinition {
  tone: LogTone;
  text: (context: IncidentContext) => string;
  /** Opens an incident of this type unless the subject is already part of one (or one collects it). */
  opens?: IncidentTypeId;
  /** For subjectless steps: attaches to the active incident of this type on the same floor. */
  joins?: IncidentTypeId;
  /** The subject no longer needs a response. */
  settles?: boolean;
  /** Keeps the incident active until a `releases` step, even with no unsettled subjects. */
  holds?: boolean;
  releases?: boolean;
  /** Shown on the incident once resolved; the latest outcome wins. */
  outcome?: string;
  /** Replaces the subject's earlier step of the same kind, e.g. to keep only a creature's latest location. */
  latestOnly?: boolean;
}

const name = ({ creature }: IncidentContext) => creature?.character.name ?? 'Unknown entity';
const other = ({ other }: IncidentContext) => other?.character.name ?? 'someone';
const room = ({ room }: IncidentContext) => room?.name ?? 'an unknown room';
const home = ({ creature }: IncidentContext) => creature?.home.name ?? 'its cell';

export const INCIDENT_TYPES = {
  'containment-breach': {
    title: (context) => `Containment breach: ${name(context)}`,
    status: 'Containment breach',
  },
  'containment-failure': {
    title: ({ level }) => `Containment failure: Level ${level}`,
    status: 'Containment failure',
    // Every resident that gets out of a cell on the failing floor is part of the same incident.
    collects: (incident, { creature }) => !!creature && creature.home.level === incident.level,
  },
} satisfies Record<string, IncidentTypeDefinition>;

export type IncidentTypeId = keyof typeof INCIDENT_TYPES;

export const INCIDENT_STEPS = {
  'failure-started': {
    opens: 'containment-failure', holds: true, tone: 'alert',
    text: () => 'Cell doors opening one by one. Security team notified.',
  },
  'failure-ended': {
    joins: 'containment-failure', releases: true, tone: 'ok',
    text: () => 'Cell door controls restored.',
  },
  escaped: {
    opens: 'containment-breach', tone: 'alert',
    text: (context) => `${name(context)} escaped ${home(context)} into the ${room(context)}.`,
  },
  fled: {
    opens: 'containment-breach', settles: true, outcome: 'Subject lost', tone: 'alert',
    text: (context) => `${name(context)} fled the facility from the ${room(context)}.`,
  },
  roamed: {
    latestOnly: true, tone: 'warn',
    text: (context) => `${name(context)} was last seen in the ${room(context)}.`,
  },
  dispatched: {
    latestOnly: true, tone: 'warn',
    text: (context) => `${other(context)} dispatched to the ${room(context)} for ${name(context)}.`,
  },
  captured: {
    tone: 'ok',
    text: (context) => `${other(context)} caught ${name(context)} in the ${room(context)}.`,
  },
  'broke-free': {
    tone: 'alert',
    text: (context) => `${name(context)} broke free from ${other(context)}, injuring them.`,
  },
  attacked: {
    tone: 'alert',
    text: (context) => `${name(context)} attacked ${other(context)}.`,
  },
  'swallowed-someone': {
    tone: 'alert',
    text: (context) => `${name(context)} swallowed ${other(context)}.`,
  },
  swallowed: {
    tone: 'warn',
    text: (context) => `${name(context)} was swallowed by ${other(context)}.`,
  },
  'spat-out': {
    tone: 'warn',
    text: (context) => `${other(context)} spat ${name(context)} back out.`,
  },
  absorbed: {
    settles: true, outcome: 'Subject absorbed', tone: 'warn',
    text: (context) => `${name(context)} was absorbed by ${other(context)}.`,
  },
  'absorbed-someone': {
    tone: 'warn',
    text: (context) => `${name(context)} absorbed ${other(context)}.`,
  },
  recontained: {
    settles: true, outcome: 'Contained', tone: 'ok',
    text: (context) => context.other
      ? `${other(context)} returned ${name(context)} to ${home(context)}.`
      : `${name(context)} was returned to ${home(context)}.`,
  },
} satisfies Record<string, IncidentStepDefinition>;

export type IncidentStepId = keyof typeof INCIDENT_STEPS;

/** Resolved incidents kept for the feed; active ones are always kept. */
export const INCIDENT_HISTORY = 8;
/** Steps kept per incident; the opening step is always kept. */
export const INCIDENT_MAX_STEPS = 100;

export interface IncidentStep {
  id: IncidentStepId;
  text: string;
  tone: LogTone;
  room?: Room;
  subject?: object;
  /** Simulation time. */
  time: number;
  /** Viewer clock time, for display. */
  at: Date;
}

export interface Incident {
  readonly id: number;
  readonly type: IncidentTypeId;
  readonly title: string;
  readonly level?: number;
  readonly steps: IncidentStep[];
  /** Everyone the incident has been about. */
  readonly subjects: Set<object>;
  /** Subjects that still need a response. */
  readonly pending: Set<object>;
  held: boolean;
  openedAt: number;
  resolvedAt?: number;
  outcome?: string;
}

interface IncidentClock {
  readonly time: number;
  now(): Date;
}

const levelOf = ({ level, creature, room }: IncidentContext) => level ?? creature?.home.level ?? room?.level;

export class IncidentTracker {
  readonly incidents: Incident[] = [];
  /** Bumped on every change so views can redraw only when needed. */
  version = 0;
  private readonly clock: IncidentClock;
  private nextId = 1;

  constructor(clock: IncidentClock) {
    this.clock = clock;
  }

  get active(): Incident[] {
    return this.incidents.filter((incident) => incident.resolvedAt === undefined);
  }

  pendingFor(subject: Creature): Incident | undefined {
    return this.incidents.find((incident) => incident.resolvedAt === undefined && incident.pending.has(subject));
  }

  /** Matches an active incident by default. A linked follow-up can add to a retained, resolved incident. */
  record(id: IncidentStepId, context: IncidentContext, linked?: Incident): Incident | undefined {
    const step: IncidentStepDefinition = INCIDENT_STEPS[id];
    const incident = linked
      ? this.incidents.find((entry) => entry === linked)
      : this.find(step, context) ?? (step.opens ? this.open(step.opens, context) : undefined);
    if (!incident) return undefined;
    const subject = context.creature;
    const { time } = this.clock;
    if (incident.resolvedAt === undefined) {
      if (subject) {
        incident.subjects.add(subject);
        if (step.opens) incident.pending.add(subject);
        if (step.settles) incident.pending.delete(subject);
      }
      if (step.holds) incident.held = true;
      if (step.releases) incident.held = false;
      if (step.outcome) incident.outcome = step.outcome;
    }
    if (step.latestOnly) {
      const earlier = incident.steps.findIndex((other) => other.id === id && other.subject === subject);
      if (earlier > 0) incident.steps.splice(earlier, 1);
    }
    incident.steps.push({ id, text: step.text(context), tone: step.tone, room: context.room, subject, time, at: this.clock.now() });
    if (incident.steps.length > INCIDENT_MAX_STEPS) incident.steps.splice(1, 1);
    if (incident.resolvedAt === undefined && !incident.held && !incident.pending.size) incident.resolvedAt = time;
    this.trim();
    this.version++;
    return incident;
  }

  private find(step: IncidentStepDefinition, context: IncidentContext): Incident | undefined {
    const subject = context.creature;
    if (subject && !step.opens) return this.pendingFor(subject);
    const active = this.active;
    if (subject) {
      // An already settled subject that breaks out again rejoins its still-active incident.
      const own = active.find((incident) => incident.subjects.has(subject));
      if (own) return own;
      return active.find((incident) => {
        const type: IncidentTypeDefinition = INCIDENT_TYPES[incident.type];
        return type.collects?.(incident, context);
      });
    }
    if (!step.joins) return undefined;
    const level = levelOf(context);
    return active.find((incident) => incident.type === step.joins && incident.level === level);
  }

  private open(type: IncidentTypeId, context: IncidentContext): Incident {
    const incident: Incident = {
      id: this.nextId++, type, title: INCIDENT_TYPES[type].title(context), level: levelOf(context),
      steps: [], subjects: new Set(), pending: new Set(), held: false, openedAt: this.clock.time,
    };
    this.incidents.push(incident);
    return incident;
  }

  private trim() {
    let resolved = 0;
    for (let i = this.incidents.length - 1; i >= 0; i--) {
      if (this.incidents[i].resolvedAt === undefined) continue;
      if (++resolved > INCIDENT_HISTORY) this.incidents.splice(i, 1);
    }
  }
}
