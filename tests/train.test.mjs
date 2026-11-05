// Merge train (T-MG-186, D-MG-65): `train <id…> | --ready` merges the approved tasks (review approved or closed; done
// not required) on a temporary integration branch in their --after order, leaves a conflicting task out, runs the gates
// once, bisects a failing task out, fast-forwards the target only when it did not move, and records every task of the
// train merged AND done in one step: the passing train gate is its verify (verify.json mode train). The fake gate is
// `node --test` with the TAP reporter that logs where it ran (no sleep, no load). This file holds no plugin name or path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const profile = await lib('profile/index.mjs');
const verify = await lib('verify/kinds.mjs');
const { main } = await lib('cli/main.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-11-04T05:42:00.000Z';
const BASE_TESTS = "import { test } from 'node:test';\ntest('adds', () => {});\n";
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "2 passing"}\n---\n\n# Report\n';
const APPROVED = { verdict: 'approved', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [] };

function repo(t, { extra = '' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'train-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  const home = join(base, 'home');
  const log = join(base, 'runs.log');
  mkdirSync(dir);
  mkdirSync(home);
  writeFileSync(log, '');
  const env = { ...ISO.env, HOME: home };
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write('calc.test.mjs', BASE_TESTS);
  write('shared.txt', 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const stateDir = join(dir, names.stateDir);
  const store = verify.openStore(stateDir, names);
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  const gate = `node --test --test-reporter=tap; s=$?; pwd >> '${log}'; ${extra} exit $s`;
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: gate, timeoutS: 60, kind: 'test' }] });
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  // An approved critical task (review r1 approved, not done) on a branch from main. edit(): changes files on the branch.
  // The review event binds the reviewed commit (head: the branch tip), as `review record` writes it (fix round 1, F2).
  const task = (name, edit, { review = true, after = [], cls = 'critical' } = {}) => {
    git('checkout', '-q', '-b', name, 'main');
    edit(write);
    git('add', '-A', '--', '.', `:(exclude)${names.stateDir}`);
    git('commit', '-q', '-m', name);
    const tipSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    // review false: the task waits for its review; the reviewer dispatch lets `review record` accept it (T-MG-187, SEC-13)
    const reviewed = review ? [{ at: AT, by: handle, event: 'review', data: { round: 1, verdict: 'approved', reviewer: 'claude', head: tipSha } }]
      : [{ at: AT, by: handle, event: 'dispatched', data: { executor: `${names.plugin}:reviewer`, base: head } }];
    const id = state.allocateId(store, {
      prefix: 'T', handle,
      build: (tid) => ({
        id: tid, kind: 'task', title: `task ${name}`, lane: null, owner: handle, class: cls, classHistory: [], status: 'in-review', round: 1,
        events: [{ at: AT, by: handle, event: 'created', data: after.length ? { after } : {} }, ...reviewed], base: head, branch: name,
      }),
    });
    writeFileSync(join(stateDir, 'tasks', id, 'report.md'), REPORT);
    if (review) store.write('review', verify.reviewKey(id, 1), { schema: verify.VERIFY_KINDS.review.version, ...APPROVED });
    git('add', '-A');
    git('commit', '-q', '-m', `task ${id}`);
    return id;
  };
  const runs = () => readFileSync(log, 'utf8').split('\n').filter((l) => l.includes(`${names.codename}-batch-`)).length;
  return { dir, env, stateDir, store, handle, git, write, task, runs };
}

async function cli(args, { dir, env }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd: dir, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, env: JSON.parse(out.join('')), stderr: err.join('') };
}
const outcomes = (res) => res.env.data.tasks.map((x) => [x.task, x.outcome]);
const events = (r, id, kind) => r.store.read('task', id).events.filter((e) => e.event === kind);
const addTest = (file, body = "test('ok', () => {});") => (w) => w(file, `import { test } from 'node:test';\n${body}\n`);

