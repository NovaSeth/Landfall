// Publication of eval results (scripts/eval-publish.mjs, scripts/eval-lib/{lock,stats}.mjs): the frozen suite lock,
// the statistics (mean over cases of the per-case difference of arm means, seeded bootstrap resampling runs within
// each case x arm, Wilson intervals) and every reason a run is refused for publication. Synthetic results only;
// no model run. This file holds no plugin name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { EVALS, HIDDEN, keptRun, out, post, probeSuite, publish, tempDir, unseal } from './helpers/eval-cases.mjs';
import { lockState } from '../scripts/eval-lib/lock.mjs';
import { bootstrap, interval, median, percentile, rng, suiteDelta, wilson } from '../scripts/eval-lib/stats.mjs';
import { summarize } from '../scripts/eval-publish.mjs';

isolateProcessEnv();

const close = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

test('statistics: seeded generator, percentiles, medians and Wilson intervals', () => {
  const a = rng(7);
  const b = rng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()], 'same seed, same draws');
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0.1), 1.3);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const [lo, hi] = wilson(5, 5, 0.95);
  assert.ok(close(lo, 0.5655) && hi === 1, `${lo} ${hi}`);
  const [lo80, hi80] = wilson(0, 5, 0.8);
  assert.ok(lo80 === 0 && close(hi80, 0.2473), `${lo80} ${hi80}`);
  assert.ok(wilson(3, 5, 0.95)[0] > 0 && wilson(3, 5, 0.95)[1] < 1);
  assert.throws(() => wilson(1, 2, 0.5), RangeError);
});

test('the primary statistic weights cases equally and the bootstrap resamples runs within each case and arm', () => {
  const cases = [
    { with: [1, 1, 1, 1, 1], without: [0, 0, 0, 0, 0] },
    { with: [1, 1, 1, 1, 1], without: [1, 1, 1, 1, 1] },
  ];
  assert.equal(suiteDelta(cases), 0.5);
  const reps = bootstrap(cases, { replicates: 2000, seed: 1 });
  assert.deepEqual(interval(reps, 0.8), [0.5, 0.5], 'identical runs give a zero-width bootstrap interval (hence Wilson intervals too)');
  const mixed = [{ with: [1, 0, 1, 1, 0], without: [0, 0, 1, 0, 0] }];
  const r1 = bootstrap(mixed, { replicates: 5000, seed: 42 });
  const r2 = bootstrap(mixed, { replicates: 5000, seed: 42 });
  assert.deepEqual(r1, r2, 'seeded: reproducible');
  const [lo, hi] = interval(r1, 0.8);
  const [lo95, hi95] = interval(r1, 0.95);
  assert.ok(lo < 0.4 && hi > 0.4 && lo95 <= lo && hi95 >= hi, `${lo} ${hi} ${lo95} ${hi95}`);
});

// Complete synthetic inputs for the real suite: every case, five runs per arm, all checked, every hidden result
// bound to its run (trace path, run id, trace and workspace hashes) and the report to its results file.
const RESULTS_SHA = 'r'.repeat(64);
const tracePathOf = (name, arm, i) => `/kept/${name}/${arm}/${i + 1}/out/trace.jsonl`;
function inputs(lock, { quality = () => 1, mutate = () => {} } = {}) {
  const cases = Object.keys(lock.lock.cases);
  const results = {
    schemaVersion: 1,
    claudeVersion: '2.1.300',
    startedAt: '2026-10-15T00:00:00.000Z',
    partial: false,
    suite: { ablation: 'with-without', concurrency: 2, plugins: [{ name: 'plugin', version: '0.0.0' }] },
    cases: cases.map((name) => ({
      name,
      arms: Object.fromEntries(['with', 'without'].map((arm) => [arm, Array.from({ length: 5 }, (_, i) => ({
        score: 1, costUsd: arm === 'with' ? 0.2 : 0.18, durationSeconds: 30 + i, startedAt: `2026-10-15T00:${String(i).padStart(2, '0')}:00.000Z`, error: null,
        tracePath: tracePathOf(name, arm, i),
      }))])),
    })),
  };
  const report = {
    schema_version: 2,
    node: process.version,
    confinement: { node_permission: true, os_sandbox: 'sandbox-exec', unconfined: false, unconfined_allowed: false },
    suite_lock: { sha256: lock.sha256, current: true },
    source: { results: '/results/aggregate-result.json', results_sha256: RESULTS_SHA, partial: false },
    runs: cases.flatMap((name) => ['with', 'without'].flatMap((arm) => Array.from({ length: 5 }, (_, i) => {
      const q = quality(name, arm, i);
      return {
        case: name, arm, run: i + 1, status: q === 1 ? 'pass' : 'fail', quality: q, checks: [{ check: 'hidden-tests', ok: q === 1 }],
        binding: { trace_path: tracePathOf(name, arm, i), run_id: `session-${name}-${arm}-${i}`, trace_sha256: 't'.repeat(64), workspace_sha256: 'w'.repeat(64) },
        process: { usage: { input_tokens: 1000, output_tokens: 100 }, model: 'agent-model', verified_after_last_change: true },
      };
    }))),
  };
  mutate(results, report);
  return { results, report };
}
const verified = () => null;
const summary = (lock, input, verifyRun = verified) => summarize({ ...input, lock, resultsSha256: RESULTS_SHA, verifyRun });

