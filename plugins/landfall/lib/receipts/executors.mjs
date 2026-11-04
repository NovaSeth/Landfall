// Data-driven executor suggestion (SD-42): per (task class x executor) cell, the tasks, the first-pass verify rate with a
// seeded percentile bootstrap interval, and the cost per task. Pure: no I/O. A suggestion needs two cells of one role
// with at least MIN_TASKS tasks each whose first-pass intervals separate; cost breaks no tie.


import { readFileSync } from 'node:fs';
const NAMES = JSON.parse(readFileSync(new URL('../name.json', import.meta.url), 'utf8'));

export const MIN_TASKS = 20;
export const RESAMPLES = 1000;
export const ROLES = Object.freeze(['implementer', 'reviewer']);

// caw: and claude: are older spellings of the current prefix; a bare provider id stays.
export const normaliseExecutor = (label) => String(label).replace(/^(?:caw|claude):/, `${NAMES.plugin}:`);

// A label ending in :reviewer is a reviewer; every other executor implements.
export const roleOf = (executor) => (/:reviewer$/.test(executor) ? 'reviewer' : 'implementer');

// mulberry32: a small seeded generator, so the same seed gives the same intervals.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (values) => {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
};

// Nearest-rank percentile, p in [0, 100]; an empty array gives null.
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

export const median = (values) => percentile(values, 50);

const resampleOf = (values, rand) => {
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = values[Math.floor(rand() * n)];
  return out;
};

const boundsOf = (stats, resamples) => {
  stats.sort((x, y) => x - y);
  return { lo: stats[Math.floor(0.05 * (resamples - 1))], hi: stats[Math.ceil(0.95 * (resamples - 1))] };
};

// The 90 % percentile bootstrap interval of stat(values), the mean by default; lessons promotion reuses it.
export function intervalOf(values, seed = 1, resamples = RESAMPLES, stat = mean) {
  const rand = prng(seed);
  const stats = [];
  for (let r = 0; r < resamples; r++) stats.push(stat(resampleOf(values, rand)));
  return boundsOf(stats, resamples);
}

// The 90 % interval of stat(b) - stat(a); a and b are resampled independently from one seeded generator.
export function diffInterval(a, b, { stat = median, seed = 1, resamples = RESAMPLES } = {}) {
  const rand = prng(seed);
  const stats = [];
  for (let r = 0; r < resamples; r++) {
    const ra = resampleOf(a, rand);
    stats.push(stat(resampleOf(b, rand)) - stat(ra));
  }
  return { delta: stat(b) - stat(a), ...boundsOf(stats, resamples) };
}

// records: [{ task, class, executor, firstPass, costMicroUsd }]. Cells by class, then executor.
export function cellStats(records, { seed = 1, resamples = RESAMPLES } = {}) {
  const groups = new Map();
  for (const r of records) {
    const executor = normaliseExecutor(r.executor);
    const key = `${r.class}\u0000${executor}`;
    if (!groups.has(key)) groups.set(key, { class: r.class, executor, rows: [] });
    groups.get(key).rows.push(r);
  }
  return [...groups.values()]
    .sort((a, b) => (a.class < b.class ? -1 : a.class > b.class ? 1 : a.executor < b.executor ? -1 : a.executor > b.executor ? 1 : 0))
    .map(({ class: cls, executor, rows }) => {
      const passes = rows.map((r) => (r.firstPass ? 1 : 0));
      const rate = passes.reduce((s, x) => s + x, 0) / rows.length;
      const cost = rows.reduce((s, r) => s + (r.costMicroUsd ?? 0), 0) / rows.length;
      return { class: cls, executor, role: roleOf(executor), tasks: rows.length, firstPass: { rate, ...intervalOf(passes, seed, resamples) }, costPerTaskMicroUsd: Math.round(cost), resamples, seed };
    });
}

// One result per role for a class: { role, executor|null, reason|null, cells }. A suggestion is the cell whose lower
// bound is above every other qualifying cell's upper bound; two qualifying cells that do not separate give none.
export function suggestExecutors(cells, cls) {
  return ROLES.map((role) => {
    const mine = cells.filter((c) => c.class === cls && c.role === role);
    const enough = mine.filter((c) => c.tasks >= MIN_TASKS);
    if (enough.length < 2) return { role, executor: null, reason: `fewer than ${MIN_TASKS} receipts`, cells: mine };
    const best = enough.find((c) => enough.every((o) => o === c || c.firstPass.lo > o.firstPass.hi));
    if (!best) return { role, executor: null, reason: 'intervals overlap', cells: mine };
    return { role, executor: best.executor, reason: null, cells: mine };
  });
}
