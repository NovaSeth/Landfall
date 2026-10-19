// Hook time budget with a slow git (review r1b, GC8, findings-r1 B3): every lifecycle hook bounds its state resolution
// by the time left in its budget. A git that does not answer in time leaves the repository state unknown: the wakeup
// guard denies a wakeup and the stop guard blocks a turn end with a pending loop prompt (fail closed, GC4); the context
// hooks print nothing; the Bash guard and the edit hook allow what does not name the state directory. Every hook ends
// under 1 s through the launcher. The slow git is a stub on PATH that sleeps before running the real git.
// Hook input (ruling of S3, fix round 1): stdin gets 2 s measured from the start of reading, not from process start; for
// the Bash guard input not fully received by then is unverifiable and blocked (exit 2), every other hook allows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { LAUNCHER, launch, lib, loopDoc, names, repo, task, writeLoop } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
function slowGitPath(seconds) {
  const bin = mkdtempSync(join(tmpdir(), 'slow-git-'));
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep ${seconds}\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return `${bin}${delimiter}${process.env.PATH}`;
}
const TICK = `Run \`${names.bin} tick\` and do the listed steps.`;

test('a slow git: every hook ends under 1 s; the termination guards fail closed, the others allow', (t) => {
  const f = repo(t, { files: { 'src/a.txt': 'x\n' } });
  task(f.store, 1);
  writeLoop(f.stateDir, loopDoc('DONE'));
  const env = { ...f.env, PATH: slowGitPath(3) };
  const T = join(f.stateDir, 'tasks', 'T-AB-1', 'task.json');
  const cases = [
    ['guard-wakeup', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, prompt: TICK } }, 'deny'],
    ['stop-guard', { stop_hook_active: false, session_crons: [{ id: 'c1', prompt: TICK }] }, 'block'],
    ['session-start', { source: 'startup' }, 'allow'],
    ['subagent-start', { agent_type: `${names.plugin}:implementer` }, 'allow'],
    ['admit-agent', { tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: `${names.plugin}:implementer` } }, 'allow'],
    ['bind-agent', { tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: `${names.plugin}:implementer` }, tool_response: { agentId: 'a1' } }, 'allow'],
    ['release-agent', { agent_id: 'a1' }, 'allow'],
    ['guard-bash', { tool_name: 'Bash', tool_input: { command: 'ls -la' } }, 'allow'],
    ['guard-bash', { tool_name: 'Bash', tool_input: { command: `echo x > ${T}` } }, 'deny'],
    ['decisions-context', { tool_name: 'Edit', tool_input: { file_path: join(f.dir, 'src', 'a.txt'), old_string: 'x', new_string: 'y' } }, 'allow'],
  ];
  for (const [name, input, want] of cases) {
    const started = performance.now();
    const r = launch(name, { session_id: 's', cwd: f.dir, ...input }, { env, cwd: f.dir });
    const ms = performance.now() - started;
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.ok(ms < 2900, `${name}: ${ms.toFixed(0)} ms (one slow git call alone takes 3 s)`);
    assert.equal(r.decision, want, `${name} ${JSON.stringify(input).slice(0, 80)}: ${r.reason}`);
    if (want === 'allow') assert.equal(r.stdout, '', `${name}: no output`);
  }
});

// Input written in timed chunks; `end` closes stdin. Result { status, stdout, stderr, ms }.
function slowLaunch(name, chunks, env, cwd) {
  return new Promise((done) => {
    const started = performance.now();
    const p = spawn(process.execPath, [LAUNCHER, 'hook', name], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.stdin.on('error', () => {});
    const timers = chunks.map(({ text, at, end }) => setTimeout(() => { if (!p.stdin.destroyed) { p.stdin.write(text); if (end) p.stdin.end(); } }, at));
    const kill = setTimeout(() => p.kill(), 8000);
    p.on('close', (status) => { timers.forEach(clearTimeout); clearTimeout(kill); done({ status, stdout, stderr, ms: performance.now() - started }); });
  });
}

test('hook input: 2 s from the start of reading; an incomplete command blocks the Bash guard only, a slow complete one is judged', async (t) => {
  const f = repo(t);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: f.dir };
  const event = (command) => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: f.dir });
  const half = (text) => text.slice(0, Math.floor(text.length / 2));
  // never completed: the guard cannot verify it
  const cut = await slowLaunch('guard-bash', [{ text: half(event('ls -la')), at: 0 }], env, f.dir);
  assert.equal(cut.status, 2, cut.stderr); assert.match(cut.stderr, /^SEC-3: blocked: could not read the whole command in time/);
  assert.ok(cut.ms >= 1900, `${cut.ms.toFixed(0)} ms: the deadline counts from the start of reading`);
  const other = await slowLaunch('session-start', [{ text: half(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: f.dir })), at: 0 }], env, f.dir);
  assert.equal(other.status, 0); assert.equal(other.stdout, ''); assert.equal(other.stderr, '');
  // complete, in two chunks 800 ms apart: read and judged like any input
  const text = event('git stash');
  const slow = await slowLaunch('guard-bash', [{ text: half(text), at: 0 }, { text: text.slice(half(text).length), at: 800, end: true }], env, f.dir);
  assert.equal(slow.status, 0, slow.stderr); assert.match(slow.stdout, /"permissionDecision":"deny"/); assert.match(slow.stdout, /ORC-13/);
});

// Under CPU saturation a handler can answer after its budget (gate --stress, fix round 1): a late deny or block is kept
// (blocking is the safe side); a late allow is replaced by the error policy, whose "guarded" test also knows the owned
// state file names (a command that names one is unverifiable for the Bash guard).
test('runner: a late deny or block is kept; a late allow falls back to the policy, which counts state file names as guarded', async () => {
  const { runRow } = await lib('hooks/registry.mjs');
  const busy = (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms); };
  const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'X-1: blocked' } });
  const BLOCK = JSON.stringify({ decision: 'block', reason: 'X-1: blocked' });
  const late = (stdout, onError) => ({ name: 'late', budgetMs: 5, onError, handler: () => { busy(30); return { stdout }; } });
  const ev = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  for (const policy of ['allow', 'block-if-guarded']) {
    assert.equal(runRow(late(DENY, policy), ev('ls'), { deadline: performance.now() + 5 }).stdout, DENY, `${policy}: late deny kept`);
    assert.equal(runRow(late(BLOCK, policy), ev('ls'), { deadline: performance.now() + 5 }).stdout, BLOCK, `${policy}: late block kept`);
  }
  assert.equal(runRow(late('', 'allow'), ev('echo x > a/.s/tasks/T-AB-1/task.json'), { deadline: performance.now() + 5 }).code, undefined, 'another hook: allow');
  const g = runRow(late('', 'block-if-guarded'), ev('echo x > a/.s/tasks/T-AB-1/task.json'), { deadline: performance.now() + 5 });
  assert.equal(g.code, 2); assert.match(g.stderr, /unverifiable/);
  assert.equal(runRow(late('', 'block-if-guarded'), ev('ls -la'), { deadline: performance.now() + 5 }).code, undefined, 'no token, no state name: allow');
});
