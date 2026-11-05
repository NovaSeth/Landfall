// Questions in a loop (T-MG-185, SPC-5, PRI-17): while a loop runs, a question for the user never stops it. The question
// is recorded on its task as `task set <id> blocked --reason "question: <text>"` (the task store: no new store); tick
// lists it under "Open questions" as an informational row and goes on with the other tasks; the PreToolUse hook
// `guard-question` denies AskUserQuestion while a loop runs, and allows it otherwise (no loop, an ended loop, an
// inactive repository, malformed input).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';
import { MALFORMED, hook, lib, loopDoc, names, pluginDir, repo as hookRepo, writeLoop } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const loop = await lib('loop/index.mjs');
const state = await lib('state/index.mjs');
const { HOOKS } = await lib('hooks/registry.mjs');
const { main } = await lib('cli/main.mjs');
const BIN = names.bin;
const T0 = Date.parse('2026-10-15T10:00:00.000Z');
const MIN = 60000;
const at = (min) => new Date(T0 + min * MIN).toISOString();
const ev = (event, min, data = {}) => ({ at: at(min), by: 'TU', event, data });
const task = (id, status, events = []) => ({ schema: state.KINDS.task.version, id, kind: 'task', title: `Task ${id}`, lane: null, owner: 'TU', class: 'standard',
  classHistory: [], status, round: 0, events: [ev('created', 0), ...events], base: null, branch: null });
const table = (tasks) => loop.nextSteps({ tasks, runs: [], handles: ['TU'], me: 'TU', plan: null, lanesOn: false, caps: loop.DEFAULT_CAPS,
  now: T0 + 5 * MIN, bin: BIN, problem: null, dirty: () => [] });

test('tick table: a task blocked on "question: …" is an open-question row with the answer step; the other tasks keep their steps', () => {
  const r = table([
    task('T-TU-1', 'blocked', [ev('blocked', 1, { reason: 'Question: deploy to staging or production?' })]),
    task('T-TU-2', 'new'),
    task('T-TU-3', 'blocked', [ev('blocked', 1, { reason: 'waiting for the API key' })]),
  ]);
  assert.equal(r.outcome, 'action', 'the question does not stop the next task');
  assert.deepEqual(r.steps.map((s) => s.task), ['T-TU-2']);
  assert.deepEqual(r.info.map((i) => [i.task, i.kind]), [['T-TU-1', 'question'], ['T-TU-3', 'blocked']]);
  const q = r.info[0];
  assert.match(q.state, /deploy to staging or production\?/);
  assert.ok(q.step.includes(`${BIN} task set T-TU-1 dispatched`), q.step);
  assert.deepEqual(q.rules, ['SPC-5', 'PRI-17']);
  for (const id of q.rules) assert.ok(loop.TABLE_RULES.includes(id), `${id} is cited by the table`);
});

test('tick table: only an open question left → WAIT (the answer may come), never DONE', () => {
  const r = table([task('T-TU-1', 'blocked', [ev('blocked', 1, { reason: 'question: which region?' })])]);
  assert.equal(r.outcome, 'wait');
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.info.map((i) => i.kind), ['question']);
});

test('F1 (fix round 1): a queued question does not hold the plan: the next independent plan entry becomes the step', () => {
  const plan = { path: 'docs/plans/p.md', entries: [{ ref: 'A', title: 'region' }, { ref: 'B', title: 'docs' }] };
  const questioned = { ...task('T-TU-1', 'blocked', [ev('blocked', 1, { reason: 'question: which region?' })]), title: 'A: region' };
  const r = loop.nextSteps({ tasks: [questioned], runs: [], handles: ['TU'], me: 'TU', plan, lanesOn: false, caps: loop.DEFAULT_CAPS,
    now: T0 + 5 * MIN, bin: BIN, problem: null, dirty: () => [] });
  assert.equal(r.outcome, 'action', JSON.stringify(r));
  assert.deepEqual(r.steps.map((s) => s.task), ['B']);
  assert.deepEqual(r.info.map((i) => [i.task, i.kind]), [['T-TU-1', 'question']]);
  // a plain blocked task still holds the plan, as before
  const blocked = { ...task('T-TU-1', 'blocked', [ev('blocked', 1, { reason: 'waiting for the API key' })]), title: 'A: region' };
  const b = loop.nextSteps({ tasks: [blocked], runs: [], handles: ['TU'], me: 'TU', plan, lanesOn: false, caps: loop.DEFAULT_CAPS,
    now: T0 + 5 * MIN, bin: BIN, problem: null, dirty: () => [] });
  assert.deepEqual(b.steps, []);
});

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

