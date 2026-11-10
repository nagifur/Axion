import { exitThroughDoor } from './agent';
import type { SimCharacter, SimImpostor } from './roster';
import { DOORS } from './room';
import type { World } from './world';

export interface Achievement {
  id: string;
  title: string;
  description: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-contact', title: 'First Contact', description: 'Pull up a personnel file from the live feed.' },
  { id: 'doppelganger', title: 'Doppelgänger', description: 'Unmask a shapeshifter posing as staff.' },
  { id: 'rude-awakening', title: 'Rude Awakening', description: 'Wake up someone napping on shift.' },
  { id: 'watch-your-step', title: 'Watch Your Step', description: 'Catch a clumsy employee tripping on camera.' },
  { id: 'ghost-story', title: 'Ghost Story', description: 'See someone leave without using a door.' },
  { id: 'full-roster', title: 'Full Roster', description: 'Identify every employee that works on Level 1.' },
  { id: 'night-shift', title: 'Night Shift', description: 'Watch the feed between midnight and 5 AM.' },
];

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const range = (min: number, max: number) => min + Math.random() * (max - min);

// Lines are taken from the Level 1 page and facility rules.
const ANNOUNCEMENTS: ((roster: SimCharacter[]) => string)[] = [
  () => 'Reminder: database access is only permitted from designated workstations.',
  () => 'All communications on this level are live monitored and logged.',
  () => 'The cafeteria is open 24/7. Meals are included in employee benefits.',
  () => 'Dormitory residents: please observe quiet hours between shifts.',
  () => 'Data server visits require a valid, documented reason.',
  () => 'Repeated attempts to access information above your clearance will be reported.',
  () => 'Interns are reminded not to enter containment enclosures unescorted.',
  (roster) => `Employee of the week: ${pick(roster).name}. Keep up the good work.`,
];

export class EventDirector {
  private nextImpostor = range(90, 180);
  private nextAnnouncement = range(20, 40);
  readonly impostors: SimImpostor[];

  constructor(impostors: SimImpostor[]) {
    this.impostors = impostors;
  }

  update(world: World, dt: number) {
    this.nextAnnouncement -= dt;
    if (this.nextAnnouncement <= 0) {
      this.nextAnnouncement = range(70, 140);
      this.announce(world);
    }

    this.nextImpostor -= dt;
    if (this.nextImpostor <= 0) {
      this.nextImpostor = this.triggerImpostor(world) ? range(240, 420) : range(20, 40);
    }

    for (const agent of world.agents) {
      if (!agent.impostor || agent.revealed) continue;
      // The disguise slips now and then: the eyes flash red for a moment.
      if (Math.random() < dt * 0.12) agent.eyeFlash = 0.35;
      if (world.time > agent.expiresAt && !agent.leaving) {
        agent.leaving = true;
        agent.setPlan(world, [exitThroughDoor(pick(DOORS))]);
      }
    }
  }

  announce(world: World) {
    if (!world.roster.length) return;
    world.log(`A1: ${pick(ANNOUNCEMENTS)(world.roster)}`);
  }

  /** A shapeshifting entity walks in disguised as someone already on the floor. */
  triggerImpostor(world: World): boolean {
    if (!this.impostors.length || world.agents.some((agent) => agent.impostor && !agent.removed)) return false;
    const victims = world.agents.filter((agent) => !agent.impostor && !agent.leaving && !agent.ghost);
    if (!victims.length) return false;

    const victim = pick(victims).character;
    let roll = Math.random() * this.impostors.reduce((sum, item) => sum + item.weight, 0);
    const impostor = this.impostors.find((item) => (roll -= item.weight) <= 0) ?? this.impostors[0];

    const agent = world.arriveByDoor(victim, undefined, impostor);
    agent.expiresAt = world.time + range(80, 120);
    world.log(`A1: Duplicate badge scan. ID ${victim.employeeID} (${victim.name}) is already on Level 1.`, 'warn');
    return true;
  }
}
