// Evidence-gated lessons, slice 1: admission in code, ID stability, the --json shapes, text stored as data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugins', readdirSync(join(root, 'plugins')).find((d) => existsSync(join(root, 'plugins', d, 'lib/name.json'))));
const names = JSON.parse(readFileSync(join(pluginDir, 'lib/name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const { admit } = await lib('lessons/index.mjs');
const state = await lib('state/index.mjs');

const GOOD = { cue: 'a verify fails after a rebase', lesson: 'the gate must run on the merged tree', component: 'gate', evidence: ['T-AB-1'], verdicts: [] };
const has = (open) => (id) => open.includes(id);

test('admit returns every problem at once as {field, problem}', () => {
  assert.deepEqual(admit(GOOD, has(['T-AB-1'])), []);
  const none = admit({ cue: '', lesson: '', component: '', evidence: [], verdicts: [] }, has([]));
  assert.deepEqual(none.map((p) => p.field).sort(), ['component', 'cue', 'evidence', 'lesson']);
  for (const p of none) assert.equal(typeof p.problem, 'string');
  assert.deepEqual(admit({ ...GOOD, cue: undefined }, has(['T-AB-1'])).map((p) => p.field), ['cue']);
  assert.deepEqual(admit({ ...GOOD, lesson: ' ' }, has(['T-AB-1'])).map((p) => p.field), ['lesson']);
  assert.deepEqual(admit({ ...GOOD, component: 'luck' }, has(['T-AB-1'])).map((p) => p.field), ['component']);
  assert.deepEqual(admit({ ...GOOD, evidence: [] }, has([])).map((p) => p.field), ['evidence']);
  const missing = admit({ ...GOOD, evidence: ['T-AB-1', 'T-AB-9'] }, has(['T-AB-1']));
  assert.deepEqual(missing.map((p) => p.field), ['evidence']);
  assert.match(missing[0].problem, /T-AB-9/);
  const confounded = admit({ ...GOOD, verdicts: [{ change: 'a', verdict: 'confounded' }, { change: 'b', verdict: 'confounded' }] }, has(['T-AB-1']));
  assert.deepEqual(confounded.map((p) => p.field), ['verdicts']);
  assert.deepEqual(admit({ ...GOOD, verdicts: [{ change: 'a', verdict: 'confounded' }, { change: 'b', verdict: 'helped' }] }, has(['T-AB-1'])), []);
  assert.deepEqual(admit({ ...GOOD, cue: 'x'.repeat(201), lesson: 'y'.repeat(301) }, has(['T-AB-1'])).map((p) => p.field), ['cue', 'lesson']);
  assert.equal(admit({ ...GOOD, evidence: Array.from({ length: 21 }, (_, i) => `T-AB-${i + 1}`) }, () => true).length, 1);
});

async function fixture(t) {
  const iso = isolatedEnv({ gitConfig: '[user]\n name = A B\n email = ab@example.com\n', prefix: 'lessons-' });
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
  await ok(['task', 'new', 'Source task', '--yes']);
  const dir = join(realpathSync(repo), names.stateDir);
  const add = (extra = []) => cli(['lessons', 'add', '--cue', 'a verify fails after a rebase', '--lesson', 'run the gate on the merged tree', '--component', 'gate', '--evidence', 'T-AB-1', ...extra, '--yes', '--json']);
  return { cli, ok, dir, add };
}

test('lessons add refuses with all problems, writes nothing, and a good lesson starts in shadow', async (t) => {
  const f = await fixture(t);
  const bad = await f.cli(['lessons', 'add', '--cue', 'c', '--evidence', 'T-AB-99', '--yes', '--json']);
  assert.equal(bad.code, 2);
  assert.deepEqual(bad.json.errors.map((e) => e.code), ['lesson-refused']);
  assert.match(bad.json.errors[0].message, /lesson/);
  assert.match(bad.json.errors[0].message, /evidence/);
  assert.match(bad.json.errors[0].message, /component/);
  assert.equal(existsSync(join(f.dir, 'lessons')), false);
  const conf = await f.add(['--verdict', 'change one=confounded', '--verdict', 'change two=confounded']);
  assert.equal(conf.code, 2);
  assert.match(conf.json.errors[0].message, /confounded/);
  const good = await f.add(['--verdict', 'change one=helped']);
  assert.equal(good.code, 0, good.stderr);
  const lesson = good.json.data.lesson;
  assert.deepEqual({ ...lesson, at: 'time' }, {
    schema: 1, id: 'L-AB-1', cue: 'a verify fails after a rebase', lesson: 'run the gate on the merged tree', component: 'gate',
    evidence: ['T-AB-1'], verdicts: [{ change: 'change one', verdict: 'helped' }], status: 'shadow', at: 'time', by: 'AB',
  });
});

test('lesson IDs are stable and never reused after a retire; list, show and retire shapes', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.ok(['lessons', 'list', '--json'])).json.data.lessons, []);
  assert.equal((await f.add()).json.data.lesson.id, 'L-AB-1');
  assert.equal((await f.add()).json.data.lesson.id, 'L-AB-2');
  const noWhy = await f.cli(['lessons', 'retire', 'L-AB-2', '--yes']);
  assert.equal(noWhy.code, 2);
  const retired = await f.ok(['lessons', 'retire', 'L-AB-2', '--why', 'it did not help', '--yes', '--json']);
  assert.equal(retired.json.data.lesson.status, 'retired');
  assert.equal(retired.json.data.lesson.retiredWhy, 'it did not help');
  assert.equal((await f.cli(['lessons', 'retire', 'L-AB-2', '--why', 'again', '--yes'])).code, 2);
  assert.equal((await f.add()).json.data.lesson.id, 'L-AB-3', 'a retired number is not reused');
  assert.deepEqual((await f.ok(['lessons', 'list', '--json'])).json.data.lessons.map((l) => l.id), ['L-AB-1', 'L-AB-3']);
  assert.deepEqual((await f.ok(['lessons', 'list', '--status', 'retired', '--json'])).json.data.lessons.map((l) => l.id), ['L-AB-2']);
  assert.equal((await f.cli(['lessons', 'list', '--status', 'bogus'])).code, 2);
  assert.equal((await f.ok(['lessons', 'show', 'L-AB-1', '--json'])).json.data.lesson.id, 'L-AB-1');
  assert.equal((await f.cli(['lessons', 'show', 'L-AB-9'])).code, 2);
  assert.match((await f.ok(['lessons', 'list'])).stdout, /L-AB-1  shadow  gate/);
});

test('verify attempts and receipts count as evidence; command-substitution text is stored as data', async (t) => {
  const f = await fixture(t);
  const refused = await f.add(['--evidence', 'T-AB-1#1']);
  assert.equal(refused.code, 2, 'no such verify attempt yet');
  const store = state.open(f.dir, { names });
  store.update('task', 'T-AB-1', (cur) => ({ ...cur, events: [...cur.events, { at: new Date().toISOString(), by: 'AB', event: 'verify', data: { attempt: 1 } }] }));
  assert.equal((await f.add(['--evidence', 'T-AB-1#1,T-AB-1'])).code, 0);
  assert.equal((await f.add(['--evidence', 'T-AB-1#2'])).code, 2);
  const text = 'run $(touch pwned) and `id`';
  const r = await f.cli(['lessons', 'add', '--cue', text, '--lesson', text, '--component', 'rule', '--evidence', 'T-AB-1', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.data.lesson.cue, text);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'lessons', `${r.json.data.lesson.id}.json`), 'utf8')).lesson, text);
  assert.equal(existsSync(join(f.dir, 'pwned')), false);
});