test('a train of 3: the conflicting task is left out, the failing one bisected out, the clean one merged and done (verify mode train)', async (t) => {
  const r = repo(t);
  const clean = r.task('feat/clean', (w) => { addTest('clean.test.mjs')(w); w('shared.txt', 'clean\n'); });
  const conflict = r.task('feat/conflict', (w) => w('shared.txt', 'conflict\n'));
  const failing = r.task('feat/failing', addTest('failing.test.mjs', "test('breaks', () => { throw new Error('boom'); });"));
  const tip = r.git('rev-parse', 'HEAD');
  const res = await cli(['train', clean, conflict, failing, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.errors));
  assert.deepEqual(outcomes(res), [[clean, 'merged'], [conflict, 'conflict'], [failing, 'failed']]);
  assert.deepEqual(res.env.data.tasks.find((x) => x.task === conflict).conflicts, ['shared.txt']);
  assert.ok(res.env.data.tasks.find((x) => x.task === failing).tests.some((x) => x.includes('breaks')));
  const head = r.git('rev-parse', 'HEAD');
  assert.notEqual(head, tip);
  r.git('merge-base', '--is-ancestor', tip, head);
  r.git('merge-base', '--is-ancestor', 'feat/clean', head);
  // merged and done in one step; the train gate is the verify
  const task = r.store.read('task', clean);
  assert.equal(task.status, 'done');
  assert.equal(events(r, clean, 'merged').length, 1);
  assert.equal(events(r, clean, 'done').length, 1);
  assert.equal(events(r, clean, 'done')[0].data.head, head);
  const v = r.store.read('verify', clean);
  assert.equal(v.result, 'pass');
  assert.deepEqual(v.mode, { kind: 'train', why: 'train gate on the integrated tree', files: [] });
  assert.deepEqual([v.head, v.train.head, v.train.commit, v.train.batch], [head, head, head, res.env.data.batch]);
  for (const id of [conflict, failing]) {
    assert.equal(r.store.read('task', id).status, 'in-review', `${id} keeps its status`);
    assert.equal(events(r, id, 'merged').length + events(r, id, 'done').length, 0, `${id}: nothing recorded`);
    assert.equal(r.store.read('verify', id), null);
  }
  assert.equal(r.git('branch', '--list', `${names.codename}/batch-*`), '', 'the integration branch is removed');
});

