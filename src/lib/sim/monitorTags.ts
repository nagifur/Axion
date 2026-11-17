import type { Agent } from './agent.ts';
import { el } from './monitorDom.ts';
import type { Renderer } from './render.ts';
import type { Point, Room } from './room.ts';
import type { World } from './world.ts';

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

interface Tag { button: HTMLButtonElement; name: HTMLElement; bubble: HTMLElement; label: string }

export interface TagState {
  viewed: Room;
  showAll: boolean;
  hovered: Agent | null;
  selected: Agent | null;
  /** Head position override for the agent being dragged. */
  heldHead?: { agent: Agent; head: Point };
}

/** Clickable name tags (with speech bubbles) floating over every visible agent. */
export class NameTags {
  private readonly tags = new Map<Agent, Tag>();

  constructor(
    private readonly layer: HTMLElement,
    private readonly events: { select(agent: Agent): void; hover(agent: Agent | null): void; hovered(): Agent | null },
  ) {}

  /** The agent whose (visible, not held) tag contains `element`. */
  agentFor(element: Element | null): Agent | null {
    if (!element) return null;
    for (const [agent, tag] of this.tags) {
      if (!agent.held && !tag.button.hidden && tag.button.contains(element)) return agent;
    }
    return null;
  }

  sync(world: World, renderer: Renderer, state: TagState) {
    for (const [agent, tag] of this.tags) {
      if (!world.agents.includes(agent)) {
        tag.button.remove();
        this.tags.delete(agent);
      }
    }

    const visible: { agent: Agent; button: HTMLButtonElement; head: Point }[] = [];
    for (const agent of world.agents) {
      const tag = this.tags.get(agent) ?? this.create(agent);
      const revealed = agent.revealed && agent.impostor;
      const label = revealed ? `${agent.impostor!.name} "${agent.impostor!.nickname}"` : agent.character.name;
      if (tag.label !== label) {
        tag.label = label;
        tag.name.textContent = label;
        tag.button.setAttribute('aria-label', `${label}. Open file`);
        tag.button.style.setProperty('--tag-tint', revealed ? 'var(--neon-red)' : agent.character.tint);
      }
      const bubble = agent.bubble ?? '';
      if (tag.bubble.textContent !== bubble) tag.bubble.textContent = bubble;

      const shown = renderer.isVisible(agent, world) || (agent.held && agent.room === state.viewed);
      const highlighted = agent === state.hovered || agent === state.selected;
      tag.button.hidden = !shown;
      tag.button.classList.toggle('is-held', agent.held);
      tag.button.classList.toggle('is-quiet', !state.showAll && !highlighted);
      tag.button.classList.toggle('is-active', highlighted);
      if (shown) {
        const head = agent.held && state.heldHead?.agent === agent ? state.heldHead.head : renderer.headPosition(agent);
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

  private create(agent: Agent): Tag {
    const button = el('button', 'monitor-tag');
    button.type = 'button';
    const bubble = el('span', 'monitor-tag-bubble');
    const name = el('span', 'monitor-tag-name');
    button.append(bubble, name);
    button.addEventListener('click', () => this.events.select(agent));
    button.addEventListener('pointerenter', () => this.events.hover(agent));
    button.addEventListener('pointerleave', () => { if (this.events.hovered() === agent) this.events.hover(null); });
    this.layer.append(button);
    const tag = { button, name, bubble, label: '' };
    this.tags.set(agent, tag);
    return tag;
  }
}
