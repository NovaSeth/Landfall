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