test('summary: per-case arm means, equal-weight delta with its interval, pass-rate intervals, overhead, conditions and raw runs', () => {
  const lock = lockState({ evals: EVALS, hidden: HIDDEN });
  assert.equal(lock.current, true);
  const first = Object.keys(lock.lock.cases)[0];
  const { results, report } = inputs(lock, { quality: (name, arm, i) => (arm === 'with' || name !== first || i < 3 ? 1 : 0) });
  const s = summary(lock, { results, report });
  assert.equal(s.refused, undefined, JSON.stringify(s.refused));
  const caseCount = Object.keys(lock.lock.cases).length;
  assert.ok(close(s.primary.value, 0.4 / caseCount), `${s.primary.value}`);
  assert.deepEqual(Object.keys(s.primary).filter((k) => k.startsWith('ci') || k.startsWith('sensitivity')), ['ci80', 'sensitivity_ci95']);
  const firstCase = s.cases.find((c) => c.name === first);
  assert.deepEqual([firstCase.with.complete, firstCase.without.complete, firstCase.delta], [5, 3, 0.4]);
  assert.ok(firstCase.without.pass_rate_ci95[0] < 0.6 && firstCase.without.pass_rate_ci95[1] > 0.6);
  assert.equal(s.runs.length, caseCount * 10, 'raw per-run rows are published');
  assert.ok(s.small_task_overhead.length >= 3 && s.small_task_overhead.every((o) => o.tokens_ratio === 1 && o.tokens_within === true));
  assert.ok(close(s.quality_and_cost.cost_delta, 0.1111, 1e-3));
  assert.equal(s.conditions.concurrency, 2);
  assert.deepEqual(s.conditions.agent_models, ['agent-model']);
  assert.match(s.label, /pilot/);
  assert.equal(s.conditions.run_order.length, caseCount * 10);
});

test('publication is refused for a stale or different lock, incomplete runs, unchecked results, skipped graders, infrastructure errors or unconfined code', () => {
  const lock = lockState({ evals: EVALS, hidden: HIDDEN });
  const name = Object.keys(lock.lock.cases)[0];
  const refusals = {
    partial: (r) => { r.partial = true; r.partialReason = 'cost_ceiling'; },
    'missing run': (r) => { r.cases[0].arms.without.pop(); },
    'missing case': (r) => { r.cases.pop(); },
    'unchecked hidden result': (r, h) => { h.runs[0].status = 'unchecked'; h.runs[0].quality = null; },
    'missing hidden result': (r, h) => { h.runs.pop(); },
    'skipped paid graders': (r) => { r.cases[0].arms.with[0].skippedPaidGraders = true; },
    'infrastructure error': (r) => { r.cases[0].arms.with[0].error = 'exit 1: Not logged in'; },
    'api error flag': (r) => { r.cases[0].arms.with[0].endedOnApiError = true; },
    unconfined: (r, h) => { h.confinement.unconfined = true; },
    'different lock': (r, h) => { h.suite_lock.sha256 = '0'.repeat(64); },
    'stale lock at post-pass': (r, h) => { h.suite_lock.current = false; },
    'no without arm': (r) => { r.suite.ablation = 'none'; },
  };
  for (const [label, mutate] of Object.entries(refusals)) {
    const s = summary(lock, inputs(lock, { mutate }));
    assert.ok(Array.isArray(s.refused) && s.refused.length > 0, label);
  }
  const genuine = inputs(lock, { mutate: (r) => { r.cases[0].arms.with[0].error = 'max turns reached'; } });
  assert.equal(summary(lock, genuine).refused, undefined, 'a task failure is kept, not refused');
  assert.ok(name);
});

