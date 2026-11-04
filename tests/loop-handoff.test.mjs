// Short orchestrator life (T-MG-177): `tick` measures the calling session's context (the last request of its transcript
// <config>/projects/<slug>/<CLAUDE_CODE_SESSION_ID>.jsonl: input + cache read + cache write) and, over
// thresholds.loop.handoffTokens (default 200000) or after a merge since the session started, prints a HANDOFF step
// (commit, schedule no wakeup, end the session, resume with `status`). While tasks of this tick are in flight it drains
// instead: only their rows, no new dispatch. An unreadable transcript, or none, changes nothing.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const loop = await lib('loop/index.mjs');
const state = await lib('state/index.mjs');
const sessions = await lib('receipts/sessions.mjs');
const { main } = await lib('cli/main.mjs');

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
const MIN = 60000;
const at = (min) => new Date(T0 + min * MIN).toISOString();
const BIN = names.bin;
const SID = '0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const ev = (event, min, data = {}) => ({ at: at(min), by: 'TU', event, data });
function task(id, status, events = []) {
  return { schema: state.KINDS.task.version, id, kind: 'task', title: `Task ${id}`, lane: null, owner: 'TU', class: 'standard', classHistory: [], status, round: 0, events: [ev('created', 0), ...events], base: null, branch: null };
}

function storeDir(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'loop-handoff-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'state');
  const where = { repo: base, dir, local: join(dir, 'local'), active: true, linked: false };
  const store = state.open(dir, { names, kinds: loop.STORE_KINDS });
  store.write('state', null, { codename: names.codename, createdWith: '1.5.2', activatedAt: at(0) });
  store.write('team', 'TU', { handle: 'TU', emailSha256: state.emailHash('test@example.com'), addedAt: at(0) });
  const probe = { heads: () => 'main 1111111', email: () => 'test@example.com', cost: () => ({ costMicroUsd: 0, partial: false }), dirty: () => [] };
  const run = (now, extra = {}) => loop.tickStore(store, { where, names, now: T0 + now * MIN, plan: null, probe: { ...probe, ...extra } });
  return { store, run };
}
const strip = (r) => ({ result: r.result, reason: r.reason, nextTickS: r.nextTickS, steps: r.steps, info: r.info, handoff: r.handoff });

test('handoff (store path): a context over 200000 tokens turns the tick into one HANDOFF action step; under it, nothing changes', (t) => {
  const under = storeDir(t);
  under.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  const plain = storeDir(t);
  plain.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  const a = under.run(1, { session: () => ({ tokens: 199999, startedAt: at(0) }) });
  const b = plain.run(1);
  assert.deepEqual(strip(a), strip(b), 'under the threshold the tick is the tick without a session');
  assert.equal(a.handoff, undefined);

  const over = storeDir(t);
  over.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  const r = over.run(1, { session: () => ({ tokens: 200000, startedAt: at(0) }) });
  assert.equal(r.result, 'ACTION');
  assert.deepEqual(r.steps.map((s) => [s.task, s.kind]), [['HANDOFF', 'action']], 'the other steps go to the next session');
  assert.ok(r.steps[0].step.includes(`${BIN} commit --yes`), r.steps[0].step);
  assert.match(r.handoff.reason, /200000 tokens/);
  assert.equal(r.handoff.draining, false);
  assert.equal(r.loop.exit, null, 'the loop stays running');
});

test('handoff (store path): a merge since the session started is a milestone; one before it is not', (t) => {
  const merged = (min) => task('T-TU-2', 'done', [ev('merged', min)]);
  const before = storeDir(t);
  before.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  before.store.write('task', 'T-TU-2', merged(1));
  assert.equal(before.run(5, { session: () => ({ tokens: 1000, startedAt: at(2) }) }).handoff, undefined);
  const after = storeDir(t);
  after.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  after.store.write('task', 'T-TU-2', merged(3));
  const r = after.run(5, { session: () => ({ tokens: 1000, startedAt: at(2) }) });
  assert.deepEqual(r.steps.map((s) => s.task), ['HANDOFF']);
  assert.match(r.handoff.reason, /T-TU-2 merged/);
});

test('handoff (store path): with a task in flight the tick drains: only its row, WAIT with a wakeup, no new dispatch', (t) => {
  const s = storeDir(t);
  s.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  s.store.write('task', 'T-TU-3', task('T-TU-3', 'dispatched', [ev('dispatched', 4, { executor: 'claude:implementer', base: 'abc1234' })]));
  const r = s.run(5, { session: () => ({ tokens: 300000, startedAt: at(0) }) });
  assert.equal(r.result, 'WAIT');
  assert.ok(Number.isInteger(r.nextTickS) && r.nextTickS >= 60, String(r.nextTickS));
  assert.deepEqual(r.steps.map((s2) => s2.task), ['T-TU-3'], 'T-TU-1 is not dispatched in this session');
  assert.equal(r.handoff.draining, true);
});

