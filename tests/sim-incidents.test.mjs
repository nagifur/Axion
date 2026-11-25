import assert from 'node:assert/strict';
import test from 'node:test';
import { IncidentTracker, INCIDENT_HISTORY } from '../src/lib/sim/incidents.ts';

const room = (id, level = 3) => ({ id, name: id, level, camera: id });
const creature = (name, level = 3) => ({ character: { name }, home: { name: `${name} cell`, level } });
const guard = { character: { name: 'Guard' } };

function tracker() {
  const clock = { time: 0, now: () => new Date(2026, 0, 1, 12) };
  return { clock, incidents: new IncidentTracker(clock) };
}

test('a breach groups its response steps and resolves once the creature is contained', () => {
  const { clock, incidents } = tracker();
  const lizard = creature('Lizard');
  const hall = room('hall');
  assert.equal(incidents.record('dispatched', { creature: lizard, other: guard, room: hall }), undefined,
    'follow-up steps never open incidents');

  const incident = incidents.record('escaped', { creature: lizard, room: hall });
  clock.time = 30;
  incidents.record('dispatched', { creature: lizard, other: guard, room: hall });
  incidents.record('captured', { creature: lizard, other: guard, room: hall });
  assert.deepEqual(incidents.active, [incident]);
  clock.time = 75;
  incidents.record('recontained', { creature: lizard, other: guard });

  assert.equal(incident.title, 'Containment breach: Lizard');
  assert.deepEqual(incident.steps.map(({ id }) => id), ['escaped', 'dispatched', 'captured', 'recontained']);
  assert.equal(incident.steps[0].room, hall);
  assert.equal(incident.steps[3].text, 'Guard returned Lizard to Lizard cell.');
  assert.equal(incident.resolvedAt, 75);
  assert.equal(incident.outcome, 'Contained');
  assert.deepEqual(incidents.active, []);

  incidents.record('attacked', { creature: lizard, other: guard });
  assert.equal(incident.steps.length, 4, 'steps after resolution do not reopen or extend the incident');
  incidents.record('escaped', { creature: lizard, room: hall });
  assert.equal(incidents.incidents.length, 2, 'a later breach is a new incident');
});

test('a floor-wide failure collects escapes on its floor and stays open until every escapee is settled', () => {
  const { incidents } = tracker();
  const [first, second, elsewhere] = [creature('First'), creature('Second'), creature('Elsewhere', 2)];
  const failure = incidents.record('failure-started', { level: 3 });
  incidents.record('escaped', { creature: first, room: room('hall') });
  incidents.record('escaped', { creature: second, room: room('hall') });
  const breach = incidents.record('escaped', { creature: elsewhere, room: room('upstairs', 2) });
  assert.notEqual(breach, failure, 'other floors get their own incident');
  assert.equal(failure.title, 'Containment failure: Level 3');

  incidents.record('absorbed', { creature: first, other: guard });
  incidents.record('roamed', { creature: second, room: room('hall') });
  incidents.record('roamed', { creature: second, room: room('lobby') });
  const seen = failure.steps.filter(({ id }) => id === 'roamed');
  assert.deepEqual(seen.map(({ text }) => text), ['Second was last seen in the lobby.'], 'only the latest sighting is kept');
  assert.equal(failure.steps.at(-1), seen[0]);
  incidents.record('failure-ended', { level: 3 });
  assert.equal(failure.resolvedAt, undefined, 'the second escapee is still loose');
  incidents.record('fled', { creature: second, room: room('exit') });
  assert.notEqual(failure.resolvedAt, undefined);
  assert.equal(failure.outcome, 'Subject lost');
  assert.deepEqual(incidents.active, [breach]);
});

test('a failure with no escapes resolves when the event ends, and old resolved incidents are trimmed', () => {
  const { incidents } = tracker();
  const failure = incidents.record('failure-started', { level: 1 });
  incidents.record('failure-ended', { level: 2 });
  assert.equal(failure.resolvedAt, undefined, 'only the same floor ends it');
  incidents.record('failure-ended', { level: 1 });
  assert.notEqual(failure.resolvedAt, undefined);

  const loose = creature('Loose');
  incidents.record('escaped', { creature: loose });
  for (let i = 0; i < INCIDENT_HISTORY + 2; i++) {
    const subject = creature(`Runner ${i}`);
    incidents.record('fled', { creature: subject });
  }
  assert.equal(incidents.incidents.length, INCIDENT_HISTORY + 1, 'active incidents are never trimmed');
  assert.equal(incidents.active[0].title, 'Containment breach: Loose');
});
