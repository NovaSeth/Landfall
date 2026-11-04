// T-MG-21: the data-driven executor suggestion from receipts (SD-42): cells per (class x executor), a seeded
// percentile bootstrap, normalised labels, and the rule of 20 tasks and separated 90 % intervals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cellStats, normaliseExecutor, suggestExecutors } from '../plugins/landfall/lib/receipts/executors.mjs';

const P = JSON.parse(readFileSync(new URL('../plugins/landfall/lib/name.json', import.meta.url), 'utf8')).plugin;

const recs = (executor, n, pass, cls = 'standard', cost = 1000) =>
  Array.from({ length: n }, (_, i) => ({ task: `T-AB-${executor.length}${i}`, class: cls, executor, firstPass: i < pass, costMicroUsd: cost }));

test('labels are normalised: caw: and claude: become the current prefix, a bare provider stays', () => {
  assert.equal(normaliseExecutor('caw:implementer'), `${P}:implementer`);
  assert.equal(normaliseExecutor('claude:implementer'), `${P}:implementer`);
  assert.equal(normaliseExecutor(`${P}:implementer`), `${P}:implementer`);
  assert.equal(normaliseExecutor('codex'), 'codex');
  const cells = cellStats([...recs('caw:implementer', 3, 3), ...recs('claude:implementer', 2, 1)]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].executor, `${P}:implementer`);
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
  const r = of(lines([...recs('codex', 19, 19), ...recs(`${P}:implementer`, 20, 2)]), 'implementer');
  assert.equal(r.executor, null);
  assert.equal(r.reason, 'fewer than 20 receipts');
});

test('20 + 20 with a clear gap give a suggestion for the better one', () => {
  const r = of(lines([...recs('codex', 20, 20), ...recs(`${P}:implementer`, 20, 4)]), 'implementer');
  assert.equal(r.executor, 'codex');
  assert.ok(r.cells.length === 2);
});

test('20 + 20 with overlapping intervals give none', () => {
  const r = of(lines([...recs('codex', 20, 14), ...recs(`${P}:implementer`, 20, 12)]), 'implementer');
  assert.equal(r.executor, null);
  assert.equal(r.reason, 'intervals overlap');
});

test('another class does not mix in; a role without cells says fewer than 20 receipts', () => {
  const res = lines([...recs('codex', 20, 20, 'critical'), ...recs(`${P}:implementer`, 20, 0, 'critical')], 'standard');
  assert.equal(of(res, 'implementer').executor, null);
  assert.equal(of(res, 'reviewer').reason, 'fewer than 20 receipts');
});

test('the bootstrap interval is exported for reuse (lessons promotion)', async () => {
  const { intervalOf } = await import('../plugins/landfall/lib/receipts/executors.mjs');
  const a = intervalOf([1, 1, 1, 0], 1, 1000);
  assert.deepEqual(a, intervalOf([1, 1, 1, 0], 1, 1000));
  assert.ok(a.lo <= 0.75 && 0.75 <= a.hi);
});

test('intervalOf keeps its pinned output for the default mean (T-MG-123)', async () => {
  const { intervalOf } = await import('../plugins/landfall/lib/receipts/executors.mjs');
  const p = [1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0];
  assert.deepEqual(intervalOf(p, 1), { lo: 0.4166666666666667, hi: 0.9166666666666666 });
  assert.deepEqual(intervalOf(p, 7, 200), { lo: 0.4166666666666667, hi: 0.8333333333333334 });
});

test('median and percentile are nearest-rank (T-MG-123)', async () => {
  const { median, percentile } = await import('../plugins/landfall/lib/receipts/executors.mjs');
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4], 90), 4);
  assert.equal(median([3, 1, 2]), 2);
});

test('diffInterval: identical samples, separated samples, determinism (T-MG-123)', async () => {
  const { diffInterval } = await import('../plugins/landfall/lib/receipts/executors.mjs');
  const same = diffInterval([1, 2, 3], [1, 2, 3]);
  assert.equal(same.delta, 0);
  assert.ok(same.lo <= 0 && 0 <= same.hi);
  const far = diffInterval(Array(10).fill(10), Array(10).fill(20));
  assert.equal(far.delta, 10);
  assert.ok(far.lo > 0);
  assert.deepEqual(diffInterval([1, 5, 9, 2], [4, 8, 3, 7], { seed: 5 }), diffInterval([1, 5, 9, 2], [4, 8, 3, 7], { seed: 5 }));
});
