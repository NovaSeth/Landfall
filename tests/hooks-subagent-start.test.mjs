// Executor rules (spec §7.13, §8.3): SubagentStart → `subagent-start`. Only for the plugin's own agents
// (agent_type `<plugin>:<agent>`) in an active repository: at most 800 characters of executor rules (brief file
// first, rule IDs on demand, report to the file, no `git stash`, no subagents). Any other agent, an inactive
// repository or malformed input: no output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { MALFORMED, hook, launch, lib, names, repo } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const { EXECUTOR_MAX } = await lib('hooks/subagent-start.mjs');
const index = (await lib('method/index.mjs')).openMethod().index;
const sub = (f, agent_type) => hook('subagent-start', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type, cwd: f.dir }, { env: f.env });

test('executor rules: the plugin agents in an active repository get ≤ 800 characters with the five rules and valid rule IDs', (t) => {
  const f = repo(t);
  assert.equal(EXECUTOR_MAX, 800);
  for (const agent of ['implementer', 'reviewer', 'designer', 'security-reviewer']) {
    const v = sub(f, `${names.plugin}:${agent}`);
    assert.equal(v.event, 'SubagentStart', agent); assert.deepEqual(v.keys, ['hookSpecificOutput']);
    const c = v.context;
    assert.ok(c.length <= EXECUTOR_MAX, `${agent}: ${c.length}`);
    for (const part of [/brief/, new RegExp(`\`${names.bin} rule <ID…>\``), /report/, /`git stash`/, /subagents/]) assert.match(c, part, `${agent}: ${part}`);
    for (const id of c.match(/\b[A-Z]{3}-\d+\b/g)) assert.ok(Object.hasOwn(index.rules, id), `unknown rule ${id}`);
  }
});

test('executor rules: other agents, an inactive repository and malformed input get nothing (GC8)', (t) => {
  const f = repo(t);
  for (const type of ['general-purpose', 'Explore', 'implementer', `${names.plugin}`, `${names.plugin}x:implementer`, `x${names.plugin}:implementer`, '', 7, null, undefined]) {
    assert.equal(sub(f, type).stdout, '', String(type));
  }
  const inactive = repo(t, { active: false });
  assert.equal(sub(inactive, `${names.plugin}:implementer`).stdout, '');
  for (const text of MALFORMED) assert.equal(hook('subagent-start', text, { env: f.env }).stdout, '', text);
  const r = launch('subagent-start', { hook_event_name: 'SubagentStart', agent_type: `${names.plugin}:reviewer`, cwd: f.dir }, { env: f.env, cwd: f.dir });
  assert.equal(r.status, 0); assert.match(r.context, /`git stash`/);
});
