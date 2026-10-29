// An external review comes from its run (finding D4, T-MG-89): `review record <id> --kind external --run <runId>`
// reads the out file of a done reviewer run of the task (a regular file, no link followed) and stores the review with
// the run ID and the sha256 of the out file's bytes. `--from` with kind external is refused, and a `--from` file that
// claims an external reviewer is refused too: a file alone never makes a review external.
// This file holds no plugin name or path: names come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = readdirSync(join(root, 'plugins')).filter((d) => existsSync(join(root, 'plugins', d, 'lib', 'name.json'))).map((d) => join(root, 'plugins', d))[0];
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const verify = await lib('verify/index.mjs');
const runs = await lib('runs/index.mjs');
const { main } = await lib('cli/main.mjs');
const { COMMANDS } = await lib('cli/commands.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-10-29T10:00:00.000Z';
const EXTERNAL = { verdict: 'approved', reviewer: { kind: 'external', id: 'codex:reviewer' }, findings: [] };
const CLAUDE = { verdict: 'approved', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [] };
const HINT = 'use --run <runId> (the review of an external run comes from its record)';

// A repository with an active store, two dispatched tasks of the git identity, and the run store.
function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'review-run-')));
  const cleanup = [base];
  t.after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });
  const dir = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(dir);
  mkdirSync(home);
  const env = { ...ISO.env, HOME: home };
  const git = (...a) => assert.equal(spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' }).status, 0, `git ${a.join(' ')}`);
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const stateDir = join(dir, names.stateDir);
  const store = state.open(stateDir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  const task = () => state.allocateId(store, {
    prefix: 'T', handle,
    build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: 'critical', classHistory: [{ class: 'critical', reason: 'critical: test', at: AT }], status: 'dispatched', round: 0, events: [], base: null, branch: null }),
  });
  const id = task();
  const other = task();
  return { base, cleanup, dir, env, stateDir, store, id, other, rstore: runs.runsStore(stateDir, names), vstore: verify.openStore(stateDir, names) };
}

// A run record of `task` and `role` with `status`, its out file holding `out` (JSON unless a string). Its out
// directory is as exec makes it (T-MG-91): a 0700 directory right under the temp directory, bound by outDirId.
function addRun(r, { task = r.id, role = 'reviewer', status = 'done', out = EXTERNAL, n = 1 } = {}) {
  const runId = runs.runIdOf('codex', task, role, n);
  const outDir = mkdtempSync(join(tmpdir(), 'review-run-out-'));
  chmodSync(outDir, 0o700);
  r.cleanup.push(outDir);
  const st = lstatSync(outDir, { bigint: true });
  const outFile = join(outDir, 'out.json');
  if (out !== null) writeFileSync(outFile, typeof out === 'string' ? out : JSON.stringify(out));
  const terminal = status === 'done' || status === 'failed';
  r.rstore.write('run', runId, {
    runId, task, role, provider: 'codex', adapterVersion: null, model: null, sandbox: 'read-only', cwd: r.dir, pid: null, pidStart: null, pidMethod: null, lease: null,
    status, queuedAt: AT, startedAt: AT, endedAt: terminal ? AT : null, elapsedMs: 0, capS: 900, tokens: null, tokensReason: null, costMicroUsd: null,
    lastLine: null, unknownEvents: 0, outFile, exit: terminal ? 0 : null, error: null, outDirId: `${st.dev}:${st.ino}`,
  });
  return { runId, outFile, outDir };
}

async function cli(args, { dir, env }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd: dir, stdin: null };
  const code = await main([...args, '--json', '--yes'], { io });
  const text = out.join('');
  return { code, text: `${text}\n${err.join('')}`, env: JSON.parse(text) };
}
const viaRun = (r, runId, id = r.id) => cli(['review', 'record', id, '--kind', 'external', '--run', runId], r);
const first = (res) => res.env.errors[0] ?? {};
const reviewKeys = (r) => r.vstore.list('review').filter((k) => k.startsWith(`${r.id}/`));

