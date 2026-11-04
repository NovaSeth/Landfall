// Verify under the heavy lease and redacted gate output (T-MG-48): a gate with timeoutS >= 60 runs while verify holds
// the heavy lease (released after), a shorter one without; every secret in a gate's output is masked before it reaches
// verify.json, the log or the CLI output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnv, relaxAdmission } from './helpers/isolated-env.mjs';
import { lib, names, pluginDir } from './helpers/hook-fixture.mjs';
import { trustWith } from './helpers/trust.mjs';

const profile = await lib('profile/index.mjs');
const state = await lib('state/index.mjs'); // trustWith (T-MG-83)
const { main } = await lib('cli/main.mjs');
const { VERIFY_KINDS } = await lib('verify/kinds.mjs');
const { measure } = await lib('verify/measure.mjs');

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
  relaxAdmission(env); // verify takes the heavy lease in this data dir (T-MG-163)
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
  trustWith(state, stateDir, names, env);
  const id = JSON.parse((await run(['task', 'new', 'Heavy', '--yes', '--json'])).text).data.id;
  assert.equal((await run(['task', 'set', id, 'dispatched', '--executor', 'claude', '--base', base, '--yes'])).code, 0);
  assert.equal((await run(['route', id, '--paths', 'README.md', '--loc', '1', '--yes'])).code, 0);
  put(join(stateDir, 'tasks', id, 'report.md'), REPORT);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'work']);
  put(join(repo, 'README.md'), '# y\n');
  git(repo, env, ['commit', '-qam', 'change']);
  return { run, id, stateDir, env, data, base: iso.base, probe: join(iso.base, 'probe') };
}
const heavyLeases = (data) => (existsSync(join(data, 'leases')) ? readdirSync(join(data, 'leases'), { recursive: true }).filter((f) => /heavy-\d/.test(f)) : []);
// The lease entry as ls -R lists it: a line of its own. A path line such as /tmp/verify-heavy-1AB/data: never counts.
const LEASE_ENTRY = /^heavy-1\b/m;
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
  trustWith(state, s.stateDir, names, s.env);
  const v = await s.run(['verify', s.id, '--yes', '--json']);
  assert.equal(v.code, 0, v.text.slice(0, 1500));
  assert.match(readFileSync(s.probe, 'utf8'), LEASE_ENTRY, 'the lease was held during the gate');
  assert.deepEqual(heavyLeases(s.data), [], 'released after');
});

test('a short gate takes no lease', async (t) => {
  const s = await setup(t, { timeoutS: 30, cmd: 'PLACEHOLDER' });
  profile.openStore(s.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: probeCmd(s.probe), timeoutS: 30, kind: 'test' }] });
  trustWith(state, s.stateDir, names, s.env);
  const v = await s.run(['verify', s.id, '--yes', '--json']);
  assert.equal(v.code, 0, v.text.slice(0, 1500));
  assert.doesNotMatch(readFileSync(s.probe, 'utf8'), LEASE_ENTRY);
});

// T-MG-80: every full gate of verify runs under the heavy lease, the base measurement too (a base without a stored
// baseline runs the suite again in a temporary worktree: lib/verify/base.mjs).
test('the base measurement runs its long gate under the heavy lease as well', async (t) => {
  const s = await setup(t, { timeoutS: 120, cmd: 'PLACEHOLDER' });
  profile.openStore(s.stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: `echo RUN >> ${s.probe}; ${probeCmd(s.probe)}`, timeoutS: 120, kind: 'test' }] });
  trustWith(state, s.stateDir, names, s.env);
  const v = await s.run(['verify', s.id, '--yes', '--json']);
  assert.equal(v.code, 0, v.text.slice(0, 1500));
  const runs = readFileSync(s.probe, 'utf8').split('RUN\n').filter(Boolean);
  assert.ok(runs.length >= 2, `the gate ran at HEAD and at the base: ${runs.length} runs`);
  runs.forEach((r, k) => assert.match(r, LEASE_ENTRY, `run ${k + 1} held the lease`));
  assert.deepEqual(heavyLeases(s.data), [], 'released after');
});

