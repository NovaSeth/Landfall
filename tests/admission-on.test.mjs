// Admission in on mode (T-MG-34): admit-agent denies with the rule ID and the `slots` hint when the agent table is
// full, allows and leases when a slot is free; shadow stays as it was. guard-bash refreshes the heartbeat of the agent
// lease of input.agent_id after its decision, and a failure never changes the decision (GC8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { hook, lib, names, repo } from './helpers/hook-fixture.mjs';

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
  const run = (extra) => { const xs = []; for (let i = 0; i < 20; i++) { age(f); const s = process.hrtime.bigint(); bash(f, extra); xs.push(Number(process.hrtime.bigint() - s) / 1e6); } return xs.sort((a, b) => a - b)[18]; };
  run({}); // warm
  const base = run({});
  const withBeat = run({ agent_id: 'agent-abc' });
  t.diagnostic(`p95 base ${base.toFixed(1)} ms, with heartbeat ${withBeat.toFixed(1)} ms`);
  assert.ok(withBeat - base < 50, `heartbeat adds ${(withBeat - base).toFixed(1)} ms`);
});
