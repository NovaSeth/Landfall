// `wait` and `runs list|show|stop` (spec §7.12, §8.5) over fake-provider runs: wait is exit 3 while running and a summary
// when terminal; stop signals the supervisor only when the recorded identity (pid + start) matches; list hides and prunes
// finished records older than 30 days. Every wait has a deadline; nothing spins the CPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const sched = await lib('sched/index.mjs');
const FAKE = join(root, 'tests', 'fixtures', 'providers', 'fake-provider.mjs');
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const TERMINAL = new Set(['done', 'failed', 'timeout', 'stopped']);

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

async function cli(args, { cwd, env }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main([...args, '--json', '--yes'], { io });
  const stdout = out.join('');
  return { code, e: stdout ? JSON.parse(stdout) : null, stderr: err.join('') };
}
const show = (r) => `exit ${r.code}\n${JSON.stringify(r.e)}\n${r.stderr}`;

// An active repository (handle TU) with routed tasks T-TU-1 and T-TU-2 and their briefs, the fake providers declared
// in its machine data, and every supervisor it started stopped afterwards.
async function project(t, { envExtra = {} } = {}) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'runs-' });
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data'), ...envExtra };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, env, ['add', 'a.txt']);
  git(repo, env, ['commit', '-q', '-m', 'start']);
  const p = { base: iso.base, repo: realpathSync(repo), cwd: repo, env };
  p.state = join(p.repo, names.stateDir);
  p.runsDir = join(p.state, 'local', 'runs');
  p.cli = (args) => cli(args, { cwd: p.cwd, env: p.env });
  p.ok = async (args) => { const r = await p.cli(args); assert.equal(r.code, 0, `${args.join(' ')}\n${show(r)}`); return r; };
  p.record = (id) => JSON.parse(readFileSync(join(p.runsDir, `${id}.json`), 'utf8'));
  p.records = () => (existsSync(p.runsDir) ? readdirSync(p.runsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(p.runsDir, f), 'utf8'))) : []);
  p.until = async (what, fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
      await pause(50);
    }
  };
  p.ended = (id, ms = 30000) => p.until(`${id} to end`, () => TERMINAL.has(p.record(id).status) && p.record(id), ms);
  p.externalLeases = () => (existsSync(join(p.env.CLAUDE_PLUGIN_DATA, 'leases')) ? readdirSync(join(p.env.CLAUDE_PLUGIN_DATA, 'leases')).filter((f) => f.startsWith('external-')) : []);
  t.after(async () => {
    for (const r of p.records()) if (Number.isInteger(r.pid) && alive(r.pid) && !TERMINAL.has(r.status)) { try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ } }
    for (const r of p.records()) if (Number.isInteger(r.pid)) await p.until(`supervisor ${r.pid} to end`, () => !alive(r.pid), 15000).catch(() => {});
    iso.cleanup();
  });
  await p.ok(['init']);
  for (const title of ['Parser', 'Lexer']) await p.ok(['task', 'new', title]);
  for (const id of ['T-TU-1', 'T-TU-2']) {
    await p.ok(['route', id, '--paths', 'src/a.js', '--loc', '10']);
    await p.ok(['brief', id, '--write']);
  }
  for (const mode of ['ok', 'gate', 'stubborn']) {
    await p.ok(['providers', 'add', `fake${mode}`, '--argv', `${process.execPath} ${FAKE} ${mode} {out} {sandbox} {cwd}`, '--sandbox-map', 'reviewer=read-only,implementer=workspace-write']);
  }
  return p;
}

const startRun = (p, task, role, provider) => p.cli(['exec', '--task', task, '--role', role, '--provider', provider]);
const DAY = 86400e3;
const age = (p, id, days) => {
  const f = join(p.runsDir, `${id}.json`);
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  const at = new Date(Date.now() - days * DAY).toISOString();
  writeFileSync(f, JSON.stringify({ ...rec, queuedAt: at, startedAt: at, endedAt: at }, null, 2));
};

