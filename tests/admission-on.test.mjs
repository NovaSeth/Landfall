// Admission in on mode (T-MG-34): admit-agent denies with the rule ID and the `slots` hint when the agent table is
// full, allows and leases when a slot is free; shadow stays as it was. guard-bash refreshes the heartbeat of the agent
// lease of input.agent_id after its decision, and a failure never changes the decision (GC8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolateProcessEnv, isolatedEnv } from './helpers/isolated-env.mjs';
import { CALL_WALL_GUARD_MS, cpuTimed } from './helpers/cpu-time.mjs';
import { hook, lib, names, pluginDir, repo } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const sched = await lib('sched/index.mjs');
const type = `${names.plugin}:implementer`;
const admit = (f, n) => hook('admit-agent', { hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'sess-1', cwd: f.dir,
  tool_use_id: `toolu_${n}`, tool_input: { subagent_type: type, prompt: 'x' } }, { env: f.env });
const bind = (f, n, agentId) => hook('bind-agent', { hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 'sess-1', cwd: f.dir,
  tool_use_id: `toolu_${n}`, tool_input: { subagent_type: type }, tool_response: { agentId } }, { env: f.env });
const leases = (f) => sched.snapshot({ names, env: f.env }).leases.filter((l) => l.kind === 'agent');
const flagOn = (f) => f.store.write('config', null, { schema: 1, flags: { admission: 'on' } });
const bash = (f, extra = {}) => hook('guard-bash', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'sess-1', cwd: f.dir,
  tool_input: { command: 'git status' }, ...extra }, { env: f.env });
const leaseFile = (f) => {
  const dir = join(f.env.CLAUDE_PLUGIN_DATA, 'leases');
  return join(dir, readdirSync(dir).find((n) => n.startsWith('agent-') && n.endsWith('.json')));
};
const OLD = '2020-01-01T00:00:00.000Z';
const age = (f) => { const p = leaseFile(f); const d = JSON.parse(readFileSync(p, 'utf8')); d.heartbeatAt = OLD; writeFileSync(p, JSON.stringify(d)); };
const beat = (f) => JSON.parse(readFileSync(leaseFile(f), 'utf8')).heartbeatAt;

test('on: a full agent table denies with the rule ID and the slots hint; a free slot allows and leases', (t) => {
  const f = repo(t);
  flagOn(f);
  const max = sched.DEFAULTS.max.agent;
  for (let n = 1; n <= max; n++) assert.equal(admit(f, n).decision, 'allow', `spawn ${n}`);
  assert.equal(leases(f).length, max);
  const v = admit(f, 99);
  assert.equal(v.decision, 'deny');
  const out = JSON.parse(v.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse'); assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /^ORC-11: /);
  assert.ok(out.permissionDecisionReason.includes(`${names.bin} slots`), out.permissionDecisionReason);
  assert.ok(!out.permissionDecisionReason.includes(' tick'), 'no tick hint');
  assert.equal(leases(f).length, max, 'no lease was taken');
});

test('shadow (the default): a full table still allows', (t) => {
  const f = repo(t);
  const max = sched.DEFAULTS.max.agent;
  for (let n = 1; n <= max + 1; n++) assert.equal(admit(f, n).decision, 'allow');
});

test('the deny hint names the bin, not tick', async (t) => {
  const f = repo(t);
  const busy = { ...sched.readings(), load1: 999 };
  const r = sched.admitAgent({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'sess-1', cwd: f.dir, tool_use_id: 'toolu_1',
    tool_input: { subagent_type: type } }, { names, env: f.env, mode: 'on', readings: busy });
  assert.equal(r.action, 'deny');
  assert.ok(r.message.includes(`\`${names.bin} slots\``), r.message);
  assert.ok(!r.message.includes('tick'));
});

test('guard-bash refreshes the heartbeat of the agent lease of agent_id, after its decision', (t) => {
  const f = repo(t);
  admit(f, 1); bind(f, 1, 'agent-abc');
  age(f);
  assert.equal(beat(f), OLD);
  const v = bash(f, { agent_id: 'agent-abc' });
  assert.equal(v.decision, 'allow');
  assert.notEqual(beat(f), OLD, 'heartbeat refreshed');
  age(f);
  bash(f, { agent_id: 'agent-other' });
  assert.equal(beat(f), OLD, 'another agent refreshes nothing');
  bash(f);
  assert.equal(beat(f), OLD, 'no agent_id: nothing');
  const blocked = bash(f, { agent_id: 'agent-abc', tool_input: { command: 'git stash' } });
  assert.equal(blocked.decision, 'deny', 'the decision is unchanged');
  assert.notEqual(beat(f), OLD, 'a block still refreshes');
});

test('a heartbeat failure never changes the decision', (t) => {
  const f = repo(t);
  admit(f, 1); bind(f, 1, 'agent-abc');
  const dir = join(f.env.CLAUDE_PLUGIN_DATA, 'leases');
  writeFileSync(leaseFile(f), '{not json');
  assert.equal(bash(f, { agent_id: 'agent-abc' }).decision, 'allow');
  assert.equal(bash(f, { agent_id: 'agent-abc', tool_input: { command: 'git stash' } }).decision, 'deny');
  assert.equal(bash(f, { agent_id: 7 }).decision, 'allow');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
  assert.equal(bash(f, { agent_id: 'agent-abc' }).decision, 'allow');
});

test('perf: the heartbeat adds under 50 ms p95 with a lease present', (t) => {
  const f = repo(t);
  admit(f, 1); bind(f, 1, 'agent-abc');
  const run = (extra) => {
    const xs = [];
    for (let i = 0; i < 20; i++) {
      age(f);
      const r = cpuTimed(() => bash(f, extra));
      assert.ok(r.wallMs < CALL_WALL_GUARD_MS, `a call hung: ${r.wallMs.toFixed(0)} ms wall`);
      xs.push(r.cpuMs);
    }
    return xs.sort((a, b) => a - b)[18];
  };
  run({}); // warm
  const base = run({});
  const withBeat = run({ agent_id: 'agent-abc' });
  t.diagnostic(`p95 base ${base.toFixed(1)} ms, with heartbeat ${withBeat.toFixed(1)} ms`);
  assert.ok(withBeat - base < 50, `heartbeat adds ${(withBeat - base).toFixed(1)} ms`);
});

// ---- T-MG-96 (review of 2.5.0, F4, F5) ----

test('F4: a Bash event without agent_id refreshes nothing; an unbound lease of another session stays unrefreshed', (t) => {
  const f = repo(t);
  admit(f, 1); // unbound: no PostToolUse bound an agent ID to it
  age(f);
  assert.equal(bash(f, { session_id: 'sess-2' }).decision, 'allow');
  assert.equal(beat(f), OLD, 'no agent_id: the unbound lease is not refreshed');
  for (const agentId of ['', 'undefined', 'null', 7, null]) {
    bash(f, { session_id: 'sess-2', agent_id: agentId });
    assert.equal(beat(f), OLD, `agent_id ${JSON.stringify(agentId)} refreshes no unbound lease`);
  }
});

const sleepMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }; // sleeps, no CPU load

