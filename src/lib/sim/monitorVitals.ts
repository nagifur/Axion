import { el } from './monitorDom.ts';
import { followCameraRoom } from './monitorFollow.ts';
import { actorIdentity } from './monitorTags.ts';
import type { Room } from './room.ts';
import { hasMagic, type LiveStats } from './stats.ts';
import {
  shownStatuses, STATUS_EFFECTS, STATUS_POLARITIES,
  type ActiveStatusEffect, type StatusPolarity,
} from './statusEffects.ts';
import type { CameraActor, World } from './world.ts';

/** One colour band of a vital bar, used while the filled fraction is at least `from`. */
export interface VitalTier {
  from: number;
  color: string;
  /** Pulses the bar to draw the eye. */
  critical?: boolean;
}

export interface VitalBarDefinition {
  stat: keyof LiveStats;
  label: string;
  /** `major` is the thick headline bar; `minor` bars are the thin resource lines beneath it. */
  size: 'major' | 'minor';
  /** Ordered from the highest `from` down; the first tier the fraction reaches wins. */
  tiers: readonly VitalTier[];
  /** Leaves the bar out for actors without this pool. */
  shownFor?(actor: CameraActor): boolean;
}

/** The bars in the selected-actor HUD, top to bottom. Add a pool here to show it. */
export const VITAL_BARS: readonly VitalBarDefinition[] = [
  {
    stat: 'hp',
    label: 'Health',
    size: 'major',
    tiers: [
      { from: 0.6, color: '#4dff7c' },
      { from: 0.3, color: '#ffa23a' },
      { from: 0, color: '#ff4552', critical: true },
    ],
  },
  { stat: 'stamina', label: 'Stamina', size: 'minor', tiers: [{ from: 0, color: '#3ddc97' }] },
  {
    stat: 'magic',
    label: 'Mana',
    size: 'minor',
    tiers: [{ from: 0, color: '#5b8dff' }],
    shownFor: (actor) => hasMagic(actor.stats),
  },
];

export interface VitalReading {
  definition: VitalBarDefinition;
  current: number;
  max: number;
  /** current / max, clamped to 0–1. */
  fraction: number;
  tier: VitalTier;
}

export function vitalTier(tiers: readonly VitalTier[], fraction: number): VitalTier {
  return tiers.find((tier) => fraction >= tier.from) ?? tiers[tiers.length - 1];
}

/** The bars an actor shows right now, with their fill and colour. */
export function readVitals(actor: CameraActor, bars: readonly VitalBarDefinition[] = VITAL_BARS): VitalReading[] {
  return bars.filter((bar) => bar.shownFor?.(actor) ?? true).map((definition) => {
    const { current, max } = actor.stats[definition.stat];
    const fraction = max > 0 ? Math.min(1, Math.max(0, current / max)) : 0;
    return { definition, current, max, fraction, tier: vitalTier(definition.tiers, fraction) };
  });
}

export interface StatusBadge {
  id: string;
  label: string;
  polarity: StatusPolarity;
  /** The effect's popup artwork, if it has any. */
  icon?: string;
  /** The effect's popup colour, else its polarity colour. */
  color: string;
  /** Fraction of a timed effect still to run; null while permanent. */
  timeLeft: number | null;
  /** Irreversible: it never ends, so the HUD sets it apart above the passing effects. */
  permanent: boolean;
}

/** One HUD row per visible effect, in the order they were applied. */
export function statusBadges(active: readonly ActiveStatusEffect[]): StatusBadge[] {
  return shownStatuses(active).map(({ id, label, polarity, remaining, duration }) => {
    const definition = STATUS_EFFECTS[id];
    return {
      id, label, polarity,
      icon: definition?.popup?.icon,
      color: definition?.popup?.color ?? STATUS_POLARITIES[polarity].color,
      timeLeft: remaining !== null && duration ? Math.min(1, remaining / duration) : null,
      permanent: !!definition?.irreversible,
    };
  });
}

/** Text shown after the name when the actor isn't on the watched camera. */
export function vitalsLocation(world: World, actor: CameraActor, viewed: Room): string {
  const room = followCameraRoom(world, actor);
  if (room === viewed) return '';
  return room ? room.camera : 'Off camera';
}

/** How long the damage trail waits after a drop, then how fast (bar fractions per second) it catches up. */
export const TRAIL_HOLD_MS = 450;
export const TRAIL_CATCH_UP_PER_SECOND = 0.8;

/**
 * Where a bar's pale damage trail sits this frame. It never drops below the fill, holds still for
 * TRAIL_HOLD_MS after it last matched the fill, then drains toward it, so steady drains stay readable too.
 */
export function trailFraction(trail: number, fill: number, sinceMatchedMs: number, elapsedMs: number): number {
  if (fill >= trail) return fill;
  if (sinceMatchedMs < TRAIL_HOLD_MS) return trail;
  return Math.max(fill, trail - (TRAIL_CATCH_UP_PER_SECOND * elapsedMs) / 1000);
}

