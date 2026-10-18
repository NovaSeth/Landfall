// Adaptive engine (spec §7.4, SD-13, SD-15, SD-38, SC11): signals from git history and the state, tiers L0–L3
// with hysteresis (up at evaluation time, down only after the whole dwell window below, at most one change per
// 7 days), the capability table, and the record of a change: in shadow mode (the default) a proposed decision in
// local/shadow.jsonl, in on mode a decision record of kind tier and the engine's capability flags.
// SC11: 1,000 seeded sequences oscillating ±10% around a threshold change the tier at most once in 60 daily
// evaluations; the outcome gate set is byte-identical across L0–L3 and every task class.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (and git run by the code under test) gets a throwaway HOME and environment (S1).
const ISO = isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const engine = await lib('engine/index.mjs');
const { KINDS, emailHash, open, resolve } = await lib('state/index.mjs');
const { CLASSES, OUTCOME_GATES, routeFor } = await lib('router/index.mjs');
const { readRecords } = await lib('decisions/index.mjs');
const { main } = await lib('cli/main.mjs');
const { COMMANDS } = await lib('cli/commands.mjs');

const DAY = 86400000;
const NOW = '2026-10-15T12:00:00.000Z';
const TODAY = '2026-10-15';
const T0 = Date.parse(`${TODAY}T00:00:00.000Z`);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysAfter = (day, n) => dayOf(Date.parse(`${day}T00:00:00.000Z`) + n * DAY);
const isoAt = (daysAgo, hour = 10, base = T0) => new Date(base - daysAgo * DAY + hour * 3600000).toISOString();

// ---- fixtures ----

