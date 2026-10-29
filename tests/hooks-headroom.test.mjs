// Context-headroom hook (T-MG-17, D-MG-22): PostToolUse Bash|Edit|Write|Agent reads the tail of the transcript, takes the
// latest assistant usage and warns once per session at 35 % and once more at 25 % remaining. Shadow logs, on injects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { MALFORMED, hook, lib, repo } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const { HOOKS } = await lib('hooks/registry.mjs');
const { headroomUsage, windowOf } = await lib('hooks/headroom.mjs');

const line = (total, model = 'claude-opus-4') => JSON.stringify({ type: 'assistant', message: { model,
  usage: { input_tokens: 10, cache_read_input_tokens: total - 30, cache_creation_input_tokens: 20, output_tokens: 5 } } });
const write = (f, lines, name = 't.jsonl') => { const p = join(f.base, name); writeFileSync(p, `${lines.join('\n')}\n`); return p; };
const run = (f, transcript_path, { session = 's1', env = {} } = {}) => hook('headroom', { hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: session,
  cwd: f.dir, transcript_path, tool_input: { command: 'ls' } }, { env: { ...f.env, ...env } });
const shadow = (f) => {
  const p = join(f.stateDir, 'local', 'shadow.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'headroom') : [];
};
const ON = (f) => ({ env: { ...f.env } });

test('registered: PostToolUse Bash|Edit|Write|Agent, capability headroom, onError allow', () => {
  const h = HOOKS.find((x) => x.name === 'headroom');
  assert.ok(h);
  assert.equal(h.event, 'PostToolUse'); assert.equal(h.matcher, 'Bash|Edit|Write|Agent');
  assert.equal(h.capability, 'headroom'); assert.equal(h.onError, 'allow');
});

test('window: [1m] model, observed total above 200k, the override, else 200k (D-MG-22)', () => {
  assert.equal(windowOf({ model: 'claude-opus-4[1m]', total: 10 }, {}), 1000000);
  assert.equal(windowOf({ model: 'claude-opus-4', total: 200001 }, {}), 1000000);
  assert.equal(windowOf({ model: 'claude-opus-4', total: 200000 }, {}), 200000);
  assert.equal(windowOf({ model: 'x', total: 10 }, { LANDFALL_CONTEXT_WINDOW: '500000' }), 500000);
  assert.equal(windowOf({ model: 'x', total: 10 }, { LANDFALL_CONTEXT_WINDOW: 'abc' }), 200000);
  assert.equal(windowOf({ model: 'x', total: 10 }, { LANDFALL_CONTEXT_WINDOW: '-5' }), 200000);
});

test('below the threshold: nothing is logged', (t) => {
  const f = repo(t);
  assert.equal(run(f, write(f, [line(100000)])).decision, 'allow');
  assert.deepEqual(shadow(f), []);
});

test('at 35 % remaining: one record, no injection in shadow; a repeat logs nothing more', (t) => {
  const f = repo(t);
  const p = write(f, [line(130000)]);
  const v = run(f, p);
  assert.equal(v.stdout, '');
  const rec = shadow(f);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].session, 's1'); assert.equal(rec[0].threshold, 35); assert.equal(rec[0].remaining, 35);
  run(f, p);
  assert.equal(shadow(f).length, 1, 'no second warning');
});

test('at 25 % remaining: one more record; another session warns again', (t) => {
  const f = repo(t);
  run(f, write(f, [line(130000)]));
  run(f, write(f, [line(130000), line(150000)]));
  assert.deepEqual(shadow(f).map((r) => r.threshold), [35, 25]);
  run(f, write(f, [line(150000)]));
  assert.equal(shadow(f).length, 2);
  run(f, write(f, [line(150000)]), { session: 's2' });
  assert.equal(shadow(f).length, 3);
});

test('on mode injects additionalContext of at most 200 characters naming /compact or a fresh session', (t) => {
  const f = repo(t);
  f.store.write('config', null, { schema: 1, flags: { headroom: 'on' } });
  const v = run(f, write(f, [line(130000)]));
  assert.ok(v.context, v.stdout);
  assert.ok(v.context.length <= 200);
  assert.match(v.context, /\/compact|fresh session/);
  assert.equal(v.event, 'PostToolUse');
  assert.equal(run(f, write(f, [line(130000)])).stdout, '', 'once only');
});

test('a [1m] model: 130k of 1M is far from a threshold', (t) => {
  const f = repo(t);
  run(f, write(f, [line(130000, 'claude-opus-4[1m]')]));
  assert.deepEqual(shadow(f), []);
  run(f, write(f, [line(650000, 'claude-opus-4[1m]')]));
  assert.equal(shadow(f)[0].threshold, 35);
});

test('malformed lines are skipped; a missing file, a directory and malformed input allow', (t) => {
  const f = repo(t);
  const p = write(f, [line(130000), '{not json', '', '[1,2]', '{"type":"assistant","message":{"usage":"x"}}']);
  run(f, p);
  assert.equal(shadow(f).length, 1);
  assert.equal(run(f, join(f.base, 'missing.jsonl'), { session: 's9' }).decision, 'allow');
  assert.equal(run(f, f.base, { session: 's9' }).decision, 'allow');
  for (const text of MALFORMED) assert.equal(hook('headroom', text, { env: f.env }).stdout, '', String(text));
});

test('a link is not followed', async (t) => {
  const { symlinkSync } = await import('node:fs');
  const f = repo(t);
  const real = write(f, [line(150000)]);
  const link = join(f.base, 'link.jsonl');
  symlinkSync(real, link);
  assert.equal(run(f, link).decision, 'allow');
  assert.deepEqual(shadow(f), []);
});

test('only the last 64 KiB is read, and it takes under 50 ms (p95)', (t) => {
  const f = repo(t);
  const filler = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `filler ${i} ${'x'.repeat(200)}` } }));
  const p = write(f, [line(190000), ...filler, line(100000)]);
  assert.equal(headroomUsage(p).total, 100000, 'the latest usage, not the first');
  const old = write(f, [line(150000), ...filler], 'old.jsonl');
  assert.equal(headroomUsage(old), null, 'a usage beyond the tail is not seen');
  const times = [];
  for (let i = 0; i < 40; i++) { const s = performance.now(); headroomUsage(p); times.push(performance.now() - s); }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.ceil(times.length * 0.95) - 1] <= 50, `p95 ${times[37]} ms`);
});
void ON;
