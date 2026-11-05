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

// T-MG-196 (SEC-13, spec A3, A4): SubagentStart mints a review token for the two reviewer roles only.
const T = await lib('state/tokens.mjs');
const { spawn } = await import('node:child_process');
const { readFileSync, readdirSync, statSync } = await import('node:fs');
const { join } = await import('node:path');
const me = T.holderOf(process.pid);
const TOKEN = /lf1_[A-Za-z0-9_-]{43}/;
const subHost = (f, agent_type, extra = {}, host = me) => hook('subagent-start', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type, cwd: f.dir, ...extra }, { env: f.env, host });
const orchestrator = (f, host = me, session = 's') => T.mint({ dir: f.stateDir, names, role: 'orchestrator', session, host });
function noTokenOnDisk(f) {
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const p of walk(f.stateDir)) assert.doesNotMatch(readFileSync(p, 'utf8'), /lf1_/, p);
}

test('A3: the reviewer roles get a token line after the executor rules, within EXECUTOR_MAX; other agents get none', (t) => {
  const f = repo(t);
  assert.ok(orchestrator(f).token);
  for (const [agent, id] of [['reviewer', 'a1'], ['security-reviewer', 'a2']]) {
    const v = subHost(f, `${names.plugin}:${agent}`, { agent_id: id });
    assert.ok(v.context.length <= EXECUTOR_MAX, `${agent}: ${v.context.length}`);
    const m = TOKEN.exec(v.context);
    assert.ok(m, agent);
    const line = v.context.split('\n').find((l) => l.includes(m[0]));
    assert.ok(line.length <= 160, `token line ${line.length}`);
    assert.ok(v.context.indexOf(m[0]) > v.context.indexOf('Do not spawn subagents'), 'after the rules');
    assert.equal(T.authorize({ dir: f.stateDir, names, token: m[0], need: 'reviewer' }).role, agent);
  }
  for (const agent of ['implementer', 'designer', 'external']) assert.doesNotMatch(subHost(f, `${names.plugin}:${agent}`).context, /lf1_/, agent);
  assert.doesNotMatch(subHost(f, 'Explore').stdout, /lf1_/);
  noTokenOnDisk(f);
});

test('A3: no token without the live orchestrator entry of the same session and holder (a nested session gets none)', (t) => {
  const f = repo(t);
  const type = `${names.plugin}:reviewer`;
  assert.doesNotMatch(subHost(f, type).context, /lf1_/, 'no orchestrator entry');
  assert.match(subHost(f, type).context, /Review token: none/);
  assert.ok(orchestrator(f).token);
  assert.doesNotMatch(subHost(f, type, { session_id: 'other' }).context, /lf1_/, 'another session');
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => child.kill());
  assert.doesNotMatch(subHost(f, type, {}, T.holderOf(child.pid)).context, /lf1_/, 'another holder');
  assert.match(subHost(f, type, { agent_id: 'a9' }).context, TOKEN);
  const c = subHost(f, type, { agent_id: 'bad id!' }).context;
  assert.doesNotMatch(c, /lf1_/); assert.ok(c.length <= EXECUTOR_MAX);
});
