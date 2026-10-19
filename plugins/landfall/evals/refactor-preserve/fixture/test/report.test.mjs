import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/report.mjs';

test('no orders', () => {
  assert.equal(buildReport([]), 'No orders.');
});

test('totals per customer with a discount tier', () => {
  const orders = [
    { customer: 'beta', amountCents: 60000 },
    { customer: 'alpha', amountCents: 1250 },
    { customer: 'alpha', amountCents: 500, refunded: true },
  ];
  assert.equal(
    buildReport(orders),
    ['alpha: $7.50 (1 orders)', 'beta: $570.00 (1 orders, discount $30.00)', 'TOTAL: $577.50', 'REFUNDS: $5.00'].join('\n'),
  );
});
