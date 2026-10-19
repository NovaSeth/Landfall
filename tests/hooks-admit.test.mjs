// Admission hooks in shadow mode (spec §7.8 admission points, §14 `admission`): admit-agent allows always and appends
// one would-deny record to local/shadow.jsonl; bind-agent attaches the agent ID to the lease; release-agent frees it;
// malformed input allows and writes nothing (GC8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { MALFORMED, hook, lib, names, repo } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const sched = await lib('sched/index.mjs');
const type = `${names.plugin}:implementer`;
const admit = (f, n, subagent_type = type) => hook('admit-agent', { hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'sess-1', cwd: f.dir,
  tool_use_id: `toolu_${n}`, tool_input: { subagent_type, prompt: 'x' } }, { env: f.env });
const bind = (f, n, agentId) => hook('bind-agent', { hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 'sess-1', cwd: f.dir,
  tool_use_id: `toolu_${n}`, tool_input: { subagent_type: type }, tool_response: { agentId } }, { env: f.env });
const stop = (f, agentId) => hook('release-agent', { hook_event_name: 'SubagentStop', session_id: 'sess-1', cwd: f.dir, agent_id: agentId, agent_type: type }, { env: f.env });
const leases = (f) => sched.snapshot({ names, env: f.env }).leases.filter((l) => l.kind === 'agent');
const shadowLog = (f) => {
  const p = join(f.stateDir, 'local', 'shadow.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('shadow: a full slot table still allows and appends one would-deny record', (t) => {
  const f = repo(t);
  const max = sched.DEFAULTS.max.agent;
  for (let n = 1; n <= max; n++) assert.equal(admit(f, n).decision, 'allow');
  assert.equal(leases(f).length, max);
  const before = shadowLog(f).length;
  const v = admit(f, 99);
  assert.equal(v.decision, 'allow'); assert.equal(v.stdout, '');
  const log = shadowLog(f);
  assert.equal(log.length, before + 1);
  const rec = log.at(-1);
  assert.equal(rec.action, 'would-deny'); assert.equal(rec.key, 'toolu_99'); assert.equal(rec.reasons[0].code, 'capacity');
  assert.equal(leases(f).length, max, 'no lease was taken');
  assert.equal(admit(f, 100, 'Explore').decision, 'allow');
  assert.equal(shadowLog(f).length, before + 1, 'other agents are not recorded');
});

test('bind attaches the agent ID to the lease; release frees it', (t) => {
  const f = repo(t);
  admit(f, 1);
  assert.equal(leases(f)[0].owner.key, 'toolu_1');
  assert.equal(bind(f, 1, 'agent-abc').decision, 'allow');
  assert.equal(leases(f)[0].owner.agentId, 'agent-abc');
  assert.equal(stop(f, 'agent-other').decision, 'allow');
  assert.equal(leases(f).length, 1, 'another agent frees nothing');
  assert.equal(stop(f, 'agent-abc').decision, 'allow');
  assert.equal(leases(f).length, 0);
});

test('malformed input allows and writes nothing', (t) => {
  const f = repo(t);
  for (const name of ['admit-agent', 'bind-agent', 'release-agent']) {
    for (const text of MALFORMED) assert.equal(hook(name, text, { env: f.env }).stdout, '', `${name} ${text}`);
  }
  assert.equal(hook('bind-agent', { cwd: f.dir, tool_use_id: 'toolu_1', tool_response: { agentId: 7 } }, { env: f.env }).stdout, '');
  assert.equal(leases(f).length, 0); assert.deepEqual(shadowLog(f), []);
});
