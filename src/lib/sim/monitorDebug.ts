import type { Agent } from './agent.ts';
import type { EventDirector } from './events.ts';
import { nap, trip } from './tasks.ts';
import type { LogTone, World } from './world.ts';

/** What the debug buttons (shown with ?debug) can poke at. */
export interface DebugControls {
  world: World;
  director: EventDirector;
  log(text: string, tone?: LogTone): void;
  /** Agents on the camera being watched. */
  onCamera(): Agent[];
  /** Shifts the sim clock by `ms` from real time (0 = live). */
  setClockOffset(ms: number): void;
  /** Redraws the clock and status after a time change. */
  refreshClock(): void;
  toggleSpeed(): void;
  toggleEditor(): void;
  resetProgress(): void;
}

const TIME_PRESETS: { label: string; hour?: number; minute?: number }[] = [
  { label: 'Live' },
  { label: '09:00 Work', hour: 9, minute: 0 },
  { label: '10:05 Break', hour: 10, minute: 5 },
  { label: '12:30 Lunch', hour: 12, minute: 30 },
  { label: '18:00 Free', hour: 18, minute: 0 },
  { label: '02:00 Night', hour: 2, minute: 0 },
];

export function bindDebugPanel(panel: HTMLElement, controls: DebugControls) {
  const { world, director, log } = controls;
  panel.hidden = false;
  // Debug actions pick someone on the camera being watched.
  const idleAgent = () => controls.onCamera().filter((agent) => !agent.busy)[0];

  let timePreset = 0;
  const cycleTime = () => {
    timePreset = (timePreset + 1) % TIME_PRESETS.length;
    const { label, hour, minute } = TIME_PRESETS[timePreset];
    let offset = 0;
    if (hour !== undefined) {
      const target = new Date();
      target.setHours(hour, minute, 0, 0);
      offset = target.getTime() - Date.now();
    }
    controls.setClockOffset(offset);
    const button = panel.querySelector<HTMLButtonElement>('[data-debug="time"]');
    if (button) {
      button.textContent = `Time: ${label}`;
      button.setAttribute('aria-pressed', String(offset !== 0));
    }
    // Idle staff pick their next task under the new clock right away.
    for (const agent of world.agents) if (!agent.busy && !agent.removed) agent.setPlan(world, []);
    log(offset ? `Debug: clock set to ${label}.` : 'Debug: clock back to live time.', 'muted');
    controls.refreshClock();
  };

  const actions: Record<string, () => void> = {
    time: cycleTime,
    impostor: () => { if (!director.triggerImpostor(world)) log('Debug: no impostor possible right now.', 'muted'); },
    arrive: () => { if (!world.arrive()) log('Debug: everyone is already on the floor.', 'muted'); },
    nap: () => idleAgent()?.setPlan(world, [nap(20, 'front')]),
    trip: () => idleAgent()?.interrupt(world, trip()),
    announce: () => director.announce(world),
    speed: controls.toggleSpeed,
    props: controls.toggleEditor,
    reset: controls.resetProgress,
  };
  panel.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-debug]')?.dataset.debug;
    if (action) actions[action]?.();
  });
}
