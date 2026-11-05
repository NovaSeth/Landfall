// Admission hooks in shadow mode (spec §7.8 admission points, §14 `admission`): admit-agent allows always and appends
// one would-deny record to local/shadow.jsonl; bind-agent attaches the agent ID to the lease; release-agent frees it;
// malformed input allows and writes nothing (GC8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFast, measured } from './helpers/cpu-time.mjs';
import { isolateProcessEnv, relaxAdmission } from './helpers/isolated-env.mjs';
import { LAUNCHER, MALFORMED, hook, lib, names, pluginDir, repo, task } from './helpers/hook-fixture.mjs';

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

// ---- wait events (plan M1.7, D1, D2): a load wait in on mode only; a held store lock skips the line (RF1, GC8) ----

const waitsLog = (f) => {
  const p = join(f.stateDir, 'local', 'waits.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
// mode on, with the load and memory checks out of the way so a loaded machine does not deny: only the agent table does
const flagOn = (f) => { f.store.write('config', null, { schema: 1, flags: { admission: 'on' } }); sched.calibrate({ names, env: f.env, loadMax: '9999.0', freeMin: 1 }); };
const fill = (f) => { for (let n = 1; n <= sched.DEFAULTS.max.agent; n++) assert.equal(admit(f, n).decision, 'allow', `spawn ${n}`); };
const admitAs = (f, n, session) => hook('admit-agent', { hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: session, cwd: f.dir,
  tool_use_id: `toolu_${n}`, tool_input: { subagent_type: type, prompt: 'x' } }, { env: f.env });

test('shadow: a would-deny records no wait and its shadow record is unchanged; on: the same deny opens one', (t) => {
  const f = repo(t);
  sched.calibrate({ names, env: f.env, loadMax: '9999.0', freeMin: 1 });
  fill(f);
  assert.equal(admit(f, 99).decision, 'allow');
  assert.deepEqual(waitsLog(f), [], 'the agent ran: no wait');
  assert.deepEqual(Object.keys(shadowLog(f).at(-1)), ['at', 'kind', 'action', 'key', 'reasons', 'readings']);
  assert.equal(shadowLog(f).at(-1).key, 'toolu_99');
  flagOn(f);
  assert.equal(admit(f, 100).decision, 'deny');
  assert.deepEqual(waitsLog(f).map((r) => [r.kind, r.until, r.key]), [['load', null, 'sess-1']]);
});

test('RF1: with the store lock held by another process, a deny in on mode is unchanged, writes no wait and uses < 1 s of CPU', { timeout: 60000 }, async (t) => {
  const f = repo(t);
  flagOn(f);
  fill(f);
  const id = task(f.store, 1);
  const input = (n, session) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: session, cwd: f.dir, tool_use_id: `toolu_${n}`,
    tool_input: { subagent_type: type, prompt: 'x' } });
  const run = (n, session) => measured((probe) => spawnSync(process.execPath, [...probe.nodeArgs, LAUNCHER, 'hook', 'admit-agent'],
    { input: input(n, session), env: { ...process.env, ...f.env, ...probe.env }, cwd: f.dir, encoding: 'utf8', timeout: 30000 }));
  const free = run(90, 'sess-a');
  assert.equal(free.status, 0);
  assert.match(free.stdout, /"permissionDecision":"deny"/);
  assert.equal(waitsLog(f).length, 1, 'without the lock the deny opens a wait');
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `const state = await import(${JSON.stringify(pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href)});
const s = state.open(${JSON.stringify(f.stateDir)}, { names: ${JSON.stringify(names)} });
s.update('task', ${JSON.stringify(id)}, (d) => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); return d; });`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((res, rej) => { holder.stdout.once('data', res); holder.once('exit', () => rej(new Error('holder exited'))); });
  const held = run(91, 'sess-b');
  assert.equal(held.status, 0);
  assert.equal(held.stdout, free.stdout, 'the same deny, byte for byte');
  assertFast(assert, held, 'admit-agent under a held lock');
  holder.kill('SIGKILL');
  await new Promise((res) => (holder.exitCode !== null || holder.signalCode !== null ? res() : holder.once('exit', res)));
  assert.deepEqual(waitsLog(f).map((r) => r.key), ['sess-a'], 'the line of sess-b was skipped');
});

