// Loop (spec §7.7, §5.2, §8.1, SD-17, SC7, GC4, RF3; the successor of the 1.x tick.mjs): `tick` computes the next
// steps from the task state, counts the tick against the caps (wall time, ticks, cost since start from receipts),
// detects a stall (same fingerprint for 3 ticks spanning ≥ 30 min with no live run) and ends the loop with a typed
// exit (ACTION 0, WAIT 3, DONE 4, STALLED 5, BUDGET 6). The terminal exit is written to local/loop.json under the
// store lock before anything is printed; every later tick returns it. `loop start|stop|status` manage the record.
// Every 1.x tick case has an equivalent here; the test names say which (`1.x: …`). The mapping table of all cases is
// in the task report. Pure parts (the tick table, the cap and stall decision) are tested directly; the store path
// with a fake probe (no git); the CLI in a throwaway repository and HOME.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (git run by the code under test too) gets a throwaway HOME and environment (S1).
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
const receipts = await lib('receipts/index.mjs');
const method = await lib('method/index.mjs');
const { main } = await lib('cli/main.mjs');
const { COMMANDS } = await lib('cli/commands.mjs');

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
const MIN = 60000;
const at = (min) => new Date(T0 + min * MIN).toISOString();
const BIN = names.bin;
const CAPS = loop.DEFAULT_CAPS;

// ---- pure tick table ----------------------------------------------------------------------------------------------

const ev = (event, min, data = {}, by = 'TU') => ({ at: at(min), by, event, data });
function task(id, status, { round = 0, cls = 'standard', owner = 'TU', kind = 'task', lane = null, title = `Task ${id}`, events = [] } = {}) {
  return { schema: 1, id, kind, title, lane, owner, class: cls, classHistory: [], status, round, events: [ev('created', 0, {}, owner), ...events], base: null, branch: null };
}
const table = (tasks, opts = {}) => loop.nextSteps({
  tasks, runs: [], handles: ['TU'], me: 'TU', plan: null, lanesOn: false, caps: CAPS, now: T0 + 5 * MIN, bin: BIN, problem: null, dirty: () => [], ...opts,
});
const row = (r, id) => r.steps.find((s) => s.task === id);

test('1.x brief not dispatched → dispatch step (FLW-3, ORC-4); not routed → route step; lanes on → --lane', () => {
  let r = table([task('T-TU-1', 'new')]);
  assert.equal(r.outcome, 'action');
  let s = row(r, 'T-TU-1');
  assert.equal(s.kind, 'action');
  assert.deepEqual(s.rules, ['FLW-3', 'ORC-4']);
  assert.match(s.step, new RegExp(`${BIN} task set T-TU-1 dispatched --executor <executor> --base <sha>`));
  assert.doesNotMatch(s.step, /--lane/, 'lanes off: no lane flag');
  r = table([task('T-TU-1', 'planned')], { lanesOn: true });
  assert.match(row(r, 'T-TU-1').step, /--lane <lane>/, 'lanes on: the dispatch names a lane');
  r = table([task('T-TU-1', 'new', { cls: null })]);
  s = row(r, 'T-TU-1');
  assert.deepEqual(s.rules, ['FLW-3']);
  assert.match(s.step, new RegExp(`${BIN} route T-TU-1 --paths`), 'an unrouted task is classified first (the 1.x router hint)');
});

test('1.x implementer working → WAIT 1800 s; after 20 min without an event → status request (ORC-9); the request resets the age', () => {
  const working = task('T-TU-1', 'dispatched', { events: [ev('dispatched', 0, { executor: 'claude:implementer', base: 'abc1234' })] });
  let r = table([working], { now: T0 + 5 * MIN });
  assert.equal(r.outcome, 'wait');
  assert.equal(r.nextTickS, 1800);
  assert.equal(row(r, 'T-TU-1').kind, 'wait');
  assert.deepEqual(row(r, 'T-TU-1').rules, ['FLW-4']);
  r = table([working], { now: T0 + 45 * MIN });
  assert.equal(r.outcome, 'action');
  const s = row(r, 'T-TU-1');
  assert.deepEqual(s.rules, ['ORC-9']);
  assert.match(s.state, /45 min since its last event/);
  assert.match(s.step, new RegExp(`${BIN} task set T-TU-1 status-request`));
  const asked = { ...working, events: [...working.events, ev('status-request', 40)] };
  assert.equal(table([asked], { now: T0 + 45 * MIN }).outcome, 'wait', 'asked 5 min ago: no second request before the threshold');
  assert.equal(table([asked], { now: T0 + 61 * MIN }).outcome, 'action', 'after the next threshold the request returns');
  const review = task('T-TU-2', 'in-review', { events: [ev('dispatched', 0)] });
  assert.equal(row(table([review]), 'T-TU-2').kind, 'wait', '1.x review in progress → wait');
});

test('1.x report delivered → check it and dispatch the review (FLW-6, PRI-6, ORC-5)', () => {
  const r = table([task('T-TU-1', 'implemented', { events: [ev('implementer', 3, { report: 'done' })] })]);
  const s = row(r, 'T-TU-1');
  assert.equal(s.kind, 'action');
  assert.deepEqual(s.rules, ['FLW-6', 'PRI-6', 'ORC-5']);
  assert.match(s.step, new RegExp(`dispatch the review to another executor and record it: \`${BIN} task set T-TU-1 dispatched --executor <reviewer> --base <sha>\``));
  const recorded = task('T-TU-1', 'dispatched', { events: [ev('implementer', 3, { report: 'done' }), ev('dispatched', 4, { executor: 'codex', base: 'abc1234' })] });
  assert.equal(row(table([recorded]), 'T-TU-1').kind, 'wait', 'the recorded review dispatch is work in progress');
});

test('1.x fix round delivered → scoped re-review (REV-6, REV-20); a round in progress → wait', () => {
  const started = task('T-TU-1', 'fix-round', { round: 1, events: [ev('fix-round', 2, { round: 1, addressed: 0, open: 3 })] });
  assert.equal(row(table([started]), 'T-TU-1').kind, 'wait', 'open findings: the round is under way');
  const delivered = task('T-TU-1', 'fix-round', { round: 1, events: [ev('fix-round', 2, { round: 1, addressed: 0, open: 3 }), ev('fix-round', 4, { round: 1, addressed: 3, open: 0 })] });
  let s = row(table([delivered]), 'T-TU-1');
  assert.equal(s.kind, 'action');
  assert.deepEqual(s.rules, ['REV-6', 'REV-20']);
  assert.match(s.step, new RegExp(`${BIN} task set T-TU-1 self-verified --round 1`));
  assert.match(s.step, new RegExp(`record it: \`${BIN} task set T-TU-1 dispatched --executor <reviewer> --base <sha>\``));
  s = row(table([task('T-TU-1', 'implemented', { round: 1, events: [ev('fix-round', 2, { round: 1, addressed: 0, open: 1 }), ev('implementer', 4, { report: 'done' })] })]), 'T-TU-1');
  assert.deepEqual(s.rules, ['REV-6', 'REV-20'], 'the implementer reporting a round delivers it too');
});

test('1.x self-verified round → approved: verify, merge, close (REV-11, FLW-8); a verified task the same', () => {
  const events = [ev('fix-round', 2, { round: 1, addressed: 1, open: 0 }), ev('self-verified', 3, { round: 1 })];
  let s = row(table([task('T-TU-1', 'fix-round', { round: 1, events })]), 'T-TU-1');
  assert.deepEqual(s.rules, ['REV-11', 'FLW-8']);
  assert.match(s.step, new RegExp(`${BIN} task done T-TU-1`));
  s = row(table([task('T-TU-1', 'verified')]), 'T-TU-1');
  assert.deepEqual(s.rules, ['REV-11', 'FLW-8']);
  // a self-check of round 1 does not approve round 2
  const later = [...events, ev('fix-round', 4, { round: 2, addressed: 0, open: 1 }), ev('fix-round', 5, { round: 2, addressed: 1, open: 0 })];
  s = row(table([task('T-TU-1', 'fix-round', { round: 2, events: later })]), 'T-TU-1');
  assert.ok(s.rules.includes('REV-6'), 'round 2 delivered: a re-review, not approval');
});

