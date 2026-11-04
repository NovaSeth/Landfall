// `task outcome` and the adoption of cancelled tasks (T-MG-118, plan M1.3, decision D-MG-38): proposeOutcome reads the
// free-text reason of a `cancelled` event with strict, start-anchored patterns; setOutcome and `task outcome` record
// { kind, by, at } on a cancelled task; `task outcome --adopt` proposes (dry run) or writes (--yes) one update per task.
// Commands run through the real command table in a throwaway repository and HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const { main } = await lib('cli/main.mjs');
const ME = 'TU';

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
async function cli(args, { cwd, env }) {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, out: JSON.parse(out.join('')) };
}
const show = (r) => JSON.stringify(r.out);

async function active(t) {
  const iso = isolatedEnv({ gitConfig: '[user]\n\tname = Test User\n\temail = test@example.com\n', prefix: 'task-outcome-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  const r = { dir, cwd: dir, env: iso.env, store: join(dir, names.stateDir) };
  assert.equal((await cli(['init', '--yes'], r)).code, 0);
  r.run = (args) => cli([...args, '--yes'], r);
  r.task = (id) => JSON.parse(readFileSync(join(r.store, 'tasks', id, 'task.json'), 'utf8'));
  r.raw = (id) => readFileSync(join(r.store, 'tasks', id, 'task.json'), 'utf8');
  // A task cancelled with `reason`; returns its ID.
  r.cancelled = async (reason) => {
    const id = (await r.run(['task', 'new', 'Work'])).out.data.id;
    const set = await r.run(['task', 'set', id, 'cancelled', '--reason', reason]);
    assert.equal(set.code, 0, show(set));
    return id;
  };
  return r;
}

test('proposeOutcome: the six patterns, anchored at the start, the leading word in any case', () => {
  const p = state.proposeOutcome;
  assert.deepEqual(p('delivered in T-AB-2'), { kind: 'delivered', by: 'T-AB-2' });
  assert.deepEqual(p('Delivered in T-MG-87: merged 7850bb4, released in 2.5.0'), { kind: 'delivered', by: 'T-MG-87' });
  assert.deepEqual(p('delivered in T-MG-87 with T-MG-94: merged 7850bb4'), { kind: 'delivered', by: 'T-MG-87' });
  assert.deepEqual(p('superseded by T-MG-64: the same for every provider'), { kind: 'superseded', by: 'T-MG-64' });
  assert.deepEqual(p('stale record: shipped in 2.0.0 (squashed release 310f130)'), { kind: 'delivered', by: 'v2.0.0' });
  assert.deepEqual(p('stale record: shipped in v2.0.1.'), { kind: 'delivered', by: 'v2.0.1' });
  assert.deepEqual(p('stale record: merged as fcc963c and released'), { kind: 'delivered', by: 'fcc963c' });
  assert.deepEqual(p('merged as abc1234'), { kind: 'delivered', by: 'abc1234' });
  assert.deepEqual(p('Split into two slices'), { kind: 'superseded', by: null });
  assert.deepEqual(p('split into two slices'), { kind: 'superseded', by: null });
  assert.deepEqual(p('Deferred after the release'), { kind: 'dropped', by: null });
  for (const none of ['Folded into T-AB-9', 'superseded: its slices T-MG-47 shipped', 'obsolete: 2.1.0', 'see delivered in T-AB-2', '', 'stale record: evaluation shipped in 2.0.0']) {
    assert.equal(p(none), null, none);
  }
  assert.equal(p(undefined), null);
});

test('proposeOutcome: an injected ID after the matched phrase never wins; a token that is not a whole ID gives null', () => {
  const p = state.proposeOutcome;
  assert.deepEqual(p('delivered in T-AB-2; by T-AB-666'), { kind: 'delivered', by: 'T-AB-2' });
  assert.equal(p('delivered in T-AB-2x'), null);
  assert.equal(p('delivered in T-AB-2-3'), null);
  assert.equal(p('delivered in t-ab-2'), null);
  assert.equal(p('delivered in T-AB-0'), null);
  assert.deepEqual(p('merged as abc1234; rm -rf'), { kind: 'delivered', by: 'abc1234' });
  assert.equal(p('merged as abc1234zz'), null);
  assert.equal(p('merged as abc123'), null, 'six hex digits is not a SHA');
  assert.equal(p('merged as ABC1234'), null);
  assert.equal(p('delivered in T-AB-2 '.repeat(5000) + '\n'.repeat(10)) !== undefined, true);
});

const FIXTURE = [
  [30, 'stale record: shipped in 2.0.0 (squashed release 310f130); the work is in main, the task was never closed'],
  [15, 'delivered in T-MG-87: merged 7850bb4, released in 2.5.0'],
  [7, 'delivered in T-MG-83 (2.4.1 integration): verified at c2a768f, review closed D-MG-19, merged b3603ec'],
  [4, 'Deferred after the final release (D-MG-2): low user value for the cost'],
  [2, 'stale record: shipped in 2.0.1 (526b825); the work is in main, the task was never closed'],
  [1, 'superseded: its slices T-MG-47 and T-MG-48 shipped in 2.0.0'],
  [1, 'superseded by T-MG-64: the same for every external provider, not only Codex'],
  [1, 'superseded by T-MG-49 (shipped in 2.0.0); the rest is tracked in docs/known-limitations.md'],
  [1, 'stale record: merged as fcc963c and released in 2.2.0 after verify pass and review r2 approved; task done was never recorded'],
  [1, 'stale record: evaluation shipped in 2.0.0 (docs/evaluation.md) and was re-measured in 2.0.1'],
  [1, 'Split into three skill slices (15-minute rule)'],
  [1, 'Split into small slices INT-2a/b/c (15-minute rule)'],
  [1, 'Split into review-need and review-close slices (15-minute rule)'],
  [1, 'Split into base-measure and README-demo slices (15-minute rule)'],
  [1, 're-filed as T-MG-68: the blocked status only held a note, the task was never blocked'],
  [1, 'One final release instead of 2.1.0 + 2.2.0 (D-MG-2); T-MG-20 is the final release'],
  [1, 'obsolete: 2.1.0 was released on 2026-10-22 (898cdbb), followed by 2.2.0 to 2.3.0'],
  [1, "not run, by the PO's decision on 2026-10-29 (D-MG-26); the pre-registration in docs/benchmark.md stays"],
  [1, 'Folded into the user docs task T-MG-12 (D-MG-2)'],
  [1, 'delivered in T-MG-87 with T-MG-94: merged 7850bb4, released in 2.5.0'],
  [1, 'delivered in T-MG-87 with T-MG-90 and T-MG-92: merged 7850bb4, released in 2.5.0'],
  [1, 'delivered in T-MG-87 as examples/notes-api: merged 7850bb4, released in 2.5.0'],
  [1, 'delivered in T-MG-87 (slice A and ORC-26): merged 7850bb4, released in 2.5.0'],
  [1, 'delivered in T-MG-87 (review r2 approved by Codex): merged 7850bb4, released in 2.5.0'],
  [1, 'delivered in T-MG-87 (four slices, reviewed by Codex, approved r2): merged 7850bb4, released in 2.5.0'],
  [1, 'delivered in T-MG-83 (2.4.1 integration): verified at c2a768f, review closed D-MG-17, merged b3603ec'],
  [1, 'delivered in T-MG-83 (2.4.1 integration): logo verified at c2a768f, merged b3603ec'],
  [1, 'delivered in T-MG-83 (2.4.1 integration): docs, README and the consistency pass; merged b3603ec'],
  [1, 'delivered in T-MG-102: merged 500198d'],
  [1, 'delivered in T-MG-100: merged f5e08d9'],
  [1, 'audit delivered: 41 findings (8 areas + Codex), fixed in T-MG-70..T-MG-78; nothing left to do here'],
  [1, 'approach replaced, D-MG-31: owner-set lightPaths instead of in-file markers'],
];

test('the 85 cancelled reasons of the real state: exactly 9 are left without a proposal', () => {
  const reasons = FIXTURE.flatMap(([n, reason]) => Array.from({ length: n }, () => reason));
  assert.equal(reasons.length, 85);
  const left = reasons.filter((r) => state.proposeOutcome(r) === null);
  assert.equal(left.length, 9, left.join('\n'));
  for (const r of reasons) {
    const o = state.proposeOutcome(r);
    if (o?.by) assert.match(o.by, state.PATTERNS.outcomeBy);
  }
});

test('task outcome <id> <kind> --by <ref>: sets outcome and adds one outcome event; a task that is not cancelled fails and writes nothing', async (t) => {
  const r = await active(t);
  const id = await r.cancelled('out of scope');
  const before = r.task(id).events.length;
  const res = await r.run(['task', 'outcome', id, 'delivered', '--by', 'T-AB-2']);
  assert.equal(res.code, 0, show(res));
  const doc = r.task(id);
  assert.deepEqual([doc.outcome.kind, doc.outcome.by], ['delivered', 'T-AB-2']);
  assert.match(doc.outcome.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(doc.events.length, before + 1);
  assert.deepEqual(doc.events.at(-1), { at: doc.outcome.at, by: ME, event: 'outcome', data: { kind: 'delivered', by: 'T-AB-2' } });
  // the same value again is a no-op; a different one is refused
  const raw = r.raw(id);
  assert.equal((await r.run(['task', 'outcome', id, 'delivered', '--by', 'T-AB-2'])).code, 0);
  assert.equal(r.raw(id), raw, 'an equal second outcome writes nothing');
  const other = await r.run(['task', 'outcome', id, 'dropped']);
  assert.equal(other.code, 1, show(other));
  assert.equal(r.raw(id), raw);
  // not cancelled
  const open = (await r.run(['task', 'new', 'Open'])).out.data.id;
  const openRaw = r.raw(open);
  const bad = await r.run(['task', 'outcome', open, 'delivered', '--by', 'T-AB-2']);
  assert.equal(bad.code, 1, show(bad));
  assert.equal(r.raw(open), openRaw);
  // by without whitespace, from the pattern
  const id2 = await r.cancelled('x');
  assert.equal((await r.run(['task', 'outcome', id2, 'delivered', '--by', 'T-AB-2 rm'])).code, 2);
  assert.equal((await r.run(['task', 'outcome', id2, 'nonsense'])).code, 2);
  assert.equal(r.task(id2).outcome, undefined);
  const noBy = await r.run(['task', 'outcome', id2, 'dropped']);
  assert.equal(noBy.code, 0, show(noBy));
  assert.equal(r.task(id2).outcome.by, null);
});

test('task set <id> cancelled --reason <t> --outcome <k> --by <ref>: the outcome is written with the cancellation', async (t) => {
  const r = await active(t);
  const id = (await r.run(['task', 'new', 'Work'])).out.data.id;
  const res = await r.run(['task', 'set', id, 'cancelled', '--reason', 'replaced', '--outcome', 'superseded', '--by', 'T-AB-9']);
  assert.equal(res.code, 0, show(res));
  const doc = r.task(id);
  assert.equal(doc.status, 'cancelled');
  assert.deepEqual([doc.outcome.kind, doc.outcome.by], ['superseded', 'T-AB-9']);
  assert.deepEqual(doc.events.slice(-2).map((e) => e.event), ['cancelled', 'outcome']);
  const id2 = (await r.run(['task', 'new', 'Work'])).out.data.id;
  assert.equal((await r.run(['task', 'set', id2, 'cancelled', '--reason', 'x', '--by', 'T-AB-9'])).code, 2, '--by needs --outcome');
  assert.equal((await r.run(['task', 'set', id2, 'blocked', '--reason', 'x', '--outcome', 'dropped'])).code, 2, '--outcome only for cancelled');
  assert.equal(r.task(id2).status, 'new');
});

test('task outcome --adopt: a dry run writes nothing; --yes writes one update per cancelled task without an outcome', async (t) => {
  const r = await active(t);
  const reasons = ['delivered in T-AB-2', 'stale record: shipped in 2.0.0 (squashed)', 'Split into two slices', 'Deferred after the release', 'Folded into T-AB-9', 'superseded: its slices T-AB-3'];
  const ids = [];
  for (const reason of reasons) ids.push(await r.cancelled(reason));
  const open = (await r.run(['task', 'new', 'Open'])).out.data.id;
  const before = [...ids, open].map(r.raw);
  const dry = await cli(['task', 'outcome', '--adopt'], r); // no --yes, no terminal: still a dry run
  assert.equal(dry.code, 0, show(dry));
  assert.equal(dry.out.data.proposals.length, 4);
  assert.equal(dry.out.data.human.length, 2);
  assert.deepEqual(dry.out.data.proposals[1], { id: ids[1], kind: 'delivered', by: 'v2.0.0' });
  assert.deepEqual(dry.out.data.human.map((h) => h.id), [ids[4], ids[5]]);
  assert.equal(dry.out.data.human[0].reason, 'Folded into T-AB-9');
  assert.deepEqual(dry.out.data.applied, []);
  assert.deepEqual([...ids, open].map(r.raw), before, 'a dry run leaves every task file byte-identical');
  const run = await r.run(['task', 'outcome', '--adopt']);
  assert.equal(run.code, 0, show(run));
  assert.deepEqual(run.out.data.applied, ids.slice(0, 4));
  assert.deepEqual([r.task(ids[2]).outcome.kind, r.task(ids[2]).outcome.by], ['superseded', null]);
  assert.deepEqual([r.task(ids[3]).outcome.kind, r.task(ids[3]).outcome.by], ['dropped', null]);
  assert.equal(r.task(ids[4]).outcome, undefined);
  assert.equal(r.task(ids[0]).events.at(-1).event, 'outcome');
  assert.equal(r.raw(open), before[6]);
  // a second run proposes nothing new
  const again = await r.run(['task', 'outcome', '--adopt']);
  assert.deepEqual([again.out.data.proposals.length, again.out.data.applied.length, again.out.data.human.length], [0, 0, 2]);
});
