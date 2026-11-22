import assert from 'node:assert/strict';
import test from 'node:test';
import { EventListeners } from '../src/lib/sim/monitorDom.ts';

test('disposing and remounting monitor listeners does not duplicate handlers', () => {
  const target = new EventTarget();
  let calls = 0;
  const dispatch = () => target.dispatchEvent(new Event('tick'));

  const firstMount = new EventListeners();
  firstMount.listen(target, 'tick', () => calls++);
  dispatch();
  assert.equal(calls, 1);
  firstMount.dispose();
  dispatch();
  assert.equal(calls, 1);

  const secondMount = new EventListeners();
  secondMount.listen(target, 'tick', () => calls++);
  dispatch();
  assert.equal(calls, 2);
  secondMount.dispose();
});
