import assert from 'node:assert/strict';
import test from 'node:test';
import { setRandomSource, weightedPick } from '../src/lib/sim/random.ts';

test('weighted selection skips zero and invalid weights and handles a zero roll', (t) => {
  t.after(() => setRandomSource(null));
  setRandomSource(() => 0);
  assert.equal(weightedPick([
    { id: 'zero', weight: 0 },
    { id: 'negative', weight: -1 },
    { id: 'selected', weight: 1 },
  ])?.id, 'selected');

  setRandomSource(() => 0.5);
  assert.equal(weightedPick([{ weight: 0 }, { weight: -1 }, { weight: Number.NaN }]), undefined);
});

test('weighted selection can assign a boundary roll to the next positive weight', (t) => {
  t.after(() => setRandomSource(null));
  const options = [{ id: 'first', weight: 5 }, { id: 'second', weight: 95 }];
  setRandomSource(() => 0.049999);
  assert.equal(weightedPick(options, { boundary: 'next' })?.id, 'first');
  setRandomSource(() => 0.05);
  assert.equal(weightedPick(options)?.id, 'first', 'existing callers keep their boundary behavior');
  assert.equal(weightedPick(options, { boundary: 'next' })?.id, 'second');
});