test('the train takes approved tasks only, in their --after order', async (t) => {
  const r = repo(t);
  const second = r.task('feat/second', addTest('second.test.mjs'));
  const first = r.task('feat/first', addTest('first.test.mjs'));
  const unreviewed = r.task('feat/unreviewed', addTest('unreviewed.test.mjs'), { review: false });
  // second waits for first: record the dependency on second's created event
  r.store.update('task', second, (cur) => ({ ...cur, events: [{ ...cur.events[0], data: { after: [first] } }, ...cur.events.slice(1)] }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'after');
  const res = await cli(['train', '--ready', '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  assert.deepEqual(outcomes(res), [[first, 'merged'], [second, 'merged']]);
  assert.equal(r.runs(), 1, 'one gate run');
  assert.equal(r.store.read('task', unreviewed).status, 'in-review', 'an unapproved task is not in the train');
  const subjects = r.git('log', '--format=%s', '--merges', 'HEAD').split('\n');
  assert.ok(subjects.findIndex((s) => s.includes(first)) > subjects.findIndex((s) => s.includes(second)), 'first merged before second');
  const named = await cli(['train', unreviewed, '--yes'], r);
  assert.equal(named.code, 1);
  assert.match(named.env.data.tasks[0].why, /review/);
});

test('the target moving during the train gate: no fast-forward, nothing recorded', async (t) => {
  const r = repo(t, { extra: 'git -C "$TARGET_DIR" commit -q --allow-empty -m moved;' });
  const a = r.task('feat/a', addTest('a.test.mjs'));
  r.env.TARGET_DIR = r.dir;
  const res = await cli(['train', a, '--yes'], r);
  assert.equal(res.code, 1);
  assert.ok(res.env.errors.some((e) => e.code === 'target-moved'), JSON.stringify(res.env.errors));
  assert.equal(r.git('log', '-1', '--format=%s'), 'moved');
  assert.equal(events(r, a, 'merged').length + events(r, a, 'done').length, 0);
  assert.equal(r.store.read('verify', a), null);
  assert.equal(r.store.read('task', a).status, 'in-review');
});

test('a task that removes a test is refused by the train without a decision', async (t) => {
  const r = repo(t);
  const a = r.task('feat/remove', (w) => w('calc.test.mjs', "import { test } from 'node:test';\n"));
  const res = await cli(['train', a, '--yes'], r);
  assert.equal(res.code, 1);
  assert.deepEqual(outcomes(res), [[a, 'failed']]);
  assert.match(res.env.data.tasks[0].why, /removed or skipped without a decision/);
  assert.equal(r.store.read('task', a).status, 'in-review');
  assert.equal(events(r, a, 'merged').length, 0);
});

// Fix round 1 (security review r1).
test('F1: the train reroutes the real change: a trivial task whose branch adds a risk path needs the critical review', async (t) => {
  const r = repo(t);
  const id = r.task('feat/risky', (w) => { addTest('x.test.mjs')(w); w('plugins/x/lib/state/migrations/099.mjs', 'export default 1;\n'); }, { review: false, cls: 'trivial' });
  const res = await cli(['train', id, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.data.tasks));
  assert.deepEqual(outcomes(res), [[id, 'skipped']]);
  assert.match(res.env.data.tasks[0].why, /the change is critical, not trivial/);
  assert.equal(r.store.read('task', id).status, 'in-review');
  assert.equal(r.store.read('verify', id), null);
  assert.equal(r.runs(), 0, 'no gate runs for a train with no eligible task');
});

test('F2: a commit pushed after the approved review keeps the task out of the train', async (t) => {
  const r = repo(t);
  const id = r.task('feat/late', addTest('a.test.mjs'));
  r.git('checkout', '-q', 'feat/late');
  r.write('late.txt', 'unreviewed after approval\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'late');
  r.git('checkout', '-q', 'main');
  const res = await cli(['train', id, '--yes'], r);
  assert.equal(res.code, 1);
  assert.deepEqual(outcomes(res), [[id, 'skipped']]);
  assert.match(res.env.data.tasks[0].why, /branch changed since its review/);
  assert.notEqual(spawnSync('git', ['cat-file', '-e', 'HEAD:late.txt'], { cwd: r.dir, env: r.env }).status, 0, 'late.txt is not on main');
});

test('F2: a review without a recorded commit does not bind the branch', async (t) => {
  const r = repo(t);
  const id = r.task('feat/old', addTest('a.test.mjs'));
  r.store.update('task', id, (cur) => ({ ...cur, events: cur.events.map((e) => (e.event === 'review' ? { ...e, data: { round: 1, verdict: 'approved', reviewer: 'claude' } } : e)) }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'old review');
  const res = await cli(['train', id, '--yes'], r);
  assert.deepEqual(outcomes(res), [[id, 'skipped']]);
  assert.match(res.env.data.tasks[0].why, /records no reviewed commit/);
});

test('F2: review record binds the reviewed commit: the tip of the task branch', async (t) => {
  const r = repo(t);
  const id = r.task('feat/rec', addTest('a.test.mjs'), { review: false });
  const file = join(r.dir, '..', 'review.json');
  writeFileSync(file, JSON.stringify(APPROVED));
  const rec = await cli(['review', 'record', id, '--from', file, '--yes'], r);
  assert.equal(rec.code, 0, JSON.stringify(rec.env.errors));
  assert.equal(events(r, id, 'review').at(-1).data.head, r.git('rev-parse', 'feat/rec'));
});

test('F3: a train that died after moving the target is recovered by the next train: merged and done', async (t) => {
  const r = repo(t);
  const a = r.task('feat/a', addTest('a.test.mjs'));
  const b = r.task('feat/b', addTest('b.test.mjs'));
  // the target already holds both tips; a has its train done recorded (died before merged), b neither
  r.git('merge', '-q', '--no-ff', '--no-edit', 'feat/a');
  r.git('merge', '-q', '--no-ff', '--no-edit', 'feat/b');
  const head = r.git('rev-parse', 'HEAD');
  r.store.update('task', a, (cur) => ({ ...cur, status: 'done', events: [...cur.events, { at: AT, by: r.handle, event: 'done', data: { head, mode: 'train' } }] }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'done a');
  const res = await cli(['train', a, b, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify([res.env.errors, res.env.data.tasks]));
  assert.deepEqual(outcomes(res), [[a, 'merged'], [b, 'merged']]);
  for (const id of [a, b]) {
    assert.equal(r.store.read('task', id).status, 'done', id);
    assert.equal(events(r, id, 'merged').length, 1, id);
    assert.equal(events(r, id, 'done').length, 1, id);
  }
  assert.equal(r.store.read('verify', b).mode.kind, 'train');
});

// Fix round 2 (security review r3): the train takes nothing `task merge` would refuse.
test('F2: a needs-fixes review recorded while the train gate runs keeps the task out: nothing merged or done', async (t) => {
  const r = repo(t, { extra: 'cp "$NEXT_REVIEW" "$REVIEW_DEST";' });
  const id = r.task('feat/a', addTest('a.test.mjs'));
  const next = join(r.dir, '..', 'r2.json');
  writeFileSync(next, JSON.stringify({ schema: verify.VERIFY_KINDS.review.version, ...APPROVED, verdict: 'needs-fixes', findings: [{ id: 'F1', severity: 'blocking', path: 'a.test.mjs', line: 1, rule: null, text: 'fails open' }] })); // REV-7: a needs-fixes with no blocking finding counts as approved
  Object.assign(r.env, { NEXT_REVIEW: next, REVIEW_DEST: join(r.stateDir, 'tasks', id, 'review-r2.json') });
  const tip = r.git('rev-parse', 'HEAD');
  const res = await cli(['train', id, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.data.tasks));
  assert.deepEqual(outcomes(res), [[id, 'skipped']]);
  assert.match(res.env.data.tasks[0].why, /review/);
  assert.equal(r.git('rev-parse', 'HEAD'), tip, 'the target did not move');
  assert.equal(events(r, id, 'merged').length + events(r, id, 'done').length, 0);
  assert.equal(r.store.read('verify', id), null);
});

test('F3: a test removed against the task merge base is refused, though the target tip lacks it too', async (t) => {
  const r = repo(t);
  const KEEP = `${BASE_TESTS}test('keep', () => {});\n`;
  r.write('calc.test.mjs', KEEP);
  r.git('commit', '-q', '-am', 'keep');
  const id = r.task('feat/drop', (w) => w('calc.test.mjs', BASE_TESTS));
  r.write('calc.test.mjs', BASE_TESTS);
  r.git('commit', '-q', '-am', 'drop keep on main');
  const res = await cli(['train', id, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.data.tasks));
  assert.deepEqual(outcomes(res), [[id, 'failed']]);
  assert.match(res.env.data.tasks[0].why, /removed or skipped without a decision/);
});

test('F5: a review that names the reviewed head binds it; a head the branch moved past is refused', async (t) => {
  const r = repo(t);
  const id = r.task('feat/rec', addTest('a.test.mjs'), { review: false });
  const first = r.git('rev-parse', 'feat/rec');
  r.git('checkout', '-q', 'feat/rec');
  r.write('late.txt', 'late\n');
  r.git('add', 'late.txt');
  r.git('commit', '-q', '-m', 'late');
  r.git('checkout', '-q', 'main');
  const file = join(r.dir, '..', 'review.json');
  writeFileSync(file, JSON.stringify({ ...APPROVED, head: first }));
  const stale = await cli(['review', 'record', id, '--from', file, '--yes'], r);
  assert.equal(stale.code, 7, JSON.stringify(stale.env));
  assert.ok(stale.env.errors.some((e) => e.code === 'review-head-moved'), JSON.stringify(stale.env.errors));
  assert.equal(events(r, id, 'review').length, 0);
  const tip = r.git('rev-parse', 'feat/rec');
  writeFileSync(file, JSON.stringify({ ...APPROVED, head: tip }));
  const ok = await cli(['review', 'record', id, '--from', file, '--yes'], r);
  assert.equal(ok.code, 0, JSON.stringify(ok.env.errors));
  assert.equal(events(r, id, 'review').at(-1).data.head, tip);
  writeFileSync(file, JSON.stringify({ ...APPROVED, head: 'not-a-sha' }));
  assert.equal((await cli(['review', 'record', id, '--from', file, '--yes'], r)).code, 2);
});

test('F6: a done head that only contains the tip, written by no train, needs tree equality', async (t) => {
  const r = repo(t);
  const id = r.task('feat/d', addTest('d.test.mjs'));
  r.git('checkout', '-q', '-b', 'other', 'feat/d');
  r.write('extra.txt', 'not verified with the task\n');
  r.git('add', 'extra.txt');
  r.git('commit', '-q', '-m', 'extra');
  const done = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', 'main');
  r.store.update('task', id, (cur) => ({ ...cur, status: 'done', events: [...cur.events, { at: AT, by: r.handle, event: 'done', data: { head: done } }] }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'done d');
  const res = await cli(['train', id, '--yes'], r);
  assert.deepEqual(outcomes(res), [[id, 'skipped']]);
  assert.match(res.env.data.tasks[0].why, /changed since done/);
});

test('F7: an escalated route is refused until its added steps exist, even with an approved review', async (t) => {
  const r = repo(t);
  const id = r.task('feat/esc', (w) => { addTest('x.test.mjs')(w); w('plugins/x/lib/state/migrations/099.mjs', 'export default 1;\n'); }, { cls: 'standard' });
  const res = await cli(['train', id, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.data.tasks));
  assert.deepEqual(outcomes(res), [[id, 'skipped']]);
  assert.match(res.env.data.tasks[0].why, /the change is critical, not standard: the route adds spec-plan, cross-provider-review, rereview/);
  assert.equal(r.store.read('verify', id), null);
  assert.equal(events(r, id, 'merged').length, 0);
});

// T-MG-195: a task merged by hand (a merged event and its tip on the target, no done) is closed by the train.
const adopt = (r, id) => {
  r.store.update('task', id, (cur) => ({ ...cur, events: [...cur.events, { at: AT, by: r.handle, event: 'merged', data: { commit: r.git('rev-parse', 'HEAD'), target: 'main', adopted: true } }] }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'adopt');
};

test('a task merged by hand is taken as done only: done with mode train, one merged event, then skipped as already merged', async (t) => {
  const r = repo(t);
  const id = r.task('feat/hand', addTest('hand.test.mjs'));
  r.git('merge', '--no-ff', '-q', '-m', 'by hand', 'feat/hand');
  adopt(r, id);
  const res = await cli(['train', id, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env));
  assert.deepEqual(outcomes(res), [[id, 'done']]);
  const head = r.git('rev-parse', 'HEAD');
  assert.equal(r.store.read('task', id).status, 'done');
  assert.equal(events(r, id, 'merged').length, 1);
  assert.deepEqual(events(r, id, 'done').map((e) => e.data), [{ head, mode: 'train' }]);
  assert.equal(r.store.read('verify', id).mode.kind, 'train');
  const again = await cli(['train', id, '--yes'], r);
  assert.match(again.env.data.tasks[0].why, /already merged/);
});

test('a merged task whose tip is not on the target is skipped as merged elsewhere', async (t) => {
  const r = repo(t);
  const id = r.task('feat/elsewhere', addTest('e.test.mjs'));
  adopt(r, id);
  const res = await cli(['train', id, '--yes'], r);
  assert.match(res.env.data.tasks[0].why, /merged elsewhere: its tip is not on main/);
});

test('T-MG-192: a merge of main into the branch after the review keeps it eligible; an own commit after it does not', async (t) => {
  const r = repo(t);
  const merged = r.task('feat/merged', addTest('merged.test.mjs'));
  const own = r.task('feat/own', addTest('own.test.mjs'));
  r.write('other.txt', 'main moved\n');
  r.git('add', '-A', '--', '.', `:(exclude)${names.stateDir}`);
  r.git('commit', '-q', '-m', 'main moves on');
  r.git('checkout', '-q', 'feat/merged');
  r.git('merge', '--no-edit', 'main');
  r.git('checkout', '-q', 'feat/own');
  r.write('own2.txt', 'one more commit\n');
  r.git('add', '-A', '--', '.', `:(exclude)${names.stateDir}`);
  r.git('commit', '-q', '-m', 'own change after the review');
  r.git('checkout', '-q', 'main');
  const res = await cli(['train', merged, own], r);
  const why = (id) => res.env.data.tasks.find((x) => x.task === id);
  assert.doesNotMatch(why(merged).why ?? '', /changed since its review/, JSON.stringify(res.env));
  assert.match(why(own).why, /branch changed since its review/);
});