// T-MG-121 (D-MG-38, plan M1.6): the wait for the heavy lease is measured apart from the gates. Another process holds
// the lease (runHeavy blocks this process's event loop with Atomics.wait, so the holder cannot live here), from another
// project directory, for `ms`, then releases it. Resolves once the lease is held, to a promise of the holder's exit.
// admitAll: the isolated machine data admit any load and free memory, so a loaded test machine delays neither the
// holder nor verify (only the lease itself makes verify wait).
const SCHED = pathToFileURL(join(pluginDir, 'lib', 'sched', 'index.mjs')).href;
const sched = await lib('sched/index.mjs');
const admitAll = (env) => sched.calibrate({ names, env, loadMax: '99999', freeMin: 1 });
async function holdHeavy(t, s, ms) {
  const code = `const sched = await import(${JSON.stringify(SCHED)});
const opts = { names: ${JSON.stringify(names)}, env: process.env, cwd: ${JSON.stringify(s.base)}, mode: 'on' };
const got = sched.acquire('heavy', opts);
if (!got.ok) { process.stdout.write('refused ' + JSON.stringify(got.reasons) + '\\n'); process.exit(1); }
process.stdout.write('held\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});
sched.release(got.lease, opts);`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', code], { env: s.env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  const exited = new Promise((res) => { holder.once('exit', res); });
  await new Promise((res, rej) => {
    let text = '';
    holder.stdout.on('data', (d) => { text += d; if (text.includes('held')) res(); else if (text.includes('refused')) rej(new Error(text)); });
    holder.once('exit', () => rej(new Error(`holder exited: ${text}`)));
  });
  return { released: exited };
}
const waitLines = (s) => {
  const file = join(s.stateDir, 'local', 'waits.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const docOf = (v) => JSON.parse(v.text).data;
// The verify doc inside the CLI's data (command.mjs adds its own fields next to the doc's) validates under v2.
const valid = (d) => {
  const { renamed: _r, written: _w, attempt: _a, closed: _c, candidates: _k, output: _o, reusedFrom: _f, ...doc } = d;
  assert.deepEqual(state.check(VERIFY_KINDS.verify, doc), [], 'the doc validates under verify v2');
};

test('a verify behind a held heavy lease records the wait apart from the gates and logs it once, not in ci mode', { timeout: 120000 }, async (t) => {
  const s = await setup(t, { timeoutS: 120, cmd: 'node --test' });
  admitAll(s.env);
  const first = await holdHeavy(t, s, 3000);
  const v = await s.run(['verify', s.id, '--yes', '--json']);
  assert.equal(v.code, 0, v.text.slice(0, 1500));
  const d = docOf(v);
  valid(d);
  assert.ok(d.heavyWaitMs >= 2000, `heavyWaitMs ${d.heavyWaitMs}`);
  assert.ok(d.gatesMs > 0 && d.gatesMs < d.durationMs, `gatesMs ${d.gatesMs}, durationMs ${d.durationMs}`);
  assert.ok(d.gatesMs + d.heavyWaitMs <= d.durationMs, `${d.gatesMs} + ${d.heavyWaitMs} <= ${d.durationMs}`);
  assert.ok(Number.isInteger(d.machine.cores) && d.machine.cores >= 1, JSON.stringify(d.machine));
  for (const k of ['load1Start', 'load1End']) assert.equal(typeof d.machine[k], process.platform === 'win32' ? 'object' : 'number', k);
  assert.equal(d.cache, 'miss');
  await first.released;
  const lines = waitLines(s);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  const [w] = lines;
  assert.deepEqual({ ...w, at: null, until: null }, { at: null, until: null, kind: 'heavy-queue', task: s.id, source: 'verify' });
  const span = Date.parse(w.until) - Date.parse(w.at);
  assert.ok(span >= 0 && Math.abs(span - d.heavyWaitMs) <= 100, `until - at ${span}, heavyWaitMs ${d.heavyWaitMs}`);
  // ci mode measures the wait and writes no line
  const second = await holdHeavy(t, s, 3000);
  const ci = await s.run(['verify', s.id, '--ci', '--no-cache', '--yes', '--json']);
  assert.equal(ci.code, 0, ci.text.slice(0, 1500));
  valid(docOf(ci));
  assert.ok(docOf(ci).heavyWaitMs >= 2000, `ci heavyWaitMs ${docOf(ci).heavyWaitMs}`);
  await second.released;
  assert.equal(waitLines(s).length, 1, 'ci mode adds no line');
  // a verify that waits for nothing adds none either
  const free = await s.run(['verify', s.id, '--yes', '--no-cache', '--json']);
  assert.equal(free.code, 0, free.text.slice(0, 1500));
  assert.equal(docOf(free).heavyWaitMs, 0);
  assert.equal(waitLines(s).length, 1, 'no wait, no line');
});

test('a wait of the base measurement counts in heavyWaitMs', { timeout: 120000 }, async (t) => {
  const s = await setup(t, { timeoutS: 120, cmd: 'node --test' });
  admitAll(s.env);
  // A first verify without the report fails on the report alone: its passing gate runs are stored in the gate cache and
  // no baseline grows, so the second verify reuses the runs at HEAD and measures the base again, behind the holder.
  const report = join(s.stateDir, 'tasks', s.id, 'report.md');
  writeFileSync(report, '# Report\n');
  const first = await s.run(['verify', s.id, '--yes', '--json']);
  assert.equal(docOf(first).result, 'missing-artifact', first.text.slice(0, 1500));
  writeFileSync(report, REPORT);
  const holder = await holdHeavy(t, s, 3000);
  const v = await s.run(['verify', s.id, '--yes', '--json']);
  assert.equal(v.code, 0, v.text.slice(0, 1500));
  const d = docOf(v);
  valid(d);
  assert.equal(d.cache, 'hit', 'the runs at HEAD came from the gate cache');
  assert.ok(d.heavyWaitMs >= 2000, `the base measurement waited: heavyWaitMs ${d.heavyWaitMs}`);
  assert.ok(d.gatesMs > 0, 'the base gates ran');
  assert.ok(d.gatesMs + d.heavyWaitMs <= d.durationMs, `${d.gatesMs} + ${d.heavyWaitMs} <= ${d.durationMs}`);
  await holder.released;
  assert.equal(waitLines(s).length, 1);
});

// Fix round 1 (review r1 F1): the waits log is optional telemetry. A directory at local/waits.jsonl (EISDIR) neither
// fails a call that passed nor replaces the error of a call that threw (heavy-busy reaches the caller as it was).
test('a waits log that cannot be written changes no result and hides no error of the call that waited', async (t) => {
  const s = await setup(t, { timeoutS: 30, cmd: 'node --test' });
  mkdirSync(join(s.stateDir, 'local', 'waits.jsonl'), { recursive: true });
  const store = profile.openStore(s.stateDir, names);
  const cost = measure({ store, id: s.id, mode: 'write' });
  const wait = () => cost.meter.waits.push({ at: '2026-11-04T10:00:00.000Z', until: '2026-11-04T10:00:03.000Z' });
  assert.equal(cost.heavy(() => { wait(); return 'runs'; }), 'runs', 'a call that passed keeps its result');
  const busy = new state.StateError('heavy-busy', 'ENV', 'no heavy slot within 590 s');
  assert.throws(() => cost.heavy(() => { wait(); throw busy; }), (e) => e === busy, 'the call\'s own error, not the log\'s');
  assert.equal(cost.fields('miss').cache, 'miss');
});

// Fix round 2 (review r2 F1): only the expected failures of the waits append are dropped; a programming error propagates.
test('an unexpected failure of the waits append is not swallowed', () => {
  const store = { append() { throw new TypeError('bug'); } };
  const cost = measure({ store, id: 'T-1', mode: 'write' });
  cost.meter.waits.push({ at: '2026-11-04T10:00:00.000Z', until: '2026-11-04T10:00:03.000Z' });
  assert.throws(() => cost.heavy(() => 'pass'), TypeError);
});
