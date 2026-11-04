// Wait events (plan M1.7, P6, D-MG-38): the loop and admission leave typed wait intervals in local/waits.jsonl.
// A usage-limit WAIT covers [now, resetAt], any other WAIT [now, now + nextTickS]; an exit records nothing (GC4). A load
// wait opens at a session's first deny in mode on and closes at that session's next admit; a shadow would-deny records
// nothing, and a held store lock skips the line without changing the decision (GC8, RF1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { lib, names, repo } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const loop = await lib('loop/index.mjs');
const state = await lib('state/index.mjs');

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
const MIN = 60000;
const at = (min) => new Date(T0 + min * MIN).toISOString();

const ev = (event, min, data = {}, by = 'AB') => ({ at: at(min), by, event, data });
const taskDoc = (id, status, events = []) => ({ schema: state.KINDS.task.version, id, kind: 'task', title: `Task ${id}`, lane: null, owner: 'AB', class: 'standard',
  classHistory: [], status, round: 0, events: [ev('created', 0), ...events], base: null, branch: null });

// A repository with active state (tests/helpers/hook-fixture.mjs) and the loop's store over it, so the tick and the
// admit hook write the same local/waits.jsonl.
function loopRepo(t) {
  const f = repo(t);
  const store = state.open(f.stateDir, { names, kinds: loop.STORE_KINDS });
  const where = { repo: f.dir, dir: f.stateDir, local: join(f.stateDir, 'local'), active: true, linked: false };
  const probe = { heads: () => 'main 1111111', email: () => 'test@example.com', cost: () => ({ costMicroUsd: 0, partial: false }), dirty: () => [] };
  const run = (min, extra = {}) => loop.tickStore(store, { where, names, now: T0 + min * MIN, plan: null, probe: { ...probe, ...extra } });
  const file = join(f.stateDir, 'local', 'waits.jsonl');
  const waits = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ...f, loopStore: store, where, run, file, waits };
}

test('a tick under a usage limit records one usage-limit wait [now, resetAt] in local/waits.jsonl', (t) => {
  const f = loopRepo(t);
  f.loopStore.write('task', 'T-AB-1', taskDoc('T-AB-1', 'new'));
  const resetAt = T0 + 30 * MIN;
  const r = f.run(2, { limits: () => ({ kind: 'session', resetAt, source: 's.jsonl' }) });
  assert.equal(r.result, 'WAIT');
  assert.ok(existsSync(f.file), 'local/waits.jsonl is written');
  assert.deepEqual(f.waits(), [{ at: at(2), until: new Date(resetAt).toISOString(), kind: 'usage-limit', task: null, source: 'loop' }]);
});

// ---- the fixture of acceptance 2: one usage-limit tick, one load deny then admit (mode on), one WAIT tick ----

const sched = await lib('sched/index.mjs');
const { hook } = await import('./helpers/hook-fixture.mjs');
const type = `${names.plugin}:implementer`;
const admit = (f, n, session = 'sess-1') => hook('admit-agent', { hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: session, cwd: f.dir,
  tool_use_id: `toolu_${n}`, tool_input: { subagent_type: type, prompt: 'x' } }, { env: f.env });
const bind = (f, n, agentId) => hook('bind-agent', { hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 'sess-1', cwd: f.dir,
  tool_use_id: `toolu_${n}`, tool_input: { subagent_type: type }, tool_response: { agentId } }, { env: f.env });
const stop = (f, agentId) => hook('release-agent', { hook_event_name: 'SubagentStop', session_id: 'sess-1', cwd: f.dir, agent_id: agentId, agent_type: type }, { env: f.env });
// mode on, and the load and memory checks out of the way so a loaded machine does not deny: only the agent table does
const flagOn = (f) => { f.loopStore.write('config', null, { schema: 1, flags: { admission: 'on' } }); sched.calibrate({ names, env: f.env, loadMax: '9999.0', freeMin: 1 }); };
const closed = (rows) => rows.filter((r) => r.until !== null);

