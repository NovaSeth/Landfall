// T-MG-21: the data-driven executor suggestion from receipts (SD-42): cells per (class x executor), a seeded
// percentile bootstrap, normalised labels, and the rule of 20 tasks and separated 90 % intervals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellStats, normaliseExecutor, suggestExecutors } from '../plugins/landfall/lib/receipts/executors.mjs';

const recs = (executor, n, pass, cls = 'standard', cost = 1000) =>
  Array.from({ length: n }, (_, i) => ({ task: `T-AB-${executor.length}${i}`, class: cls, executor, firstPass: i < pass, costMicroUsd: cost }));

test('labels are normalised: caw: and claude: become landfall:, a bare provider stays', () => {
  assert.equal(normaliseExecutor('caw:implementer'), 'landfall:implementer');
  assert.equal(normaliseExecutor('claude:implementer'), 'landfall:implementer');
  assert.equal(normaliseExecutor('landfall:implementer'), 'landfall:implementer');
  assert.equal(normaliseExecutor('codex'), 'codex');
  const cells = cellStats([...recs('caw:implementer', 3, 3), ...recs('claude:implementer', 2, 1)]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].executor, 'landfall:implementer');
  assert.equal(cells[0].tasks, 5);
});

test('a cell holds tasks, first-pass rate, cost per task and a 90 % interval', () => {
  const [c] = cellStats(recs('codex', 10, 8, 'standard', 2000));
  assert.equal(c.tasks, 10);
  assert.equal(c.firstPass.rate, 0.8);
  assert.equal(c.costPerTaskMicroUsd, 2000);
  assert.ok(c.firstPass.lo <= 0.8 && 0.8 <= c.firstPass.hi && c.firstPass.lo < c.firstPass.hi);
});

test('the same seed gives the same intervals; another seed may differ', () => {
  const data = recs('codex', 25, 15);
  assert.deepEqual(cellStats(data, { seed: 7 }), cellStats(data, { seed: 7 }));
  assert.equal(cellStats(data, { seed: 7 })[0].resamples, 1000);
});

const lines = (data, cls = 'standard') => suggestExecutors(cellStats(data), cls);
const of = (res, role) => res.find((r) => r.role === role);

test('19 tasks in a cell give no suggestion', () => {
  const r = of(lines([...recs('codex', 19, 19), ...recs('landfall:implementer', 20, 2)]), 'implementer');
  assert.equal(r.executor, null);
  assert.equal(r.reason, 'fewer than 20 receipts');
});

test('20 + 20 with a clear gap give a suggestion for the better one', () => {
  const r = of(lines([...recs('codex', 20, 20), ...recs('landfall:implementer', 20, 4)]), 'implementer');
  assert.equal(r.executor, 'codex');
  assert.ok(r.cells.length === 2);
});

test('20 + 20 with overlapping intervals give none', () => {
  const r = of(lines([...recs('codex', 20, 14), ...recs('landfall:implementer', 20, 12)]), 'implementer');
  assert.equal(r.executor, null);
  assert.equal(r.reason, 'intervals overlap');
});

test('another class does not mix in; a role without cells says fewer than 20 receipts', () => {
  const res = lines([...recs('codex', 20, 20, 'critical'), ...recs('landfall:implementer', 20, 0, 'critical')], 'standard');
  assert.equal(of(res, 'implementer').executor, null);
  assert.equal(of(res, 'reviewer').reason, 'fewer than 20 receipts');
});

test('the bootstrap interval is exported for reuse (lessons promotion)', async () => {
  const { intervalOf } = await import('../plugins/landfall/lib/receipts/executors.mjs');
  const a = intervalOf([1, 1, 1, 0], 1, 1000);
  assert.deepEqual(a, intervalOf([1, 1, 1, 0], 1, 1000));
  assert.ok(a.lo <= 0.75 && 0.75 <= a.hi);
});
