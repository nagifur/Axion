import type { Agent } from './agent.ts';
import { Creature } from './creature.ts';
import { el } from './monitorDom.ts';
import type { Renderer } from './render.ts';
import type { Point, Room } from './room.ts';
import { entityDisplayName } from './roster.ts';
import { statusPopups } from './statusEffects.ts';
import type { CameraActor, World } from './world.ts';

/** A tag to place: anchored at a head position in room pixels, measured in layer pixels. */
export interface TagBox {
  head: Point;
  width: number;
  height: number;
  /** Larger depth is nearer the camera and is placed first. */
  depth: number;
}

const TAG_GAP = 2;
const TAG_MAX_NUDGES = 8;
const TAG_MIN_HEAD_Y = 8;

/**
 * Places tags front to back above their heads; any tag that would overlap one already placed moves up.
 * Returns each tag's centre-bottom anchor in layer pixels, in input order.
 */
export function layoutTags(tags: TagBox[], room: { width: number; height: number }, layer: { width: number; height: number }): Point[] {
  const positions: Point[] = new Array(tags.length);
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  const order = tags.map((_, index) => index).sort((a, b) => tags[b].depth - tags[a].depth);
  for (const index of order) {
    const tag = tags[index];
    const x = (tag.head.x / room.width) * layer.width;
    let bottom = (Math.max(TAG_MIN_HEAD_Y, tag.head.y - 1) / room.height) * layer.height;
    const left = x - tag.width / 2;
    const right = x + tag.width / 2;
    for (let attempt = 0; attempt < TAG_MAX_NUDGES; attempt++) {
      const hit = placed.find((box) => left < box.right + TAG_GAP && right > box.left - TAG_GAP && bottom - tag.height < box.bottom && bottom > box.top);
      if (!hit) break;
      bottom = hit.top - 1;
    }
    placed.push({ left, right, top: bottom - tag.height, bottom });
    positions[index] = { x, y: bottom };
  }
  return positions;
}

interface Tag {
  button: HTMLButtonElement;
  name: HTMLElement;
  bubble: HTMLElement;
  statuses: HTMLElement;
  statusKey: string;
  label: string;
}

export interface TagState {
  viewed: Room;
  showAll: boolean;
  hovered: CameraActor | null;
  selected: CameraActor | null;
  /** Head position override for the agent being dragged. */
  heldHead?: { agent: Agent; head: Point };
}

interface TagEvents {
  select(actor: CameraActor): void;
  hover(actor: CameraActor | null): void;
  hovered(): CameraActor | null;
}

/** Clickable name tags with speech and status popups over visible actors. */
export class NameTags {
  private readonly tags = new Map<CameraActor, Tag>();
  private readonly layer: HTMLElement;
  private readonly events: TagEvents;

  constructor(
    layer: HTMLElement,
    events: TagEvents,
  ) {
    this.layer = layer;
    this.events = events;
  }

  /** The agent whose (visible, not held) tag contains `element`. */
  actorFor(element: Element | null): CameraActor | null {
    if (!element) return null;
    for (const [agent, tag] of this.tags) {
      if ((agent instanceof Creature || !agent.held) && !tag.button.hidden && tag.button.contains(element)) return agent;
    }
    return null;
  }

  sync(world: World, renderer: Renderer, state: TagState) {
    // Swallowed prey keep their tag (and status popups) above the predator carrying them.
    const actors = [...world.actorsIn(state.viewed), ...world.swallowedIn(state.viewed)];
    for (const [agent, tag] of this.tags) {
      if (!actors.includes(agent)) {
        tag.button.remove();
        this.tags.delete(agent);
      }
    }

    const visible: { agent: CameraActor; button: HTMLButtonElement; head: Point }[] = [];
    for (const agent of actors) {
      const tag = this.tags.get(agent) ?? this.create(agent);
      const creature = agent instanceof Creature;
      const revealed = !creature && agent.revealed && agent.impostor;
      const label = revealed ? entityDisplayName(revealed) : creature ? entityDisplayName(agent.character) : agent.character.name;
      if (tag.label !== label) {
        tag.label = label;
        tag.name.textContent = label;
        tag.button.style.setProperty('--tag-tint', revealed ? 'var(--neon-red)' : agent.character.tint);
      }
      const popups = statusPopups(agent.statuses.active);
      const statusKey = JSON.stringify(popups);
      if (tag.statusKey !== statusKey) {
        tag.statusKey = statusKey;
        tag.statuses.replaceChildren(...popups.map(({ id, label, icon, color, background }) => {
          const box = el('span', 'monitor-tag-status');
          box.setAttribute('data-status', id);
          box.title = label;
          box.style.setProperty('--status-color', color);
          if (background) box.style.setProperty('--status-background', background);
          if (icon) {
            const image = el('img');
            image.src = icon;
            image.alt = label;
            image.width = image.height = 16;
            box.append(image);
          } else box.append(el('span', 'monitor-tag-status-mark'));
          return box;
        }));
      }
      const ariaLabel = [label, ...popups.map((popup) => popup.label), 'Open file'].join('. ');
      if (tag.button.getAttribute('aria-label') !== ariaLabel) tag.button.setAttribute('aria-label', ariaLabel);
      const bubble = creature ? '' : agent.bubble ?? '';
      if (tag.bubble.textContent !== bubble) tag.bubble.textContent = bubble;

      const held = !creature && agent.held;
      const shown = renderer.isVisible(agent, world) || (held && agent.room === state.viewed);
      const highlighted = agent === state.hovered || agent === state.selected;
      tag.button.hidden = !shown;
      tag.button.classList.toggle('is-held', held);
      tag.button.classList.toggle('is-quiet', !state.showAll && !highlighted);
      tag.button.classList.toggle('is-active', highlighted);
      if (shown) {
        const head = held && state.heldHead?.agent === agent ? state.heldHead.head : renderer.headPosition(agent);
        visible.push({ agent, button: tag.button, head });
      }
    }

    const positions = layoutTags(
      visible.map(({ agent, button, head }) => ({ head, width: button.offsetWidth, height: button.offsetHeight, depth: agent.y })),
      state.viewed,
      { width: this.layer.clientWidth, height: this.layer.clientHeight },
    );
    visible.forEach(({ button }, index) => {
      button.style.left = `${positions[index].x}px`;
      button.style.top = `${positions[index].y}px`;
    });
  }

  private create(agent: CameraActor): Tag {
    const button = el('button', 'monitor-tag');
    button.type = 'button';
    const bubble = el('span', 'monitor-tag-bubble');
    const statuses = el('span', 'monitor-tag-statuses');
    const name = el('span', 'monitor-tag-name');
    button.append(statuses, bubble, name);
    button.addEventListener('click', () => this.events.select(agent));
    button.addEventListener('pointerenter', () => this.events.hover(agent));
    button.addEventListener('pointerleave', () => { if (this.events.hovered() === agent) this.events.hover(null); });
    this.layer.append(button);
    const tag = { button, name, bubble, statuses, statusKey: '', label: '' };
    this.tags.set(agent, tag);
    return tag;
  }
}