test('one fixture yields exactly 3 closed waits (usage-limit, load, tick), each until ≥ at; the only other line is the closed open marker', (t) => {
  const f = loopRepo(t);
  f.loopStore.write('task', 'T-AB-1', taskDoc('T-AB-1', 'blocked', [ev('blocked', 0, { reason: 'waiting for a key' })]));
  flagOn(f);
  // a usage-limit tick
  assert.equal(f.run(1, { limits: () => ({ kind: 'weekly', resetAt: T0 + 61 * MIN, source: 's.jsonl' }) }).result, 'WAIT');
  // a deny then an admit of one session in mode on (the table is full of sess-1's agents; one of them ends)
  const max = sched.DEFAULTS.max.agent;
  for (let n = 1; n <= max; n++) assert.equal(admit(f, n).decision, 'allow', `spawn ${n}`);
  assert.equal(f.waits().length, 1, 'an admit with no open wait writes nothing');
  assert.equal(admit(f, 90, 'sess-2').decision, 'deny');
  assert.equal(admit(f, 91, 'sess-2').decision, 'deny', 'still full');
  assert.equal(f.waits().filter((r) => r.kind === 'load').length, 1, 'a second deny of an open wait adds nothing');
  bind(f, 1, 'agent-1'); stop(f, 'agent-1');
  const back = admit(f, 92, 'sess-2');
  assert.equal(back.decision, 'allow', back.reason);
  // a WAIT tick with nextTickS (the blocked task)
  const w = f.run(70);
  assert.equal(w.result, 'WAIT');
  assert.ok(w.nextTickS > 0);
  const rows = f.waits();
  const done = closed(rows);
  assert.deepEqual(done.map((r) => r.kind), ['usage-limit', 'load', 'tick']);
  for (const r of done) assert.ok(Date.parse(r.until) >= Date.parse(r.at), JSON.stringify(r));
  assert.deepEqual([done[0].at, done[0].until], [at(1), at(61)]);
  assert.deepEqual([done[2].at, done[2].until], [at(70), new Date(T0 + 70 * MIN + w.nextTickS * 1000).toISOString()]);
  const open = rows.filter((r) => r.until === null);
  assert.equal(open.length, 1, 'one open marker');
  assert.deepEqual(open[0], { at: done[1].at, until: null, kind: 'load', task: null, source: 'admit', key: 'sess-2' });
  assert.equal(done[1].key, 'sess-2');
  assert.equal(rows.length, 4);
  bind(f, 2, 'agent-2'); stop(f, 'agent-2');
  assert.equal(admit(f, 93, 'sess-2').decision, 'allow');
  assert.equal(f.waits().length, 4, 'a later admit of a closed wait writes nothing');
});

test('a second tick of one usage limit adds no line, a new reset adds one; DONE and STALLED ticks add none (GC4)', (t) => {
  const f = loopRepo(t);
  f.loopStore.write('task', 'T-AB-1', taskDoc('T-AB-1', 'new'));
  const hit = { kind: 'session', resetAt: T0 + 30 * MIN, source: 's.jsonl' };
  f.run(1, { limits: () => hit });
  f.run(5, { limits: () => hit });
  assert.equal(f.waits().length, 1, 'the same resetAt: no new line');
  f.run(6, { limits: () => ({ ...hit, resetAt: T0 + 40 * MIN }) });
  assert.equal(f.waits().length, 2, 'a new reset is a new wait');
  assert.equal(f.run(7, { limits: () => ({ kind: 'codex', resetAt: T0 + 50 * MIN, source: 'r', provider: 'codex' }) }).result, 'ACTION');
  assert.equal(f.run(8).result, 'ACTION');
  assert.equal(f.waits().length, 2, 'a codex limit and an ACTION tick record nothing');
  f.loopStore.write('task', 'T-AB-1', taskDoc('T-AB-1', 'cancelled'));
  assert.equal(f.run(9).result, 'DONE');
  assert.equal(f.run(10).result, 'DONE');
  assert.equal(f.waits().length, 2, 'DONE records nothing, also when repeated');

  const g = loopRepo(t);
  g.loopStore.write('task', 'T-AB-1', taskDoc('T-AB-1', 'blocked', [ev('blocked', 0, { reason: 'waiting for a key' })]));
  assert.deepEqual([0, 30, 60].map((m) => g.run(m).result), ['WAIT', 'WAIT', 'WAIT']);
  assert.deepEqual(g.waits().map((r) => r.kind), ['tick', 'tick', 'tick']);
  assert.equal(g.run(90).result, 'STALLED');
  assert.equal(g.waits().length, 3, 'STALLED records nothing');
});

