import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PositionHistory } from '../src/game/PositionHistory';

test('history interpolates between samples and clamps outside the range', () => {
  const h = new PositionHistory(1000);
  h.push(0, { x: 0, y: 0, z: 0 });
  h.push(100, { x: 10, y: 0, z: 0 }, true);
  h.push(200, { x: 10, y: 0, z: 10 });
  assert.deepEqual(h.sample(50)?.pos, { x: 5, y: 0, z: 0 });
  assert.equal(h.sample(80)?.crouch, true);
  assert.deepEqual(h.sample(150)?.pos, { x: 10, y: 0, z: 5 });
  assert.deepEqual(h.sample(-50)?.pos, { x: 0, y: 0, z: 0 });
  assert.deepEqual(h.sample(999)?.pos, { x: 10, y: 0, z: 10 });
});

test('old samples are dropped beyond the keep window', () => {
  const h = new PositionHistory(300);
  for (let t = 0; t <= 1000; t += 33) h.push(t, { x: t, y: 0, z: 0 });
  // Asking for t=0 now clamps to the oldest kept sample (~700 ms).
  assert.ok(h.sample(0)!.pos.x >= 600);
});

test('empty history returns null; clear() forgets everything', () => {
  const h = new PositionHistory(1000);
  assert.equal(h.sample(5), null);
  h.push(1, { x: 1, y: 1, z: 1 });
  h.clear();
  assert.equal(h.sample(1), null);
});
