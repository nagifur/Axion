import type { Agent } from './agent.ts';
import { el } from './monitorDom.ts';
import type { Room } from './room.ts';
import { scheduleFor } from './schedule.ts';
import type { AgentStats } from './stats.ts';
import type { World } from './world.ts';

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

/** The personnel file panel for the selected agent; only rebuilds its DOM when the file's facts change. */
export class PersonnelFile {
  private key = '';
  private activityNode: HTMLElement | null = null;
  private readonly statNodes = new Map<keyof AgentStats, HTMLElement>();

  constructor(
    private readonly node: HTMLElement,
    private readonly world: World,
    private readonly jumpTo: (room: Room) => void,
  ) {}

  render(agent: Agent | null, viewed: Room) {
    const world = this.world;
    const twin = agent ? hasTwin(world, agent) : false;
    const onScreen = agent ? agent.room === viewed : false;
    const period = agent ? scheduleFor(agent.character, world.now()) : 'free';
    const key = agent ? `${agent.uid}|${agent.revealed}|${agent.removed}|${twin}|${agent.room.id}|${onScreen}|${period}|${agent.item?.type ?? ''}` : '';
    if (key === this.key) {
      if (agent && this.activityNode) this.activityNode.textContent = agent.removed ? 'Off camera' : agent.activity;
      if (agent) this.updateStats(agent);
      return;
    }
    this.key = key;
    this.statNodes.clear();

    if (!agent) {
      this.node.replaceChildren(el('p', 'monitor-file-empty', 'Select someone on the feed to pull up their file.'));
      this.activityNode = null;
      return;
    }

    const revealed = agent.revealed && agent.impostor;
    const character = agent.character;
    const head = el('div', 'monitor-file-head');
    const image = revealed ? agent.impostor!.image : character.image;
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
      el('p', 'panel-kicker', revealed ? 'Entity file · Escaped' : `Personnel file · ID ${character.employeeID}`),
      el('h3', undefined, revealed ? `${agent.impostor!.name} "${agent.impostor!.nickname}"` : character.name),
      el('p', 'monitor-file-role', revealed ? `Shapeshifter posing as ${character.name}` : character.position),
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
    if (!revealed) {
      stat('Clearance', /^\d+$/.test(character.accessLevel) ? `Level ${character.accessLevel}` : character.accessLevel);
      stat('Species', character.species);
      stat('Schedule', SCHEDULE_LABELS[period]);
    }
    this.activityNode = stat('Status', agent.removed ? 'Off camera' : agent.activity);
    stat('Item', agent.item?.type ?? 'Empty');
    for (const [statKey, label] of STAT_LABELS) {
      const node = stat(label, '');
      if (statKey === 'hunger' || statKey === 'thirst') node.title = '0 = satisfied; maximum = urgent need';
      this.statNodes.set(statKey, node);
    }
    this.updateStats(agent);
    if (!agent.removed) {
      const location = stat('Location', `${agent.room.name} · ${agent.room.camera}`);
      if (!onScreen) {
        const jump = el('button', 'monitor-file-jump', `View ${agent.room.camera} →`);
        jump.type = 'button';
        jump.addEventListener('click', () => this.jumpTo(agent.room));
        location.append(jump);
      }
    }

    const parts: HTMLElement[] = [head, stats];
    if (twin) parts.push(el('p', 'monitor-file-warning', 'A1: Duplicate badge signal detected for this ID.'));
    if (!revealed && character.traits.length) {
      const traits = el('ul', 'monitor-file-traits');
      traits.append(...character.traits.map((trait) => el('li', undefined, trait)));
      parts.push(traits);
    }
    const link = el('a', 'btn monitor-file-link', 'Open database file →');
    link.href = revealed ? agent.impostor!.href : character.href;
    parts.push(link);
    this.node.replaceChildren(...parts);
  }

  private updateStats(agent: Agent) {
    for (const [key, node] of this.statNodes) {
      const { current, max } = agent.stats[key];
      node.textContent = key === 'magic' && !agent.hasMagic ? 'None' : `${Math.round(current)} / ${max}`;
    }
  }
}
