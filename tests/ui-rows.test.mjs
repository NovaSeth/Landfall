// `<bin> ui rows` (spec §7.12 UI, SD-32, SC15, U6): the body of the agent-panel rows from the plugin's
// subagentStatusLine. It reads the statusline JSON on stdin (tasks[], columns), matches rows named
// <provider>-<role>-<task> (provider `auto`: any) to the first run record of that task and role under the row's cwd
// queued after the row started (its own run), and prints one {"id","content"} line per matched row:
// `<provider> · <role> · <task> · <elapsed> · [<n> tok · ][$<cost> · ]<status> · <last line>`, cut to `columns`.
// Other rows get no line (Claude Code keeps its own rendering); malformed input prints nothing, exit 0. Budget: ≤ 100 ms
// of handler CPU time per call with 20 rows (node startup excluded; wall time only as a ceiling, R77).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
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
const { main } = await lib('cli/main.mjs');
const { rowLines } = await lib('ui/rows.mjs');
const FAKE = join(root, 'tests', 'fixtures', 'providers', 'fake-provider.mjs');
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

async function cli(args, { cwd, env, stdin = null, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, e: json ? JSON.parse(stdout) : null, text: stdout, stderr: err.join('') };
}
const rows = (p, input) => cli(['ui', 'rows'], { cwd: p.cwd, env: p.env, json: false, stdin: Readable.from([typeof input === 'string' ? input : JSON.stringify(input)]) });
const parsed = (r) => r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function project(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'ui-rows-' });
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const p = { base: iso.base, repo: realpathSync(repo), cwd: repo, env };
  p.runsDir = join(p.repo, names.stateDir, 'local', 'runs');
  p.ok = async (args) => { const r = await cli([...args, '--yes'], p); assert.equal(r.code, 0, `${args.join(' ')}: ${JSON.stringify(r.e)}`); return r; };
  t.after(async () => {
    const recs = existsSync(p.runsDir) ? readdirSync(p.runsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(p.runsDir, f), 'utf8'))) : [];
    for (const r of recs) if (Number.isInteger(r.pid) && alive(r.pid)) { try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ } }
    for (const r of recs) for (let i = 0; i < 200 && Number.isInteger(r.pid) && alive(r.pid); i++) await pause(50);
    iso.cleanup();
  });
  await p.ok(['init']);
  await p.ok(['task', 'new', 'Parser']);
  await p.ok(['route', 'T-TU-1', '--paths', 'src/a.js', '--loc', '10']);
  await p.ok(['brief', 'T-TU-1', '--write']);
  await p.ok(['providers', 'add', 'fakeslow', '--argv', `${process.execPath} ${FAKE} slow {out} {sandbox} {cwd}`, '--sandbox-map', 'reviewer=read-only']);
  return p;
}
const task = (p, over = {}) => ({ id: 'a1', name: 'fakeslow-reviewer-T-TU-1', type: 'local_agent', agentType: `${names.plugin}:external`, status: 'running',
  description: 'T-TU-1 reviewer via fakeslow', label: 'T-TU-1 reviewer via fakeslow', startTime: Date.now() - 1000, tokenCount: 1200, cwd: p.repo, ...over });