test('publication is refused for any missing, unknown, inconsistent, duplicate or extra hidden result', () => {
  const lock = lockState({ evals: EVALS, hidden: HIDDEN });
  const first = (h) => h.runs[0];
  const refusals = {
    'quality null on a failed run': (r, h) => { first(h).status = 'fail'; first(h).quality = null; first(h).checks[0].ok = false; },
    'unknown status': (r, h) => { first(h).status = 'skipped'; },
    'pass with a failing check': (r, h) => { first(h).checks.push({ check: 'visible-suite', ok: false }); },
    'pass with an unchecked check': (r, h) => { first(h).checks.push({ check: 'visible-suite', ok: null }); },
    'fail without a failing check': (r, h) => { first(h).status = 'fail'; first(h).quality = 0; },
    'quality that contradicts the status': (r, h) => { first(h).quality = 0; },
    'no checks': (r, h) => { first(h).checks = []; },
    'duplicate hidden result': (r, h) => { h.runs.push({ ...first(h), status: 'fail', quality: 0, checks: [{ check: 'hidden-tests', ok: false }] }); },
    'hidden result for a run that does not exist': (r, h) => { h.runs.push({ ...first(h), run: 6 }); },
  };
  for (const [label, mutate] of Object.entries(refusals)) {
    const s = summary(lock, inputs(lock, { mutate }));
    assert.ok(Array.isArray(s.refused) && s.refused.length > 0, label);
  }
});

test('publication is refused when a hidden result is not bound to its run or the report to its results file', () => {
  const lock = lockState({ evals: EVALS, hidden: HIDDEN });
  const first = (h) => h.runs[0];
  const refusals = {
    'report from another results file': [(r, h) => { h.source.results_sha256 = 'x'.repeat(64); }],
    'no results hash in the report': [(r, h) => { delete h.source.results_sha256; }],
    'bound to another trace': [(r, h) => { first(h).binding.trace_path = '/kept/elsewhere/out/trace.jsonl'; }],
    'no binding': [(r, h) => { delete first(h).binding; }],
    'no run id': [(r, h) => { first(h).binding.run_id = null; }],
    'kept run no longer matches': [() => {}, (record) => (record === undefined ? null : record.run === 1 && record.arm === 'with' ? 'workspace changed since the post-pass' : null)],
  };
  for (const [label, [mutate, verify]] of Object.entries(refusals)) {
    const s = summary(lock, inputs(lock, { mutate }), verify ?? verified);
    assert.ok(Array.isArray(s.refused) && s.refused.length > 0, label);
  }
});

