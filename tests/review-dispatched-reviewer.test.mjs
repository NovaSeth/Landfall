// T-MG-187: `review record --from` (a claude review) is accepted only when the task's latest dispatch names a reviewer
// executor and no implementer report came after it; an implementer cannot approve its own task. SEC-13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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
const T = await lib('state/tokens.mjs');
const { openStore } = await lib('verify/index.mjs');
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

// T-MG-194 (SEC-13): the role token rows of the command matrix (spec D2, Contracts).
const me = T.holderOf(process.pid);
const mint = (r, role) => T.mint({ dir: join(r.dir, names.stateDir), names, role, session: 's1', agent: 'ag1', host: me }).token;
// Runs the CLI in process; `token` goes to the stdin of the call, `tty` marks stdin as a terminal.
async function cli(r, argv, { token, tty = false, json = true } = {}) {
  const out = [];
  const err = [];
  const stdin = token === undefined ? null : Readable.from([Buffer.from(token)]);
  const code = await main([...argv, '--yes', ...(json ? ['--json'] : [])], { io: { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env: r.env, cwd: r.dir, stdin } });
  const all = out.join('') + err.join('');
  assert.ok(!all.includes('lf1_'), 'a token is never echoed');
  return { code, err: err.join(''), env: json ? JSON.parse(out.join('')) : null };
}
const rec = (r, extra = []) => ['review', 'record', r.id, '--from', r.file, ...extra];
const reviews = (r) => openStore(join(r.dir, names.stateDir), names).list('review');
const codeOf = (res) => res.env.errors[0].code;
const dispatched = (r) => r.set('dispatched', { executor: 'claude:reviewer', base: r.head });

test('token matrix, review record: no token and nothing live records with the SEC-13 warning', async (t) => {
  const r = repo(t);
  dispatched(r);
  const res = await cli(r, rec(r), { json: false });
  assert.equal(res.code, 0, res.err);
  assert.ok(res.err.includes(`warning: no live session token in ${join(r.dir, names.stateDir)}; recorded without a role check (SEC-13)\n`), res.err);
});

test('token matrix, review record: a live orchestrator refuses a call without a token, and writes nothing', async (t) => {
  const r = repo(t);
  dispatched(r);
  mint(r, 'orchestrator');
  const res = await cli(r, rec(r));
  assert.deepEqual([res.code, codeOf(res)], [7, 'token-required']);
  assert.deepEqual(reviews(r), []);
});

test('token matrix, review record: a reviewer token records once; the second call is token-unknown', async (t) => {
  const r = repo(t);
  dispatched(r);
  mint(r, 'orchestrator');
  const token = mint(r, 'reviewer');
  const bad = join(r.dir, 'bad.json');
  writeFileSync(bad, '{"verdict":"nope"}');
  assert.equal((await cli(r, ['review', 'record', r.id, '--from', bad, '--token', '-'], { token })).code, 2, 'invalid input keeps the token');
  assert.equal((await cli(r, rec(r, ['--token', '-']), { token })).code, 0);
  const again = await cli(r, rec(r, ['--token', '-']), { token });
  assert.deepEqual([again.code, codeOf(again)], [7, 'token-unknown']);
  assert.equal(reviews(r).length, 1);
});

test('token matrix, review record: the orchestrator token is the wrong role for a claude review; external needs it', async (t) => {
  const r = repo(t);
  dispatched(r);
  const orch = mint(r, 'orchestrator');
  const rev = mint(r, 'reviewer');
  const wrong = await cli(r, rec(r, ['--token', '-']), { token: orch });
  assert.deepEqual([wrong.code, codeOf(wrong)], [7, 'token-role']);
  const ext = ['review', 'record', r.id, '--kind', 'external', '--run', 'codex-T-AB-1-reviewer-1', '--token', '-'];
  assert.equal(codeOf(await cli(r, ext, { token: rev })), 'token-role');
  assert.equal(codeOf(await cli(r, ext, { token: orch })), 'run-unknown', 'the orchestrator token passes the role check');
});

for (const state_ of ['dispatched', 'self-verified']) {
  test(`token matrix, task set ${state_}: orchestrator token proceeds; reviewer token, no token and a live orchestrator are refused`, async (t) => {
    const r = repo(t);
    const orch = mint(r, 'orchestrator');
    const rev = mint(r, 'reviewer');
    const argv = ['task', 'set', r.id, state_, ...(state_ === 'dispatched' ? ['--executor', 'claude:reviewer', '--base', r.head] : [])];
    assert.equal(codeOf(await cli(r, [...argv, '--token', '-'], { token: rev })), 'token-role');
    const none = await cli(r, argv);
    assert.deepEqual([none.code, codeOf(none)], [7, 'token-required']);
    assert.match(none.env.errors[0].message, /s1/);
    assert.equal((await cli(r, [...argv, '--token', '-'], { token: orch })).code, 0);
  });
}

test('token matrix, task set: nothing live warns and proceeds; other states never need a token', async (t) => {
  const r = repo(t);
  const res = await cli(r, ['task', 'set', r.id, 'dispatched', '--executor', 'claude:reviewer', '--base', r.head], { json: false });
  assert.equal(res.code, 0, res.err);
  assert.ok(res.err.includes('(SEC-13)'));
  mint(r, 'orchestrator');
  assert.equal((await cli(r, ['task', 'set', r.id, 'blocked', '--reason', 'why'])).code, 0);
  assert.equal((await cli(r, ['task', 'set', r.id, 'implementer', '--report', 'done'])).code, 0);
});

test('token flag: argv value, a terminal, a malformed token and a corrupt store are refused before anything is written', async (t) => {
  const r = repo(t);
  dispatched(r);
  const argv = rec(r);
  const on = await cli(r, [...argv, '--token', 'lf1_abc']);
  assert.deepEqual([on.code, codeOf(on)], [2, 'token-on-argv']);
  const tty = await cli(r, [...argv, '--token', '-'], { token: 'x', tty: true });
  assert.deepEqual([tty.code, codeOf(tty)], [2, 'token-stdin-tty']);
  for (const token of ['', 'lf1_short', `lf1_${'A'.repeat(43)}x`, 'x'.repeat(300)]) {
    const bad = await cli(r, [...argv, '--token', '-'], { token });
    assert.deepEqual([bad.code, codeOf(bad)], [2, 'token-malformed'], JSON.stringify(token.slice(0, 10)));
  }
  writeFileSync(join(r.dir, names.stateDir, 'local', 'token.json'), '{"schema": 9}\n');
  const closed = await cli(r, argv);
  assert.deepEqual([closed.code, codeOf(closed)], [7, 'token-store']);
  assert.deepEqual(reviews(r), []);
});

test('token matrix, review record: a failed review write keeps the reviewer token, so the retry records once', async (t) => {
  const r = repo(t);
  dispatched(r);
  mint(r, 'orchestrator');
  const token = mint(r, 'reviewer');
  const taskDir = join(r.dir, names.stateDir, 'tasks', r.id);
  chmodSync(taskDir, 0o555);
  t.after(() => existsSync(taskDir) && chmodSync(taskDir, 0o755));
  const failed = await cli(r, rec(r, ['--token', '-']), { token });
  assert.notEqual(failed.code, 0);
  assert.deepEqual(reviews(r), []);
  chmodSync(taskDir, 0o755);
  assert.equal((await cli(r, rec(r, ['--token', '-']), { token })).code, 0);
  const again = await cli(r, rec(r, ['--token', '-']), { token });
  assert.deepEqual([again.code, codeOf(again)], [7, 'token-unknown']);
  assert.equal(reviews(r).length, 1);
});
