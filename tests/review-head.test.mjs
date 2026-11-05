// T-MG-192: `review record --from` binds the commit the reviewer read. With `head` in the JSON: that commit. Without it:
// the Range head of the round's review brief, else the branch tip only when the tip is older than the review file
// (review-head-unknown otherwise). A head that is not the tip stands while the branch only gained merges of main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1);
  return join(plugins, hits[0]);
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const { main } = await lib('cli/main.mjs');
const { openStore } = await lib('verify/index.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-11-05T05:42:00.000Z';
const REVIEW = { verdict: 'approved', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [] };
const LONG_AGO = '2020-01-01T00:00:00Z';

// A repository with a task on branch `feat` (one commit, dated `tipDate`) dispatched to a reviewer.
function repo(t, { tipDate = LONG_AGO } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'review-head-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  mkdirSync(join(base, 'home'));
  const env = { ...ISO.env, HOME: join(base, 'home') };
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, env: { ...env, GIT_COMMITTER_DATE: tipDate, GIT_AUTHOR_DATE: tipDate }, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base0 = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'b.txt'), 'b');
  git('add', '-A');
  git('commit', '-q', '-m', 'work');
  const reviewed = git('rev-parse', 'HEAD');
  const store = state.open(join(dir, names.stateDir), { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  const id = state.allocateId(store, { prefix: 'T', handle, build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: 'standard', classHistory: [{ class: 'standard', reason: 'standard: test', at: AT }], status: 'new', round: 0, events: [], base: base0, branch: 'feat' }) });
  state.setTask({ cwd: dir, env, names, id, state: 'dispatched', options: { executor: 'claude:reviewer', base: base0 } });
  const file = join(base, 'review.json');
  writeFileSync(file, JSON.stringify(REVIEW));
  const brief = (head) => {
    mkdirSync(join(dir, names.stateDir, 'tasks', id), { recursive: true });
    writeFileSync(join(dir, names.stateDir, 'tasks', id, 'review-r1-brief.md'), `# Review brief\n\nRange: ${base0}..${head} (branch feat; HEAD at rendering: ${head})\n`);
  };
  return { dir, env, id, git, file, reviewed, brief, store: openStore(join(dir, names.stateDir), names) };
}

async function record(r) {
  const out = [];
  const code = await main(['review', 'record', r.id, '--from', r.file, '--yes', '--json'], { io: { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env: r.env, cwd: r.dir, stdin: null } });
  return { code, env: JSON.parse(out.join('')) };
}
const headOf = (r) => r.store.read('task', r.id).events.findLast((e) => e.event === 'review').data.head;
const moveBranch = (r, { merge }) => {
  if (merge) {
    r.git('checkout', '-q', 'main');
    writeFileSync(join(r.dir, 'm.txt'), 'm');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'main moves');
    r.git('checkout', '-q', 'feat');
    r.git('merge', '--no-edit', 'main');
  } else {
    writeFileSync(join(r.dir, 'c.txt'), 'c');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'own change');
  }
};

test('no head in the JSON: the Range head of the review brief is the reviewed commit, not the tip', async (t) => {
  const r = repo(t);
  r.brief(r.reviewed);
  moveBranch(r, { merge: true }); // the branch moved after the brief: a merge of main only
  const res = await record(r);
  assert.equal(res.code, 0, JSON.stringify(res.env));
  assert.equal(headOf(r), r.reviewed);
});

test('no head, the brief names a commit and the branch gained an own commit after it: review-head-moved', async (t) => {
  const r = repo(t);
  r.brief(r.reviewed);
  moveBranch(r, { merge: false });
  const res = await record(r);
  assert.equal(res.code, 7, JSON.stringify(res.env));
  assert.equal(res.env.errors[0].code, 'review-head-moved');
});

test('no head and no brief: a tip older than the review file is the reviewed commit', async (t) => {
  const r = repo(t);
  const res = await record(r);
  assert.equal(res.code, 0, JSON.stringify(res.env));
  assert.equal(headOf(r), r.reviewed);
});

test('no head and no brief: a tip newer than the review file is refused with review-head-unknown', async (t) => {
  const r = repo(t, { tipDate: new Date(Date.now() + 3600e3).toISOString() });
  const past = new Date(Date.now() - 1000);
  utimesSync(r.file, past, past);
  const res = await record(r);
  assert.equal(res.code, 7, JSON.stringify(res.env));
  assert.equal(res.env.errors[0].code, 'review-head-unknown');
  assert.match(res.env.errors[0].hint, /head/);
});

test('a head in the JSON that is not the tip stands after a merge of main, and is refused after an own commit', async (t) => {
  const r = repo(t);
  writeFileSync(r.file, JSON.stringify({ ...REVIEW, head: r.reviewed }));
  moveBranch(r, { merge: true });
  assert.equal((await record(r)).code, 0);
  assert.equal(headOf(r), r.reviewed);
  moveBranch(r, { merge: false });
  const res = await record(r);
  assert.equal(res.env.errors[0].code, 'review-head-moved');
});

test('a merge of main that also carries its own edit is a changed branch: review-head-moved', async (t) => {
  const r = repo(t);
  writeFileSync(r.file, JSON.stringify({ ...REVIEW, head: r.reviewed }));
  r.git('checkout', '-q', 'main');
  writeFileSync(join(r.dir, 'm.txt'), 'm');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'main moves');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '--no-edit', '--no-commit', 'main');
  writeFileSync(join(r.dir, 'evil.txt'), 'smuggled in the merge');
  r.git('add', 'evil.txt');
  r.git('commit', '-q', '-m', 'Merge main (edited)');
  const res = await record(r);
  assert.equal(res.code, 7, JSON.stringify(res.env));
  assert.equal(res.env.errors[0].code, 'review-head-moved');
});

test('a merge committed with its conflict unresolved is a changed branch, not a clean merge (merge-tree fails)', async (t) => {
  const r = repo(t);
  writeFileSync(join(r.dir, 'a.txt'), 'feat side');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'feat edits a');
  const reviewed = r.git('rev-parse', 'HEAD');
  writeFileSync(r.file, JSON.stringify({ ...REVIEW, head: reviewed }));
  r.git('checkout', '-q', 'main');
  writeFileSync(join(r.dir, 'a.txt'), 'main side');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'main edits a');
  r.git('checkout', '-q', 'feat');
  spawnSync('git', ['merge', '--no-edit', 'main'], { cwd: r.dir, env: r.env, encoding: 'utf8' }); // conflicts
  r.git('add', 'a.txt'); // the conflict markers are committed as they are
  r.git('commit', '-q', '-m', 'Merge main (unresolved)');
  const res = await record(r);
  assert.equal(res.code, 7, JSON.stringify(res.env));
  assert.equal(res.env.errors[0].code, 'review-head-moved');
});
