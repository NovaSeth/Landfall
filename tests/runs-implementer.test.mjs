// `exec --role implementer [--brief <file>]` (T-MG-64): another provider runs in the task's worktree under its
// implementer sandbox, as a recorded run (role implementer in runs list, so the dashboard shows it). Refused before a
// run is recorded: no linked worktree of this repository (implementer-no-worktree), an adapter without an implementer
// mapping (role-unavailable), a --brief that is a link or not a regular file (brief-unsafe). The record pins the sha256
// of the brief the provider gets. Every wait has a deadline; nothing spins the CPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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
const { main } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'main.mjs')).href);
const FAKE = join(root, 'tests', 'fixtures', 'providers', 'fake-provider.mjs');
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const TERMINAL = new Set(['done', 'failed', 'timeout', 'stopped']);
const sha = (b) => createHash('sha256').update(b).digest('hex');

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

// An active repository (handle TU): T-TU-1 started with a linked worktree, T-TU-2 started without one, both with task
// briefs; fakeimpl declares an implementer mapping, fakerev only a reviewer one.
async function project(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'runs-impl-' });
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, env, ['add', 'a.txt']);
  git(repo, env, ['commit', '-q', '-m', 'start']);
  const p = { base: iso.base, repo: realpathSync(repo), cwd: repo, env };
  p.runsDir = join(p.repo, names.stateDir, 'local', 'runs');
  p.cli = (args) => cli(args, { cwd: p.cwd, env: p.env });
  p.ok = async (args) => { const r = await p.cli(args); assert.equal(r.code, 0, `${args.join(' ')}\n${show(r)}`); return r; };
  p.record = (id) => JSON.parse(readFileSync(join(p.runsDir, `${id}.json`), 'utf8'));
  p.records = () => (existsSync(p.runsDir) ? readdirSync(p.runsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(p.runsDir, f), 'utf8'))) : []);
  p.ended = async (id, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const rec = p.record(id);
      if (TERMINAL.has(rec.status)) return rec;
      if (Date.now() > end) assert.fail(`timed out waiting for ${id} to end`);
      await pause(50);
    }
  };
  t.after(async () => {
    for (const r of p.records()) if (Number.isInteger(r.pid) && alive(r.pid) && !TERMINAL.has(r.status)) { try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ } }
    const end = Date.now() + 15000;
    for (const r of p.records()) while (Number.isInteger(r.pid) && alive(r.pid) && Date.now() < end) await pause(50);
    iso.cleanup();
  });
  await p.ok(['init']);
  for (const title of ['Parser', 'Lexer']) await p.ok(['task', 'new', title]);
  const head = git(repo, env, ['rev-parse', 'HEAD']);
  p.worktree = join(iso.base, 'wt-1');
  git(repo, env, ['worktree', 'add', '-q', '-b', 'task/T-TU-1', p.worktree, head]);
  p.worktree = realpathSync(p.worktree);
  for (const id of ['T-TU-1', 'T-TU-2']) {
    await p.ok(['route', id, '--paths', 'src/a.js', '--loc', '10']);
    await p.ok(['brief', id, '--write']);
  }
  await p.ok(['task', 'set', 'T-TU-1', 'started', '--branch', 'task/T-TU-1', '--base', head, '--worktree', p.worktree]);
  await p.ok(['task', 'set', 'T-TU-2', 'started', '--branch', 'main', '--base', head]);
  await p.ok(['providers', 'add', 'fakeimpl', '--argv', `${process.execPath} ${FAKE} implement {out} {sandbox} {cwd}`, '--sandbox-map', 'reviewer=read-only,implementer=workspace-write']);
  await p.ok(['providers', 'add', 'fakerev', '--argv', `${process.execPath} ${FAKE} ok {out} {sandbox} {cwd}`, '--sandbox-map', 'reviewer=read-only']);
  return p;
}

const implement = (p, task, provider, extra = []) => p.cli(['exec', '--task', task, '--role', 'implementer', '--provider', provider, ...extra]);

test('an implementer run edits the task worktree (its cwd), ends done, is listed with role implementer and pins the brief sha', async (t) => {
  const p = await project(t);
  const s = await implement(p, 'T-TU-1', 'fakeimpl');
  assert.equal(s.code, 0, show(s));
  const id = s.e.data.runId;
  const rec = await p.ended(id);
  assert.equal(rec.status, 'done', JSON.stringify(rec));
  assert.equal(rec.role, 'implementer');
  assert.equal(rec.cwd, p.worktree, 'the record names the worktree');
  assert.equal(rec.sandbox, 'workspace-write', 'the implementer sandbox of the mapping');
  assert.ok(existsSync(join(p.worktree, 'implemented.txt')), 'the provider wrote inside the worktree');
  assert.ok(!existsSync(join(p.repo, 'implemented.txt')), 'nothing written in the main checkout');
  const args = JSON.parse(readFileSync(`${rec.outFile}.args`, 'utf8'));
  assert.equal(realpathSync(args.processCwd), p.worktree, 'the provider process runs in the worktree');
  assert.equal(args.cwd, p.worktree, '{cwd} is the worktree');
  assert.equal(args.sandbox, 'workspace-write');
  const prompt = readFileSync(`${rec.outFile}.prompt`);
  assert.match(prompt.toString('utf8'), /Parser/, 'the task brief is fed');
  assert.match(rec.briefSha256 ?? '', /^[0-9a-f]{64}$/, 'the brief sha is stored');
  assert.equal(rec.briefSha256, sha(prompt), 'the stored sha is the one of the brief the provider got');
  const listed = (await p.ok(['runs', 'list'])).e.data.runs.find((r) => r.runId === id);
  assert.equal(listed?.role, 'implementer', 'runs list --json shows the implementer run');
});