// The hidden post-pass runs candidate code only under Node's permission model (Node >= 22.13); without it publication is
// refused by design, so this end-to-end case needs that Node. The plugin itself supports Node 22 and later.
const NODE_PERMISSION = process.allowedNodeEnvironmentFlags.has('--permission');
test('end to end: hidden results are bound to kept runs; a changed workspace, a replaced trace or another results file is refused', { skip: !NODE_PERMISSION && 'needs Node\'s permission model (Node >= 22.13) for the confined post-pass' }, () => {
  const suite = probeSuite();
  assert.equal(publish(['lock', '--evals', suite.evals, '--hidden', suite.hidden]).status, 0);
  const runs = { with: [], without: [] };
  for (const arm of ['with', 'without']) {
    for (let i = 0; i < 5; i += 1) {
      const ws = tempDir('pub-ws');
      mkdirSync(join(ws, 'src'));
      writeFileSync(join(ws, 'package.json'), '{"type": "module"}\n');
      writeFileSync(join(ws, 'src', 'm.mjs'), arm === 'with' || i < 2 ? 'export const add = (a, b) => a + b;\n' : 'export const add = (a, b) => a - b;\n');
      const trace = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: `s-${arm}-${i}`, model: 'agent-model' })}\n${JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, result: 'done', usage: { input_tokens: 500, output_tokens: 50 } })}\n`;
      runs[arm].push(keptRun(ws, { trace }));
    }
  }
  const dir = tempDir('pub-e2e');
  const results = {
    schemaVersion: 1, claudeVersion: '2.1.300', partial: false, suite: { ablation: 'with-without', concurrency: 1 },
    cases: [{ name: 'probe', dir: 'evals/probe', arms: Object.fromEntries(['with', 'without'].map((arm) => [arm, runs[arm].map((k, i) => ({ score: 1, costUsd: 0.1, durationSeconds: 10 + i, tracePath: k.trace }))])) }],
  };
  const agg = join(dir, 'aggregate-result.json');
  writeFileSync(agg, JSON.stringify(results));
  const hiddenReport = join(dir, 'hidden.json');
  const flags = ['--evals', suite.evals, '--hidden', suite.hidden];
  try {
    const pass = post(['--results', agg, '--out', hiddenReport, ...flags]);
    assert.equal(pass.status, 0, out(pass));
    const ok = publish(['summarize', '--results', agg, '--hidden-report', hiddenReport, '--out', join(dir, 's.json'), '--markdown', join(dir, 's.md'), ...flags]);
    assert.equal(ok.status, 0, out(ok));
    assert.equal(JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')).primary.value, 0.6);
    assert.match(readFileSync(join(dir, 's.md'), 'utf8'), /^\| Case \| Class \|/m);

    const other = join(dir, 'other.json');
    writeFileSync(other, JSON.stringify({ ...results, claudeVersion: '2.1.301' }));
    const otherRun = publish(['summarize', '--results', other, '--hidden-report', hiddenReport, ...flags]);
    assert.equal(otherRun.status, 1, out(otherRun));
    assert.match(otherRun.stderr, /another results file/);

    unseal(runs.without[4]);
    writeFileSync(join(runs.without[4].root, 'sealed', 'home', 'cwd', 'src', 'm.mjs'), 'export const add = (a, b) => a + b;\n');
    const changed = publish(['summarize', '--results', agg, '--hidden-report', hiddenReport, ...flags]);
    assert.equal(changed.status, 1, out(changed));
    assert.match(changed.stderr, /without, run 5: .*workspace/);

    unseal(runs.with[0]);
    writeFileSync(runs.with[0].trace, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'another-session' })}\n`);
    const replaced = publish(['summarize', '--results', agg, '--hidden-report', hiddenReport, ...flags]);
    assert.equal(replaced.status, 1, out(replaced));
    assert.match(replaced.stderr, /with, run 1: .*trace/);
  } finally {
    for (const k of [...runs.with, ...runs.without]) unseal(k);
  }
});

test('the lock goes stale when a case, its hidden tests or its completion change, and the publisher refuses then', () => {
  const base = tempDir('suite-copy');
  const evals = join(base, 'evals');
  const hidden = join(base, 'hidden');
  cpSync(EVALS, evals, { recursive: true });
  cpSync(HIDDEN, hidden, { recursive: true });
  assert.equal(publish(['lock', '--check', '--evals', evals, '--hidden', hidden]).status, 0, 'the copied lock is current');
  const edits = [
    () => writeFileSync(join(evals, 'typo-fix', 'prompt.md'), 'Fix it.\n'),
    () => writeFileSync(join(hidden, 'typo-fix', 'extra.hidden.test.mjs'), '// changed\n'),
    () => {
      const file = join(hidden, 'typo-fix', 'completion.json');
      const def = JSON.parse(readFileSync(file, 'utf8'));
      def.checks.pop();
      writeFileSync(file, JSON.stringify(def));
    },
  ];
  for (const change of edits) {
    cpSync(EVALS, evals, { recursive: true });
    cpSync(HIDDEN, hidden, { recursive: true, force: true });
    change();
    const check = publish(['lock', '--check', '--evals', evals, '--hidden', hidden]);
    assert.equal(check.status, 1, out(check));
  }
  const relock = publish(['lock', '--evals', evals, '--hidden', hidden]);
  assert.equal(relock.status, 0, out(relock));
  assert.equal(publish(['lock', '--check', '--evals', evals, '--hidden', hidden]).status, 0);
});

test('command line: results whose kept runs cannot be re-verified are refused (exit 1); usage errors exit 2', () => {
  const lock = lockState({ evals: EVALS, hidden: HIDDEN });
  const dir = tempDir('publish');
  const write = (name, value) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(value)); return p; };
  for (const input of [inputs(lock), inputs(lock, { mutate: (r) => { r.partial = true; } })]) {
    const refused = publish(['summarize', '--results', write('agg.json', input.results), '--hidden-report', write('hidden.json', input.report)]);
    assert.equal(refused.status, 1, out(refused));
    assert.match(refused.stderr, /publication refused/);
  }
  for (const args of [[], ['frobnicate'], ['summarize'], ['summarize', '--results', join(dir, 'missing.json'), '--hidden-report', join(dir, 'missing.json')], ['lock', '--bogus']]) {
    assert.equal(publish(args).status, 2, args.join(' '));
  }
});