test('a failed waits line never fails or changes a tick', (t) => {
  const f = loopRepo(t);
  f.loopStore.write('task', 'T-AB-1', taskDoc('T-AB-1', 'new'));
  const append = f.loopStore.append;
  f.loopStore.append = () => { throw new Error('disk full'); };
  const r = f.run(1, { limits: () => ({ kind: 'session', resetAt: T0 + 30 * MIN, source: 's.jsonl' }) });
  f.loopStore.append = append;
  assert.equal(r.result, 'WAIT');
  assert.equal(r.loop.ticks, 1);
  assert.deepEqual(f.waits(), []);
});

// ---- the contract of lib/loop/waits.mjs ----

const waits = await lib('loop/waits.mjs');

test('recordWait checks its fields (TypeError) and writes through store.append; the kinds are fixed', (t) => {
  const f = loopRepo(t);
  assert.deepEqual(waits.WAIT_KINDS, ['usage-limit', 'load', 'tick', 'heavy-queue']);
  const ok = { kind: 'heavy-queue', at: at(1), until: at(2), task: 'T-AB-1', source: 'verify' };
  assert.deepEqual(waits.recordWait(f.loopStore, ok), ok);
  assert.deepEqual(f.waits(), [ok]);
  assert.deepEqual(waits.recordWait(f.loopStore, { ...ok, kind: 'load', key: 'sess-9' }).key, 'sess-9');
  for (const bad of [{ kind: 'nap' }, { at: '2026-10-15' }, { until: at(0) }, { until: null }, { until: 'later' }, { task: 'T-1' }, { source: '' },
    { source: 'x'.repeat(41) }, { key: '-bad' }, { key: 7 }, { kind: 'load' }]) {
    assert.throws(() => waits.recordWait(f.loopStore, { ...ok, ...bad }), TypeError, JSON.stringify(bad));
  }
  assert.equal(f.waits().length, 2, 'nothing written on bad input');
  assert.equal(waits.closeLoadWait(f.loopStore, { key: 'sess-9', at: at(3) }), null, 'no open marker: nothing to close');
  assert.equal(waits.openLoadWait(f.loopStore, { key: 'sess-9', at: at(3) }).until, null);
  assert.equal(waits.openLoadWait(f.loopStore, { key: 'sess-9', at: at(4) }), null, 'already open');
  assert.equal(waits.openLoadWait(f.loopStore, { key: 'sess-90', at: at(4) }).key, 'sess-90', 'another key (a prefix of none) opens its own');
  assert.deepEqual(waits.closeLoadWait(f.loopStore, { key: 'sess-9', at: at(2) }), { at: at(3), until: at(3), kind: 'load', task: null, source: 'admit', key: 'sess-9' }, 'a clock behind the marker: an empty wait, never until < at');
  assert.equal(waits.closeLoadWait(f.loopStore, { key: 'sess-9', at: at(5) }), null, 'closed once');
  assert.deepEqual(waits.closeLoadWait(f.loopStore, { key: 'sess-90', at: at(6) }), { at: at(4), until: at(6), kind: 'load', task: null, source: 'admit', key: 'sess-90' });
});

test('loopWait: a past or unknown reset waits nextTickS; ACTION, exits and a codex limit record nothing', () => {
  const now = T0;
  assert.deepEqual(waits.loopWait({ result: 'WAIT', nextTickS: 600, limit: { kind: 'session', resetAt: null }, now }), { kind: 'usage-limit', at: at(0), until: at(10), task: null, source: 'loop' });
  assert.equal(waits.loopWait({ result: 'WAIT', nextTickS: 60, limit: { kind: 'session', resetAt: now - MIN }, now }).until, at(1));
  assert.equal(waits.loopWait({ result: 'WAIT', nextTickS: 600, limit: { kind: 'codex', resetAt: now + MIN }, now }).kind, 'tick');
  assert.equal(waits.loopWait({ result: 'WAIT', nextTickS: null, now }), null);
  for (const result of ['ACTION', 'DONE', 'STALLED', 'BUDGET']) assert.equal(waits.loopWait({ result, nextTickS: 600, limit: { kind: 'session', resetAt: now + MIN }, now }), null, result);
});
