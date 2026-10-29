// External runs end to end with the fake provider (spec §7.12, §8.5, §7.8, R80/R81): `exec` writes the run record and
// starts one detached supervisor per run; the supervisor takes the `external` lease (queued while none is free), runs
// the provider in its own process group under the wall cap, streams its output into the record (≤ 1/s) and the log,
// ends the whole group on the cap (SIGTERM, grace, SIGKILL) and releases the lease only after the group is gone. The
// tests observe the run record file directly (`wait` and `runs` come in the next slice). The fake provider is a generic
// adapter declared with `providers add` (tests/fixtures/providers/fake-provider.mjs); it sleeps between lines, nothing
// spins the CPU, and every wait here has a deadline. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    await p.ok(['task', 'set', id, 'started', '--branch', 'main', '--base', git(repo, env, ['rev-parse', 'HEAD'])]);
    await p.ok(['review', 'brief', id, '--write']);
  }
  for (const mode of ['ok', 'gate', 'stubborn']) {
    await p.ok(['providers', 'add', `fake${mode}`, '--argv', `${process.execPath} ${FAKE} ${mode} {out} {sandbox} {cwd}`, '--sandbox-map', 'reviewer=read-only,implementer=workspace-write']);
  }
  return p;
}
const startRun = (p, task, role, provider) => p.cli(['exec', '--task', task, '--role', role, '--provider', provider]);
const reviewBrief = (p, task, round = 1) => readFileSync(join(p.state, 'tasks', task, `review-r${round}-brief.md`), 'utf8');
const externalSection = (provider, task) => `## External run (overrides the Output section above)\nYou run as ${provider}:reviewer in a read-only sandbox: write no file. Your final message is the review JSON object alone, with "reviewer": {"kind": "external", "id": "${provider}:reviewer"}, per the schema the Output section names. The orchestrator records it from the run's out file with \`${names.bin} review record ${task} --kind external --run <run ID>\`.\n`;

test('a fake-provider run: starting → running → done with tokens and lastLine; the out file exists; the record per §8.5', async (t) => {
  const p = await project(t);
  const r = await startRun(p, 'T-TU-1', 'reviewer', 'fakeok');
  assert.equal(r.code, 0, show(r));
  const id = r.e.data.runId;
  assert.equal(id, 'fakeok-T-TU-1-reviewer-1');
  assert.equal(r.e.data.status, 'starting');
  const seen = new Set();
  await p.until('the run to end', () => { const s = p.record(id).status; seen.add(s); return TERMINAL.has(s); }, 30000);
  assert.ok(seen.has('running'), `statuses seen: ${[...seen].join(' → ')}`);
  const rec = p.record(id);
  assert.deepEqual(Object.keys(rec), ['schema', 'runId', 'task', 'role', 'provider', 'adapterVersion', 'model', 'sandbox', 'cwd', 'pid', 'pidStart', 'pidMethod', 'lease',
    'status', 'queuedAt', 'startedAt', 'endedAt', 'elapsedMs', 'capS', 'tokens', 'tokensReason', 'costMicroUsd', 'lastLine', 'unknownEvents', 'outFile', 'exit', 'error', 'bin', 'outDirId']);
  assert.equal(rec.bin, process.execPath, 'the program is the absolute path exec resolved (B-2)');
  assert.equal(rec.status, 'done');
  assert.equal(rec.exit, 0);
  assert.equal(rec.sandbox, 'read-only', 'a reviewer runs read-only');
  assert.equal(rec.cwd, p.repo, 'in the task worktree (the repository: no worktree holds its branch)');
  assert.equal(rec.lease, 'external-1');
  assert.equal(rec.lastLine, 'done: approved');
  assert.equal(rec.tokens, null);
  assert.equal(rec.tokensReason, 'not reported');
  assert.ok(rec.elapsedMs >= 300 && rec.capS === 900, `${rec.elapsedMs} ms, cap ${rec.capS} s`);
  assert.ok(Number.isInteger(rec.pid) && rec.pidStart !== null, 'the supervisor identity is recorded');
  assert.deepEqual(JSON.parse(readFileSync(rec.outFile, 'utf8')).verdict, 'approved');
  assert.equal(statSync(dirname(rec.outFile)).mode & 0o777, 0o700, 'the out dir is private');
  // The brief went to the provider on stdin, and the lease env with it.
  const prompt = readFileSync(`${rec.outFile}.prompt`, 'utf8');
  const review = reviewBrief(p, 'T-TU-1');
  assert.ok(prompt.startsWith(review), 'the saved review brief starts the prompt');
  assert.ok(prompt.endsWith(externalSection('fakeok', 'T-TU-1')), 'the external output instruction ends the prompt');
  const taskBrief = readFileSync(join(p.state, 'tasks', 'T-TU-1', 'brief.md'), 'utf8');
  const taskOnlyLine = taskBrief.split('\n').find((line) => line.trim() && !review.includes(line));
  assert.ok(taskOnlyLine, 'the task brief has a distinctive line absent from the review brief');
  assert.ok(!prompt.includes(taskOnlyLine), `task-only line must not be fed: ${taskOnlyLine}`);
  const pinned = join(dirname(rec.outFile), 'brief.md');
  assert.equal(readFileSync(pinned, 'utf8'), prompt);
  assert.equal(statSync(pinned).mode & 0o777, 0o600, 'the pinned brief is private');
  const args = JSON.parse(readFileSync(`${rec.outFile}.args`, 'utf8'));
  assert.equal(args.sandbox, 'read-only');
  assert.equal(args.env[`${names.envPrefix}SLOT`], 'external-1');
  const log = JSON.parse(readFileSync(join(p.runsDir, `${id}.log`), 'utf8'));
  assert.ok(log.lines.includes('checking the diff'), JSON.stringify(log.lines));
  await p.until('the lease to be released', () => p.externalLeases().length === 0, 5000);
});