test('--brief <file> is fed instead of the task brief and its sha pinned', async (t) => {
  const p = await project(t);
  const file = join(p.base, 'my-brief.md');
  writeFileSync(file, '# My own brief\nImplement the marker MARKER-64.\n');
  const s = await implement(p, 'T-TU-1', 'fakeimpl', ['--brief', file]);
  assert.equal(s.code, 0, show(s));
  const rec = await p.ended(s.e.data.runId);
  assert.equal(rec.status, 'done', JSON.stringify(rec));
  const prompt = readFileSync(`${rec.outFile}.prompt`);
  assert.match(prompt.toString('utf8'), /MARKER-64/);
  assert.doesNotMatch(prompt.toString('utf8'), /Parser/, 'not the task brief');
  assert.equal(rec.briefSha256, sha(prompt));
});

test('refused before a run is recorded: no worktree, a worktree that is not a linked one, a symlinked --brief, an adapter without an implementer mapping', async (t) => {
  const p = await project(t);
  const noWt = await implement(p, 'T-TU-2', 'fakeimpl');
  assert.notEqual(noWt.code, 0, show(noWt));
  assert.equal(noWt.e.errors[0].code, 'implementer-no-worktree', show(noWt));

  const head = git(p.repo, p.env, ['rev-parse', 'HEAD']);
  const plain = join(p.base, 'plain');
  mkdirSync(plain);
  await p.ok(['task', 'set', 'T-TU-2', 'started', '--branch', 'main', '--base', head, '--worktree', realpathSync(plain)]);
  const notLinked = await implement(p, 'T-TU-2', 'fakeimpl');
  assert.equal(notLinked.e?.errors?.[0]?.code, 'implementer-no-worktree', show(notLinked));
  await p.ok(['task', 'set', 'T-TU-2', 'started', '--branch', 'main', '--base', head, '--worktree', p.repo]);
  const mainCheckout = await implement(p, 'T-TU-2', 'fakeimpl');
  assert.equal(mainCheckout.e?.errors?.[0]?.code, 'implementer-no-worktree', `the main checkout is no task worktree\n${show(mainCheckout)}`);

  const real = join(p.base, 'real-brief.md');
  writeFileSync(real, '# brief\n');
  const link = join(p.base, 'link-brief.md');
  symlinkSync(real, link);
  const linked = await implement(p, 'T-TU-1', 'fakeimpl', ['--brief', link]);
  assert.equal(linked.e?.errors?.[0]?.code, 'brief-unsafe', show(linked));
  const dir = await implement(p, 'T-TU-1', 'fakeimpl', ['--brief', p.base]);
  assert.equal(dir.e?.errors?.[0]?.code, 'brief-unsafe', show(dir));
  const big = join(p.base, 'big-brief.md');
  writeFileSync(big, 'x'.repeat(65537));
  const tooBig = await implement(p, 'T-TU-1', 'fakeimpl', ['--brief', big]);
  assert.equal(tooBig.e?.errors?.[0]?.code, 'brief-unsafe', show(tooBig));

  const noMap = await implement(p, 'T-TU-1', 'fakerev');
  assert.equal(noMap.e?.errors?.[0]?.code, 'role-unavailable', show(noMap));
  assert.deepEqual(p.records(), [], 'no run was recorded');
});

test('run-supervise refuses an implementer record whose cwd is not the task worktree or whose pinned brief changed', async (t) => {
  const p = await project(t);
  // The supervisor is run by hand on a rewritten record of an ended run (its temp directory and pinned brief remain).
  const s = await implement(p, 'T-TU-1', 'fakeimpl');
  assert.equal(s.code, 0, show(s));
  const id = s.e.data.runId;
  const rec = await p.ended(id);
  assert.equal(rec.status, 'done', JSON.stringify(rec));
  const file = join(p.runsDir, `${id}.json`);
  for (const bad of [{ cwd: p.repo }, { briefSha256: '0'.repeat(64) }]) {
    writeFileSync(file, JSON.stringify({ ...rec, ...bad, status: 'starting', pid: null, pidStart: null, pidMethod: null, endedAt: null, exit: null, error: null }, null, 2));
    const r = await p.cli(['run-supervise', id]);
    assert.equal(r.e?.errors?.[0]?.code, 'run-tampered', `${JSON.stringify(bad)}\n${show(r)}`);
  }
});