test('SC15: a fake-provider run shows as its row within 5 s: provider, role, task, elapsed, status, last line', async (t) => {
  const p = await project(t);
  const spawned = Date.now();
  const input = { session_id: 's', cwd: p.repo, columns: 120, tasks: [task(p, { startTime: spawned }), task(p, { id: 'other', name: 'helper', agentType: 'Explore' })] };
  const r = await cli(['exec', '--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'fakeslow', '--yes'], p);
  assert.equal(r.code, 0, JSON.stringify(r.e));
  let lines = [];
  while (Date.now() - spawned < 5000) {
    const out = await rows(p, input);
    assert.equal(out.code, 0, out.stderr);
    lines = parsed(out);
    if (lines.length && /running · tick \d+$/.test(lines[0].content)) break;
    await pause(200);
  }
  assert.ok(Date.now() - spawned < 5000, `the row shows within 5 s: ${JSON.stringify(lines)}`);
  assert.equal(lines.length, 1, 'only the external row gets a body');
  assert.equal(lines[0].id, 'a1');
  assert.match(lines[0].content, /^fakeslow · reviewer · T-TU-1 · 00:0\d · running · tick \d+$/);
});

test('rows: elapsed, tokens and cost, columns cut, provider auto, rows started after the run are not matched, junk prints nothing', async (t) => {
  const now = Date.parse('2026-10-19T10:00:00.000Z');
  const at = (s) => new Date(now - s * 1000).toISOString();
  const rec = (over) => ({ schema: 1, runId: 'codex-T-MG-3-reviewer-1', task: 'T-MG-3', role: 'reviewer', provider: 'codex', status: 'running', queuedAt: at(260), startedAt: at(252), endedAt: null,
    elapsedMs: 0, tokens: { input: 10000, output: 2200, cached: 6000 }, costMicroUsd: 210000, lastLine: 'reading lib/state/store.mjs', ...over });
  const records = [rec({}), rec({ runId: 'codex-T-MG-3-reviewer-2', queuedAt: at(5000), startedAt: at(4990), status: 'done', elapsedMs: 3723000, endedAt: at(1000) }),
    rec({ runId: 'gem-T-MG-4-implementer-1', task: 'T-MG-4', role: 'implementer', provider: 'gem', tokens: null, costMicroUsd: null, queuedAt: at(10), startedAt: null, status: 'queued', lastLine: 'waiting for an external slot' })];
  const runsOf = (cwd) => (cwd === '/repo' ? records : []);
  const base = { id: 'r1', name: 'codex-reviewer-T-MG-3', type: 'local_agent', agentType: 'x:external', status: 'running', description: 'd', label: 'd', startTime: now - 300000, tokenCount: 1, cwd: '/repo' };
  const lines = (tasks, columns = 200) => rowLines({ tasks, columns }, { now, runsOf });
  // The row's run is the first of its task and role queued after the row started (each wrapper runs one exec).
  assert.deepEqual(lines([base]), [{ id: 'r1', content: 'codex · reviewer · T-MG-3 · 04:12 · 18.2k tok · $0.21 · running · reading lib/state/store.mjs' }]);
  assert.deepEqual(lines([{ ...base, startTime: now - 6000000 }]), [{ id: 'r1', content: 'codex · reviewer · T-MG-3 · 1:02:03 · 18.2k tok · $0.21 · done · reading lib/state/store.mjs' }]);
  assert.deepEqual(lines([{ ...base, id: 'r2', name: 'auto-implementer-T-MG-4' }]), [{ id: 'r2', content: 'gem · implementer · T-MG-4 · 00:10 · queued · waiting for an external slot' }]);
  assert.deepEqual(lines([base], 30), [{ id: 'r1', content: 'codex · reviewer · T-MG-3 · 0…' }]);
  assert.equal([...lines([base], 30)[0].content].length, 30);
  assert.deepEqual(lines([{ ...base, startTime: now }]), [], 'a row started after every run of its task: no match yet');
  assert.deepEqual(lines([{ ...base, name: 'helper' }, { ...base, name: 'codex-reviewer-T-MG-3', cwd: '/elsewhere' }, { ...base, name: undefined }]), []);
  // Through the command: junk on stdin, no stdin, a tasks field that is no array: no output, exit 0.
  const p = { cwd: realpathSync(isolatedEnv({ prefix: 'ui-rows-junk-' }).base), env: { ...process.env } };
  for (const input of ['not json', '{"tasks":{}}', '[]', '']) {
    const r = await rows(p, input);
    assert.deepEqual([r.code, r.text, r.stderr], [0, '', ''], input);
  }
});

test('≤ 100 ms of handler CPU per call with 20 rows (each reads one small run record)', async (t) => {
  const p = await project(t);
  mkdirSync(p.runsDir, { recursive: true });
  const now = Date.now();
  const tasks = [];
  for (let n = 1; n <= 20; n++) {
    const runId = `fakeslow-T-TU-${n}-reviewer-1`;
    writeFileSync(join(p.runsDir, `${runId}.json`), `${JSON.stringify({ schema: 1, runId, task: `T-TU-${n}`, role: 'reviewer', provider: 'fakeslow', adapterVersion: null, model: null, sandbox: 'read-only', cwd: p.repo, pid: null, pidStart: null, pidMethod: null, lease: null, capS: 900, tokensReason: null, unknownEvents: 0, outFile: null, exit: null, error: null, status: 'running',
      queuedAt: new Date(now - 5000).toISOString(), startedAt: new Date(now - 4000).toISOString(), endedAt: null, elapsedMs: 0, tokens: null, costMicroUsd: null, lastLine: `line ${n}` }, null, 2)}\n`);
    tasks.push(task(p, { id: `t${n}`, name: `fakeslow-reviewer-T-TU-${n}`, startTime: now - 10000 }));
  }
  const input = { session_id: 's', cwd: p.repo, columns: 100, tasks };
  await rows(p, input); // warm: modules loaded once per process, as in the real one-shot process before the handler runs
  let worst = 0;
  let wall = 0;
  for (let i = 0; i < 5; i++) {
    const cpu = process.cpuUsage();
    const started = performance.now();
    const r = await rows(p, input);
    const used = process.cpuUsage(cpu);
    worst = Math.max(worst, (used.user + used.system) / 1000);
    wall = Math.max(wall, performance.now() - started);
    assert.equal(parsed(r).length, 20);
  }
  t.diagnostic(`worst handler CPU ${worst.toFixed(1)} ms, wall ${wall.toFixed(1)} ms`);
  assert.ok(worst <= 100, `handler CPU ${worst} ms > 100 ms`);
  assert.ok(wall <= 2000, `wall ${wall} ms over the 2 s ceiling`);
});