test('F5: with a 450 ms evaluation and the normal 500 ms budget, a busy heartbeat never turns the allow into a block', async (t) => {
  const f = repo(t);
  admit(f, 1); bind(f, 1, 'agent-abc');
  age(f);
  // Another process holds the scheduler lock, so a heartbeat would wait its whole lock timeout.
  const lock = join(f.env.CLAUDE_PLUGIN_DATA, 'leases', 'lock');
  const fsx = pathToFileURL(join(pluginDir, 'lib', 'fsx', 'index.mjs')).href;
  // the lock holder needs only the lock path; its environment is an isolated home like every spawned process here
  const iso = isolatedEnv({ prefix: 'lock-holder-' });
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import { withLock } from ${JSON.stringify(fsx)}; withLock(${JSON.stringify(lock)}, () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000); });`],
  { stdio: 'ignore', env: iso.env });
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* gone */ } iso.cleanup(); });
  const owner = () => { try { return JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid; } catch { return null; } };
  for (const end = Date.now() + 10000; owner() !== holder.pid;) {
    assert.ok(Date.now() < end, 'the lock holder did not start');
    await new Promise((r) => { setTimeout(r, 20); });
  }
  const v = hook('guard-bash', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'sess-1', cwd: f.dir, agent_id: 'agent-abc',
    tool_input: { command: 'echo commit' } }, { env: f.env, deadline: undefined, readGuardExtra: () => { sleepMs(450); return null; } });
  assert.equal(v.code, 0, `${v.decision}: ${v.stderr}`);
  assert.equal(v.decision, 'allow');
});

test('T-MG-96: heartbeatAgent and releaseAgent match only a non-empty string agentId; null and undefined touch an unbound lease nowhere', (t) => {
  const f = repo(t);
  flagOn(f);
  assert.equal(admit(f, 1).decision, 'allow');
  age(f);
  const opts = { names, env: f.env, minIntervalMs: 0 };
  sched.heartbeatAgent(null, opts);
  sched.heartbeatAgent(undefined, opts);
  sched.heartbeatAgent('', opts);
  sched.releaseAgent(undefined, opts);
  sched.releaseAgent(null, opts);
  sched.releaseAgent('', opts);
  assert.equal(leases(f).length, 1, 'the unbound lease is still held');
  assert.equal(beat(f), OLD, 'and its heartbeat is untouched');
});
