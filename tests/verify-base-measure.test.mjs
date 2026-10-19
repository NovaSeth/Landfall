// verify measures the reference at the task base when no stored baseline describes it (T-MG-37): the gates run in a
// temporary detached worktree at the base, and the inventory they report is the reference, united with the task's own
// last passing verify. A gate that cannot run at the base is an error, never a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isolatedEnv } from './helpers/isolated-env.mjs';
import { lib, names } from './helpers/hook-fixture.mjs';

const profile = await lib('profile/index.mjs');
const { main } = await lib('cli/main.mjs');

const IDENTITY = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "1 passing"}\n---\n\n# Report\n';
const GATES = [{ name: 'test', cmd: 'node --test', timeoutS: 120, kind: 'test' }];
const TEST = (name) => `test('${name}', () => {});\n`;
const HEADER = "import { test } from 'node:test';\n";

function git(cwd, env, args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const head = (cwd, env) => git(cwd, env, ['rev-parse', 'HEAD']).trim();
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const show = (r) => JSON.stringify(r.out ?? r).slice(0, 1500);
const codes = (r) => r.out.errors.map((e) => e.code);

async function cli(args, { cwd, env }) {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, out: JSON.parse(out.join('')) };
}

// A fresh repository (`files` in its first commit) activated with in-repo or linked state, no baseline, the test
// gate in the profile, and a linked worktree `wt` on branch feature.
async function fresh(t, { linked, files = {}, gates = GATES }) {
  const iso = isolatedEnv({ gitConfig: IDENTITY, prefix: 'verify-base-' });
  t.after(iso.cleanup);
  const env = iso.env;
  const repo = join(iso.base, 'main');
  const wt = join(iso.base, 'wt');
  const external = join(iso.base, 'control', 'state');
  mkdirSync(repo);
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  for (const [rel, text] of Object.entries({ 'README.md': '# x\n', ...files })) put(join(repo, rel), text);
  git(repo, env, ['add', '-A']);
  git(repo, env, ['commit', '-q', '-m', 'base']);
  const p = { env, repo, wt, stateDir: linked ? external : join(repo, names.stateDir) };
  p.run = (args, where = 'main') => cli(args, { cwd: where === 'wt' ? wt : repo, env });
  assert.equal((await p.run(['init', '--yes', ...(linked ? ['--state-dir', external] : [])])).code, 0);
  profile.openStore(p.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates });
  p.base = head(repo, env);
  git(repo, env, ['worktree', 'add', '-q', wt, '-b', 'feature']);
  p.task = async (title, where = 'main') => {
    const id = (await p.run(['task', 'new', title, '--yes'], where)).out.data.id;
    assert.equal((await p.run(['task', 'set', id, 'dispatched', '--executor', 'claude', '--base', p.base, '--yes'], where)).code, 0);
    assert.equal((await p.run(['route', id, '--paths', 'calc.test.mjs', '--loc', '1', '--yes'], where)).code, 0);
    put(join(p.stateDir, 'tasks', id, 'report.md'), REPORT);
    return id;
  };
  p.commit = (where, rel, text) => {
    const dir = where === 'wt' ? wt : repo;
    if (text === null) git(dir, env, ['rm', '-q', rel]);
    else { put(join(dir, rel), text); git(dir, env, ['add', rel]); }
    git(dir, env, ['commit', '-q', '-m', `change ${rel}`]);
  };
  p.baseline = () => JSON.parse(readFileSync(join(p.stateDir, 'baseline', 'tests.json'), 'utf8'));
  p.noTempWorktree = () => {
    const local = join(p.stateDir, 'local');
    const left = existsSync(local) ? readdirSync(local).filter((n) => n.startsWith('base-')) : [];
    assert.deepEqual(left, [], 'the worktree at the base is removed');
    assert.equal(git(repo, env, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length, 2);
  };
  return p;
}

for (const linked of [true, false]) {
  const mode = linked ? 'linked' : 'in-repo';

  test(`${mode}: the first test-first task in a fresh repository passes verify and grows the baseline`, async (t) => {
    const p = await fresh(t, { linked });
    const id = await p.task('First test');
    p.commit('main', 'calc.test.mjs', `${HEADER}${TEST('adds')}`);
    const v = await p.run(['verify', id, '--yes']);
    assert.equal(v.code, 0, show(v));
    assert.equal(p.baseline().tests.length, 1);
    p.noTempWorktree();
  });

  test(`${mode}: a task that deletes a test of the base is baseline-shrunk`, async (t) => {
    const p = await fresh(t, { linked, files: { 'calc.test.mjs': `${HEADER}${TEST('adds')}${TEST('subtracts')}` } });
    const id = await p.task('Drop a test');
    p.commit('main', 'calc.test.mjs', `${HEADER}${TEST('adds')}`);
    const v = await p.run(['verify', id, '--yes']);
    assert.equal(v.code, 1, show(v));
    assert.deepEqual(codes(v), ['baseline-shrunk'], show(v));
    p.noTempWorktree();
  });

  // The gate exits 127 itself when its script is absent (a missing script gives 127 under bash and 2 under dash).
  test(`${mode}: a gate that cannot run at the base is a verify error, never a pass`, async (t) => {
    const p = await fresh(t, { linked, gates: [{ name: 'test', cmd: 'test -f gate.sh || exit 127; sh ./gate.sh', timeoutS: 60, kind: 'test' }] });
    const id = await p.task('Gate script');
    p.commit('main', 'gate.sh', 'node --test\n');
    p.commit('main', 'calc.test.mjs', `${HEADER}${TEST('adds')}`);
    const v = await p.run(['verify', id, '--yes']);
    assert.equal(v.code, 8, show(v));
    assert.ok(codes(v).includes('base-gate-error'), show(v));
    p.noTempWorktree();
  });

  test(`${mode}: two parallel branches each pass in either order; a test the task verified and then deletes is baseline-shrunk`, async (t) => {
    const p = await fresh(t, { linked, files: { 'calc.test.mjs': `${HEADER}${TEST('adds')}` } });
    const a = await p.task('Branch A', 'wt');
    const b = await p.task('Branch B');
    p.commit('wt', 'a.test.mjs', `${HEADER}${TEST('x')}`);
    p.commit('main', 'b.test.mjs', `${HEADER}${TEST('y')}`);
    const va = await p.run(['verify', a, '--yes'], 'wt');
    assert.equal(va.code, 0, show(va));
    const vb = await p.run(['verify', b, '--yes']);
    assert.equal(vb.code, 0, `B after A: ${show(vb)}`);
    p.commit('wt', 'a.test.mjs', null);
    const shrunk = await p.run(['verify', a, '--yes'], 'wt');
    assert.equal(shrunk.code, 1, show(shrunk));
    assert.deepEqual(codes(shrunk), ['baseline-shrunk'], show(shrunk));
    assert.match(shrunk.out.errors[0].message, /"x"/, show(shrunk));
    p.commit('wt', 'a.test.mjs', `${HEADER}${TEST('x')}`);
    const again = await p.run(['verify', a, '--yes'], 'wt');
    assert.equal(again.code, 0, `A after B: ${show(again)}`);
    p.noTempWorktree();
  });
}
