const STORAGE_KEY = 'axion-monitor-diagnostics';
const MAX_ENTRIES = 100;
const MAX_TEXT = 2000;
const MAX_SAVED_SIZE = 250_000;
const CHECKPOINT_MS = 5000;

interface DiagnosticEntry {
  at: string;
  kind: string;
  message: string;
}

interface DiagnosticReport {
  format: 'axion-monitor-diagnostics-v1';
  startedAt: string;
  savedAt: string;
  snapshotAt: string | null;
  phase: string;
  environment: Record<string, string>;
  snapshot: Record<string, unknown>;
  entries: DiagnosticEntry[];
}

export function diagnosticError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)).slice(0, MAX_TEXT);
}

/** Bounded recorder; storage and time are injectable for tests. */
export class MonitorDiagnostics {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  private readonly notify: (message: string) => void;
  private readonly now: () => number;
  private readonly report: DiagnosticReport;
  private readonly previous: DiagnosticReport | null;
  private lastCheckpoint = -Infinity;
  private storageFailed = false;

  constructor(
    storage: Pick<Storage, 'getItem' | 'setItem'>,
    environment: Record<string, string>,
    notify: (message: string) => void,
    now: () => number = Date.now,
  ) {
    this.storage = storage;
    this.notify = notify;
    this.now = now;
    const at = new Date(now()).toISOString();
    this.report = {
      format: 'axion-monitor-diagnostics-v1', startedAt: at, savedAt: at,
      phase: 'boot', environment, snapshot: {}, snapshotAt: null, entries: [],
    };
    let previous: DiagnosticReport | null = null;
    try {
      const saved = storage.getItem(STORAGE_KEY);
      if (saved) {
        if (saved.length > MAX_SAVED_SIZE) throw new Error('Saved diagnostic report exceeds the size limit.');
        const parsed = JSON.parse(saved);
        if (parsed?.format !== this.report.format || !Array.isArray(parsed.entries) ||
          parsed.entries.length > MAX_ENTRIES || typeof parsed.savedAt !== 'string') {
          throw new Error('Saved diagnostic report has an invalid format.');
        }
        previous = parsed;
      }
    } catch (error) {
      this.record('storage-error', diagnosticError(error));
      notify('Previous diagnostics could not be read. Current diagnostics are still available.');
    }
    this.previous = previous;
    this.record('session', 'Monitoring session started.');
    this.persist();
  }

  phase(phase: string) {
    this.report.phase = phase;
  }

  record(kind: string, message: string) {
    this.report.entries.push({
      at: new Date(this.now()).toISOString(), kind, message: message.slice(0, MAX_TEXT),
    });
    if (this.report.entries.length > MAX_ENTRIES) this.report.entries.shift();
  }

  checkpoint(snapshot: () => Record<string, unknown>, force = false) {
    if (!force && this.now() - this.lastCheckpoint < CHECKPOINT_MS) return;
    this.report.snapshot = snapshot();
    this.lastCheckpoint = this.now();
    this.report.snapshotAt = new Date(this.lastCheckpoint).toISOString();
    this.persist();
  }

  persist() {
    if (this.storageFailed) return;
    this.report.savedAt = new Date(this.now()).toISOString();
    try {
      const text = JSON.stringify(this.report);
      if (text.length > MAX_SAVED_SIZE) throw new Error('Diagnostic report exceeds the storage size limit.');
      this.storage.setItem(STORAGE_KEY, text);
    } catch (error) {
      this.storageFailed = true;
      this.record('storage-error', diagnosticError(error));
      this.notify('Diagnostics cannot be saved in this browser. If debug mode is open, copy the report before reloading.');
    }
  }

  export(): string {
    return JSON.stringify({
      exportedAt: new Date(this.now()).toISOString(),
      current: this.report,
      previous: this.previous,
    }, null, 2);
  }
}

export function bindMonitorDiagnostics(root: HTMLElement, debugMode: boolean) {
  const controls = root.querySelector<HTMLElement>('[data-monitor-diagnostics]');
  const button = root.querySelector<HTMLButtonElement>('[data-monitor-copy-diagnostics]');
  const output = root.querySelector<HTMLTextAreaElement>('[data-monitor-diagnostics-output]');
  const status = root.querySelector<HTMLElement>('[data-monitor-diagnostics-status]');
  if (controls) controls.hidden = !debugMode;
  const notify = (message: string) => {
    if (status) {
      status.hidden = false;
      status.textContent = debugMode ? message : `${message} Diagnostics are available in ?debug.`;
    }
  };
  // Access localStorage inside the recorder's guarded operations (it can throw on access).
  const diagnostics = new MonitorDiagnostics({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  }, {
    browser: navigator.userAgent, path: location.pathname,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  }, notify);

  const onError = (event: ErrorEvent) => {
    diagnostics.record('uncaught-error', `${event.filename}:${event.lineno}:${event.colno}\n${diagnosticError(event.error ?? event.message)}`);
    diagnostics.persist();
    notify('A browser error was recorded. Copy diagnostics to investigate.');
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    diagnostics.record('unhandled-rejection', diagnosticError(event.reason));
    diagnostics.persist();
    notify('An unhandled promise error was recorded. Copy diagnostics to investigate.');
  };
  const onResourceError = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement || target instanceof HTMLScriptElement) {
      diagnostics.record('resource-error', target.src);
      diagnostics.persist();
      notify('An image or script failed to load. Copy diagnostics to investigate.');
    }
  };
  const onCopy = async () => {
    const text = diagnostics.export();
    if (output) {
      output.hidden = false;
      output.value = text;
    }
    try {
      await navigator.clipboard.writeText(text);
      notify('Diagnostics copied, including the previous session if available.');
    } catch (error) {
      diagnostics.record('clipboard-error', diagnosticError(error));
      notify('Clipboard unavailable. Select and copy the report below manually.');
      output?.focus();
      output?.select();
    }
  };
  const onVisibility = () => {
    diagnostics.record('visibility', document.visibilityState);
    diagnostics.persist();
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  root.addEventListener('error', onResourceError, true);
  document.addEventListener('visibilitychange', onVisibility);
  button?.addEventListener('click', onCopy);

  return {
    diagnostics, notify,
    dispose: () => {
      diagnostics.record('session', 'Monitoring session disposed normally.');
      diagnostics.persist();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      root.removeEventListener('error', onResourceError, true);
      document.removeEventListener('visibilitychange', onVisibility);
      button?.removeEventListener('click', onCopy);
    },
  };
}