// S4 (T-MG-180): the implementer keeps the model its agent file declares; an override is denied in every admission mode.
for (const mode of ['off', 'shadow', 'on']) {
  test(`model lock (${mode}): an implementer launched with another model is denied, ORC-21 and the designer named`, (t) => {
    const f = repo(t);
    relaxAdmission(f.env);
    f.store.write('config', null, { schema: 1, flags: { admission: mode } });
    let n = 0;
    const call = (tool_input) => hook('admit-agent', { hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'sess-1', cwd: f.dir, tool_use_id: `toolu_m${++n}`, tool_input }, { env: f.env });
    const v = call({ subagent_type: type, model: 'opus', prompt: 'x' });
    assert.equal(v.decision, 'deny');
    assert.match(v.reason, /ORC-21/); assert.match(v.reason, new RegExp(`hard work goes to ${names.plugin}:designer \\(ORC-1\\)`));
    assert.equal(call({ subagent_type: type, model: 'sonnet', prompt: 'x' }).decision, 'allow');
    assert.equal(call({ subagent_type: type, prompt: 'x' }).decision, 'allow');
    assert.equal(call({ subagent_type: `${names.plugin}:designer`, model: 'opus' }).decision, 'allow');
    assert.equal(call({ subagent_type: 'Explore', model: 'opus' }).decision, 'allow');
    assert.equal(call({ subagent_type: type, model: 7 }).decision, 'allow');
    assert.equal(call(null).decision, 'allow');
  });
}

// T-MG-196 (SEC-13, spec A10, A4): a subagent starts no agent; SubagentStop revokes the review token also with admission off.
const T = await lib('state/tokens.mjs');
const me = T.holderOf(process.pid);
for (const mode of ['off', 'shadow', 'on']) {
  test(`spawn lock (${mode}): an Agent call from a hook input with agent_type set is denied, ORC-2`, (t) => {
    const f = repo(t);
    relaxAdmission(f.env);
    f.store.write('config', null, { schema: 1, flags: { admission: mode } });
    const call = (extra) => hook('admit-agent', { hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'sess-1', cwd: f.dir, tool_use_id: 'toolu_s1', tool_input: { subagent_type: `${names.plugin}:reviewer`, prompt: 'x' }, ...extra }, { env: f.env });
    for (const agent_type of [`${names.plugin}:implementer`, 'Explore', 'x']) {
      const v = call({ agent_type, agent_id: 'a1' });
      assert.equal(v.decision, 'deny', agent_type);
      assert.equal(v.reason, 'ORC-2: blocked: a subagent does not start agents. Instead report back to the orchestrator.');
    }
    assert.equal(call({}).decision, 'allow', 'the main session');
    for (const agent_type of ['', 7, null]) assert.equal(call({ agent_type }).decision, 'allow', String(agent_type));
  });

  test(`release (${mode}): SubagentStop removes the agent's token entry`, (t) => {
    const f = repo(t);
    relaxAdmission(f.env);
    f.store.write('config', null, { schema: 1, flags: { admission: mode } });
    assert.ok(T.mint({ dir: f.stateDir, names, role: 'orchestrator', session: 'sess-1', host: me }).token);
    for (const a of ['agent-abc', 'agent-def']) assert.ok(T.mint({ dir: f.stateDir, names, role: 'reviewer', session: 'sess-1', agent: a, host: me }).token);
    const file = join(f.stateDir, 'local', 'token.json');
    const agents = () => JSON.parse(readFileSync(file, 'utf8')).agents.map((a) => a.agent);
    assert.deepEqual(agents().sort(), ['agent-abc', 'agent-def']);
    assert.equal(stop(f, 'agent-abc').decision, 'allow');
    assert.deepEqual(agents(), ['agent-def']);
    assert.equal(stop(f, 'agent-nobody').decision, 'allow');
    assert.deepEqual(agents(), ['agent-def']);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /lf1_/);
  });
}
