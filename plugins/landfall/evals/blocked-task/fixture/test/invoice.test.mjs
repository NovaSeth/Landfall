import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceTotal } from '../src/invoice.mjs';
import { taxRateBp } from '../src/tax.mjs';

test('adds regional tax to the subtotal', () => {
  const lines = [{ description: 'Widget', amountCents: 10000 }, { description: 'Gadget', amountCents: 2500 }];
  assert.deepEqual(invoiceTotal(lines, 'north'), { subtotal: 12500, tax: 906, total: 13406 });
});

test('unknown regions are rejected', () => {
  assert.throws(() => taxRateBp('mars'), RangeError);
});