/** Delay between rows sliding in together when a new actor is selected. */
const STATUS_STAGGER_MS = 70;
const STATUS_LEAVE_ANIMATION = 'monitor-vitals-status-out';
/** Longest frame gap the damage trail catches up across (e.g. after the tab was hidden). */
const MAX_TRAIL_STEP_MS = 100;

const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

interface BarView {
  node: HTMLElement;
  fill: HTMLElement;
  trail: HTMLElement;
  width: string;
  trailWidth: string;
  /** Fraction the damage trail shows. */
  trailLevel: number;
  /** When (ms) the trail last matched the fill. */
  trailMatched: number;
  color: string;
  value: string;
}

interface StatusRow {
  node: HTMLElement;
  timer: HTMLElement;
  leaving: boolean;
  timeLeft: string;
}

/**
 * The selected actor's name, vitals and status effects, overlaid in a corner of the feed.
 * Status rows slide in when an effect starts and out when it ends.
 */
export class VitalsHud {
  private actor: CameraActor | null = null;
  private barKey = '';
  private nameText = '';
  private whereText = '';
  private lastFrame: number | null = null;
  private readonly bars = new Map<keyof LiveStats, BarView>();
  private readonly rows = new Map<string, StatusRow>();
  private readonly root: HTMLElement;
  private readonly world: World;
  private readonly head: HTMLElement;
  private readonly name: HTMLElement;
  private readonly where: HTMLElement;
  private readonly barList: HTMLElement;
  /** Irreversible effects sit in their own group above the ones that will pass. */
  private readonly permanentList: HTMLElement;
  private readonly statusList: HTMLElement;

  constructor(root: HTMLElement, world: World) {
    this.root = root;
    this.world = world;
    this.head = el('div', 'monitor-vitals-head');
    this.name = el('span', 'monitor-vitals-name');
    this.where = el('span', 'monitor-vitals-where');
    this.head.append(this.name, this.where);
    this.barList = el('div', 'monitor-vitals-bars');
    this.permanentList = el('ul', 'monitor-vitals-statuses is-permanent');
    this.permanentList.setAttribute('aria-label', 'Permanent effects');
    this.statusList = el('ul', 'monitor-vitals-statuses');
    this.statusList.setAttribute('aria-label', 'Status effects');
    root.replaceChildren(this.head, this.barList, this.permanentList, this.statusList);
    root.setAttribute('aria-hidden', 'true');
  }

  /** `now` is a real-time clock in ms; it only paces the damage trail. */
  render(actor: CameraActor | null, viewed: Room, now = performance.now()) {
    const changed = actor !== this.actor;
    this.actor = actor;
    if (changed) {
      this.root.classList.toggle('is-shown', !!actor);
      this.root.setAttribute('aria-hidden', String(!actor));
    }
    // Deselecting keeps the last contents so the panel slides away intact.
    if (!actor) return;
    if (changed) {
      this.clearStatuses();
      this.barKey = '';
      this.replay(this.head, 'is-new');
    }

    const { name, tint } = actorIdentity(actor);
    if (name !== this.nameText) {
      this.nameText = name;
      this.name.textContent = name;
      this.root.style.setProperty('--vitals-tint', tint);
    }
    const where = vitalsLocation(this.world, actor, viewed);
    if (where !== this.whereText) {
      this.whereText = where;
      this.where.textContent = where;
    }
    this.syncBars(actor, now, Math.min(MAX_TRAIL_STEP_MS, Math.max(0, now - (this.lastFrame ?? now))));
    this.lastFrame = now;
    this.syncStatuses(actor, changed);
  }

  private syncBars(actor: CameraActor, now: number, elapsed: number) {
    const readings = readVitals(actor);
    const key = readings.map(({ definition, max }) => `${definition.stat}:${max}`).join('|');
    if (key !== this.barKey) {
      this.barKey = key;
      this.bars.clear();
      this.barList.replaceChildren(...readings.map((reading) => this.createBar(reading, now)));
    }
    for (const reading of readings) {
      const bar = this.bars.get(reading.definition.stat);
      if (bar) this.updateBar(bar, reading, now, elapsed);
    }
  }

  private createBar({ definition, max, fraction }: VitalReading, now: number): HTMLElement {
    const node = el('div', `monitor-vitals-bar is-${definition.size}`);
    node.setAttribute('role', 'meter');
    node.setAttribute('aria-label', definition.label);
    node.setAttribute('aria-valuemin', '0');
    node.setAttribute('aria-valuemax', String(max));
    node.setAttribute('data-stat', definition.stat);
    // The trail lingers behind the fill so sudden damage stays readable for a moment.
    const trail = el('span', 'monitor-vitals-trail');
    const fill = el('span', 'monitor-vitals-fill');
    node.append(trail, fill);
    this.bars.set(definition.stat, {
      node, fill, trail, width: '', trailWidth: '', trailLevel: fraction, trailMatched: now, color: '', value: '',
    });
    return node;
  }

