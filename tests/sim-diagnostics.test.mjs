import assert from 'node:assert/strict';
import test from 'node:test';
import { bindMonitorDiagnostics, MonitorDiagnostics, diagnosticError } from '../src/lib/sim/monitorDiagnostics.ts';

function fixture() {
  let time = 0;
  const saved = new Map();
  const warnings = [];
  const storage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  const create = () => new MonitorDiagnostics(storage, { browser: 'test' }, (message) => warnings.push(message), () => time);
  return { create, saved, warnings, advance: (ms) => { time += ms; } };
}

test('reload preserves the prior session error, phase, and state instead of overwriting them', () => {
  const f = fixture();
  const first = f.create();
  first.phase('world.update');
  first.record('simulation-error', diagnosticError(new Error('bad route')));
  first.checkpoint(() => ({ camera: 'offices', agents: [{ activity: 'Walking', x: 12 }] }), true);
  const saved = JSON.parse(first.export()).current;
  f.advance(1000);
  const next = f.create();
  next.record('incident:ok', 'New feed ready');
  next.persist();
  const report = JSON.parse(next.export());
  assert.deepEqual(report.previous, saved);
  assert.equal(report.previous.phase, 'world.update');
  assert.match(report.previous.entries.at(-1).message, /Error: bad route\n.*Error: bad route/s);
  assert.equal(report.previous.snapshot.agents[0].x, 12);
  assert.equal(report.current.entries.at(-1).message, 'New feed ready');
  assert.equal(f.warnings.length, 0);
});

test('checkpoints sample lazily every five seconds, with immediate error checkpoints', () => {
  const f = fixture();
  const recorder = f.create();
  let samples = 0;
  const sample = () => ({ sample: ++samples });
  recorder.checkpoint(sample);
  f.advance(4999);
  recorder.checkpoint(sample);
  assert.equal(samples, 1);
  f.advance(1);
  recorder.checkpoint(sample);
  assert.equal(samples, 2);
  recorder.checkpoint(sample, true);
  assert.equal(samples, 3);
  assert.equal(JSON.parse(recorder.export()).current.snapshotAt, '1970-01-01T00:00:05.000Z');
});

test('report entries and messages remain bounded and keep the newest events', () => {
  const f = fixture();
  const recorder = f.create();
  for (let i = 0; i < 200; i++) recorder.record('incident', `${i}:${'x'.repeat(5000)}`);
  recorder.persist();
  const report = JSON.parse(recorder.export()).current;
  assert.equal(report.entries.length, 100);
  assert.ok(report.entries[0].message.startsWith('100:'));
  assert.ok(report.entries.at(-1).message.startsWith('199:'));
  assert.ok(report.entries.every((entry) => entry.message.length <= 2000));
  assert.ok([...f.saved.values()][0].length <= 250_000);
  assert.equal(f.warnings.length, 0);
});

test('blocked storage is reported once, without losing the in-memory error log', () => {
  const warnings = [];
  let writes = 0;
  const recorder = new MonitorDiagnostics({
    getItem: () => { throw new Error('Storage blocked'); },
    setItem: () => { writes++; throw new Error('Storage blocked'); },
  }, {}, (message) => warnings.push(message));
  recorder.record('simulation-error', 'Still copyable');
  recorder.persist();
  recorder.persist();
  const report = JSON.parse(recorder.export());
  assert.equal(report.previous, null);
  assert.equal(report.current.entries.at(-1).message, 'Still copyable');
  assert.equal(writes, 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings.at(-1), /copy the report before reloading/);
});

test('malformed saved data is reported explicitly and replaced with a usable current report', () => {
  const warnings = [];
  let saved = '{"format":"axion-monitor-diagnostics-v1","entries":{}}';
  const recorder = new MonitorDiagnostics({
    getItem: () => saved,
    setItem: (_key, value) => { saved = value; },
  }, {}, (message) => warnings.push(message));
  assert.equal(JSON.parse(recorder.export()).previous, null);
  assert.equal(JSON.parse(saved).format, 'axion-monitor-diagnostics-v1');
  assert.equal(warnings.length, 1);
  assert.equal(JSON.parse(saved).entries[0].kind, 'storage-error');
});

test('diagnostics controls require debug mode while normal sessions still record errors', async (t) => {
  const saved = new Map();
  let copied = '';
  const window = new EventTarget();
  window.innerWidth = 800;
  window.innerHeight = 600;
  const document = new EventTarget();
  const location = { pathname: '/monitoring' };
  const globals = {
    window, document, location,
    navigator: { userAgent: 'test', clipboard: { writeText: async (text) => { copied = text; } } },
    localStorage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const makeRoot = () => {
    const root = new EventTarget();
    const controls = { hidden: true };
    const button = new EventTarget();
    const output = { hidden: true, value: '' };
    const status = { hidden: true, textContent: '' };
    const nodes = {
      '[data-monitor-diagnostics]': controls,
      '[data-monitor-copy-diagnostics]': button,
      '[data-monitor-diagnostics-output]': output,
      '[data-monitor-diagnostics-status]': status,
    };
    root.querySelector = (selector) => nodes[selector] ?? null;
    return { root, controls, button, output, status };
  };

  const normal = makeRoot();
  const normalBinding = bindMonitorDiagnostics(normal.root, false);
  assert.equal(normal.controls.hidden, true);
  normalBinding.diagnostics.record('simulation-error', 'Test error in normal mode');
  normalBinding.diagnostics.checkpoint(() => ({ camera: 'offices' }), true);
  normalBinding.notify('Simulation stopped.');
  assert.equal(normal.status.hidden, false);
  assert.match(normal.status.textContent, /\?debug/);
  normalBinding.dispose();

  const debug = makeRoot();
  const debugBinding = bindMonitorDiagnostics(debug.root, true);
  assert.equal(debug.controls.hidden, false);
  debug.button.dispatchEvent(new Event('click'));
  await Promise.resolve();
  const report = JSON.parse(copied);
  assert.ok(report.previous.entries.some((entry) => entry.message === 'Test error in normal mode'));
  assert.equal(report.previous.snapshot.camera, 'offices');
  assert.equal(debug.output.hidden, false);
  assert.equal(debug.output.value, copied);
  assert.match(debug.status.textContent, /Diagnostics copied/);
  debugBinding.dispose();
});
