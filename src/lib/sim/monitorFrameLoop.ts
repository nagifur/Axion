import { diagnosticError, type MonitorDiagnostics } from './monitorDiagnostics.ts';
import type { EventListeners } from './monitorDom.ts';

/** Schedules the feed, samples frame health and stops scheduling on failure or unmount. */
export function bindFrameLoop(
  listeners: EventListeners, diagnostics: MonitorDiagnostics, snapshot: () => Record<string, unknown>,
  notify: (message: string) => void, showFailure: () => void,
) {
  let draw: ((elapsed: number) => void) | null = null;
  let raf = 0;
  let last = performance.now();
  let lastFrameCompleted = last;
  let stalled = false;

  const resetClock = () => {
    last = performance.now();
    lastFrameCompleted = last;
    stalled = false;
  };
  listeners.listen(document, 'visibilitychange', resetClock);
  const watchdog = window.setInterval(() => {
    if (!draw || document.hidden || stalled) return;
    if (performance.now() - lastFrameCompleted > 5000) {
      stalled = true;
      diagnostics.record('frame-stall', 'No completed animation frame for over 5 seconds while visible.');
      diagnostics.checkpoint(snapshot, true);
      notify('The camera frame loop appears stalled. Copy diagnostics to investigate.');
    }
  }, 1000);

  function fail(error: unknown) {
    draw = null;
    diagnostics.record('simulation-error', diagnosticError(error));
    diagnostics.checkpoint(snapshot, true);
    notify('Simulation stopped with an error. Copy diagnostics to investigate.');
    console.error('Simulation stopped', error);
    showFailure();
  }

  function frame(now: number) {
    if (!draw) return;
    const started = performance.now();
    try {
      if (!document.hidden && now - last > 2000) {
        diagnostics.record('frame-gap', `${Math.round(now - last)}ms between frames; may indicate a freeze or browser suspension.`);
      }
      diagnostics.phase('frame-start');
      diagnostics.checkpoint(snapshot);
      // rAF timestamps can be slightly older than the performance.now() taken at boot.
      const elapsed = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      draw(elapsed);
      diagnostics.phase('frame-complete');
      lastFrameCompleted = performance.now();
      stalled = false;
      if (lastFrameCompleted - started > 1000) {
        diagnostics.record('slow-frame', `${Math.round(lastFrameCompleted - started)}ms to update and render.`);
        diagnostics.checkpoint(snapshot, true);
      }
      raf = requestAnimationFrame(frame);
    } catch (error) {
      fail(error);
    }
  }

  return {
    start(drawFrame: (elapsed: number) => void) {
      draw = drawFrame;
      resetClock();
      diagnostics.phase('ready');
      diagnostics.checkpoint(snapshot, true);
      raf = requestAnimationFrame(frame);
    },
    fail,
    dispose() {
      draw = null;
      cancelAnimationFrame(raf);
      window.clearInterval(watchdog);
    },
  };
}