test('tick through the CLI: the question is listed under "Open questions (informational)" with its task', async (t) => {
  const iso = isolatedEnv({ gitConfig: '[user]\n\tname = Test User\n\temail = test@example.com\n', prefix: 'loop-questions-' });
  t.after(iso.cleanup);
  for (const k of [`${names.envPrefix}BILLING`, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete iso.env[k];
  const cwd = join(iso.base, 'repo');
  mkdirSync(cwd);
  git(cwd, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(cwd, iso.env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const p = { cwd, env: iso.env };
  assert.equal((await cli(['init', '--yes'], p)).code, 0);
  assert.equal((await cli(['task', 'new', 'Release notes', '--yes'], p)).code, 0);
  const set = await cli(['task', 'set', 'T-TU-1', 'blocked', '--reason', 'question: publish the notes to the website?', '--yes'], p);
  assert.equal(set.code, 0, set.text);
  const r = await cli(['tick'], p);
  assert.equal(r.code, 3, r.text);
  const at = r.text.indexOf('Open questions (informational');
  assert.ok(at > 0, r.text);
  assert.match(r.text.slice(at), /\| T-TU-1 \| question: publish the notes to the website\? \|/);
  assert.doesNotMatch(r.text, /Blocked \(informational\)/, 'a question is not listed again as blocked');
});

// ---- the AskUserQuestion hook ----

const ask = (f, extra = {}) => hook('guard-question', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Deploy now?', options: [{ label: 'yes' }, { label: 'no' }] }] }, cwd: f.dir, ...extra }, { env: f.env });

test('guard-question is registered for PreToolUse AskUserQuestion, fails open', () => {
  const h = HOOKS.find((x) => x.name === 'guard-question');
  assert.ok(h, 'registered');
  assert.deepEqual([h.event, h.matcher, h.onError], ['PreToolUse', 'AskUserQuestion', 'allow']);
  const json = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(json.hooks.PreToolUse.some((e) => e.matcher === 'AskUserQuestion' && e.hooks[0].args.includes('guard-question')), 'in hooks.json');
});

test('guard-question: a running loop denies AskUserQuestion and names the recording command; no loop or an ended loop allows', (t) => {
  const f = hookRepo(t);
  assert.equal(ask(f).decision, 'allow', 'no loop document: the user is asked as usual');
  writeLoop(f.stateDir, loopDoc(null));
  const v = ask(f);
  assert.equal(v.decision, 'deny');
  assert.ok(v.reason.includes(`${BIN} task set <id> blocked --reason "question:`), v.reason);
  assert.match(v.reason, /next independent task/);
  assert.ok(v.reason.length <= 300, `${v.reason.length} characters`);
  for (const exit of ['DONE', 'STALLED', 'BUDGET']) {
    writeLoop(f.stateDir, loopDoc(exit));
    assert.equal(ask(f).decision, 'allow', `after ${exit}`);
  }
});

test('guard-question: an inactive repository and malformed input allow (GC8)', (t) => {
  const f = hookRepo(t, { active: false });
  assert.equal(ask(f).decision, 'allow');
  for (const input of MALFORMED) assert.equal(hook('guard-question', input, { env: f.env }).decision, 'allow', input);
});

test('the loop skill records questions instead of asking', () => {
  const skill = readFileSync(join(pluginDir, 'skills', 'loop', 'SKILL.md'), 'utf8');
  assert.match(skill, /AskUserQuestion/);
  assert.ok(skill.includes(`${BIN} task set <id> blocked --reason "question: <text>"`), skill);
  assert.match(skill, /PRI-17/);
});
