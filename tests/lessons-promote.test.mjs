// Lessons slice 2 (T-MG-94): promotion from receipts, retrieval by cue, the lesson line in the brief, and the
// executor evidence line (T-MG-21 leftovers: executorRecords end to end and the brief numbers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';
import { seedReceipts } from './helpers/seed-receipts.mjs';

isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugins', readdirSync(join(root, 'plugins')).find((d) => existsSync(join(root, 'plugins', d, 'lib/name.json'))));
const names = JSON.parse(readFileSync(join(pluginDir, 'lib/name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const state = await lib('state/index.mjs');
const { RECEIPT, executorRecords } = await lib('receipts/index.mjs');
const { cellStats, suggestExecutors } = await lib('receipts/executors.mjs');

const OLD = '2020-01-01T00:00:00.000Z';
const NEW = '2099-01-01T00:00:00.000Z';
const rows = (n, pass, extra) => Array.from({ length: n }, (_, i) => ({ pass: i < pass, ...extra }));

async function fixture(t) {
  const iso = isolatedEnv({ gitConfig: '[user]\n name = A B\n email = ab@example.com\n', prefix: 'promote-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }).status, 0);
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'fixture');
  const cli = async (args) => {
    const io = { cwd: repo, env, stdinIsTTY: false, stdin: null, stdout: '', stderr: '' };
    io.out = (s) => { io.stdout += s; };
    io.err = (s) => { io.stderr += s; };
    const code = await main(args, { io });
    return { code, stdout: io.stdout, stderr: io.stderr, json: args.includes('--json') ? JSON.parse(io.stdout) : null };
  };
  const ok = async (args) => {
    const r = await cli(args);
    assert.equal(r.code, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
    return r;
  };
  await ok(['init', '--handle', 'AB', '--yes']);
  const dir = join(realpathSync(repo), names.stateDir);
  const store = state.open(dir, { names, kinds: { ...state.KINDS, [RECEIPT.name]: RECEIPT } });
  const seed = (list, first) => seedReceipts(pluginDir, store, list, { first });
  const add = (extra = []) => cli(['lessons', 'add', '--cue', 'a verify fails after a rebase', '--lesson', 'run the gate on the merged tree', '--component', 'gate', '--evidence', 'T-AB-1', ...extra, '--yes', '--json']);
  return { cli, ok, dir, store, seed, add, repo, env };
}

test('promote: 20 receipts on each side and separated intervals turn a helped lesson active', async (t) => {
  const f = await fixture(t);
  await f.seed([...rows(20, 4, { endedAt: OLD }), ...rows(20, 19, { endedAt: NEW })], 1);
  await f.add(['--verdict', 'gate on merged tree=helped']);
  const r = await f.cli(['lessons', 'promote', 'L-AB-1', '--yes', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.data.lesson.status, 'active');
  assert.equal(r.json.data.evidence.before.tasks, 20);
  assert.equal(r.json.data.evidence.after.tasks, 20);
  assert.equal((await f.ok(['lessons', 'show', 'L-AB-1', '--json'])).json.data.lesson.status, 'active');
});

test('promote refuses with exit 7 and the numbers: fewer than 20 receipts, overlapping intervals, the wrong direction, no consent', async (t) => {
  const f = await fixture(t);
  await f.seed([...rows(20, 4, { endedAt: OLD }), ...rows(19, 19, { endedAt: NEW })], 1);
  await f.add(['--verdict', 'x=helped']);
  const few = await f.cli(['lessons', 'promote', 'L-AB-1', '--yes', '--json']);
  assert.equal(few.code, 7);
  assert.match(few.json.errors[0].message, /fewer than 20 receipts/);
  assert.match(few.json.errors[0].message, /19/);
  assert.equal((await f.ok(['lessons', 'show', 'L-AB-1', '--json'])).json.data.lesson.status, 'shadow');

  const g = await fixture(t);
  await g.seed([...rows(20, 12, { endedAt: OLD }), ...rows(20, 14, { endedAt: NEW })], 1);
  await g.add(['--verdict', 'x=helped']);
  const overlap = await g.cli(['lessons', 'promote', 'L-AB-1', '--yes', '--json']);
  assert.equal(overlap.code, 7);
  assert.match(overlap.json.errors[0].message, /intervals overlap/);

  const h = await fixture(t);
  await h.seed([...rows(20, 4, { endedAt: OLD }), ...rows(20, 19, { endedAt: NEW })], 1);
  await h.add(['--verdict', 'x=hurt']);
  const wrong = await h.cli(['lessons', 'promote', 'L-AB-1', '--yes', '--json']);
  assert.equal(wrong.code, 7, 'the rate rose but the lesson says hurt');
  assert.match(wrong.json.errors[0].message, /intervals overlap|direction/);
  assert.equal((await h.cli(['lessons', 'promote', 'L-AB-1', '--json'])).code, 7, 'no consent');
});

test('promote counts only the class of the evidence', async (t) => {
  const f = await fixture(t);
  await f.seed([...rows(20, 4, { endedAt: OLD }), ...rows(20, 19, { endedAt: NEW, cls: 'critical' })], 1);
  await f.add(['--verdict', 'x=helped']);
  const r = await f.cli(['lessons', 'promote', 'L-AB-1', '--yes', '--json']);
  assert.equal(r.code, 7);
  assert.match(r.json.errors[0].message, /fewer than 20 receipts/);
});

test('promote of a hurt lesson needs the rate to fall; a non-shadow lesson is a usage error', async (t) => {
  const f = await fixture(t);
  await f.seed([...rows(20, 19, { endedAt: OLD }), ...rows(20, 4, { endedAt: NEW })], 1);
  await f.add(['--verdict', 'x=hurt']);
  assert.equal((await f.cli(['lessons', 'promote', 'L-AB-1', '--yes'])).code, 0);
  assert.equal((await f.cli(['lessons', 'promote', 'L-AB-1', '--yes'])).code, 2, 'already active');
});

test('lessons find lists active lessons sharing a cue word, best first, at most 5; rule keeps its output', async (t) => {
  const f = await fixture(t);
  await f.seed(rows(1, 1, { endedAt: OLD }), 1);
  const cues = ['Verify fails after a rebase', 'verify gate runs late', 'unrelated cue text', 'rebase conflicts in the verify gate', 'gate gate', 'gate again one', 'gate again two'];
  for (const c of cues) await f.ok(['lessons', 'add', '--cue', c, '--lesson', `lesson for ${c}`, '--component', 'gate', '--evidence', 'T-AB-1', '--yes']);
  const { writeLesson } = { writeLesson: (id) => f.store.update('lesson', id, (l) => ({ ...l, status: 'active' })) };
  for (let n = 1; n <= cues.length; n++) writeLesson(`L-AB-${n}`);
  const r = await f.ok(['lessons', 'find', 'Verify', 'gate', 'rebase', '--json']);
  const ids = r.json.data.lessons.map((l) => l.id);
  assert.equal(ids[0], 'L-AB-4', 'three shared words rank first');
  assert.ok(!ids.includes('L-AB-3'));
  assert.ok(ids.length <= 5);
  const short = await f.ok(['lessons', 'find', 'an', 'is', '--json']);
  assert.deepEqual(short.json.data.lessons, [], 'words under 3 letters are ignored');
  f.store.update('lesson', 'L-AB-4', (l) => ({ ...l, status: 'shadow' }));
  assert.ok(!(await f.ok(['lessons', 'find', 'rebase', '--json'])).json.data.lessons.some((l) => l.id === 'L-AB-4'), 'shadow lessons do not match');
  assert.match((await f.ok(['rule', 'COD-1'])).stdout, /^COD-1\. /);
});

test('brief --write adds one Lessons line for active lessons matching the title: at most 3 and 300 characters', async (t) => {
  const f = await fixture(t);
  await f.ok(['task', 'new', 'Fix the rebase verify gate', '--yes']);
  await f.ok(['route', 'T-AB-1', '--paths', 'src/a.js', '--loc', '2', '--yes']);
  for (let n = 1; n <= 5; n++) await f.ok(['lessons', 'add', '--cue', `rebase verify case ${n}`, '--lesson', `${'long '.repeat(30)}${n}`, '--component', 'gate', '--evidence', 'T-AB-1', '--yes']);
  const before = (await f.ok(['brief', 'T-AB-1', '--json'])).json.data.text;
  assert.ok(!/^Lessons: /m.test(before), 'shadow lessons are not briefed');
  for (let n = 1; n <= 5; n++) f.store.update('lesson', `L-AB-${n}`, (l) => ({ ...l, status: 'active' }));
  const w = await f.ok(['brief', 'T-AB-1', '--write', '--yes', '--json']);
  const text = readFileSync(w.json.data.file, 'utf8');
  const found = text.match(/^Lessons: .*$/gm);
  assert.equal(found.length, 1);
  assert.match(found[0], /^Lessons: L-AB-\d: /);
  assert.ok([...found[0].slice('Lessons: '.length)].length <= 300);
  assert.ok((found[0].match(/L-AB-\d/g) ?? []).length <= 3);
  await f.ok(['task', 'new', 'Nothing alike', '--yes']);
  await f.ok(['route', 'T-AB-2', '--paths', 'src/a.js', '--loc', '2', '--yes']);
  assert.ok(!/^Lessons: /m.test((await f.ok(['brief', 'T-AB-2', '--json'])).json.data.text));
});

test('executorRecords reads seeded receipts with dispatched and verify events; route --executor suggests from them and brief writes the numbers', async (t) => {
  const f = await fixture(t);
  await f.seed([
    ...rows(20, 20, { executor: 'codex', cls: 'standard' }),
    ...rows(20, 3, { executor: 'caw:implementer', cls: 'standard' }),
  ], 1);
  const records = executorRecords({ cwd: f.repo, env: f.env, names });
  assert.equal(records.length, 40);
  assert.deepEqual(records[0], { task: 'T-AB-1', class: 'standard', executor: 'codex', firstPass: true, costMicroUsd: 1000, endedAt: OLD });
  const impl = suggestExecutors(cellStats(records), 'standard').find((r) => r.role === 'implementer');
  assert.equal(impl.executor, 'codex');
  await f.ok(['task', 'new', 'Wire the login', '--yes']);
  const id = 'T-AB-41';
  const route = await f.ok(['route', id, '--paths', 'src/a.js', '--loc', '100', '--executor', '--yes', '--json']);
  assert.equal(route.json.data.class, 'standard');
  assert.equal(route.json.data.executor.results.find((r) => r.role === 'implementer').executor, 'codex');
  const brief = await f.ok(['brief', id, '--write', '--yes', '--json']);
  const line = readFileSync(brief.json.data.file, 'utf8').match(/^Executor evidence: .*$/m);
  assert.ok(line, 'the brief carries the cell numbers');
  assert.match(line[0], /codex/);
  assert.match(line[0], /1\.00/);
  assert.match(line[0], /20 tasks/);
});