test('wait: exit 3 while the run runs, exit 0 with a summary under 1 KB when it ended', async (t) => {
  const p = await project(t);
  const id = (await startRun(p, 'T-TU-1', 'reviewer', 'fakegate')).e.data.runId;
  await p.until('the run to run', () => p.record(id).status === 'running');
  const w = await p.cli(['wait', id, '--timeout', '1']);
  assert.equal(w.code, 3, show(w));
  writeFileSync(`${p.record(id).outFile}.go`, '');
  await p.ended(id);
  const d = await p.ok(['wait', id, '--timeout', '5']);
  assert.ok(JSON.stringify(d.e.data).length <= 1024, 'summary ≤ 1 KB');
  assert.equal(d.e.data.status, 'done');
  assert.equal(d.e.data.provider, 'fakegate');
  assert.equal(d.e.data.role, 'reviewer');
  assert.equal(d.e.data.task, 'T-TU-1');
  assert.equal(d.e.data.lastLine, 'done: approved');
  assert.equal(d.e.data.outFile, p.record(id).outFile);
  assert.ok('elapsedMs' in d.e.data && 'tokens' in d.e.data);
  assert.equal((await p.cli(['wait', 'fakeok-T-TU-1-reviewer-9'])).code, 1, 'an unknown run');
});

test('runs stop ends a fake run; a recorded identity that does not match is never signalled', async (t) => {
  const p = await project(t);
  const id = (await startRun(p, 'T-TU-1', 'reviewer', 'fakegate')).e.data.runId;
  await p.until('the run to run', () => p.record(id).status === 'running');
  const rec = p.record(id);
  // A record whose start time is not the supervisor's: the pid now names "another process".
  const f = join(p.runsDir, `${id}.json`);
  writeFileSync(f, JSON.stringify({ ...rec, pidStart: 'not-the-start' }, null, 2));
  const mismatch = await p.ok(['runs', 'stop', id]);
  assert.equal(mismatch.e.data.status, 'failed', 'a different process: the run is marked failed');
  assert.ok(alive(rec.pid), 'the process that now holds the pid was not signalled');
  assert.equal((await p.cli(['runs', 'stop', 'fakeok-T-TU-1-reviewer-9'])).code, 1, 'unknown run: refused');
  // The matching identity: the supervisor gets SIGTERM and the run is stopped.
  const id2 = (await startRun(p, 'T-TU-2', 'reviewer', 'fakegate')).e.data.runId;
  await p.until('the second run to run', () => p.record(id2).status === 'running');
  const r2 = p.record(id2);
  const stopped = await p.ok(['runs', 'stop', id2]);
  assert.equal(stopped.e.data.status, 'stopped');
  await p.until('the supervisor to end', () => !alive(r2.pid), 10000);
  assert.equal(p.record(id2).status, 'stopped');
  for (const x of [rec, r2]) writeFileSync(`${x.outFile}.go`, '');
  process.kill(rec.pid, 'SIGTERM');
});

test('runs list shows recent runs, hides and prunes finished records older than 30 days; show prints one run', async (t) => {
  const p = await project(t);
  const a = (await startRun(p, 'T-TU-1', 'reviewer', 'fakeok')).e.data.runId;
  await p.ended(a);
  const b = (await startRun(p, 'T-TU-2', 'reviewer', 'fakeok')).e.data.runId;
  await p.ended(b);
  age(p, a, 40);
  const l = await p.ok(['runs']);
  assert.deepEqual(l.e.data.runs.map((r) => r.runId), [b]);
  assert.ok(!existsSync(join(p.runsDir, `${a}.json`)) && !existsSync(join(p.runsDir, `${a}.log`)), 'pruned with its log');
  assert.deepEqual((await p.ok(['runs', 'list'])).e.data.runs.map((r) => r.runId), [b]);
  const s = await p.ok(['runs', 'show', b]);
  assert.equal(s.e.data.run.runId, b);
  assert.equal(s.e.data.run.status, 'done');
  const sum = await p.ok(['runs', 'show', b, '--summary']);
  assert.equal(sum.e.data.status, 'done');
  assert.equal((await p.cli(['runs', 'show', a])).code, 1);
});