const put = (dir, rel, value) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
function git(dir, env, ...args) {
  const r = spawnSync('git', args, { cwd: dir, env: { ...ISO.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const ANN = { name: 'Ann Lee', email: 'ann@example.com' };
const BOB = { name: 'Bob Stone', email: 'bob@example.com' };
const BOT = { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' };
// One commit at `when` (ISO) by `who`; files: { rel: content | null (delete) }.
function commitAt(dir, when, files, { who = ANN, message = 'change' } = {}) {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) rmSync(join(dir, rel));
    else put(dir, rel, content);
  }
  const env = { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, {}, 'rev-parse', 'HEAD');
}
// A throwaway repository; active: state.json, config.json with `flags` (when any), .gitignore and the handle TU of the test identity.
function repo(t, { active = true, flags = {} } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engine-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  git(dir, {}, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(dir, {}, 'config', 'user.name', 'Test User');
  git(dir, {}, 'config', 'user.email', 'test@example.com');
  const store = join(dir, names.stateDir);
  if (active) {
    put(store, 'state.json', { schema: KINDS.state.version, codename: names.codename, createdWith: '2.0.0', activatedAt: isoAt(400) });
    if (Object.keys(flags).length) put(store, 'config.json', { schema: KINDS.config.version, flags });
    put(store, '.gitignore', 'local/\n');
    put(store, 'team/TU.json', { schema: KINDS.team.version, handle: 'TU', emailSha256: emailHash('test@example.com'), addedAt: isoAt(400) });
  }
  return { base, dir, store };
}
const where = (dir) => resolve({ cwd: dir, env: ISO.env, names });
const evaluate = (dir, now = NOW) => engine.evaluate(where(dir), { names, env: ISO.env, now });
const shadowLines = (store) => {
  const file = join(store, 'local', 'shadow.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const tierRecords = (store) => readRecords(store).records.filter((r) => r.doc.kind === 'tier');
const stateFlags = (store) => (existsSync(join(store, 'config.json')) ? JSON.parse(readFileSync(join(store, 'config.json'), 'utf8')).flags : {});
function snapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      if (!rel && name === '.git') continue;
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (lstatSync(p).isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out;
}
async function cli(args, { dir }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env: ISO.env, cwd: dir };
  const code = await main([...args, '--yes'], { io });
  return { code, stdout: out.join(''), stderr: err.join('') };
}
// Series of `n` daily values (oldest first) from a function of days ago.
const series = (n, f) => Array.from({ length: n }, (_, i) => f(n - 1 - i));
const D = engine.THRESHOLDS;
const dwell = (s) => D.tierSignals[s].dwellDays;
// A full tier input: every tier signal constant except the overrides.
function input(over = {}, { loc = 0, modules = 0, contributors30 = 0 } = {}) {
  return {
    loc: over.loc ?? series(dwell('loc'), () => loc),
    modules: over.modules ?? series(dwell('modules'), () => modules),
    contributors30: over.contributors30 ?? series(dwell('contributors30'), () => contributors30),
  };
}

// ---- thresholds ----

test('thresholds are the spec §7.4 defaults, kept as data in lib/engine/thresholds.json', () => {
  const file = JSON.parse(readFileSync(join(pluginDir, 'lib', 'engine', 'thresholds.json'), 'utf8'));
  assert.deepEqual(engine.THRESHOLDS, file, 'the engine reads its thresholds from the data file');
  assert.deepEqual(engine.TIERS, ['L0', 'L1', 'L2', 'L3']);
  assert.equal(D.changeEveryDays, 7, 'at most one tier change per 7 days');
  const lv = (s) => D.tierSignals[s].levels.map((l) => [l.tier, l.up, l.down]);
  assert.deepEqual(lv('loc'), [['L1', 5000, 4000], ['L3', 150000, 120000]]);
  assert.deepEqual(lv('modules'), [['L1', 4, 3], ['L3', 40, 32]]);
  assert.deepEqual(lv('contributors30'), [['L2', 2, 2], ['L3', 8, 6]], 'L2 down: ≤ 1 (below 2); L3 down: ≤ 5');
  assert.deepEqual([dwell('loc'), dwell('modules'), dwell('contributors30')], [14, 14, 45]);
  assert.equal(D.tierSignals.contributors30.windowDays, 30);
  assert.equal(D.tierSignals.contributors30.distinctDays, 2);
  assert.deepEqual(D.toggles.parallelTasks, { up: 3, down: 2, dwellDays: 7 });
  assert.deepEqual(D.toggles.incidents30, { up: 1, down: 1, dwellDays: 60, windowDays: 30 });
  assert.deepEqual(D.floors, { deployedToUsers: 'L1' });
  assert.equal(D.codeownersContributors, 3);
  // SC11 precondition: values ±10% around either threshold of a level never both reach up and fall below down.
  for (const [s, { levels }] of Object.entries(D.tierSignals)) {
    for (const l of levels) {
      for (const around of [l.up, l.down]) {
        const r = (v) => (s === 'loc' ? v : Math.round(v));
        const [lo, hi] = [r(around * 0.9), r(around * 1.1)];
        assert.ok(!(lo < l.down && hi >= l.up), `${s} ${l.tier}: ±10% around ${around} spans [${lo}, ${hi}], both thresholds`);
      }
    }
  }
});

// ---- hysteresis ----

test('up: the tier rises at the evaluation where an up threshold holds; tier = max over the signals', () => {
  const r = engine.decideTier({ current: { tier: 'L0', since: null }, series: input({}, { loc: 5000 }), today: TODAY });
  assert.deepEqual([r.tier, r.change], ['L1', { from: 'L0', to: 'L1' }]);
  assert.ok(r.reasons.some((x) => /loc 5000 ≥ 5000 → L1/.test(x)), r.reasons.join('; '));
  const four = engine.decideTier({ current: { tier: 'L0', since: null }, series: input({}, { loc: 4999 }), today: TODAY });
  assert.deepEqual([four.tier, four.change], ['L0', null], '4,999 lines stay L0');
  const max = engine.decideTier({ current: { tier: 'L0', since: null }, series: input({}, { loc: 6000, modules: 40, contributors30: 2 }), today: TODAY });
  assert.equal(max.tier, 'L3', 'modules ≥ 40 → L3 wins over loc → L1 and contributors → L2');
  const team = engine.decideTier({ current: { tier: 'L1', since: '2026-01-01' }, series: input({}, { loc: 6000, contributors30: 2 }), today: TODAY });
  assert.deepEqual(team.change, { from: 'L1', to: 'L2' });
  // Up uses only today's value: one day at the threshold is enough.
  const today = engine.decideTier({ current: { tier: 'L0', since: null }, series: input({ loc: series(14, (ago) => (ago === 0 ? 5000 : 100)) }), today: TODAY });
  assert.equal(today.tier, 'L1');
  const yesterday = engine.decideTier({ current: { tier: 'L0', since: null }, series: input({ loc: series(14, (ago) => (ago === 1 ? 9000 : 100)) }), today: TODAY });
  assert.equal(yesterday.tier, 'L0', 'yesterday above, today below: no rise');
});

test('down: only after the value stayed under the down threshold for the whole dwell window', () => {
  const at = (cur, sig) => engine.decideTier({ current: { tier: cur, since: '2026-01-01' }, series: sig, today: TODAY });
  // In the band (4,000 ≤ loc < 5,000): L1 is kept for good.
  assert.equal(at('L1', input({}, { loc: 4000 })).tier, 'L1');
  // Below 4,000 for 13 of 14 days: kept; for all 14: L0.
  assert.equal(at('L1', input({ loc: series(14, (ago) => (ago === 13 ? 4000 : 3999)) })).tier, 'L1', 'one day in the window at 4,000 holds L1');
  const down = at('L1', input({}, { loc: 3999 }));
  assert.deepEqual([down.tier, down.change], ['L0', { from: 'L1', to: 'L0' }]);
  // contributors30: L2 is kept until 45 days at ≤ 1; then the tier falls to what the other signals hold.
  assert.equal(at('L2', input({ contributors30: series(45, (ago) => (ago === 44 ? 2 : 1)) }, { loc: 6000 })).tier, 'L2');
  assert.equal(at('L2', input({}, { contributors30: 1, loc: 6000 })).tier, 'L1', 'loc still holds L1');
  // L3 from loc: 120,000 ≤ loc < 150,000 keeps L3; under 120,000 for 14 days falls to L1 (loc ≥ 4,000 holds L1).
  assert.equal(at('L3', input({}, { loc: 120000 })).tier, 'L3');
  assert.equal(at('L3', input({}, { loc: 119999 })).tier, 'L1');
  // A down move needs every signal below: modules in its band holds L1 while loc is gone.
  assert.equal(at('L1', input({}, { loc: 0, modules: 3 })).tier, 'L1');
  assert.equal(at('L1', input({}, { loc: 0, modules: 2 })).tier, 'L0');
});

test('at most one tier change per 7 days: a change inside the window waits for its end; the first change does not', () => {
  const sig = input({}, { loc: 6000, contributors30: 2 });
  const held = engine.decideTier({ current: { tier: 'L1', since: daysAfter(TODAY, -6) }, series: sig, today: TODAY });
  assert.deepEqual([held.tier, held.change, held.target], ['L1', null, 'L2']);
  assert.deepEqual(held.waiting, { to: 'L2', until: daysAfter(TODAY, 1) });
  const free = engine.decideTier({ current: { tier: 'L1', since: daysAfter(TODAY, -7) }, series: sig, today: TODAY });
  assert.deepEqual([free.tier, free.waiting], ['L2', null]);
  const first = engine.decideTier({ current: { tier: 'L0', since: null }, series: sig, today: TODAY });
  assert.equal(first.tier, 'L2', 'no earlier change: nothing to wait for');
  const downHeld = engine.decideTier({ current: { tier: 'L1', since: daysAfter(TODAY, -2) }, series: input({}, { loc: 10 }), today: TODAY });
  assert.deepEqual([downHeld.tier, downHeld.waiting?.to], ['L1', 'L0'], 'a down move waits as well');
});

test('deployedToUsers sets an L1 floor (§7.4a key name); other facts raise no tier', () => {
  const r = engine.decideTier({ current: { tier: 'L0', since: null }, series: input(), facts: { deployedToUsers: true }, today: TODAY });
  assert.equal(r.tier, 'L1');
  assert.ok(r.reasons.some((x) => /deployedToUsers/.test(x)));
  assert.equal(engine.decideTier({ current: { tier: 'L0', since: null }, series: input(), facts: { deployedToUsers: false, ui: true, deployed: true }, today: TODAY }).tier, 'L0');
});

test('toggle: on at the up threshold, off only after the dwell days below the down threshold, kept in the band', () => {
  const rule = D.toggles.parallelTasks; // up 3, down 2, 7 days
  const n = rule.dwellDays * 2;
  assert.equal(engine.toggle(series(n, () => 0), rule), false);
  assert.equal(engine.toggle(series(n, (ago) => (ago === 0 ? 3 : 0)), rule), true, 'on the day it reaches 3');
  assert.equal(engine.toggle(series(n, (ago) => (ago === 6 ? 3 : 1)), rule), true, '6 days at ≤ 1 after a 3: still on');
  assert.equal(engine.toggle(series(n, (ago) => (ago === 7 ? 3 : 1)), rule), false, '7 days at ≤ 1: off');
  assert.equal(engine.toggle(series(n, (ago) => (ago === 10 ? 3 : 2)), rule), true, 'in the band (2) after a 3: kept');
  assert.equal(engine.toggle(series(n, () => 2), rule), false, 'in the band without a 3: off');
});

// ---- SC11 ----

// A seeded generator (mulberry32), so a failure names a reproducible seed.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 60 daily evaluations of one signal oscillating ±10% around one threshold (with its history before day 0);
// returns the number of tier changes and of crossings of the threshold. The tier before day 0 is settled by one
// evaluation of that history: from L0 around an up threshold, from the level's tier around a down threshold (the
// project reached that level earlier); the settling evaluation is not counted.
function oscillate(seed, thresholds = D) {
  const rnd = prng(seed);
  const signals = Object.keys(thresholds.tierSignals);
  const s = signals[Math.floor(rnd() * signals.length)];
  const { levels } = thresholds.tierSignals[s];
  const level = levels[Math.floor(rnd() * levels.length)];
  const around = rnd() < 0.5 ? level.up : level.down;
  const integer = s !== 'loc';
  const span = 60 + Math.max(...signals.map((x) => thresholds.tierSignals[x].dwellDays));
  const values = Array.from({ length: span }, () => {
    const v = around * (1 + (rnd() * 0.2 - 0.1));
    return integer ? Math.round(v) : Math.round(v * 100) / 100;
  });
  const at = (k, current) => {
    const sig = {};
    for (const x of signals) {
      const n = thresholds.tierSignals[x].dwellDays;
      sig[x] = x === s ? values.slice(k - n + 1, k + 1) : series(n, () => 0);
    }
    return engine.decideTier({ current, series: sig, today: daysAfter(TODAY, k), thresholds });
  };
  let current = { tier: at(span - 61, { tier: around === level.up ? 'L0' : level.tier, since: null }).tier, since: null };
  let changes = 0;
  let crossings = 0;
  for (let k = span - 60; k < span; k++) {
    if ((values[k] >= around) !== (values[k - 1] >= around)) crossings++;
    const r = at(k, current);
    if (r.change) { changes++; current = { tier: r.tier, since: daysAfter(TODAY, k) }; }
  }
  return { changes, crossings, signal: s, around };
}

test('SC11: 1,000 seeded sequences oscillating ±10% around a threshold change the tier at most once in 60 daily evaluations', () => {
  let crossed = 0;
  let changed = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const r = oscillate(seed);
    assert.ok(r.changes <= 1, `seed ${seed}: ${r.signal} around ${r.around} changed the tier ${r.changes} times`);
    if (r.crossings >= 10) crossed++;
    if (r.changes === 1) changed++;
  }
  assert.ok(crossed >= 500, `the sequences oscillate across their threshold (${crossed} of 1,000 crossed it 10+ times)`);
  assert.ok(changed >= 100, `the sequences reach a tier change (${changed} of 1,000)`);
  // The check distinguishes (KOD-59): without the band, the dwell and the 7-day cap the same sequences flap.
  const bare = structuredClone(D);
  bare.changeEveryDays = 0;
  for (const sig of Object.values(bare.tierSignals)) { sig.dwellDays = 1; for (const l of sig.levels) l.down = l.up; }
  let flapped = 0;
  for (let seed = 1; seed <= 1000; seed++) if (oscillate(seed, bare).changes > 1) flapped++;
  assert.ok(flapped >= 500, `a thresholds set without hysteresis flaps (${flapped} of 1,000)`);
});

// ---- capabilities ----

test('capability table per tier (spec §7.4); the engine flags are the config.json keys of lanes and generated files', () => {
  assert.deepEqual(engine.ENGINE_FLAGS, ['lanes', 'ci-gate', 'pre-push', 'codeowners', 'pr-template']);
  const cap = (tier, o = {}) => engine.capabilities(tier, { scheduler: false, contributors30: 0, packs: [], ...o });
  const row = (tier) => {
    const c = cap(tier);
    return [c.review.standard, c.review.critical, c.specPlan.critical, c.scheduler, c.flags.lanes, c.flags['ci-gate'], c.flags['pre-push'], c.flags.codeowners, c.flags['pr-template']];
  };
  assert.deepEqual(row('L0'), ['self-check', 'same-provider', 'plan-in-brief', 'off', 'off', 'offered', 'offered', 'off', 'offered']);
  assert.deepEqual(row('L1'), ['same-provider-fresh-context', 'cross-provider-if-available', 'spec-section-and-plan', 'on', 'off', 'offered', 'offered', 'off', 'offered']);
  assert.deepEqual(row('L2'), ['same-provider', 'cross-provider', 'spec-and-plan', 'on', 'on', 'on', 'on', 'off', 'on']);
  assert.deepEqual(row('L3'), ['same-provider', 'cross-provider-and-area-gate', 'spec-and-plan', 'on', 'on', 'on', 'on', 'on', 'on']);
  for (const t of engine.TIERS) assert.deepEqual(cap(t).core, ['router', 'verify', 'decisions', 'receipts', 'loop'], `${t}: core always on`);
  assert.equal(cap('L0', { scheduler: true }).scheduler, 'on', 'L0: the scheduler follows parallelTasks');
  assert.equal(cap('L2', { contributors30: 3 }).flags.codeowners, 'on', 'L2: CODEOWNERS when contributors ≥ 3');
  assert.equal(cap('L2', { contributors30: 2 }).flags.codeowners, 'off');
  assert.deepEqual(cap('L1', { packs: ['design-system'] }).packs, ['design-system']);
});

test('SC11: the outcome gate set is byte-identical across L0–L3 and every task class (SD-15)', () => {
  const sets = engine.TIERS.map((t) => JSON.stringify(engine.capabilities(t, { scheduler: true, contributors30: 9, packs: ['team'] }).gates));
  for (const cls of CLASSES) sets.push(JSON.stringify(routeFor(cls, { flags: ['irreversible'] }).gates), JSON.stringify(routeFor(cls).gates));
  assert.equal(new Set(sets).size, 1, sets.join('\n'));
  assert.equal(sets[0], JSON.stringify(OUTCOME_GATES), 'one source: the router\'s outcome gates');
});

// ---- signals ----

test('signals from git history: loc per day (source files only), modules, contributors30 (2 distinct days, bots excluded), reverts', (t) => {
  const { dir } = repo(t);
  commitAt(dir, isoAt(20), { 'src/a/x.js': lines(10), 'src/b/y.ts': lines(5), 'README.md': lines(100), 'logo.png': 'bin\0ary' });
  commitAt(dir, isoAt(10), { 'src/c/z.js': lines(20) }, { who: BOB });
  commitAt(dir, isoAt(5), { 'src/a/x.js': lines(15) });
  commitAt(dir, isoAt(3), { 'packages/p/index.js': lines(1) }, { who: BOT });
  commitAt(dir, isoAt(2), { 'src/c/z.js': null }, { who: BOB, message: 'Revert "add z"\n\nThis reverts commit 0000000.' });
  commitAt(dir, isoAt(1), { 'packages/p/README.md': lines(3) }, { who: BOT });
  commitAt(dir, isoAt(0, 9), { 'README.md': lines(101) });
  const s = engine.readSignals(where(dir), { names, env: ISO.env, now: NOW });
  assert.equal(s.day, TODAY);
  assert.equal(s.head, git(dir, {}, 'rev-parse', 'HEAD'));
  const byAgo = (arr) => Object.fromEntries(arr.map((v, i) => [arr.length - 1 - i, v]));
  const loc = byAgo(s.series.loc);
  assert.equal(s.series.loc.length, 14);
  assert.deepEqual([loc[13], loc[11], loc[10], loc[6], loc[5], loc[4], loc[3], loc[2], loc[0]], [15, 15, 35, 35, 40, 40, 41, 21, 21]);
  const modules = byAgo(s.series.modules);
  assert.deepEqual([modules[13], modules[10], modules[4], modules[3], modules[2], modules[0]], [2, 3, 3, 4, 3, 3]);
  assert.equal(s.values.contributors30, 2, 'Ann (3 days) and Bob (2 days); the bot (2 days) does not count');
  assert.equal(s.series.contributors30.length, 45);
  const c30 = byAgo(s.series.contributors30);
  assert.deepEqual([c30[10], c30[5], c30[2], c30[0]], [0, 1, 2, 2], 'an author counts from the second day with a commit in the window');
  assert.equal(s.values.incidents30, 1, 'the revert commit');
  assert.deepEqual([s.values.loc, s.values.modules], [21, 3]);
  // Before the first commit everything is zero; a commit on day −20 is counted from that day.
  assert.equal(byAgo(s.series.contributors30)[44], 0);
});

test('signals: loc counts the extensions of the profile stack; a repository without commits has zero signals', (t) => {
  const { dir } = repo(t);
  const empty = engine.readSignals(where(dir), { names, env: ISO.env, now: NOW });
  assert.deepEqual([empty.head, empty.values.loc, empty.values.modules, empty.values.contributors30], [null, 0, 0, 0]);
  commitAt(dir, isoAt(1), { 'src/a/x.js': lines(10), 'tool/run.py': lines(7) });
  assert.equal(engine.readSignals(where(dir), { names, env: ISO.env, now: NOW }).values.loc, 17, 'no stack fact: every known source extension');
  put(join(dir, names.stateDir), 'profile.json', {
    schema: 1, facts: { stack: { value: ['python'], source: 'said', evidence: 'we write Python', confidence: 1, at: isoAt(1) } }, gates: [], riskPaths: [], lastScan: null,
  });
  assert.equal(engine.readSignals(where(dir), { names, env: ISO.env, now: NOW }).values.loc, 7, 'stack python: .py only');
});

test('signals: a git failure is an environment error (exit 8), never a zero signal', async (t) => {
  const { dir } = repo(t);
  commitAt(dir, isoAt(1), { 'src/a/big.js': lines(5000) });
  const tree = git(dir, {}, 'rev-parse', 'HEAD^{tree}');
  rmSync(join(dir, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  assert.throws(() => engine.readSignals(where(dir), { names, env: ISO.env, now: NOW }), (e) => e.exit === 'ENV' && e.code === 'git-failed');
  const r = await cli(['tier', '--json'], { dir });
  assert.deepEqual([r.code, JSON.parse(r.stdout).errors[0].code], [8, 'git-failed']);
});

test('signals from the state: tasks in flight per day, incident tasks, profile facts', (t) => {
  const { dir, store } = repo(t);
  commitAt(dir, isoAt(50), { 'a.txt': 'a\n' });
  const s = open(store, { names });
  const task = (id, status, events, kind = 'task') => s.write('task', id, {
    id, kind, title: id, lane: null, owner: 'TU', class: null, classHistory: [], status, round: 0, base: null, branch: null,
    events: events.map(([ago, event, data = {}]) => ({ at: isoAt(ago), by: 'TU', event, data })),
  });
  task('T-TU-1', 'implemented', [[12, 'created'], [10, 'dispatched', { executor: 'x', base: 'abcdef1' }], [9, 'implementer', { report: 'done' }]]);
  task('T-TU-2', 'cancelled', [[9, 'created'], [8, 'dispatched', { executor: 'x', base: 'abcdef1' }], [6, 'cancelled', { reason: 'no' }]]);
  task('T-TU-3', 'dispatched', [[3, 'created'], [2, 'dispatched', { executor: 'x', base: 'abcdef1' }]]);
  task('T-TU-4', 'new', [[1, 'created']]);
  task('T-TU-5', 'blocked', [[45, 'created']], 'incident');
  put(store, 'profile.json', {
    schema: 1, facts: { deployedToUsers: { value: true, source: 'said', evidence: 'it is live', confidence: 1, at: isoAt(5) }, ui: { value: true, source: 'observed', evidence: 'src/App.tsx', confidence: 0.9, at: isoAt(5) } },
    gates: [], riskPaths: [], lastScan: null,
  });
  const sig = engine.readSignals(where(dir), { names, env: ISO.env, now: NOW });
  const par = Object.fromEntries(sig.series.parallelTasks.map((v, i, a) => [a.length - 1 - i, v]));
  assert.equal(sig.series.parallelTasks.length, 14);
  assert.deepEqual([par[11], par[10], par[8], par[7], par[6], par[2], par[0]], [0, 1, 2, 2, 1, 2, 2]);
  assert.equal(sig.values.parallelTasks, 2, 'now: T-TU-1 (implemented) and T-TU-3 (dispatched)');
  const inc = Object.fromEntries(sig.series.incidents30.map((v, i, a) => [a.length - 1 - i, v]));
  assert.deepEqual([inc[46], inc[45], inc[16], inc[15], inc[0]], [0, 1, 1, 0, 0], 'the incident task counts for 30 days from its creation');
  assert.deepEqual(sig.facts, { deployedToUsers: true, ui: true });
  const r = evaluate(dir);
  assert.equal(r.toggles.incidents30, true, 'an incident within the 60-day dwell keeps the incident packs');
  assert.deepEqual(r.capabilities.packs, ['design-system', 'runbooks', 'release']);
  assert.equal(r.tier, 'L1', 'deployedToUsers floor');
});

// ---- record of a change ----

// A repository whose signals call for L1 (5,000 source lines) at NOW.
function l1Repo(t, flags) {
  const r = repo(t, { flags });
  commitAt(r.dir, isoAt(3), { 'src/a/big.js': lines(5000) });
  return r;
}

test('shadow mode (default): a change is logged as a proposed tier decision with signal values and thresholds; nothing else is written', (t) => {
  const { dir, store } = l1Repo(t, {});
  const before = snapshot(dir).filter((l) => !l.includes('/local'));
  const r = evaluate(dir);
  assert.deepEqual([r.mode, r.tier, r.previous, r.change, r.written], ['shadow', 'L1', 'L0', { from: 'L0', to: 'L1' }, 'shadow']);
  const log = shadowLines(store);
  assert.equal(log.length, 1);
  const e = log[0];
  assert.deepEqual([e.capability, e.event, e.status, e.kind, e.from, e.to, e.at], ['engine', 'tier', 'proposed', 'tier', 'L0', 'L1', NOW]);
  assert.deepEqual(e.signals, { loc: 5000, modules: 1, contributors30: 0, parallelTasks: 0, incidents30: 0, deployedToUsers: null });
  assert.deepEqual(e.thresholds, D.tierSignals);
  assert.equal(e.head, git(dir, {}, 'rev-parse', 'HEAD'));
  assert.deepEqual(e.capabilities.flags, engine.capabilities('L1', { scheduler: false, contributors30: 0, packs: [] }).flags);
  assert.deepEqual(snapshot(dir).filter((l) => !l.includes('/local')), before, 'no decision record, no flag: capabilities are not enforced');
  assert.deepEqual(stateFlags(store), {});
  assert.deepEqual(tierRecords(store), []);
  // The same evaluation again: no change, nothing appended.
  const again = evaluate(dir);
  assert.deepEqual([again.tier, again.previous, again.change, again.written], ['L1', 'L1', null, null]);
  assert.equal(shadowLines(store).length, 1);
});

test('shadow mode: the 7-day cap and the current tier come from the log; other capabilities\' lines are kept', (t) => {
  const { dir, store } = l1Repo(t, { engine: 'shadow' });
  put(store, 'local/shadow.jsonl', `${JSON.stringify({ at: isoAt(9), capability: 'auto-allow', event: 'would-allow' })}\nnot json\n`);
  assert.equal(evaluate(dir).change.to, 'L1');
  // Two authors with commits on two days each: L2 is due, but the last change was today.
  for (const [ago, who] of [[2, ANN], [1, ANN], [2, BOB], [1, BOB]]) commitAt(dir, isoAt(ago, 11 + (who === BOB ? 1 : 0)), { [`n/${who.name}${ago}.txt`]: 'x\n' }, { who });
  const held = evaluate(dir, isoAt(-3, 12));
  assert.deepEqual([held.tier, held.change, held.waiting], ['L1', null, { to: 'L2', until: daysAfter(TODAY, 7) }]);
  const later = evaluate(dir, isoAt(-7, 12));
  assert.deepEqual([later.previous, later.tier, later.change], ['L1', 'L2', { from: 'L1', to: 'L2' }]);
  const log = readFileSync(join(store, 'local', 'shadow.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(log.length, 4, 'the earlier lines stay, two engine lines appended');
  assert.match(log[0], /auto-allow/);
  assert.equal(log[1], 'not json');
});

test('shadow mode: concurrent evaluations log one change (the check and the append share one lock section)', async (t) => {
  const { dir, store } = l1Repo(t, {});
  const launcher = join(pluginDir, 'bin', names.bin);
  // A helper holds the store lock while the evaluations start, so each one computes its signals and reaches the
  // log while the lock is held: one that read the log outside the lock would decide on the empty log (KOD-59).
  const stateUrl = pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    const { open } = await import(${JSON.stringify(stateUrl)});
    open(${JSON.stringify(store)}, { names: ${JSON.stringify(names)} }).locked(() => {
      process.stdout.write('held\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    });`], { env: ISO.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const released = new Promise((res) => holder.on('close', res));
  await new Promise((res) => holder.stdout.on('data', (d) => { if (String(d).includes('held')) res(); }));
  const runs = Array.from({ length: 6 }, () => new Promise((res) => {
    const p = spawn(process.execPath, [launcher, 'tier', '--yes', '--json'], { cwd: dir, env: ISO.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  }));
  const results = await Promise.all(runs);
  assert.equal(await released, 0, 'the helper held the lock and exited');
  for (const r of results) assert.equal(r.code, 0, r.out);
  // Real time: the commit is 3 days before today; L1 is due once.
  assert.equal(shadowLines(store).filter((e) => e.capability === 'engine').length, 1);
  assert.equal(results.filter((r) => JSON.parse(r.out).data.change).length, 1);
});

test('on mode: a change writes a decision record of kind tier with the signal values and thresholds, then flips the engine flags', (t) => {
  const { dir, store } = l1Repo(t, { engine: 'on', lanes: 'off', 'ci-gate': 'on' });
  for (const [ago, who] of [[2, ANN], [1, ANN], [2, BOB], [1, BOB]]) commitAt(dir, isoAt(ago, who === BOB ? 12 : 11), { [`n/${who.name}${ago}.txt`]: 'x\n' }, { who });
  const r = evaluate(dir);
  assert.deepEqual([r.mode, r.tier, r.change, r.written], ['on', 'L2', { from: 'L0', to: 'L2' }, 'decision']);
  const recs = tierRecords(store);
  assert.equal(recs.length, 1);
  const { doc, body } = recs[0];
  assert.deepEqual([doc.id, r.decision, doc.kind, doc.status, doc.title, doc.date, doc.author], ['D-TU-1', 'D-TU-1', 'tier', 'active', 'Tier L2 from L0', TODAY, 'TU']);
  for (const want of ['loc 5000', 'modules 1', 'contributors30 2', 'parallelTasks 0', 'incidents30 0', 'deployedToUsers unknown',
    'loc: L1 up ≥ 5000, down < 4000', 'L3 up ≥ 150000, down < 120000', 'dwell 14 days', 'contributors30: L2 up ≥ 2, down < 2', 'dwell 45 days', 'one change per 7 days']) {
    assert.ok(body.includes(want), `the record states "${want}":\n${body}`);
  }
  assert.deepEqual(stateFlags(store), { engine: 'on', lanes: 'on', 'ci-gate': 'on', 'pre-push': 'on', codeowners: 'off', 'pr-template': 'on' });
  assert.deepEqual(shadowLines(store), [], 'on mode writes no shadow line');
  // Evaluated again: the record is the current tier; nothing new.
  const again = evaluate(dir);
  assert.deepEqual([again.previous, again.tier, again.change], ['L2', 'L2', null]);
  assert.equal(tierRecords(store).length, 1);
  // Contributors gone (≤ 1) for the 45-day dwell: L2 falls to L1, which loc holds; offered flags are left alone.
  const later = evaluate(dir, isoAt(-75, 12));
  assert.deepEqual([later.previous, later.tier], ['L2', 'L1']);
  const two = tierRecords(store).map((x) => [x.doc.id, x.doc.title]);
  assert.deepEqual(two, [['D-TU-1', 'Tier L2 from L0'], ['D-TU-2', 'Tier L1 from L2']]);
  assert.deepEqual(stateFlags(store), { engine: 'on', lanes: 'off', 'ci-gate': 'on', 'pre-push': 'on', codeowners: 'off', 'pr-template': 'on' });
});

test('off mode: tier is refused (exit 7) naming the flag; an inactive repository is evaluated and nothing is written', async (t) => {
  const { dir } = l1Repo(t, { engine: 'off' });
  assert.throws(() => evaluate(dir), (e) => e.exit === 'REFUSED' && /engine/.test(e.message));
  const r = await cli(['tier', '--json'], { dir });
  const env = JSON.parse(r.stdout);
  assert.deepEqual([r.code, env.exit, env.errors[0].code], [7, 'REFUSED', 'capability-off']);
  assert.match(env.errors[0].message, /flags\.engine/);
  const idle = repo(t, { active: false });
  commitAt(idle.dir, isoAt(1), { 'src/a/big.js': lines(5000) });
  const before = snapshot(idle.dir);
  const v = evaluate(idle.dir);
  assert.deepEqual([v.active, v.tier, v.change, v.written], [false, 'L1', { from: 'L0', to: 'L1' }, null]);
  assert.deepEqual(snapshot(idle.dir), before, 'zero footprint (GC2)');
});

// ---- command ----

test('tier [--explain]: one table row; the envelope carries tier, change and capabilities; --explain shows each signal', async (t) => {
  const row = COMMANDS.find((r) => r.name === 'tier');
  assert.ok(row && row.mutating && !row.hidden, 'tier: public, records a change (consent)');
  assert.deepEqual(row.flags.map((f) => f.flag), ['--explain']);
  const { dir, store } = repo(t);
  commitAt(dir, new Date(Date.now() - 2 * DAY).toISOString(), { 'src/a/big.js': lines(5000), 'src/b/c.js': lines(1) });
  const json = await cli(['tier', '--json'], { dir });
  assert.equal(json.code, 0, json.stdout + json.stderr);
  const env = JSON.parse(json.stdout);
  assert.deepEqual([env.command, env.data.tier, env.data.mode, env.data.change, env.data.written], ['tier', 'L1', 'shadow', { from: 'L0', to: 'L1' }, 'shadow']);
  assert.equal(env.data.signals.loc, 5001);
  assert.deepEqual(env.data.capabilities.gates, [...OUTCOME_GATES]);
  assert.equal(env.data.explain, undefined, 'the explanation only with --explain');
  assert.equal(shadowLines(store).length, 1);
  const text = await cli(['tier', '--explain'], { dir });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Tier L1 Standard/m);
  assert.match(text.stdout, /shadow/);
  for (const re of [/loc 5001: .*≥ 5000 → L1/, /modules 2: /, /contributors30 0: /, /parallelTasks 0: /, /incidents30 0: /, /7 days/]) assert.match(text.stdout, re);
  const plain = await cli(['tier'], { dir });
  assert.doesNotMatch(plain.stdout, /loc 5001: /, 'without --explain: no per-signal lines');
  const ex = JSON.parse((await cli(['tier', '--json', '--explain'], { dir })).stdout);
  assert.ok(Array.isArray(ex.data.explain) && ex.data.explain.length >= 5);
});

test('evaluate reads engine threshold overrides from config.json; defaults hold without them', (t) => {
  assert.equal(evaluate(l1Repo(t, {}).dir).tier, 'L1', 'default: 5,000 lines call for L1');
  const { dir, store } = l1Repo(t, {});
  put(store, 'config.json', { schema: KINDS.config.version, thresholds: { 'engine.tierSignals.loc.levels.0.up': { value: 8000, decision: 'D-TU-1', at: isoAt(1) } } });
  assert.equal(evaluate(dir).tier, 'L0', 'override 8000: 5,000 lines stay L0');
});