test('handoff (store path): a session probe that throws or finds nothing changes nothing; an ended loop stays ended', (t) => {
  const a = storeDir(t);
  a.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  const b = storeDir(t);
  b.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  const thrown = a.run(1, { session: () => { throw new Error('EACCES'); } });
  assert.deepEqual(strip(thrown), strip(b.run(1, { session: () => null })));
  assert.equal(thrown.handoff, undefined);
  const c = storeDir(t);
  c.store.write('task', 'T-TU-1', task('T-TU-1', 'cancelled'));
  const done = c.run(1, { session: () => ({ tokens: 900000, startedAt: at(0) }) });
  assert.equal(done.result, 'DONE');
  assert.equal(done.handoff, undefined);
});

// ---- the session transcript --------------------------------------------------------------------------------------

const line = (requestId, ts, usage) => JSON.stringify({
  type: 'assistant', sessionId: SID, version: '2.1.318', timestamp: ts, requestId,
  message: { id: `msg_${requestId}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'SYNTH' }], usage },
});
const transcript = (big) => [
  line('req_1', at(0), { input_tokens: 10, cache_read_input_tokens: 500000, cache_creation_input_tokens: 0, output_tokens: 5 }),
  line('req_2', at(1), { input_tokens: 3, cache_read_input_tokens: big, cache_creation_input_tokens: 2000, output_tokens: 40 }),
].join('\n') + '\n';

const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
async function cli(args, { cwd, env }) {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(args, { io });
  return { code, text: out.join('') };
}
async function repo(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'handoff-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, iso.env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  for (const k of [`${names.envPrefix}BILLING`, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete iso.env[k];
  const transcripts = join(iso.env.CLAUDE_CONFIG_DIR, 'projects', realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(transcripts, { recursive: true });
  const r = { cwd: dir, env: iso.env, file: join(transcripts, `${SID}.jsonl`) };
  assert.equal((await cli(['init', '--yes'], r)).code, 0);
  assert.equal((await cli(['task', 'new', 'Loop work', '--yes'], r)).code, 0);
  return r;
}

test('sessionContext: the last request of the session named by CLAUDE_CODE_SESSION_ID (input + cache read + cache write); null otherwise', async (t) => {
  const p = await repo(t);
  writeFileSync(p.file, transcript(250000));
  const env = { ...p.env, CLAUDE_CODE_SESSION_ID: SID };
  assert.deepEqual(sessions.sessionContext({ repo: realpathSync(p.cwd), env, bin: BIN }), { tokens: 3 + 250000 + 2000, startedAt: at(0) });
  assert.equal(sessions.sessionContext({ repo: realpathSync(p.cwd), env: p.env, bin: BIN }), null, 'no session ID');
  assert.equal(sessions.sessionContext({ repo: realpathSync(p.cwd), env: { ...env, CLAUDE_CODE_SESSION_ID: '../x' }, bin: BIN }), null, 'not an ID');
  assert.equal(sessions.sessionContext({ repo: realpathSync(p.cwd), env: { ...env, CLAUDE_CODE_SESSION_ID: 'other' }, bin: BIN }), null, 'no transcript');
});

test('tick through the CLI: a fixture transcript over the threshold prints the HANDOFF step; under it and unreadable, the tick of today', async (t) => {
  const p = await repo(t);
  const env = { ...p.env, CLAUDE_CODE_SESSION_ID: SID };
  assert.equal((await cli(['tick'], p)).code, 0); // the first tick starts the loop
  const base = await cli(['tick'], p); // no session: today's tick
  assert.equal(base.code, 0);
  const body = (text) => text.split('\n').slice(1).join('\n'); // the TICK line carries the tick count and time

  writeFileSync(p.file, transcript(150000));
  const under = await cli(['tick'], { ...p, env });
  assert.equal(under.code, 0);
  assert.equal(body(under.text), body(base.text), 'under the threshold nothing changes');

  chmodSync(p.file, 0o000);
  writeFileSync(join(dirname(p.file), 'decoy.jsonl'), transcript(900000));
  const unreadable = await cli(['tick'], { ...p, env });
  assert.equal(unreadable.code, 0);
  assert.equal(body(unreadable.text), body(base.text), 'an unreadable transcript changes nothing');
  chmodSync(p.file, 0o600);

  writeFileSync(p.file, transcript(250000));
  const over = await cli(['tick'], { ...p, env });
  assert.equal(over.code, 0, 'ACTION: no new exit code');
  assert.match(over.text, /^TICK .* — ACTION \(1\)/m);
  assert.match(over.text, /\| HANDOFF \| context 252003 tokens/);
  assert.ok(over.text.includes(`${BIN} commit --yes`), over.text);
  assert.match(over.text, /^NEXT_TICK: new session — .*schedule no wakeup.*end this session/m);
  assert.ok(over.text.includes(`\`${BIN} status\``), over.text);
  assert.ok(!over.text.includes('ScheduleWakeup after') && !over.text.includes(loop.fixedPrompt(names)), 'no wakeup carries the session on (FLW-5)');
  const json = await cli(['tick', '--json'], { ...p, env });
  assert.equal(JSON.parse(json.text).data.handoff.threshold, 200000);
});