test('a done reviewer run of the task records an external review with the run ID and the sha256 of its out file', async (t) => {
  const r = repo(t);
  const { runId, outFile } = addRun(r);
  const res = await viaRun(r, runId);
  assert.equal(res.code, 0, res.text);
  assert.equal(res.env.data.round, 1);
  const sha256 = createHash('sha256').update(readFileSync(outFile)).digest('hex');
  assert.deepEqual(r.vstore.read('review', verify.reviewKey(r.id, 1)), { schema: 1, ...EXTERNAL, run: runId, sha256 });
  const event = r.store.read('task', r.id).events.at(-1);
  assert.deepEqual([event.event, event.data.reviewer], ['review', 'external']);
});

test('a run that is not a done reviewer run of this task is refused; nothing is written', async (t) => {
  const r = repo(t);
  const cases = [
    ['a run of another task', addRun(r, { task: r.other }).runId],
    ['an implementer run', addRun(r, { role: 'implementer' }).runId],
    ['a run still running', addRun(r, { status: 'running', n: 2 }).runId],
    ['a failed run', addRun(r, { status: 'failed', n: 3 }).runId],
  ];
  for (const [what, runId] of cases) {
    const res = await viaRun(r, runId);
    assert.equal(res.code, 7, `${what}: ${res.text}`);
    assert.equal(first(res).code, 'run-not-reviewable', what);
  }
  let res = await viaRun(r, runs.runIdOf('codex', r.id, 'reviewer', 9));
  assert.deepEqual([res.code, first(res).code], [2, 'run-unknown'], res.text);
  res = await viaRun(r, '../x');
  assert.deepEqual([res.code, first(res).code], [2, 'invalid-value'], res.text);
  assert.deepEqual(reviewKeys(r), []);
});

test('an out file that is a symbolic link, missing or not review JSON is refused', async (t) => {
  const r = repo(t);
  const { runId, outFile } = addRun(r, { out: null });
  const real = join(r.base, 'forged.json');
  writeFileSync(real, JSON.stringify(EXTERNAL));
  let res = await viaRun(r, runId);
  assert.deepEqual([res.code, first(res).code], [2, 'review-unreadable'], `missing: ${res.text}`);
  symlinkSync(real, outFile);
  res = await viaRun(r, runId);
  assert.deepEqual([res.code, first(res).code], [2, 'review-unreadable'], `a link: ${res.text}`);
  assert.match(first(res).message, /not a regular file/);
  const bad = addRun(r, { out: '{"verdict": ', n: 2 });
  res = await viaRun(r, bad.runId);
  assert.deepEqual([res.code, first(res).code], [2, 'invalid-review'], res.text);
  assert.deepEqual(reviewKeys(r), []);
});

test('--from with kind external is refused with the hint; a --from file claiming an external reviewer is refused', async (t) => {
  const r = repo(t);
  const file = join(r.base, 'review.json');
  writeFileSync(file, JSON.stringify(EXTERNAL));
  let res = await cli(['review', 'record', r.id, '--kind', 'external', '--from', file], r);
  assert.deepEqual([res.code, first(res).hint], [2, HINT], res.text);
  res = await cli(['review', 'record', r.id, '--kind', 'external'], r);
  assert.deepEqual([res.code, first(res).hint], [2, HINT], res.text);
  res = await cli(['review', 'record', r.id, '--from', file], r);
  assert.deepEqual([res.code, first(res).code, first(res).hint], [7, 'external-needs-run', HINT], res.text);
  res = await cli(['review', 'record', r.id, '--run', addRun(r).runId], r);
  assert.equal(res.code, 2, `--run needs --kind external: ${res.text}`);
  assert.deepEqual(reviewKeys(r), []);
});

test('kind claude with --from still records, with no run and no sha256', async (t) => {
  const r = repo(t);
  const file = join(r.base, 'review.json');
  writeFileSync(file, JSON.stringify(CLAUDE));
  for (const extra of [[], ['--kind', 'claude']]) {
    const res = await cli(['review', 'record', r.id, '--from', file, ...extra], r);
    assert.equal(res.code, 0, res.text);
  }
  assert.deepEqual(r.vstore.read('review', verify.reviewKey(r.id, 1)), { schema: 1, ...CLAUDE });
  assert.deepEqual(reviewKeys(r).length, 2);
});

test('the review record row lists --from, --kind and --run', () => {
  const row = COMMANDS.find((c) => c.name === 'review record');
  assert.deepEqual(row.flags.map((f) => f.flag), ['--from', '--kind', '--run']);
});

