// Data-driven executor suggestion (SD-42): per (task class x executor) cell, the tasks, the first-pass verify rate with a
// seeded percentile bootstrap interval, and the cost per task. Pure: no I/O. A suggestion needs two cells of one role
// with at least MIN_TASKS tasks each whose first-pass intervals separate; cost breaks no tie.

export const MIN_TASKS = 20;
export const RESAMPLES = 1000;
export const ROLES = Object.freeze(['implementer', 'reviewer']);

// caw: and claude: are older spellings of landfall:; a bare provider id stays.
export const normaliseExecutor = (label) => String(label).replace(/^(?:caw|claude):/, 'landfall:');

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

function interval(passes, seed, resamples) {
  const n = passes.length;
  const rand = prng(seed);
  const rates = [];
  for (let r = 0; r < resamples; r++) {
    let k = 0;
    for (let i = 0; i < n; i++) k += passes[Math.floor(rand() * n)];
    rates.push(k / n);
  }
  rates.sort((x, y) => x - y);
  return { lo: rates[Math.floor(0.05 * (resamples - 1))], hi: rates[Math.ceil(0.95 * (resamples - 1))] };
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
      return { class: cls, executor, role: roleOf(executor), tasks: rows.length, firstPass: { rate, ...interval(passes, seed, resamples) }, costPerTaskMicroUsd: Math.round(cost), resamples, seed };
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