test('with external max 1 a second run is queued until the first ends, then runs', async (t) => {
  const p = await project(t);
  sched.calibrate({ names, env: p.env, max: { external: 1 } });
  const first = (await startRun(p, 'T-TU-1', 'reviewer', 'fakegate')).e.data.runId;
  await p.until('the first run to run', () => p.record(first).status === 'running');
  const second = await startRun(p, 'T-TU-2', 'reviewer', 'fakeok');
  assert.equal(second.code, 0, show(second));
  const id2 = second.e.data.runId;
  await p.until('the second run to wait', () => p.record(id2).status === 'queued' && p.record(id2).pid !== null);
  for (let i = 0; i < 3; i++) {
    assert.equal(p.record(id2).status, 'queued', 'queued while the slot is held');
    assert.equal(p.record(first).status, 'running');
    await pause(400);
  }
  writeFileSync(`${p.record(first).outFile}.go`, '');
  assert.equal((await p.ended(first)).status, 'done');
  assert.equal((await p.ended(id2)).status, 'done');
  assert.ok(p.record(id2).startedAt >= p.record(first).endedAt, 'the second started after the first ended');
});

test('wall cap: status timeout, the whole group gone (a grandchild ignoring SIGTERM), the lease released', async (t) => {
  const p = await project(t, { envExtra: { [`${names.envPrefix}EXTERNAL_TIMEOUT`]: '2' } });
  const id = (await startRun(p, 'T-TU-1', 'reviewer', 'fakestubborn')).e.data.runId;
  await p.until('the provider to start its grandchild', () => existsSync(`${p.record(id).outFile}.pids`));
  const pids = readFileSync(`${p.record(id).outFile}.pids`, 'utf8').trim().split(' ').map(Number);
  assert.ok(pids.every(alive), 'provider and grandchild run');
  assert.equal(p.externalLeases().length, 1, 'the run holds its lease');
  const rec = await p.ended(id);
  assert.equal(rec.status, 'timeout');
  assert.equal(rec.capS, 2);
  assert.ok(rec.elapsedMs >= 2000, `${rec.elapsedMs}`);
  await p.until('the group to be gone', () => pids.every((pid) => !alive(pid)), 5000);
  await p.until('the lease to be released after the group', () => p.externalLeases().length === 0, 5000);
});