test('rounds (1.x breaker after 2 rounds): the second round names the decision; a third round → decide only (REV-7)', () => {
  const round = (k, open) => task('T-TU-1', 'fix-round', { round: k, events: [ev('fix-round', 2, { round: k, addressed: open ? 0 : 1, open })] });
  let s = row(table([round(1, 0)]), 'T-TU-1');
  assert.ok(!s.rules.includes('REV-7'), 'round 1 of 2: no decision yet');
  s = row(table([round(2, 0)]), 'T-TU-1');
  assert.deepEqual(s.rules, ['REV-6', 'REV-20', 'REV-7']);
  assert.match(s.step, /decide/);
  assert.match(s.step, /no fix round 3/);
  s = row(table([round(3, 2)]), 'T-TU-1');
  assert.equal(s.kind, 'action');
  assert.deepEqual(s.rules, ['REV-7']);
  assert.match(s.step, /^decide: escalate to the user or change the approach/);
  assert.match(s.step, /Critical findings are exempt/, '1.x: Critical is not subject to the breaker');
  s = row(table([round(1, 0)], { caps: { ...CAPS, rounds: 1 } }), 'T-TU-1');
  assert.ok(s.rules.includes('REV-7'), 'the rounds cap of the loop decides when');
});

test('1.x report BLOCKED / NEEDS_CONTEXT → resolve it (ORC-7), no review; dispatched again → wait', () => {
  const blocked = task('T-TU-1', 'blocked', { events: [ev('dispatched', 1), ev('implementer', 3, { report: 'needs-context' })] });
  let r = table([blocked]);
  const s = row(r, 'T-TU-1');
  assert.deepEqual(s.rules, ['ORC-7']);
  assert.match(s.state, /needs-context/);
  assert.doesNotMatch(s.step, /dispatch the review/);
  r = table([{ ...blocked, status: 'dispatched', events: [...blocked.events, ev('dispatched', 4)] }]);
  assert.equal(row(r, 'T-TU-1').kind, 'wait');
});

test('1.x blocked → informational and WAIT (never DONE); cancelled → skipped', () => {
  const r = table([
    task('T-TU-1', 'blocked', { events: [ev('blocked', 2, { reason: 'waiting for the API key' })] }),
    task('T-TU-2', 'cancelled', { events: [ev('cancelled', 2, { reason: 'out of scope' })] }),
  ], { now: T0 + 90 * MIN });
  assert.equal(r.outcome, 'wait');
  assert.equal(r.nextTickS, 1800);
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.info.map((i) => [i.task, i.kind]), [['T-TU-1', 'blocked']]);
  assert.match(r.info[0].state, /waiting for the API key/);
});

test('1.x complete → skipped; every task done or cancelled → DONE; an open gate task (kind gate) keeps the loop open', () => {
  assert.equal(table([task('T-TU-1', 'done'), task('T-TU-2', 'cancelled')]).outcome, 'done');
  const gate = task('T-TU-3', 'new', { kind: 'gate', title: 'Area gate: loop' });
  const r = table([task('T-TU-1', 'done'), gate]);
  assert.equal(r.outcome, 'action');
  assert.ok(row(r, 'T-TU-3'), 'the gate task is in scope like any task');
  assert.equal(table([task('T-TU-1', 'done'), { ...gate, status: 'done' }]).outcome, 'done');
});

test('1.x fresh project → START (not DONE): spec and plan first (SPC-1, SPC-2)', () => {
  const r = table([]);
  assert.equal(r.outcome, 'action');
  const s = row(r, 'START');
  assert.deepEqual(s.rules, ['SPC-1', 'SPC-2']);
  assert.match(s.step, new RegExp(`${BIN} task new`));
});

test('1.x plan: the next entry gets its task; entries in code fences are ignored; all closed → DONE; --plan is only a hint while work runs', () => {
  const text = '# Plan\n### Task P1: first\n```\n### Task X9: inside a fence\n```\nbody\n### Task P2: second\n';
  const entries = loop.parsePlan(text);
  assert.deepEqual(entries, [{ ref: 'P1', title: 'first' }, { ref: 'P2', title: 'second' }]);
  const plan = { path: 'docs/plans/plan.md', entries };
  let r = table([task('T-TU-1', 'done', { title: 'P1: first' })], { plan });
  assert.equal(r.outcome, 'action');
  const s = row(r, 'P2');
  assert.deepEqual(s.rules, ['SPC-11', 'FLW-9']);
  assert.match(s.step, new RegExp(`${BIN} task new "P2: second"`));
  assert.match(s.state, /docs\/plans\/plan\.md/);
  assert.equal(table([task('T-TU-1', 'done', { title: 'P1: first' }), task('T-TU-2', 'cancelled', { title: 'P2 second' })], { plan }).outcome, 'done');
  assert.equal(table([task('T-TU-1', 'done', { title: 'P10: other' })], { plan: { ...plan, entries: entries.slice(0, 1) } }).outcome, 'action', 'P10 is not P1');
  // own work in progress: the next entry is information, not an action
  r = table([task('T-TU-1', 'dispatched', { title: 'P1: first', events: [ev('dispatched', 3)] })], { plan });
  assert.equal(r.outcome, 'wait');
  assert.deepEqual(r.info.map((i) => [i.task, i.kind]), [['P2', 'plan']]);
  // a plan without entries is reported, never DONE
  r = table([], { plan: { path: 'docs/plans/empty.md', entries: [] } });
  assert.equal(r.outcome, 'action');
  assert.deepEqual(r.steps[0].rules, ['SPC-11']);
});

