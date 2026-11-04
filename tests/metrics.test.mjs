import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = join(root, 'plugins');
const plugin = join(plugins, readdirSync(plugins).find((d) => existsSync(join(plugins, d, 'lib/name.json'))));
const names = JSON.parse(readFileSync(join(plugin, 'lib/name.json'), 'utf8'));
const lib = (p) => import(pathToFileURL(join(plugin, 'lib', p)).href);
const { main } = await lib('cli/main.mjs');
const { git } = await lib('git/index.mjs');
const { slug } = await lib('receipts/sessions.mjs');
const FIXTURES = join(root, 'tests/fixtures/metrics');
const DAY = '2026-11-04';
const IDS = ['orchestratorCallsPerClosedTask', 'medianOrchestratorContext', 'cacheReadsPerClosedTask',
  'tasksOverTwoFixRounds', 'medianStartToMerge', 'medianLastReviewToMerge', 'openBacklog'];

async function cli(args, p, json = true) {
  let stdout = '', stderr = '';
  const code = await main([...args, ...(json ? ['--json'] : [])], { io: {
    cwd: p.cwd, env: p.env, stdinIsTTY: false, stdin: null,
    out: (s) => { stdout += s; }, err: (s) => { stderr += s; },
  } });
  if (json) assert.equal(stdout.trim().split('\n').length, 1);
  return { code, stdout, stderr, body: json ? JSON.parse(stdout) : null };
}

async function project(t, { transcripts = true, active = true } = {}) {
  const iso = isolatedEnv({ prefix: 'metrics-', gitConfig: '[user]\n\tname = Test User\n\temail = test@example.com\n' });
  t.after(iso.cleanup);
  const cwd = join(iso.base, 'repo');
  mkdirSync(cwd);
  const p = { ...iso, cwd, state: join(cwd, names.stateDir) };
  const runGit = (args) => { const r = git(args, { cwd, env: p.env }); assert.equal(r.status, 0, r.stderr); };
  runGit(['init', '-q']);
  runGit(['commit', '-q', '--allow-empty', '-m', 'fixture']);
  p.worktree = join(iso.base, 'worktree');
  runGit(['worktree', 'add', '-q', '-b', 'worker', p.worktree]);
  if (active) {
    const initialized = await cli(['init', '--yes'], p);
    assert.equal(initialized.code, 0, initialized.stdout);
    cpSync(join(FIXTURES, 'tasks'), join(p.state, 'tasks'), { recursive: true });
  }
  p.transcripts = join(p.env.CLAUDE_CONFIG_DIR, 'projects');
  if (transcripts) {
    const mainDir = join(p.transcripts, slug(cwd));
    mkdirSync(join(mainDir, 'session/subagents'), { recursive: true });
    cpSync(join(FIXTURES, 'main.jsonl'), join(mainDir, 'session.jsonl'));
    cpSync(join(FIXTURES, 'main.jsonl'), join(mainDir, 'resumed.jsonl'));
    cpSync(join(FIXTURES, 'agent.jsonl'), join(mainDir, 'session/subagents/agent-fixture.jsonl'));
    const wtDir = join(p.transcripts, slug(p.worktree));
    mkdirSync(wtDir, { recursive: true });
    cpSync(join(FIXTURES, 'worktree.jsonl'), join(wtDir, 'worker.jsonl'));
    const unrelated = join(p.transcripts, 'unrelated-repository');
    mkdirSync(unrelated);
    cpSync(join(FIXTURES, 'main.jsonl'), join(unrelated, 'unrelated.jsonl'));
  }
  return p;
}

const values = (r) => r.body.data.rows.map((row) => row.value);
const contents = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? contents(p) : [[p, readFileSync(p, 'base64'), statSync(p).mtimeMs]];
});

