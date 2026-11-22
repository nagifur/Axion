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
