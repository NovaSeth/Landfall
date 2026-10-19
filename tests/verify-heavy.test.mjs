// Verify under the heavy lease and redacted gate output (T-MG-48): a gate with timeoutS >= 60 runs while verify holds
// the heavy lease (released after), a shorter one without; every secret in a gate's output is masked before it reaches
// verify.json, the log or the CLI output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isolatedEnv } from './helpers/isolated-env.mjs';
import { lib, names } from './helpers/hook-fixture.mjs';

const profile = await lib('profile/index.mjs');
const { main } = await lib('cli/main.mjs');

const IDENTITY = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "1 passing"}\n---\n\n# Report\n';
const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`; // built at run time: no literal key in the repository

function git(cwd, env, args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

async function setup(t, { timeoutS, cmd }) {
  const iso = isolatedEnv({ gitConfig: IDENTITY, prefix: 'verify-heavy-' });
  t.after(iso.cleanup);
  const data = join(iso.base, 'data');
  mkdirSync(data);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: data };
  const repo = join(iso.base, 'main');
  mkdirSync(repo);
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  put(join(repo, 'README.md'), '# x\n');
  put(join(repo, 'calc.test.mjs'), "import { test } from 'node:test';\ntest('adds', () => {});\n");
  git(repo, env, ['add', '-A']);
  git(repo, env, ['commit', '-q', '-m', 'base']);
  const base = git(repo, env, ['rev-parse', 'HEAD']).trim();
  const stateDir = join(iso.base, 'control', 'state');
  const run = async (args) => {
    const out = [];
    const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd: repo, stdin: null };
    const code = await main(args, { io });
    return { code, text: out.join('') };
  };
  assert.equal((await run(['init', '--yes', '--state-dir', stateDir])).code, 0);
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd, timeoutS, kind: 'test' }] });
  const id = JSON.parse((await run(['task', 'new', 'Heavy', '--yes', '--json'])).text).data.id;
  assert.equal((await run(['task', 'set', id, 'dispatched', '--executor', 'claude', '--base', base, '--yes'])).code, 0);
  assert.equal((await run(['route', id, '--paths', 'README.md', '--loc', '1', '--yes'])).code, 0);
  put(join(stateDir, 'tasks', id, 'report.md'), REPORT);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'work']);
  put(join(repo, 'README.md'), '# y\n');
  git(repo, env, ['commit', '-qam', 'change']);
  return { run, id, stateDir, data, probe: join(iso.base, 'probe') };
}
const heavyLeases = (data) => (existsSync(join(data, 'leases')) ? readdirSync(join(data, 'leases'), { recursive: true }).filter((f) => /heavy-\d/.test(f)) : []);
const probeCmd = (probe, extra = '') => `ls -R "$CLAUDE_PLUGIN_DATA" >> ${probe}; ${extra}node --test`;

test('a gate printing a key: verify.json, the log and the CLI output hold the masked value, never the key', async (t) => {
  const s = await setup(t, { timeoutS: 30, cmd: `printf "token %s%s\\n" ${KEY.slice(0, 8)} ${KEY.slice(8)}; printf "err %s%s\\n" ${KEY.slice(0, 8)} ${KEY.slice(8)} >&2; node --test` });
  const v = await s.run(['verify', s.id, '--yes', '--json']);
  assert.equal(v.code, 0, v.text.slice(0, 1500));
  assert.ok(!v.text.includes(KEY), `CLI output: ${v.text.slice(Math.max(0, v.text.indexOf(KEY) - 250), v.text.indexOf(KEY) + 80)}`);
  assert.match(v.text, /ghp_\*{8}/);
  const txt = await s.run(['verify', s.id, '--yes', '--no-cache']);
  assert.ok(!txt.text.includes(KEY), 'text output');
  const files = readdirSync(s.stateDir, { recursive: true }).map((f) => join(s.stateDir, f)).filter((f) => /verify/.test(f) && existsSync(f) && !readdirSync(dirname(f)).includes(f));
  let seen = 0;
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    assert.ok(!text.includes(KEY), `${f} holds the key`);
    if (text.includes('ghp_********')) seen += 1;
  }
  assert.ok(seen >= 1, 'the log holds the masked value');
});

test('a long gate runs while verify holds the heavy lease, and the lease is released after', async (t) => {
  const s = await setup(t, { timeoutS: 120, cmd: 'PLACEHOLDER' });
  profile.openStore(s.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: probeCmd(s.probe), timeoutS: 120, kind: 'test' }] });
  const v = await s.run(['verify', s.id, '--yes', '--json']);
  assert.equal(v.code, 0, v.text.slice(0, 1500));
  assert.match(readFileSync(s.probe, 'utf8'), /heavy-1/, 'the lease was held during the gate');
  assert.deepEqual(heavyLeases(s.data), [], 'released after');
});

test('a short gate takes no lease', async (t) => {
  const s = await setup(t, { timeoutS: 30, cmd: 'PLACEHOLDER' });
  profile.openStore(s.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: probeCmd(s.probe), timeoutS: 30, kind: 'test' }] });
  const v = await s.run(['verify', s.id, '--yes', '--json']);
  assert.equal(v.code, 0, v.text.slice(0, 1500));
  assert.doesNotMatch(readFileSync(s.probe, 'utf8'), /heavy-1/);
});
