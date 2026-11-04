// T-MG-187: `review record --from` (a claude review) is accepted only when the task's latest dispatch names a reviewer
// executor and no implementer report came after it; an implementer cannot approve its own task. SEC-13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-11-05T05:42:00.000Z';
const REVIEW = { verdict: 'approved', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [] };

function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'review-disp-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  mkdirSync(join(base, 'home'));
  const env = { ...ISO.env, HOME: join(base, 'home') };
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const stateDir = join(dir, names.stateDir);
  const store = state.open(stateDir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  const id = state.allocateId(store, { prefix: 'T', handle, build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: 'standard', classHistory: [{ class: 'standard', reason: 'standard: test', at: AT }], status: 'new', round: 0, events: [], base: head, branch: null }) });
  const file = join(base, 'review.json');
  writeFileSync(file, JSON.stringify(REVIEW));
  const set = (st, options) => state.setTask({ cwd: dir, env, names, id, state: st, options });
  return { dir, env, id, head, file, set };
}

async function record(r) {
  const out = [];
  const code = await main(['review', 'record', r.id, '--from', r.file, '--yes', '--json'], { io: { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env: r.env, cwd: r.dir, stdin: null } });
  return { code, env: JSON.parse(out.join('')) };
}

test('an implementer-dispatched task takes no claude review: exit 7 naming the rule and the hint', async (t) => {
  const r = repo(t);
  r.set('dispatched', { executor: 'claude:implementer', base: r.head });
  const res = await record(r);
  assert.equal(res.code, 7, JSON.stringify(res.env));
  assert.equal(res.env.errors[0].code, 'reviewer-not-dispatched');
  assert.match(res.env.errors[0].message, /SEC-13/);
  assert.match(res.env.errors[0].hint ?? res.env.errors[0].message, /dispatch/);
});

test('a task with no dispatch takes no claude review', async (t) => {
  const r = repo(t);
  assert.equal((await record(r)).code, 7);
});

for (const executor of ['claude:reviewer', `${names.codename}:security-reviewer`]) {
  test(`a task dispatched to ${executor} takes the review`, async (t) => {
    const r = repo(t);
    r.set('dispatched', { executor: 'claude:implementer', base: r.head });
    r.set('dispatched', { executor, base: r.head });
    const res = await record(r);
    assert.equal(res.code, 0, JSON.stringify(res.env));
  });
}

test('an implementer report after the reviewer dispatch voids it', async (t) => {
  const r = repo(t);
  r.set('dispatched', { executor: 'claude:reviewer', base: r.head });
  r.set('implementer', { report: 'done' });
  const res = await record(r);
  assert.equal(res.code, 7, JSON.stringify(res.env));
  assert.equal(res.env.errors[0].code, 'reviewer-not-dispatched');
});