  private updateBar(bar: BarView, { fraction, current, tier }: VitalReading, now: number, elapsed: number) {
    const width = percent(fraction);
    if (width !== bar.width) {
      bar.width = width;
      bar.fill.style.width = width;
    }
    bar.trailLevel = trailFraction(bar.trailLevel, fraction, now - bar.trailMatched, elapsed);
    if (bar.trailLevel === fraction) bar.trailMatched = now;
    const trailWidth = percent(bar.trailLevel);
    if (trailWidth !== bar.trailWidth) {
      bar.trailWidth = trailWidth;
      bar.trail.style.width = trailWidth;
    }
    if (tier.color !== bar.color) {
      bar.color = tier.color;
      bar.node.style.setProperty('--vital-color', tier.color);
      bar.node.classList.toggle('is-critical', !!tier.critical);
    }
    const value = String(Math.max(0, Math.round(current)));
    if (value !== bar.value) {
      bar.value = value;
      bar.node.setAttribute('aria-valuenow', value);
    }
  }

  private syncStatuses(actor: CameraActor, stagger: boolean) {
    const badges = statusBadges(actor.statuses.active);
    const ids = new Set(badges.map(({ id }) => id));
    for (const [id, row] of this.rows) if (!ids.has(id) && !row.leaving) this.leave(id, row);
    badges.forEach((badge, index) => {
      let row = this.rows.get(badge.id);
      if (row?.leaving) {
        // Reapplied while sliding out: slide straight back in.
        row.leaving = false;
        row.node.classList.toggle('is-leaving', false);
      }
      if (!row) {
        row = this.createRow(badge, stagger ? index : 0);
        this.rows.set(badge.id, row);
        (badge.permanent ? this.permanentList : this.statusList).append(row.node);
      }
      const timeLeft = badge.timeLeft === null ? '' : badge.timeLeft.toFixed(3);
      if (timeLeft !== row.timeLeft) {
        row.timeLeft = timeLeft;
        row.timer.hidden = badge.timeLeft === null;
        if (badge.timeLeft !== null) row.timer.style.transform = `scaleX(${timeLeft})`;
      }
    });
  }

  private createRow({ id, label, polarity, icon, color, permanent }: StatusBadge, order: number): StatusRow {
    const node = el('li', `monitor-vitals-status${permanent ? ' is-permanent' : ''}`);
    node.setAttribute('data-status', id);
    node.setAttribute('data-polarity', polarity);
    node.style.setProperty('--status-color', color);
    node.style.setProperty('--polarity-color', STATUS_POLARITIES[polarity].color);
    node.style.setProperty('--enter-delay', `${order * STATUS_STAGGER_MS}ms`);
    if (icon) {
      const image = el('img', 'monitor-vitals-status-icon');
      image.src = icon;
      image.alt = '';
      image.width = image.height = 18;
      node.append(image);
    } else node.append(el('span', 'monitor-vitals-status-mark'));
    const sign = el('span', 'monitor-vitals-sign');
    sign.setAttribute('aria-hidden', 'true');
    const text = el('span', 'monitor-vitals-status-label');
    text.append(el('span', 'sr-only', `${STATUS_POLARITIES[polarity].label}: `), document.createTextNode(label));
    const timer = el('span', 'monitor-vitals-status-timer');
    timer.hidden = true;
    text.append(timer);
    node.append(sign, text);
    if (permanent) node.append(el('span', 'monitor-vitals-permanent-tag', 'Permanent'));
    return { node, timer, leaving: false, timeLeft: '' };
  }

  /** Plays the slide-out animation, then removes the row unless the effect came back meanwhile. */
  private leave(id: string, row: StatusRow) {
    row.leaving = true;
    row.node.classList.toggle('is-leaving', true);
    const done = () => {
      if (!row.leaving || this.rows.get(id) !== row) return;
      row.node.remove();
      this.rows.delete(id);
    };
    const animations = (row.node.getAnimations?.() ?? []).filter((animation) =>
      !('animationName' in animation) || animation.animationName === STATUS_LEAVE_ANIMATION);
    if (animations.length) Promise.all(animations.map((animation) => animation.finished)).then(done, done);
    else done();
  }

  private clearStatuses() {
    for (const row of this.rows.values()) row.node.remove();
    this.rows.clear();
  }

  /** Restarts a one-shot CSS animation class. */
  private replay(node: HTMLElement, className: string) {
    node.classList.toggle(className, false);
    void node.offsetWidth;
    node.classList.toggle(className, true);
  }
}