test('1.x background runs (finding 6: the 1.x prerequisite, every task closed): live → WAIT 600 s, never DONE; finished after its task\'s last event → collect it (FLW-6) before DONE; recorded → gone; an open task\'s live run is its row', () => {
  // 1.x: the plan's tasks complete and the gate done; here the task is done
  const closed = task('T-TU-1', 'done', { events: [ev('dispatched', 1), ev('done', 3)] });
  const run = { runId: 'fake-T-TU-1-reviewer-1', task: 'T-TU-1', status: 'running', startedAt: at(2), endedAt: null, exit: null };
  let r = table([closed], { runs: [run] });
  assert.equal(r.outcome, 'wait', 'a live run keeps the loop waiting, its task closed or not');
  assert.equal(r.nextTickS, 600);
  assert.equal(r.liveRuns, 1);
  assert.deepEqual(r.steps.map((s) => [s.task, s.kind]), [[run.runId, 'wait']]);
  const ended = { ...run, status: 'failed', endedAt: at(4), exit: 1 };
  r = table([closed], { runs: [ended] });
  assert.equal(r.outcome, 'action', 'a finished, uncollected run is collected before DONE');
  assert.equal(r.liveRuns, 0);
  let s = row(r, run.runId);
  assert.deepEqual(s.rules, ['FLW-6']);
  assert.match(s.state, /failed, exit 1/);
  assert.ok(s.step.includes(`${BIN} task new "${run.runId}: `), s.step);
  assert.equal(table([closed], { runs: [{ ...ended, status: 'done', exit: 0 }] }).outcome, 'action', 'a run done after its task closed: the same');
  // recorded: a closed task takes no further state, so a task named after the run records it
  const follow = task('T-TU-2', 'new', { title: `${run.runId}: findings after the merge` });
  assert.equal(row(table([closed, follow], { runs: [ended] }), run.runId), undefined, 'collected');
  assert.equal(table([closed, { ...follow, status: 'cancelled' }], { runs: [ended] }).outcome, 'done');
  assert.equal(table([closed], { runs: [{ ...ended, endedAt: at(2) }] }).outcome, 'done', 'a run that ended before its task closed was collected with it');
  // an open task: its live run is its work in progress; a later event of the task records the result
  const t = task('T-TU-1', 'in-review', { events: [ev('dispatched', 1)] });
  r = table([t], { runs: [run] });
  assert.equal(r.outcome, 'wait');
  assert.deepEqual(r.steps.map((x) => [x.task, x.kind]), [['T-TU-1', 'wait']], 'the live run is folded into its task\'s row');
  assert.match(row(r, 'T-TU-1').state, /fake-T-TU-1-reviewer-1 running/);
  const reviewing = table([task('T-TU-1', 'implemented', { events: [ev('implementer', 1, { report: 'done' })] })], { runs: [run] });
  assert.equal(row(reviewing, 'T-TU-1').kind, 'wait', 'a review run is live: no second "dispatch the review"');
  assert.equal(reviewing.outcome, 'wait');
  s = row(table([t], { runs: [ended] }), run.runId);
  assert.deepEqual(s.rules, ['FLW-6']);
  assert.match(s.step, /record T-TU-1's state/);
  r = table([{ ...t, events: [...t.events, ev('status-request', 5)] }], { runs: [ended] });
  assert.equal(row(r, run.runId), undefined, 'an event after the run ended: collected');
});

test('1.x team: actions only for my (or unowned) tasks; others\' tasks informational and WAIT; no handle → register it', () => {
  const mine = task('T-TU-1', 'new');
  const theirs = task('T-AB-1', 'dispatched', { owner: 'AB', lane: 'api', events: [ev('dispatched', -90, {}, 'AB')] });
  let r = table([mine, theirs], { handles: ['AB', 'TU'], now: T0 + 60 * MIN });
  assert.deepEqual(r.steps.map((s) => s.task), ['T-TU-1']);
  assert.deepEqual(r.info.map((i) => [i.task, i.kind]), [['T-AB-1', 'others']]);
  assert.match(r.info[0].state, /AB: dispatched/);
  assert.match(r.info[0].state, /lane api/);
  r = table([theirs], { handles: ['AB', 'TU'], now: T0 + 60 * MIN });
  assert.equal(r.outcome, 'wait', 'others\' work in progress: wait, not DONE, never a status request to their agent');
  r = table([mine, theirs], { handles: ['AB', 'TU'], me: null });
  assert.deepEqual(r.steps.map((s) => s.task), ['-'], 'no handle: every task belongs to someone else');
  assert.match(r.steps[0].step, new RegExp(`${BIN} init`));
  r = table([theirs], { handles: ['TU'], now: T0 + 60 * MIN });
  assert.equal(row(r, 'T-AB-1').kind, 'action', 'solo (one handle): the task of an unregistered owner is unowned, so mine');
});

test('1.x uncommitted process records before DONE → commit step (PRI-1; team COL-24); not checked while work remains', () => {
  let asked = 0;
  const dirty = () => { asked++; return ['.state/tasks/T-TU-1/task.json', '.state/decisions/D-TU-1.md']; };
  let r = table([task('T-TU-1', 'done')], { dirty });
  assert.equal(r.outcome, 'action');
  assert.deepEqual(r.steps[0].rules, ['PRI-1']);
  assert.match(r.steps[0].state, /2 \(.*task\.json/);
  r = table([task('T-TU-1', 'done')], { dirty, handles: ['AB', 'TU'] });
  assert.deepEqual(r.steps[0].rules, ['COL-24']);
  asked = 0;
  table([task('T-TU-1', 'new')], { dirty });
  assert.equal(asked, 0, 'git status runs only when the loop would otherwise end');
});

test('a task state that cannot be read → one repair step (FLW-7), never START or DONE', () => {
  const r = table([], { problem: { message: '/x/tasks/T-TU-1/task.json is invalid: not valid JSON', hint: 'fix or restore the file' } });
  assert.equal(r.outcome, 'action');
  assert.deepEqual(r.steps.map((s) => [s.task, s.rules]), [['-', ['FLW-7']]]);
});

test('every rule ID the tick table cites resolves in the method (1.x: rule IDs in tick.mjs exist)', () => {
  const m = method.openMethod();
  assert.ok(loop.TABLE_RULES.length >= 15);
  for (const id of loop.TABLE_RULES) assert.ok(method.getRule(m, id), `${id} is a method rule`);
  const src = readdirSync(join(pluginDir, 'lib', 'loop')).map((f) => readFileSync(join(pluginDir, 'lib', 'loop', f), 'utf8')).join('\n');
  const cited = new Set([...src.matchAll(/'([A-Z]{3}-\d+)'/g)].map((x) => x[1]));
  for (const id of cited) assert.ok(loop.TABLE_RULES.includes(id), `${id} is listed in TABLE_RULES`);
});

test('every command a step cites is a command row, or a spec §8.2 command of a unit not merged yet (none left)', () => {
  const PENDING = [];
  const src = readdirSync(join(pluginDir, 'lib', 'loop')).map((f) => readFileSync(join(pluginDir, 'lib', 'loop', f), 'utf8')).join('\n');
  const cited = [...new Set([...src.matchAll(/\$\{(?:names\.)?bin\} ([a-z]+(?: [a-z]+)?)/g)].map((m) => m[1]))].sort();
  assert.ok(cited.length >= 8, cited.join(', '));
  const rows = new Set(COMMANDS.map((c) => c.name));
  for (const c of cited) assert.ok(rows.has(c) || PENDING.includes(c), `${c}: no such command`);
});

// ---- pure loop decision: caps, stall, typed exits (SC7) ------------------------------------------------------------

const fresh = (caps = {}) => loop.newLoop({ now: T0, caps: { ...CAPS, ...caps } });
const obs = (o = {}) => ({ now: T0 + MIN, fingerprint: 'a'.repeat(64), costMicroUsd: 0, liveRuns: 0, outcome: 'action', nextTickS: null, ...o });

test('a new loop: default caps 8 h / 200 ticks / $25 / 2 rounds (SD-17), integer micro-dollars (R70), no exit', () => {
  assert.deepEqual(CAPS, { wallMin: 480, ticks: 200, costMicroUsd: 25000000, rounds: 2 });
  const l = fresh();
  assert.equal(l.startedAt, at(0));
  assert.deepEqual([l.ticks, l.sameCount, l.exit, l.exitAt, l.fingerprint], [0, 0, null, null, null]);
  assert.deepEqual(l.caps, CAPS);
  assert.deepEqual(l.extensions, []);
  assert.deepEqual(state.check(loop.LOOP, l), [], 'a valid loop document');
});

test('SC7 caps: wall time, ticks and cost each end the loop with BUDGET (6), before every other exit', () => {
  let d = loop.decide(fresh(), obs({ now: T0 + 480 * MIN, outcome: 'done' }));
  assert.equal(d.result, 'BUDGET');
  assert.match(d.reason, /wall time/);
  assert.equal(loop.decide(fresh(), obs({ now: T0 + 479 * MIN })).result, 'ACTION', 'under the wall cap');
  d = loop.decide({ ...fresh({ ticks: 5 }), ticks: 4 }, obs());
  assert.equal(d.result, 'BUDGET');
  assert.equal(d.doc.ticks, 5);
  assert.match(d.reason, /tick cap/);
  assert.equal(loop.decide({ ...fresh({ ticks: 5 }), ticks: 3 }, obs()).result, 'ACTION', 'tick 4 of 5');
  d = loop.decide(fresh({ costMicroUsd: 1000 }), obs({ costMicroUsd: 1000, outcome: 'wait', nextTickS: 600 }));
  assert.equal(d.result, 'BUDGET');
  assert.match(d.reason, /cost/);
  assert.equal(d.doc.costMicroUsd, 1000);
  assert.equal(loop.decide(fresh({ costMicroUsd: 1000 }), obs({ costMicroUsd: 999 })).result, 'ACTION', 'under the cost cap');
  assert.equal(d.doc.exit, 'BUDGET');
  assert.equal(d.doc.exitAt, at(1));
  assert.equal(d.nextTickS, null, 'a terminal exit schedules nothing');
});

test('SC7 stall: 3 unchanged ticks spanning ≥ 30 min with no live run → STALLED (5); a change resets; a live run holds it', () => {
  const F = 'f'.repeat(64);
  const G = '9'.repeat(64);
  let l = fresh();
  const step = (min, o = {}) => { const d = loop.decide(l, obs({ now: T0 + min * MIN, fingerprint: F, outcome: 'wait', nextTickS: 1800, ...o })); l = d.doc; return d; };
  assert.equal(step(0).result, 'WAIT');
  assert.deepEqual([l.sameCount, l.sameSince], [0, at(0)]);
  assert.equal(step(10).result, 'WAIT');
  assert.equal(step(20).result, 'WAIT');
  assert.equal(l.sameCount, 2);
  assert.equal(step(29).result, 'WAIT', '3 unchanged ticks but only 29 min: not yet');
  assert.equal(l.sameCount, 3);
  assert.equal(step(31, { liveRuns: 1 }).result, 'WAIT', 'a live run holds the stall');
  const d = step(32);
  assert.equal(d.result, 'STALLED');
  assert.match(d.reason, /32 min/);
  assert.equal(l.exit, 'STALLED');
  // a change resets the count and the window
  l = fresh();
  step(0); step(10); step(20);
  step(25, { fingerprint: G });
  assert.deepEqual([l.sameCount, l.sameSince], [0, at(25)]);
  step(40, { fingerprint: G }); step(50, { fingerprint: G });
  assert.equal(step(54, { fingerprint: G }).result, 'WAIT', '3 unchanged ticks after the change, 29 min since it');
  assert.equal(step(56, { fingerprint: G }).result, 'STALLED', '31 min since the change');
  // the count matters on its own: 2 unchanged ticks over hours are no stall
  l = fresh();
  step(0); step(60); step(120);
  assert.equal(l.sameCount, 2);
  assert.equal(l.exit, null, '2 unchanged ticks over 120 min: not yet');
  assert.equal(step(121).result, 'STALLED');
});

test('typed exits: DONE (4), WAIT (3) with NEXT_TICK, ACTION (0); a recorded exit is returned unchanged (idempotent)', () => {
  let d = loop.decide(fresh(), obs({ outcome: 'wait', nextTickS: 600 }));
  assert.deepEqual([d.result, d.nextTickS, d.doc.ticks, d.doc.exit], ['WAIT', 600, 1, null]);
  d = loop.decide(fresh(), obs({ outcome: 'action' }));
  assert.deepEqual([d.result, d.nextTickS, d.doc.exit], ['ACTION', null, null]);
  d = loop.decide(fresh(), obs({ outcome: 'done' }));
  assert.deepEqual([d.result, d.doc.exit, d.doc.exitAt, d.nextTickS], ['DONE', 'DONE', at(1), null]);
  const again = loop.decide(d.doc, obs({ now: T0 + 999 * MIN, outcome: 'action', costMicroUsd: 1e12 }));
  assert.equal(again.result, 'DONE');
  assert.equal(again.repeated, true);
  assert.equal(again.doc, d.doc, 'nothing changes after the exit');
});

test('caps parse from k=v lists (usd in dollars → whole micro-dollars); bad keys and values are usage errors', () => {
  assert.deepEqual(loop.parseCaps('wallMin=60,ticks=20,usd=1.5,rounds=1'), { wallMin: 60, ticks: 20, costMicroUsd: 1500000, rounds: 1 });
  assert.deepEqual(loop.parseCaps('usd=0.000001'), { costMicroUsd: 1 });
  for (const bad of ['', 'ticks', 'ticks=0', 'ticks=-1', 'ticks=1.5', 'usd=1e3', 'usd=0.0000001', 'speed=3', 'ticks=1,ticks=2', 'wallMin=99999']) {
    assert.throws(() => loop.parseCaps(bad), (e) => e.exit === 'USAGE', bad);
  }
});

// ---- the store path (real store, fake probe: no git) --------------------------------------------------------------

function storeDir(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'loop-store-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'state');
  const where = { repo: base, dir, local: join(dir, 'local'), active: true, linked: false };
  const store = state.open(dir, { names, kinds: loop.STORE_KINDS });
  store.write('state', null, { codename: names.codename, createdWith: '1.5.2', activatedAt: at(0), flags: {} });
  store.write('team', 'TU', { handle: 'TU', emailSha256: state.emailHash('test@example.com'), addedAt: at(0) });
  const probe = { heads: () => 'main 1111111', email: () => 'test@example.com', cost: () => ({ costMicroUsd: 0, partial: false }), dirty: () => [] };
  const run = (now, extra = {}) => loop.tickStore(store, { where, names, now: T0 + now * MIN, plan: null, probe: { ...probe, ...extra } });
  return { dir, where, store, run, file: join(dir, 'local', 'loop.json') };
}

test('the first tick starts the loop with the default caps; the exit is on disk before the result returns (hooks reader contract)', (t) => {
  const s = storeDir(t);
  s.store.write('task', 'T-TU-1', task('T-TU-1', 'cancelled'));
  const r = s.run(0);
  assert.equal(r.result, 'DONE');
  assert.equal(r.repeated, false);
  const st = lstatSync(s.file);
  assert.ok(st.isFile() && !st.isSymbolicLink(), 'a regular file');
  assert.ok(st.size < 65536, 'within the reader limit');
  const doc = JSON.parse(readFileSync(s.file, 'utf8'));
  assert.ok(doc && typeof doc === 'object' && !Array.isArray(doc));
  assert.equal(doc.exit, 'DONE', 'field exit: DONE | STALLED | BUDGET');
  assert.equal(doc.ticks, 1);
  assert.deepEqual(doc.caps, CAPS);
  const bytes = readFileSync(s.file, 'utf8');
  const again = s.run(500);
  assert.deepEqual([again.result, again.repeated, again.nextTickS], ['DONE', true, null]);
  assert.equal(readFileSync(s.file, 'utf8'), bytes, 'a repeated exit writes nothing');
});

test('SC7 BUDGET at the cost cap: the cost since the loop start comes from receipts (costSince)', (t) => {
  const s = storeDir(t);
  s.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  const seen = [];
  const cost = (startedAt) => { seen.push(startedAt); return { costMicroUsd: 25000000, partial: false }; };
  assert.equal(s.run(0, { cost }).result, 'ACTION', 'the first tick starts the loop: nothing spent yet');
  assert.deepEqual(seen, [], 'a loop started by this tick reads no transcripts');
  const r = s.run(5, { cost });
  assert.equal(r.result, 'BUDGET');
  assert.match(r.reason, /cost/);
  assert.deepEqual(seen, [at(0)], 'measured since the loop started');
  assert.equal(s.run(6, { cost }).result, 'BUDGET', 'caps never auto-extend');
});

test('SC7 stall end to end: an unchanged state over 3 ticks and ≥ 30 min → STALLED with the open steps; caps bound a tick that cannot read the tasks (GC4)', (t) => {
  const s = storeDir(t);
  s.store.write('task', 'T-TU-1', task('T-TU-1', 'blocked', { events: [ev('blocked', 0, { reason: 'waiting for a key' })] }));
  const results = [0, 30, 60, 90].map((m) => s.run(m).result);
  assert.deepEqual(results, ['WAIT', 'WAIT', 'WAIT', 'STALLED']);
  const r = s.run(91);
  assert.equal(r.repeated, true);
  assert.match(r.reason, /no progress/);
  const t2 = storeDir(t);
  mkdirSync(join(t2.dir, 'tasks', 'T-TU-1'), { recursive: true });
  writeFileSync(join(t2.dir, 'tasks', 'T-TU-1', 'task.json'), '{ not json');
  const first = t2.run(0);
  assert.equal(first.result, 'ACTION');
  assert.deepEqual(first.steps.map((x) => x.rules), [['FLW-7']]);
  assert.deepEqual([0, 10, 20, 40].map((m) => t2.run(m).result).slice(-1), ['STALLED'], 'the unreadable state still counts and stalls');
});

// ---- receipts: cost since a time (R70) ----------------------------------------------------------------------------

const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
async function cli(args, { cwd, env, tty = false }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, out: JSON.parse(out.join('')), stderr: err.join('') };
}
async function cliText(args, { cwd, env }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(args, { io });
  return { code, text: out.join(''), stderr: err.join('') };
}
const show = (r) => JSON.stringify(r.out ?? r);

async function repo(t, { activate = true } = {}) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'loop-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, iso.env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const r = { cwd: dir, env: iso.env, store: join(dir, names.stateDir) };
  // as in a Claude Code session: the repository has a transcript directory, so its cost is measurable (zero here)
  r.transcripts = join(iso.env.CLAUDE_CONFIG_DIR, 'projects', realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(r.transcripts, { recursive: true });
  r.run = (args, opts = {}) => cli([...args, '--yes'], { ...r, ...opts });
  r.loopFile = join(r.store, 'local', 'loop.json');
  if (activate) assert.equal((await r.run(['init'])).code, 0);
  return r;
}

const line = (requestId, ts, usage) => JSON.stringify({
  type: 'assistant', sessionId: 's', version: '2.1.300', timestamp: ts, requestId,
  message: { id: `msg_${requestId}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'SYNTH' }], usage },
});

test('receipts costSince: requests and runs at or after the start, priced in whole micro-dollars; earlier ones left out', async (t) => {
  const p = await repo(t);
  const dir = join(p.env.CLAUDE_CONFIG_DIR, 'projects', realpathSync(p.cwd).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  // Opus 5.5: input 4, output 20 µ$ per token. Before the start: 1000 input = 4000 µ$ (left out); after: 10·4 + 100·20 = 2040.
  writeFileSync(join(dir, 'a.jsonl'), [
    line('req_before', '2026-10-15T09:59:59.000Z', { input_tokens: 1000, output_tokens: 0 }),
    line('req_after', '2026-10-15T10:00:00.000Z', { input_tokens: 10, output_tokens: 100 }),
  ].join('\n') + '\n');
  const runs = join(p.store, 'local', 'runs');
  mkdirSync(runs, { recursive: true });
  const runDoc = (id, startedAt, cost) => JSON.stringify({ schema: 1, runId: id, task: 'T-TU-1', role: 'reviewer', provider: 'fake', model: null, status: 'done', startedAt, endedAt: startedAt, tokens: null, costMicroUsd: cost, exit: 0 });
  writeFileSync(join(runs, 'fake-T-TU-1-reviewer-1.json'), runDoc('fake-T-TU-1-reviewer-1', '2026-10-15T09:00:00.000Z', 70000));
  writeFileSync(join(runs, 'fake-T-TU-1-reviewer-2.json'), runDoc('fake-T-TU-1-reviewer-2', '2026-10-15T10:30:00.000Z', 50000));
  const c = receipts.costSince(at(0), { cwd: p.cwd, env: p.env, names });
  assert.equal(c.costMicroUsd, 2040 + 50000);
  assert.ok(Number.isSafeInteger(c.costMicroUsd));
  assert.equal(c.partial, false);
  assert.equal(receipts.costSince(at(60), { cwd: p.cwd, env: p.env, names }).costMicroUsd, 0);
  assert.throws(() => receipts.costSince('yesterday', { cwd: p.cwd, env: p.env, names }), TypeError);
});

// ---- the CLI ------------------------------------------------------------------------------------------------------

test('the fixed wakeup prompt: "Run `<bin> tick` and do the listed steps." (hooks contract)', () => {
  assert.equal(loop.fixedPrompt(names), `Run \`${BIN} tick\` and do the listed steps.`);
});

test('tick through the CLI: START → ACTION 0; dispatched → WAIT 3 with NEXT_TICK and the fixed prompt; closed and committed → DONE 4, then always DONE', async (t) => {
  const p = await repo(t);
  let r = await p.run(['tick']);
  assert.equal(r.code, 0, show(r));
  assert.deepEqual([r.out.exit, r.out.data.result], ['OK', 'ACTION']);
  assert.equal(r.out.data.steps[0].task, 'START');
  assert.equal(r.out.data.loop.ticks, 1);
  assert.equal((await p.run(['task', 'new', 'Loop work'])).code, 0);
  assert.equal((await p.run(['task', 'set', 'T-TU-1', 'dispatched', '--executor', 'claude:implementer', '--base', 'abc1234'])).code, 0);
  r = await p.run(['tick']);
  assert.equal(r.code, 3, show(r));
  assert.deepEqual([r.out.exit, r.out.data.result, r.out.data.nextTickS], ['WAIT', 'WAIT', 1800]);
  const text = await cliText(['tick'], p);
  assert.equal(text.code, 3);
  assert.match(text.text, /^TICK .* — WAIT/m);
  assert.match(text.text, /\| T-TU-1 \| executor working/);
  assert.ok(text.text.includes(`NEXT_TICK: 1800s`), text.text);
  assert.ok(text.text.includes(loop.fixedPrompt(names)), 'the wakeup is scheduled with the fixed prompt');
  assert.equal((await p.run(['task', 'set', 'T-TU-1', 'cancelled', '--reason', 'out of scope'])).code, 0);
  r = await p.run(['tick']);
  assert.equal(r.code, 0, '1.x T6: uncommitted state → commit step instead of DONE');
  assert.deepEqual(r.out.data.steps.map((s) => s.rules), [['PRI-1']]);
  git(p.cwd, p.env, ['add', '-A']);
  git(p.cwd, p.env, ['commit', '-q', '-m', 'state']);
  r = await p.run(['tick']);
  assert.equal(r.code, 4, show(r));
  assert.deepEqual([r.out.exit, r.out.data.result, r.out.data.nextTickS], ['DONE', 'DONE', null]);
  assert.equal(JSON.parse(readFileSync(p.loopFile, 'utf8')).exit, 'DONE');
  const done = await cliText(['tick'], p);
  assert.equal(done.code, 4);
  assert.match(done.text, /NEXT_TICK: none/);
  assert.doesNotMatch(done.text, /NEXT_TICK: \d/, 'never a reschedule step after the exit');
  assert.ok(!done.text.includes(loop.fixedPrompt(names)), 'no wakeup prompt after the exit');
  assert.equal((await p.run(['task', 'new', 'Late work'])).code, 0);
  r = await p.run(['tick']);
  assert.deepEqual([r.code, r.out.data.repeated], [4, true], 'new work after DONE needs a new loop');
});

test('1.x rule reminder: the text lists the rules of this tick\'s action steps only; --json carries them', async (t) => {
  const p = await repo(t);
  assert.equal((await p.run(['task', 'new', 'Loop work'])).code, 0);
  const text = (await cliText(['tick'], p)).text;
  assert.match(text, /Rules for this tick's steps:/);
  assert.match(text, /^FLW-3\. /m);
  assert.doesNotMatch(text, /^COD-\d+\. /m);
  const r = await p.run(['tick']);
  assert.ok(r.out.data.rules.some((x) => x.id === 'FLW-3' && x.text.length > 20));
});

test('tick --plan: relative to the repository root or absolute; a missing plan → USAGE 2; an inactive repository → REFUSED 7, nothing written', async (t) => {
  const p = await repo(t);
  mkdirSync(join(p.cwd, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(p.cwd, 'docs', 'plans', 'x.md'), '### Task Q1: first\n');
  let r = await p.run(['tick', '--plan', 'docs/plans/x.md']);
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.steps[0].task, 'Q1');
  r = await p.run(['tick', '--plan', join(p.cwd, 'docs', 'plans', 'x.md')]);
  assert.equal(r.out.data.steps[0].task, 'Q1');
  r = await p.run(['tick', '--plan', '/no/such/plan.md']);
  assert.equal(r.code, 2, show(r));
  assert.equal(r.out.errors[0].code, 'plan-missing');
  r = await p.run(['tick', '--bogus']);
  assert.equal(r.code, 2);
  r = await p.run(['tick', 'extra']);
  assert.equal(r.code, 2);
  const q = await repo(t, { activate: false });
  r = await q.run(['tick']);
  assert.equal(r.code, 7, show(r));
  assert.ok(!existsSync(q.store), 'zero footprint in an inactive repository (GC2)');
});

test('tick --plan: the wakeup prompt and the next tick command carry a docs/plans/*.md plan; a plan elsewhere is not carried and a warning says so', async (t) => {
  const p = await repo(t);
  mkdirSync(join(p.cwd, 'docs', 'plans'), { recursive: true });
  const plan = join(p.cwd, 'docs', 'plans', 'x.md');
  writeFileSync(plan, '### Task Q1: first\n### Task Q2: second\n');
  let r = await cliText(['tick', '--plan', 'docs/plans/x.md'], p);
  assert.equal(r.code, 0, r.text);
  assert.ok(r.text.includes(`then run \`${BIN} tick --plan docs/plans/x.md\` again`), r.text);
  assert.equal((await p.run(['task', 'new', 'Q1: first'])).code, 0);
  assert.equal((await p.run(['task', 'set', 'T-TU-1', 'dispatched', '--executor', 'claude:implementer', '--base', 'abc1234'])).code, 0);
  r = await cliText(['tick', '--plan', plan], p);
  assert.equal(r.code, 3, r.text);
  assert.ok(r.text.includes(`with the fixed prompt: Run \`${BIN} tick --plan docs/plans/x.md\` and do the listed steps.`), r.text);
  assert.equal(r.stderr, '');
  assert.equal(loop.fixedPrompt(names, 'docs/plans/x.md'), `Run \`${BIN} tick --plan docs/plans/x.md\` and do the listed steps.`);
  mkdirSync(join(p.cwd, 'plans'));
  for (const elsewhere of ['plans/y.md', 'docs/plans/a b.md']) {
    writeFileSync(join(p.cwd, elsewhere), '### Task Q1: first\n');
    r = await cliText(['tick', '--plan', elsewhere], p);
    assert.equal(r.code, 3, r.text);
    assert.ok(r.text.includes(`with the fixed prompt: ${loop.fixedPrompt(names)}`), `${elsewhere}: the bare fixed prompt`);
    assert.ok(r.stderr.includes(`${elsewhere} is not carried by the wakeup prompt`), r.stderr);
  }
});

test('loop start / status / stop: caps from flags; raising a cap or a new loop after BUDGET or STALLED is the user\'s (terminal); stop ends with DONE', async (t) => {
  const p = await repo(t);
  let r = await p.run(['loop', 'status']);
  assert.equal(r.code, 0);
  assert.equal(r.out.data.loop, null);
  r = await p.run(['loop', 'start', '--caps', 'ticks=2,usd=1']);
  assert.equal(r.code, 0, show(r));
  assert.deepEqual(r.out.data.loop.caps, { ...CAPS, ticks: 2, costMicroUsd: 1000000 });
  r = await p.run(['loop', 'start']);
  assert.equal(r.code, 1, 'a running loop is not replaced');
  assert.equal(r.out.errors[0].code, 'loop-running');
  assert.equal((await p.run(['tick'])).code, 0);
  r = await p.run(['tick']);
  assert.equal(r.code, 6, show(r));
  r = await p.run(['loop', 'start']);
  assert.equal(r.code, 7, 'after BUDGET a new loop needs the user (a terminal)');
  assert.equal(r.out.errors[0].code, 'user-decision');
  assert.equal(JSON.parse(readFileSync(p.loopFile, 'utf8')).exit, 'BUDGET', 'the refused start changed nothing');
  r = await p.run(['loop', 'start'], { tty: true });
  assert.equal(r.code, 0, show(r));
  r = await p.run(['loop', 'stop']);
  assert.equal(r.code, 0);
  assert.equal(r.out.data.stopped, true);
  const doc = JSON.parse(readFileSync(p.loopFile, 'utf8'));
  assert.equal(doc.exit, 'DONE');
  assert.match(doc.reason, /stop/);
  assert.equal((await p.run(['tick'])).code, 4, 'a stopped loop never ticks again');
  r = await p.run(['loop', 'start', '--caps', 'ticks=500']);
  assert.equal(r.code, 7, 'raising a cap above its default is the user\'s decision');
  r = await p.run(['loop', 'start', '--caps', 'ticks=500'], { tty: true });
  assert.equal(r.code, 0, show(r));
  r = await p.run(['loop', 'status']);
  assert.equal(r.out.data.loop.caps.ticks, 500);
  r = await p.run(['loop', 'start', '--caps', 'speed=3']);
  assert.equal(r.code, 2);
});

test('SC7 stall through the CLI: the fingerprint holds while nothing changes; a commit, a worktree HEAD, a task event or a run status resets it; the window → STALLED (5) with the open steps', async (t) => {
  const p = await repo(t);
  assert.equal((await p.run(['task', 'new', 'Loop work'])).code, 0);
  assert.equal((await p.run(['task', 'set', 'T-TU-1', 'dispatched', '--executor', 'claude:implementer', '--base', 'abc1234'])).code, 0);
  const same = async () => {
    const r = await p.run(['tick']);
    assert.ok([0, 3].includes(r.code), show(r));
    return r.out.data.loop.sameCount;
  };
  assert.equal(await same(), 0, 'the first tick records the fingerprint');
  assert.equal(await same(), 1, 'nothing changed: the same fingerprint');
  git(p.cwd, p.env, ['commit', '-q', '--allow-empty', '-m', 'progress']);
  assert.equal(await same(), 0, 'a commit on a branch resets it');
  const tree = join(dirname(p.cwd), 'tree');
  git(p.cwd, p.env, ['worktree', 'add', '-q', '--detach', tree]);
  assert.equal(await same(), 0, 'a new worktree resets it');
  assert.equal(await same(), 1);
  git(tree, p.env, ['commit', '-q', '--allow-empty', '-m', 'detached work']);
  assert.equal(await same(), 0, 'a commit on a detached worktree HEAD resets it');
  assert.equal(await same(), 1);
  assert.equal((await p.run(['task', 'set', 'T-TU-1', 'status-request'])).code, 0);
  assert.equal(await same(), 0, 'a task event (a file under tasks/) resets it');
  assert.equal(await same(), 1);
  const runs = join(p.store, 'local', 'runs');
  mkdirSync(runs, { recursive: true });
  const runFile = join(runs, 'fake-T-TU-1-reviewer-1.json');
  const runDoc = (status) => JSON.stringify({ schema: 1, runId: 'fake-T-TU-1-reviewer-1', task: 'T-TU-1', role: 'reviewer', provider: 'fake', model: null, status,
    startedAt: new Date().toISOString(), endedAt: status === 'running' ? null : new Date().toISOString(), tokens: null, costMicroUsd: 0, exit: status === 'running' ? null : 0 });
  writeFileSync(runFile, runDoc('running'));
  assert.equal(await same(), 0, 'a new run resets it');
  writeFileSync(runFile, runDoc('done'));
  assert.equal(await same(), 0, 'a run status change resets it');
  assert.equal(await same(), 1);
  // the stall window: as if the same state had been seen for 3 ticks over 31 min
  state.open(p.store, { names, kinds: loop.STORE_KINDS }).update('loop', null, (cur) => ({ ...cur, sameCount: 3, sameSince: new Date(Date.now() - 31 * MIN).toISOString() }));
  const text = await cliText(['tick'], p);
  assert.equal(text.code, 5, text.text);
  assert.match(text.text, /^TICK .* — STALLED/m);
  assert.match(text.text, /The loop ended \(STALLED\): no progress/);
  assert.match(text.text, /^\| left open \| state \| next step \| rules \|$/m, 'the report lists the steps left open');
  assert.match(text.text, /^\| T-TU-1 \| /m);
  assert.match(text.text, /NEXT_TICK: none/);
  assert.ok(!text.text.includes(loop.fixedPrompt(names)), 'no wakeup prompt after the exit');
  assert.equal(JSON.parse(readFileSync(p.loopFile, 'utf8')).exit, 'STALLED');
  const r = await p.run(['tick']);
  assert.equal(r.code, 5, show(r));
  assert.deepEqual([r.out.exit, r.out.data.result, r.out.data.repeated, r.out.data.nextTickS], ['STALLED', 'STALLED', true, null]);
});

test('SC7 BUDGET through the CLI: the cost cap counts the transcripts\' requests since the loop started (receipts costSince)', async (t) => {
  const p = await repo(t);
  let r = await p.run(['loop', 'start', '--caps', 'usd=0.01']);
  assert.equal(r.code, 0, show(r));
  const { startedAt } = r.out.data.loop;
  const dir = join(p.env.CLAUDE_CONFIG_DIR, 'projects', realpathSync(p.cwd).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'a.jsonl');
  // Opus 5.5: 4 µ$ per input token. Before the start 10,000 tokens (left out); after it 500 (2,000 µ$), then 2,000 more (8,000 µ$).
  const before = new Date(Date.parse(startedAt) - 1000).toISOString();
  writeFileSync(file, `${line('req_old', before, { input_tokens: 10000, output_tokens: 0 })}\n${line('req_1', startedAt, { input_tokens: 500, output_tokens: 0 })}\n`);
  r = await p.run(['tick']);
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.loop.costMicroUsd, 2000, 'only the requests at or after the start count');
  appendFileSync(file, `${line('req_2', startedAt, { input_tokens: 2000, output_tokens: 0 })}\n`);
  r = await p.run(['tick']);
  assert.equal(r.code, 6, show(r));
  assert.deepEqual([r.out.exit, r.out.data.result, r.out.data.loop.costMicroUsd], ['BUDGET', 'BUDGET', 10000]);
  assert.match(r.out.data.reason, /cost cap reached: \$0\.01 of \$0\.01/);
  assert.equal(JSON.parse(readFileSync(p.loopFile, 'utf8')).exit, 'BUDGET');
});

test('command rows: tick needs no --yes (the fixed prompt carries none; it writes only its loop record); loop start and stop ask consent', () => {
  const rowOf = (n) => COMMANDS.find((c) => c.name === n);
  for (const n of ['tick', 'loop start', 'loop stop', 'loop status']) assert.ok(rowOf(n) && !rowOf(n).hidden, `${n}: public`);
  assert.equal(Boolean(rowOf('tick').mutating), false);
  assert.equal(Boolean(rowOf('loop status').mutating), false);
  assert.equal(rowOf('loop start').mutating, true);
  assert.equal(rowOf('loop stop').mutating, true);
  for (const e of ['OK', 'WAIT', 'DONE', 'STALLED', 'BUDGET']) assert.ok(rowOf('tick').exits.includes(e), `tick exits ${e}`);
  assert.deepEqual(rowOf('tick').flags.map((f) => f.flag), ['--plan']);
});

// ---- fix round 1: review r1 findings (each test reproduces the reviewer's scenario) --------------------------------

test('finding 1: a new loop after DONE (loop stop or a natural DONE) is the user\'s, as after STALLED or BUDGET: refused without a terminal, loop.json unchanged', async (t) => {
  const p = await repo(t);
  assert.equal((await p.run(['loop', 'start'])).code, 0);
  assert.equal((await p.run(['tick'])).code, 0);
  let r = await p.run(['loop', 'stop']);
  assert.equal(r.out.data.stopped, true, show(r));
  const stopped = readFileSync(p.loopFile, 'utf8');
  r = await p.run(['loop', 'start']);
  assert.equal(r.code, 7, `loop start --yes without a terminal after loop stop: ${show(r)}`);
  assert.equal(r.out.errors[0].code, 'user-decision');
  assert.equal(readFileSync(p.loopFile, 'utf8'), stopped, 'the refused start changed nothing: caps, ticks and the exit stay');
  assert.equal((await p.run(['tick'])).code, 4, 'no tick starts a loop after the exit');
  assert.equal(readFileSync(p.loopFile, 'utf8'), stopped);
  // a natural DONE: every task closed and the state committed
  const q = await repo(t);
  assert.equal((await q.run(['task', 'new', 'Loop work'])).code, 0);
  assert.equal((await q.run(['task', 'set', 'T-TU-1', 'cancelled', '--reason', 'out of scope'])).code, 0);
  git(q.cwd, q.env, ['add', '-A']);
  git(q.cwd, q.env, ['commit', '-q', '-m', 'state']);
  assert.equal((await q.run(['tick'])).code, 4);
  const done = readFileSync(q.loopFile, 'utf8');
  r = await q.run(['loop', 'start']);
  assert.equal(r.code, 7, `loop start --yes without a terminal after a natural DONE: ${show(r)}`);
  assert.equal(r.out.errors[0].code, 'user-decision');
  assert.equal(readFileSync(q.loopFile, 'utf8'), done);
  r = await q.run(['loop', 'start'], { tty: true });
  assert.equal(r.code, 0, `the user starts it: ${show(r)}`);
  assert.equal(r.out.data.replaced.exit, 'DONE');
});

test('finding 3 (any user): a cost measurement that throws never keeps a tick from counting; at the wall or tick cap the cost is not measured', (t) => {
  let calls = 0;
  const cost = () => { calls++; throw Object.assign(new Error("EACCES: permission denied, scandir 'local/runs'"), { code: 'EACCES' }); };
  const s = storeDir(t);
  s.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  s.store.write('loop', null, loop.newLoop({ now: T0, caps: { ...CAPS, wallMin: 60 } }));
  assert.deepEqual([s.run(5, { cost }).loop.ticks, s.run(10, { cost }).loop.ticks], [1, 2], 'each tick counts');
  let seen = calls;
  let r = s.run(60, { cost });
  assert.deepEqual([r.result, r.loop.ticks], ['BUDGET', 3]);
  assert.match(r.reason, /wall time cap reached/);
  assert.equal(calls, seen, 'the wall cap is checked before the cost is measured');
  assert.equal(JSON.parse(readFileSync(s.file, 'utf8')).exit, 'BUDGET');
  const u = storeDir(t);
  u.store.write('task', 'T-TU-1', task('T-TU-1', 'new'));
  u.store.write('loop', null, loop.newLoop({ now: T0, caps: { ...CAPS, ticks: 3 } }));
  u.run(1, { cost });
  u.run(2, { cost });
  seen = calls;
  r = u.run(3, { cost });
  assert.deepEqual([r.result, r.loop.ticks], ['BUDGET', 3]);
  assert.match(r.reason, /tick cap reached/);
  assert.equal(calls, seen, 'the tick cap is checked before the cost is measured');
});

test('finding 3: an unreadable runs directory never keeps a tick from counting or the wall cap from ending the loop: ticks counted, BUDGET written', { skip: process.getuid?.() === 0 }, async (t) => {
  const p = await repo(t);
  assert.equal((await p.run(['loop', 'start', '--caps', 'wallMin=5'])).code, 0);
  const runs = join(p.store, 'local', 'runs');
  mkdirSync(runs, { recursive: true });
  chmodSync(runs, 0o000);
  try {
    for (const n of [1, 2, 3]) {
      const r = await p.run(['tick']);
      assert.equal(r.code, 0, `tick ${n}: ${show(r)}`);
      assert.equal(r.out.data.loop.ticks, n, 'the tick counts');
      assert.deepEqual(r.out.data.steps.map((x) => x.rules), [['FLW-7']], 'the unreadable records are one repair step');
    }
    // the wall cap expires
    state.open(p.store, { names, kinds: loop.STORE_KINDS }).update('loop', null, (cur) => ({ ...cur, startedAt: new Date(Date.now() - 6 * MIN).toISOString() }));
    const r = await p.run(['tick']);
    assert.equal(r.code, 6, show(r));
    assert.match(r.out.data.reason, /wall time cap reached/);
    const doc = JSON.parse(readFileSync(p.loopFile, 'utf8'));
    assert.deepEqual([doc.exit, doc.ticks], ['BUDGET', 4]);
    assert.equal((await p.run(['tick'])).code, 6, 'every later tick returns it');
  } finally {
    chmodSync(runs, 0o700);
  }
  // the same principle for an unreadable tasks directory (the fingerprint reads it too): the tick counts, one repair step
  const q = await repo(t);
  assert.equal((await q.run(['task', 'new', 'Loop work'])).code, 0);
  assert.equal((await q.run(['tick'])).code, 0);
  const tasks = join(q.store, 'tasks');
  chmodSync(tasks, 0o000);
  try {
    const r = await q.run(['tick']);
    assert.equal(r.code, 0, show(r));
    assert.equal(r.out.data.loop.ticks, 2);
    assert.deepEqual(r.out.data.steps.map((x) => x.rules), [['FLW-7']]);
  } finally {
    chmodSync(tasks, 0o700);
  }
});

test('finding 4: transcripts that cannot be found are partial data, never a complete zero: data.partial and the reason in JSON and text; 3 such ticks in a row → BUDGET (cost-unmeasurable)', async (t) => {
  const p = await repo(t);
  let r = await p.run(['loop', 'start', '--caps', 'usd=1']);
  const { startedAt } = r.out.data.loop;
  // Opus 5.5: 4 µ$ per input token; 500 tokens = 2,000 µ$ of transcript-only spending
  writeFileSync(join(p.transcripts, 'a.jsonl'), `${line('req_1', startedAt, { input_tokens: 500, output_tokens: 0 })}\n`);
  r = await p.run(['tick']);
  assert.deepEqual([r.code, r.out.data.loop.costMicroUsd], [0, 2000], show(r));
  const gone = { ...p.env, CLAUDE_CONFIG_DIR: '/nonexistent' };
  const c = receipts.costSince(startedAt, { cwd: p.cwd, env: gone, names });
  assert.deepEqual([c.costMicroUsd, c.partial, c.unmeasurable], [0, true, true], 'costSince: no transcripts is not a complete zero');
  assert.ok(c.problems.some((x) => x.code === 'no-transcripts'), JSON.stringify(c.problems));
  r = await p.run(['tick'], { env: gone });
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.partial, true, 'spec §8.1: data.partial');
  assert.ok(r.out.errors.some((e) => e.code === 'no-transcripts'), `the reason is in the envelope: ${show(r)}`);
  assert.equal(r.out.data.loop.costMicroUsd, 2000, 'the spending measured before does not disappear from the cap');
  assert.equal(r.out.data.loop.unmeasured, 1);
  const text = await cliText(['tick'], { ...p, env: gone });
  assert.equal(text.code, 0, text.text);
  assert.match(text.text, /^TICK .*partial/m);
  assert.match(text.stderr, /no Claude Code transcripts/);
  r = await p.run(['tick']);
  assert.deepEqual([r.out.data.partial, r.out.data.loop.unmeasured], [false, 0], 'a measured tick resets the count');
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((r = await p.run(['tick'], { env: gone })).code);
  assert.deepEqual(codes, [0, 0, 6], show(r));
  assert.match(r.out.data.reason, /^cost-unmeasurable/);
  assert.equal(JSON.parse(readFileSync(p.loopFile, 'utf8')).exit, 'BUDGET');
});