test('metrics: seven KPI values, deduplicated transcripts, JSON envelope, worktree lookup and no writes', async (t) => {
  const p = await project(t);
  const before = contents(p.base);
  const r = await cli(['metrics', '--day', DAY], p);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.stderr, '');
  assert.deepEqual(Object.keys(r.body), ['cli', 'command', 'ok', 'code', 'exit', 'data', 'errors']);
  assert.equal(r.body.command, 'metrics');
  assert.deepEqual(Object.keys(r.body.data), ['period', 'rows']);
  assert.deepEqual(r.body.data.period, { day: DAY });
  assert.deepEqual(r.body.data.rows.map((row) => row.id), IDS);
  assert.deepEqual(values(r), [2, 250, 550, 1, 75, 20, 2]);
  assert.equal(r.body.data.rows[3].total, 4);
  for (const row of r.body.data.rows) {
    assert.equal(row.reason, null);
    assert.equal(typeof row.label, 'string');
    assert.equal(typeof row.unit, 'string');
  }
  const wt = await cli(['metrics', '--day', DAY], { ...p, cwd: p.worktree });
  assert.deepEqual(wt.body, r.body);
  assert.deepEqual(contents(p.base), before, 'no state, transcript, cache or snapshot writes');
  const text = await cli(['metrics', '--day', DAY], p, false);
  assert.equal(text.code, 0);
  assert.equal(text.stdout.trim().split('\n').length, 9, 'only header, separator and seven rows');
  assert.match(text.stdout, /Tasks with more than 2 fix rounds\s*\| 1 of 4/);
  assert.match(text.stdout, /Median start.*merge\s*\| 75 min/);
});

test('metrics --since includes later tasks and calls, retains earlier starts and current open backlog', async (t) => {
  const p = await project(t);
  const r = await cli(['metrics', '--since', DAY], p);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.body.data.period, { since: DAY });
  assert.deepEqual(values(r), [5 / 3, 300, 1550 / 3, 1, 90, 30, 2]);
  assert.equal(r.body.data.rows[3].total, 5);
});

test('metrics: missing transcripts are n/a with reasons; task KPIs remain available', async (t) => {
  const p = await project(t, { transcripts: false });
  const r = await cli(['metrics', '--day', DAY], p);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(values(r), [null, null, null, 1, 75, 20, 2]);
  for (const row of r.body.data.rows.slice(0, 3)) assert.match(row.reason, /transcript/i);
  const text = await cli(['metrics', '--day', DAY], p, false);
  assert.equal((text.stdout.match(/n\/a \(/g) ?? []).length, 3);
});

test('metrics: worker-only transcripts cannot imply zero orchestrator usage; damaged transcripts give reasons', async (t) => {
  const p = await project(t);
  rmSync(join(p.transcripts, slug(p.cwd)), { recursive: true });
  let r = await cli(['metrics', '--day', DAY], p);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(values(r), [null, null, 25, 1, 75, 20, 2]);
  for (const row of r.body.data.rows.slice(0, 2)) assert.match(row.reason, /orchestrator transcript/i);
  writeFileSync(join(p.transcripts, slug(p.worktree), 'broken.jsonl'), '{"usage":broken}\n');
  r = await cli(['metrics', '--day', DAY], p);
  assert.equal(r.code, 0, r.stdout);
  for (const row of r.body.data.rows.slice(0, 3)) {
    assert.equal(row.value, null);
    assert.match(row.reason, /malformed/i);
  }
});

test('metrics: no touched tasks and no timings give n/a, while measured zero fix rounds stays zero', async (t) => {
  const p = await project(t);
  let r = await cli(['metrics', '--day', '2026-11-06'], p);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(values(r), [null, null, null, null, null, null, 2]);
  for (const row of r.body.data.rows.slice(0, 6)) assert.ok(row.reason);
  const taskFile = join(p.state, 'tasks/T-TU-1/task.json');
  const doc = JSON.parse(readFileSync(taskFile, 'utf8'));
  doc.events = doc.events.filter((e) => !['started', 'review'].includes(e.event));
  writeFileSync(taskFile, JSON.stringify(doc));
  rmSync(join(p.state, 'tasks/T-TU-2'), { recursive: true });
  r = await cli(['metrics', '--day', DAY], p);
  assert.deepEqual(values(r), [4, 250, 1100, 0, null, null, 2]);
  assert.equal(r.body.data.rows[3].total, 3);
});

test('metrics: inactive state is unavailable, never a zero backlog', async (t) => {
  const p = await project(t, { active: false, transcripts: false });
  const r = await cli(['metrics', '--day', DAY], p);
  assert.equal(r.code, 0, r.stdout);
  assert.ok(r.body.data.rows.every((row) => row.value === null && row.reason));
  assert.equal(existsSync(p.state), false);
});

test('metrics: default UTC day and strict mutually exclusive date selectors', async (t) => {
  const p = await project(t, { transcripts: false });
  const r = await cli(['metrics'], p);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.body.data.period, { day: new Date().toISOString().slice(0, 10) });
  for (const flags of [['--day', DAY, '--since', DAY], ['--day', '2026-02-30'], ['--since', 'yesterday'], ['--day', '2026-1-04']]) {
    const bad = await cli(['metrics', ...flags], p);
    assert.equal(bad.code, 2, bad.stdout);
    assert.ok(bad.body.errors.length);
  }
});