// ---- T-MG-91: the run's bound out directory, and a stored external round without its run ----

test('review record --run checks the run\'s bound out directory as run-supervise does; anything else is run-not-reviewable', async (t) => {
  const r = repo(t);
  const patch = (runId, fields) => r.rstore.update('run', runId, (cur) => ({ ...cur, ...fields }));
  const cases = [];
  let n = 1;
  const next = () => addRun(r, { n: n++ });
  let x = next();
  writeFileSync(join(x.outDir, 'other.json'), JSON.stringify(EXTERNAL));
  patch(x.runId, { outFile: join(x.outDir, 'other.json') });
  cases.push(['not named out.json', x.runId]);
  x = next();
  const nested = join(r.base, 'nested');
  mkdirSync(nested, { mode: 0o700 });
  writeFileSync(join(nested, 'out.json'), JSON.stringify(EXTERNAL));
  const nst = lstatSync(nested, { bigint: true });
  patch(x.runId, { outFile: join(nested, 'out.json'), outDirId: `${nst.dev}:${nst.ino}` });
  cases.push(['not directly under the temp directory', x.runId]);
  x = next();
  chmodSync(x.outDir, 0o755);
  cases.push(['mode 0755', x.runId]);
  x = next();
  patch(x.runId, { outDirId: '1:2' });
  cases.push(['another outDirId', x.runId]);
  x = next();
  r.rstore.update('run', x.runId, ({ outDirId, ...rest }) => rest); // eslint-disable-line no-unused-vars
  cases.push(['no outDirId', x.runId]);
  x = next();
  const link = `${x.outDir}-link`;
  symlinkSync(x.outDir, link);
  r.cleanup.push(link);
  patch(x.runId, { outFile: join(link, 'out.json') });
  cases.push(['a linked directory', x.runId]);
  x = next();
  renameSync(x.outDir, `${x.outDir}-old`);
  r.cleanup.push(`${x.outDir}-old`);
  mkdirSync(x.outDir, { mode: 0o700 });
  writeFileSync(x.outFile, JSON.stringify(EXTERNAL));
  cases.push(['a replaced directory', x.runId]);
  for (const [what, runId] of cases) {
    const res = await viaRun(r, runId);
    assert.deepEqual([res.code, first(res).code], [7, 'run-not-reviewable'], `${what}: ${res.text}`);
  }
  assert.deepEqual(reviewKeys(r), []);
  assert.equal((await viaRun(r, next().runId)).code, 0, 'the control run records');
});

test('a stored external round without run and sha256 does not count; verify names the fix; the round is kept', async (t) => {
  const r = repo(t);
  const steps = ['review', 'cross-provider-review'];
  r.vstore.create('review', verify.reviewKey(r.id, 1), EXTERNAL); // as a --from file stored it before 2.5.0
  assert.equal(verify.reviewState(r.vstore, r.id, steps, { providerAvailable: true }), 'missing');
  assert.equal(verify.reviewState(r.vstore, r.id, ['review']), 'missing', 'it counts for no route');
  assert.equal(verify.reviewProblem(r.vstore, r.id, names), `external review without its run: record it again with ${names.bin} review record ${r.id} --kind external --run <run ID>`);
  assert.deepEqual(r.vstore.read('review', verify.reviewKey(r.id, 1)), { schema: 1, ...EXTERNAL }, 'the old round is kept');
  const { runId } = addRun(r);
  assert.equal((await viaRun(r, runId)).code, 0);
  assert.equal(verify.reviewState(r.vstore, r.id, steps, { providerAvailable: true }), 'approved');
  assert.equal(verify.reviewProblem(r.vstore, r.id, names), null);
});

test('the texts name the --run form: the dispatch skill step 6, and the providers CLI header names --env', () => {
  const dispatch = readFileSync(join(pluginDir, 'templates', 'skills', 'dispatch.md'), 'utf8');
  assert.match(dispatch.split('\n').find((l) => l.startsWith('6. ')), /review record <id> --kind external --run <run ID>/);
  assert.match(readFileSync(join(pluginDir, 'lib', 'providers', 'cli.mjs'), 'utf8').split('\n')[0], /--env/);
});