test('exec refuses an unknown task, a task without a brief and a live run of the same task and role', async (t) => {
  const p = await project(t);
  const codes = async (args, exit, code) => {
    const r = await p.cli(['exec', ...args]);
    assert.equal(r.code, exit, `${args.join(' ')}\n${show(r)}`);
    assert.equal(r.e.errors[0].code, code);
  };
  await codes(['--task', 'T-TU-9', '--role', 'reviewer', '--provider', 'fakeok'], 1, 'task-unknown');
  await codes(['--task', 'T-TU-1', '--role', 'boss', '--provider', 'fakeok'], 2, 'invalid-value');
  await codes(['--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'nosuch'], 2, 'provider-unknown');
  await p.ok(['task', 'new', 'No brief']);
  await codes(['--task', 'T-TU-3', '--role', 'reviewer', '--provider', 'fakeok'], 1, 'review-brief-missing');
  const live = (await startRun(p, 'T-TU-1', 'reviewer', 'fakegate')).e.data.runId;
  await p.until('the live run to run', () => p.record(live).status === 'running');
  await codes(['--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'fakeok'], 1, 'run-live');
  writeFileSync(`${p.record(live).outFile}.go`, '');
  await p.ended(live);
});

// run-supervise trusts the role and the repository, never the run record (T-MG-53): a rewritten record ends `failed`
// with run-tampered and no provider starts.
async function tampered(t, change) {
  const p = await project(t);
  const base = p.record((await (async () => { const id = (await startRun(p, 'T-TU-1', 'reviewer', 'fakeok')).e.data.runId; await p.ended(id); return { id }; })()).id);
  const outDir = mkdtempSync(join(tmpdir(), `${names.bin}-run-`));
  writeFileSync(join(outDir, 'brief.md'), readFileSync(`${base.outFile}.prompt`), { mode: 0o600 });
  const st = statSync(outDir, { bigint: true }); // bound as exec binds it (SF-AB-10), so only `change` is tampered
  const runId = 'fakeok-T-TU-2-reviewer-1';
  const rec = { ...base, runId, task: 'T-TU-2', status: 'starting', pid: null, endedAt: null, error: null, outFile: join(outDir, 'out.json'), outDirId: `${st.dev}:${st.ino}`, ...change(p, outDir) };
  writeFileSync(join(p.runsDir, `${runId}.json`), `${JSON.stringify(rec)}\n`);
  const r = await p.cli(['run-supervise', runId]);
  return { p, r, rec: p.record(runId), outFile: rec.outFile };
}

test('run-supervise: a record with a widened sandbox ends failed run-tampered and starts nothing', async (t) => {
  const { r, rec, outFile } = await tampered(t, () => ({ sandbox: 'workspace-write' }));
  assert.equal(rec.status, 'failed', show(r));
  assert.equal(rec.error, 'run-tampered');
  assert.equal(existsSync(`${outFile}.args`), false, 'no provider was started');
});

test('run-supervise: a record whose cwd is not the repository ends failed run-tampered and starts nothing', async (t) => {
  const { r, rec, outFile } = await tampered(t, (p) => ({ cwd: p.base }));
  assert.equal(rec.status, 'failed', show(r));
  assert.equal(rec.error, 'run-tampered');
  assert.equal(existsSync(`${outFile}.args`), false, 'no provider was started');
});

test('run-supervise: an out file outside the run temp directory ends failed run-tampered', async (t) => {
  const { r, rec } = await tampered(t, (p) => ({ outFile: join(p.repo, 'a.txt') }));
  assert.equal(rec.status, 'failed', show(r));
  assert.equal(rec.error, 'run-tampered');
  assert.equal(readFileSync(join(rec.cwd, 'a.txt'), 'utf8'), 'a\n');
});

test('reviewer prompt starts with the latest review brief and ends with the external JSON instruction', async (t) => {
  const p = await project(t);
  await p.ok(['review', 'brief', 'T-TU-1', '--round', '2', '--write']);
  const review = reviewBrief(p, 'T-TU-1', 2);
  const taskBrief = readFileSync(join(p.state, 'tasks', 'T-TU-1', 'brief.md'), 'utf8');
  const taskOnlyLine = taskBrief.split('\n').find((line) => line.trim() && !review.includes(line));
  assert.ok(taskOnlyLine);
  const r = await p.ok(['exec', '--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'fakeok']);
  const rec = await p.ended(r.e.data.runId);
  assert.equal(rec.status, 'done');
  const prompt = readFileSync(`${rec.outFile}.prompt`, 'utf8');
  assert.ok(prompt.startsWith(review), 'the latest review brief starts the prompt');
  assert.ok(prompt.endsWith(externalSection('fakeok', 'T-TU-1')));
  assert.ok(!prompt.includes(taskOnlyLine), `task-only line must not be fed: ${taskOnlyLine}`);
  assert.equal(readFileSync(join(dirname(rec.outFile), 'brief.md'), 'utf8'), prompt);
  assert.equal(statSync(join(dirname(rec.outFile), 'brief.md')).mode & 0o777, 0o600);
});

test('reviewer exec selects an explicit review round or the highest stored round and validates --round', async (t) => {
  const p = await project(t);
  await p.ok(['review', 'brief', 'T-TU-1', '--round', '2', '--write']);
  for (const [flags, round] of [[['--round', '1'], 1], [[], 2]]) {
    const r = await p.ok(['exec', '--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'fakeok', ...flags]);
    const rec = await p.ended(r.e.data.runId);
    assert.equal(rec.status, 'done');
    assert.equal(readFileSync(`${rec.outFile}.prompt`, 'utf8'), `${reviewBrief(p, 'T-TU-1', round)}\n${externalSection('fakeok', 'T-TU-1')}`);
  }
  for (const round of ['0', '-1', '1000', '1.5', 'abc']) {
    const r = await p.cli(['exec', '--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'fakeok', '--round', round]);
    assert.equal(r.code, 2, show(r));
    assert.equal(r.e.errors[0].code, 'invalid-value');
  }
  const missing = await p.cli(['exec', '--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'fakeok', '--round', '3']);
  assert.equal(missing.code, 1, show(missing));
  assert.equal(missing.e.errors[0].code, 'review-brief-missing');
});

test('a task brief alone does not satisfy reviewer exec', async (t) => {
  const p = await project(t);
  await p.ok(['task', 'new', 'Task brief only']);
  await p.ok(['route', 'T-TU-3', '--paths', 'src/a.js', '--loc', '10']);
  await p.ok(['brief', 'T-TU-3', '--write']);
  const r = await startRun(p, 'T-TU-3', 'reviewer', 'fakeok');
  assert.equal(r.code, 1, show(r));
  assert.equal(r.e.errors[0].code, 'review-brief-missing');
  assert.equal(r.e.errors[0].hint, `${names.bin} review brief T-TU-3 --write`);
});

test('a queued reviewer keeps the review brief pinned at exec after the stored brief is rewritten', async (t) => {
  const p = await project(t);
  sched.calibrate({ names, env: p.env, max: { external: 1 } });
  const first = (await p.ok(['exec', '--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'fakegate'])).e.data.runId;
  await p.until('the first run to run', () => p.record(first).status === 'running');
  const before = reviewBrief(p, 'T-TU-2');
  const second = (await p.ok(['exec', '--task', 'T-TU-2', '--role', 'reviewer', '--provider', 'fakeok'])).e.data.runId;
  await p.until('the second run to queue', () => p.record(second).status === 'queued');
  await p.ok(['review', 'brief', 'T-TU-2', '--write', '--force', '--security']);
  assert.notEqual(reviewBrief(p, 'T-TU-2'), before, 'the stored review brief really changed');
  writeFileSync(`${p.record(first).outFile}.go`, '');
  assert.equal((await p.ended(first)).status, 'done');
  const rec = await p.ended(second);
  assert.equal(rec.status, 'done');
  assert.equal(readFileSync(`${rec.outFile}.prompt`, 'utf8'), `${before}\n${externalSection('fakeok', 'T-TU-2')}`);
});

for (const kind of ['symlink', 'missing', 'directory']) {
  test(`run-supervise refuses a ${kind} pinned brief as run-tampered`, async (t) => {
    const { r, rec, outFile } = await tampered(t, (p, outDir) => {
      const file = join(outDir, 'brief.md');
      unlinkSync(file);
      if (kind === 'symlink') symlinkSync(join(p.repo, 'a.txt'), file);
      if (kind === 'directory') mkdirSync(file);
      return {};
    });
    assert.equal(r.code, 1, show(r));
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error, 'run-tampered');
    assert.equal(existsSync(`${outFile}.args`), false, 'no provider was started');
  });
}

test('reviewer exec passes the review schema to the Codex adapter argv', async (t) => {
  const p = await project(t);
  const binDir = join(p.base, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'codex'), `#!${process.execPath}\nprocess.argv.splice(2, 0, 'codex');\nimport(${JSON.stringify(pathToFileURL(FAKE).href)});\n`, { mode: 0o700 });
  p.env.PATH = `${binDir}:${p.env.PATH}`;
  const r = await p.ok(['exec', '--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'codex']);
  const rec = await p.ended(r.e.data.runId);
  assert.equal(rec.status, 'done');
  const args = JSON.parse(readFileSync(`${rec.outFile}.args`, 'utf8'));
  assert.equal(args.schemaFile, join(pluginDir, 'templates', 'review.schema.json'));
  assert.equal(args.sandbox, 'read-only');
  assert.ok(readFileSync(`${rec.outFile}.prompt`, 'utf8').endsWith(externalSection('codex', 'T-TU-1')));
});
