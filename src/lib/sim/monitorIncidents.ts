import { INCIDENT_TYPES, type Incident, type IncidentTracker } from './incidents.ts';
import { clock, el, EventListeners } from './monitorDom.ts';
import type { Room } from './room.ts';

function duration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${String(total % 60).padStart(2, '0')}s` : `${total}s`;
}

/** Renders the incident tracker: active incidents pinned first, then recently resolved ones. */
export class IncidentFeed {
  private readonly list: HTMLOListElement;
  private readonly empty: HTMLElement | null;
  private readonly count: HTMLElement | null;
  private readonly tracker: IncidentTracker;
  private readonly rooms = new Map<string, Room>();
  /** Expanded state the viewer chose, by incident ID; otherwise active incidents start expanded. */
  private readonly expanded = new Map<number, boolean>();
  private rendered = -1;

  constructor(
    list: HTMLOListElement, empty: HTMLElement | null, count: HTMLElement | null,
    tracker: IncidentTracker, listeners: EventListeners, showCamera: (room: Room) => void,
  ) {
    this.list = list;
    this.empty = empty;
    this.count = count;
    this.tracker = tracker;
    listeners.listen(list, 'click', (event) => {
      const button = (event.target as Element).closest<HTMLElement>('[data-incident-camera]');
      const room = button && this.rooms.get(button.dataset.incidentCamera ?? '');
      if (room) showCamera(room);
    });
    // `toggle` does not bubble, so listen while it is captured on the way down.
    listeners.listen(list, 'toggle', (event) => {
      const details = event.target as HTMLDetailsElement;
      const id = Number(details.dataset.incidentId);
      if (Number.isFinite(id)) this.expanded.set(id, details.open);
    }, true);
  }

  /** Status banner text for the most recent active incident, if any. */
  get status(): string | undefined {
    const latest = this.tracker.active.at(-1);
    return latest && INCIDENT_TYPES[latest.type].status;
  }

  sync() {
    if (this.rendered === this.tracker.version) return;
    this.rendered = this.tracker.version;
    const active = this.tracker.active.reverse();
    const resolved = this.tracker.incidents.filter((incident) => incident.resolvedAt !== undefined).reverse();
    this.rooms.clear();
    this.list.replaceChildren(...[...active, ...resolved].map((incident) => this.item(incident)));
    if (this.empty) this.empty.hidden = this.tracker.incidents.length > 0;
    if (this.count) this.count.textContent = active.length ? `${active.length} active` : '';
  }

  private item(incident: Incident) {
    const resolved = incident.resolvedAt !== undefined;
    const item = el('li', `monitor-incident ${resolved ? 'is-resolved' : 'is-active'}`);
    const details = el('details');
    details.dataset.incidentId = String(incident.id);
    details.open = this.expanded.get(incident.id) ?? !resolved;

    const summary = el('summary', 'monitor-incident-summary');
    const state = resolved
      ? `${incident.outcome ?? 'Resolved'} · ${duration(incident.resolvedAt! - incident.openedAt)}`
      : 'Active';
    summary.append(
      el('span', 'monitor-incident-state', state),
      el('strong', 'monitor-incident-title', incident.title),
      el('time', 'monitor-log-time', clock(incident.steps[0]?.at ?? new Date())),
    );

    const steps = el('ol', 'monitor-incident-steps');
    for (const step of incident.steps) {
      const line = el('li', `monitor-log-line is-${step.tone}`);
      line.append(el('time', 'monitor-log-time', clock(step.at)), el('span', 'monitor-incident-text', step.text));
      if (step.room) {
        this.rooms.set(step.room.id, step.room);
        const button = el('button', 'monitor-incident-camera', step.room.camera);
        button.type = 'button';
        button.dataset.incidentCamera = step.room.id;
        button.title = `Show ${step.room.label} ${step.room.name}`;
        line.append(button);
      }
      steps.append(line);
    }
    details.append(summary, steps);
    item.append(details);
    return item;
  }
}