test('finding 4: one unreadable record → partial, the cost of the rest counted; tick carries data.partial and the problem', async (t) => {
  const p = await repo(t);
  let r = await p.run(['loop', 'start', '--caps', 'usd=1']);
  const { startedAt } = r.out.data.loop;
  writeFileSync(join(p.transcripts, 'a.jsonl'), `${line('req_1', startedAt, { input_tokens: 500, output_tokens: 0 })}\n`);
  const runs = join(p.store, 'local', 'runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, 'fake-T-TU-1-reviewer-1.json'), '{ not json');
  writeFileSync(join(runs, 'fake-T-TU-1-reviewer-2.json'), JSON.stringify({ schema: 1, runId: 'fake-T-TU-1-reviewer-2', task: 'T-TU-1', role: 'reviewer', provider: 'fake', model: null,
    status: 'done', startedAt, endedAt: startedAt, tokens: null, costMicroUsd: 3000, exit: 0 }));
  const c = receipts.costSince(startedAt, { cwd: p.cwd, env: p.env, names });
  assert.deepEqual([c.costMicroUsd, c.partial], [5000, true], JSON.stringify(c));
  r = await p.run(['tick']);
  assert.equal(r.code, 0, show(r));
  assert.deepEqual([r.out.data.partial, r.out.data.loop.costMicroUsd], [true, 5000], show(r));
  assert.deepEqual(r.out.errors.map((e) => e.code), ['run-invalid']);
  assert.equal(c.unmeasurable, false, 'partial, not unmeasurable: the transcripts were read');
  assert.equal(r.out.data.loop.unmeasured, 0);
  const text = await cliText(['tick'], p);
  assert.match(text.stderr, /fake-T-TU-1-reviewer-1\.json/);
});

test('finding 5: a run live when the loop started counts toward it with its full cost: launched 1 s before the loop, spending $30 during it → counted, BUDGET', async (t) => {
  const p = await repo(t);
  let r = await p.run(['loop', 'start']);
  assert.equal(r.code, 0, show(r));
  const { startedAt } = r.out.data.loop;
  const launched = new Date(Date.parse(startedAt) - 1000).toISOString();
  const runs = join(p.store, 'local', 'runs');
  mkdirSync(runs, { recursive: true });
  const file = join(runs, 'fake-T-TU-1-implementer-1.json');
  const runDoc = (o) => JSON.stringify({ schema: 1, runId: 'fake-T-TU-1-implementer-1', task: 'T-TU-1', role: 'implementer', provider: 'fake', model: null, startedAt: launched, tokens: null, ...o });
  const since = () => receipts.costSince(startedAt, { cwd: p.cwd, env: p.env, names });
  writeFileSync(file, runDoc({ status: 'running', endedAt: null, costMicroUsd: 1000, exit: null }));
  assert.equal(since().costMicroUsd, 1000, 'live at the loop start: its cost so far counts');
  r = await p.run(['tick']);
  assert.ok([0, 3].includes(r.code), show(r));
  writeFileSync(file, runDoc({ status: 'done', endedAt: new Date().toISOString(), costMicroUsd: 30000000, exit: 0 }));
  assert.deepEqual([since().costMicroUsd, since().partial], [30000000, false], 'after it ends: its full cost');
  r = await p.run(['tick']);
  assert.equal(r.code, 6, show(r));
  assert.match(r.out.data.reason, /cost cap reached: \$30\.00 of \$25\.00/);
  writeFileSync(file, runDoc({ status: 'done', endedAt: new Date(Date.parse(startedAt) - 500).toISOString(), costMicroUsd: 30000000, exit: 0 }));
  assert.equal(since().costMicroUsd, 0, 'a run that ended before the loop started is not the loop\'s');
});
