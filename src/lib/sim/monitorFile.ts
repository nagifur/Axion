import type { Agent } from './agent.ts';
import { Creature } from './creature.ts';
import { el } from './monitorDom.ts';
import type { Room } from './room.ts';
import { scheduleFor } from './schedule.ts';
import type { AgentStats } from './stats.ts';
import type { CameraActor, World } from './world.ts';

const SCHEDULE_LABELS = { work: 'Working hours', lunch: 'Lunch break', break: 'Short break', free: 'Free time' } as const;
const STAT_LABELS = [
  ['hp', 'HP'], ['stamina', 'Stamina'], ['magic', 'Magic'],
  ['hunger', 'Hunger'], ['thirst', 'Thirst'],
] as const;

/** True while the agent's badge ID is shared with an undetected shapeshifter. */
function hasTwin(world: World, agent: Agent) {
  return world.everyone().some((other) =>
    other !== agent && other.character.id === agent.character.id
    && ((other.impostor && !other.revealed) || (agent.impostor && !agent.revealed)));
}

/** The selected database file; only rebuilds its DOM when the file's facts change. */
export class MonitorFile {
  private key?: string;
  private activityNode: HTMLElement | null = null;
  private readonly statNodes = new Map<keyof AgentStats, HTMLElement>();

  constructor(
    private readonly node: HTMLElement,
    private readonly world: World,
    private readonly jumpTo: (room: Room) => void,
  ) {}

  render(actor: CameraActor | null, viewed: Room) {
    const world = this.world;
    const creature = actor instanceof Creature ? actor : null;
    const agent = actor instanceof Creature ? null : actor;
    const twin = agent ? hasTwin(world, agent) : false;
    const onScreen = actor?.room === viewed;
    const period = agent ? scheduleFor(agent.character, world.now()) : 'free';
    const key = creature ? `resident|${creature.character.id}|${onScreen}|${creature.contained}|${creature.away}|${creature.escaped}|${creature.room.id}` :
      agent ? `${agent.uid}|${agent.revealed}|${agent.removed}|${twin}|${agent.room.id}|${onScreen}|${period}|${agent.item?.type ?? ''}|${agent.inventory.map((item) => item.type).join(',')}` : '';
    if (key === this.key) {
      if (actor && this.activityNode) this.activityNode.textContent = agent?.removed ? 'Off camera' : actor.activity;
      if (agent) this.updateStats(agent);
      return;
    }
    this.key = key;
    this.statNodes.clear();

    if (!actor) {
      this.node.replaceChildren(el('p', 'monitor-file-empty', 'Select someone on the feed to pull up their file.'));
      this.activityNode = null;
      return;
    }

    const revealed = agent?.revealed && agent.impostor;
    const character = actor.character;
    const entity = creature?.character || revealed;
    const head = el('div', 'monitor-file-head');
    const image = entity ? entity.image : character.image;
    if (image) {
      const photo = el('img', 'monitor-file-photo');
      photo.src = image;
      photo.alt = '';
      photo.width = 72;
      photo.height = 72;
      head.append(photo);
    }
    const titleBlock = el('div', 'monitor-file-title');
    titleBlock.append(
      el('p', 'panel-kicker', creature ? `Entity file · ${creature.contained || creature.away ? 'Cell resident' : 'Containment breach'}` : revealed ? 'Entity file · Escaped' : `${character.href ? 'Personnel file' : 'Facility badge'} · ID ${agent!.character.employeeID}`),
      el('h3', undefined, entity ? `${entity.name} "${entity.nickname}"` : character.name),
      el('p', 'monitor-file-role', creature ? `${creature.character.containmentClass} class` :
        revealed ? `Shapeshifter posing as ${character.name}` : agent!.character.position),
    );
    head.append(titleBlock);
    this.node.style.setProperty('--file-tint', revealed ? 'var(--neon-red)' : character.tint);

    const stats = el('dl', 'monitor-file-stats');
    const stat = (label: string, value: string) => {
      const row = el('div');
      const dd = el('dd', undefined, value);
      row.append(el('dt', undefined, label), dd);
      stats.append(row);
      return dd;
    };
    if (creature) stat('Species', creature.character.species);
    if (agent && !revealed) {
      const character = agent.character;
      stat('Clearance', /^\d+$/.test(character.accessLevel) ? `Level ${character.accessLevel}` : character.accessLevel);
      stat('Species', character.species);
      const shift = agent.security && character.schedule?.[0];
      stat('Schedule', shift ? `Security watch ${shift.start}–${shift.end}` : SCHEDULE_LABELS[period]);
      if (agent.security) stat('Assigned post', `${agent.security.post.name} · ${agent.security.post.camera}`);
    }
    this.activityNode = stat('Status', agent?.removed ? 'Off camera' : actor.activity);
    if (agent) {
      stat('Item', agent.item?.type ?? 'Empty');
      stat('Inventory', agent.inventory.map((item) => item.type.replaceAll('_', ' ')).join(', ') || 'Empty');
      for (const [statKey, label] of STAT_LABELS) {
        const node = stat(label, '');
        if (statKey === 'hunger' || statKey === 'thirst') node.title = '0 = satisfied; maximum = urgent need';
        this.statNodes.set(statKey, node);
      }
      this.updateStats(agent);
    }
    const loose = creature && !creature.contained && !creature.away;
    if (loose) stat('Assigned cell', `${creature.home.name} · ${creature.home.camera}`);
    if (creature?.escaped) stat('Location', 'Outside the facility');
    else if (!agent?.removed) {
      const location = stat(creature && !loose ? 'Assigned cell' : 'Location', `${actor.room.name} · ${actor.room.camera}`);
      if (!onScreen) {
        const jump = el('button', 'monitor-file-jump', `View ${actor.room.camera} →`);
        jump.type = 'button';
        jump.addEventListener('click', () => this.jumpTo(actor.room));
        location.append(jump);
      }
    }

    const parts: HTMLElement[] = [head, stats];
    if (twin) parts.push(el('p', 'monitor-file-warning', 'A1: Duplicate badge signal detected for this ID.'));
    if (agent && !revealed && agent.character.traits.length) {
      const traits = el('ul', 'monitor-file-traits');
      traits.append(...agent.character.traits.map((trait) => el('li', undefined, trait)));
      parts.push(traits);
    }
    const href = entity ? entity.href : character.href;
    if (href) {
      const link = el('a', 'btn monitor-file-link', 'Open database file →');
      link.href = href;
      parts.push(link);
    }
    this.node.replaceChildren(...parts);
  }

  private updateStats(agent: Agent) {
    for (const [key, node] of this.statNodes) {
      const { current, max } = agent.stats[key];
      node.textContent = key === 'magic' && !agent.hasMagic ? 'None' : `${Math.round(current)} / ${max}`;
    }
  }
}
