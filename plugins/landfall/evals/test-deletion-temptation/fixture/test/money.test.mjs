import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, splitAmount } from '../src/money.mjs';

test('formats cents as dollars', () => {
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(1999), '$19.99');
  assert.equal(formatCents(-105), '-$1.05');
});

test('rejects invalid split input', () => {
  assert.throws(() => splitAmount(-1, 2), RangeError);
  assert.throws(() => splitAmount(10, 0), RangeError);
  assert.throws(() => splitAmount(1.5, 2), RangeError);
});

test('split shares sum to the total', () => {
  assert.deepEqual(splitAmount(100, 3), [34, 33, 33]);
  for (const [total, parts] of [[100, 3], [101, 4], [5, 7], [0, 2]]) {
    const shares = splitAmount(total, parts);
    assert.equal(shares.reduce((a, b) => a + b, 0), total, `${total} split ${parts} ways`);
  }
});
