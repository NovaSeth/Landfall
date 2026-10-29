// Commands of the verify unit (spec §8.1, §8.2), loaded by their rows in lib/cli/commands.mjs: `verify <id> [--ci]`,
// `task done <id>`, `task merge <id> [--branch <b>]` (several IDs or --ready: a batch, batch.mjs), `review record <id> --from <file>`, `baseline show`,
// `baseline pin --decision <D>`. Context comes from io (cwd, env), never from process state (COD-9). A typed error
// of lib/state, lib/router or lib/profile becomes its exit code with message and hint.
// Exit: verify and task merge by result (pass 0 · error 8 · any other 1); task done 0 when done; review record 0
// when recorded, 2 with one error per failing field; baseline show 1 when the sha256 does not match the content.
// Gate output is returned in `data.output` (never written to committed state; verify also keeps it under local/).
import { EXIT } from '../cli/commands.mjs';
import { ProfileError } from '../profile/index.mjs';
import { RouteError } from '../router/index.mjs';
import { StateError } from '../state/index.mjs';
import { forTerminal } from '../text/clean.mjs';
import { batchMerge } from './batch.mjs';
import { markDone } from './done.mjs';
import { adoptMerged, mergeTask } from './merge.mjs';
import { pinBaseline, showBaseline } from './pin.mjs';
import { recordReview } from './review.mjs';
import { verifyTask } from './run.mjs';

const exitOf = (result) => (result === 'pass' ? EXIT.OK : result === 'error' ? EXIT.ENV : EXIT.FAIL);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const some = (list, n = 10) => (list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} (+${list.length - n} more)`);

const typed = (fn) => (ctx) => {
  try {
    return fn(ctx);
  } catch (err) {
    const known = err instanceof StateError || err instanceof RouteError || err instanceof ProfileError;
    if (known && err.exit !== 'INTERNAL' && Object.hasOwn(EXIT, err.exit)) return { code: EXIT[err.exit], errors: [err] };
    throw err;
  }
};

// `reused`: the time of the gate runs reused from the gate cache (null: the gates ran); `renamed`: the [{ from, to }]
// pairs of tests that changed their title and kept their body (no decision needed).
export function renderVerify(doc, reused = null, renamed = []) {
  const lines = [`${doc.task}: ${doc.result} (${doc.head ? `head ${doc.head.slice(0, 12)}` : 'uncommitted changes'}, class ${doc.class ?? 'none'})`];
  if (doc.gates.length) {
    const width = Math.max(...doc.gates.map((g) => g.name.length));
    lines.push(reused ? `gates: reused from ${reused}` : 'gates:', ...doc.gates.map((g) => `  ${g.name.padEnd(width)}  ${g.result.padEnd(7)}  exit ${g.exit ?? '-'}  ${seconds(g.durationMs)}`));
  }
  const inv = doc.inventory;
  lines.push(`tests (${inv.collector}${inv.weak ? ', weak: a test gate read by the static scan only' : ''}): ${inv.total}; added ${inv.added.length}, removed ${inv.removed.length}, renamed ${renamed.length}, newly skipped ${inv.newlySkipped.length}${inv.allowedBy.length ? `; allowed by ${inv.allowedBy.join(', ')}` : ''}`);
  if (inv.removed.length) lines.push(`  removed: ${some(inv.removed)}`);
  if (renamed.length) lines.push(`  renamed (same body, no decision needed): ${some(renamed.map((r) => `${r.from} → ${r.to}`), 5)}`);
  if (inv.newlySkipped.length) lines.push(`  newly skipped: ${some(inv.newlySkipped)}`);
  lines.push(`failures: ${doc.failures.new.length} new, ${doc.failures.preexisting.length} pre-existing`);
  const r = doc.route;
  lines.push(`route: ${r.actual ?? 'unclassified'}${r.escalated ? ` (raised from ${r.declared}; adds ${r.missingSteps.join(', ')})` : ''}`);
  lines.push(`artifacts: report ${doc.artifacts.report ? 'with RED/GREEN evidence' : 'missing'}, review ${doc.artifacts.review}`);
  return lines;
}

export const verify = typed(({ args, flags, names, version, io }) => {
  const out = verifyTask({ cwd: io.cwd, env: io.env, names, id: args.id, ci: Boolean(flags.ci), cache: !flags.noCache, version: version ?? null });
  const data = { ...out.doc, renamed: out.renamed, written: out.written, attempt: out.attempt, closed: out.closed, ...(out.candidates ? { candidates: out.candidates } : {}), output: out.output, reusedFrom: out.reused };
  const tail = out.written ? `gate output: local/verify/${out.doc.task}.log in the state directory (attempt ${out.attempt}: ${out.doc.task}-${out.attempt}.log)`
    : out.closed ? `nothing written: ${out.doc.task} is ${out.closed}, a closed task takes no further state` : 'nothing written (--ci)';
  return { code: exitOf(out.doc.result), data, errors: out.reasons, text: `${forTerminal([...renderVerify(out.doc, out.reused, out.renamed), tail].join('\n'))}\n` };
});

export const taskDone = typed(({ args, names, io }) => {
  const r = markDone({ cwd: io.cwd, env: io.env, names, id: args.id });
  const text = r.changed ? `${r.id}: done (verified at ${r.head.slice(0, 12)})` : `${r.id}: already done`;
  return { data: { task: r.id, status: r.task.status, changed: r.changed, head: r.head, fixed: r.fixed }, text: `${text}\n${r.fixed.length ? `findings fixed: ${r.fixed.join(', ')}\n` : ''}` };
});

export const taskMerge = typed(({ args, flags, names, version, io }) => {
  const ids = [].concat(args.id ?? []);
  if (flags.adopt) {
    if (flags.branch !== undefined) return { code: EXIT.USAGE, errors: [{ code: 'unexpected-flag', message: '--branch does not apply to --adopt', hint: `${names.bin} task merge --adopt <id…>` }] };
    if (flags.ready) return { code: EXIT.USAGE, errors: [{ code: 'unexpected-flag', message: '--ready does not apply to --adopt', hint: `${names.bin} task merge --adopt <id…>` }] };
    const a = adoptMerged({ cwd: io.cwd, env: io.env, names, ids, version: version ?? null });
    const { exit, reasons, ...data } = a;
    const lines = a.result === 'pass'
      ? [`gates pass on ${a.target} at ${a.commit.slice(0, 12)}`, ...a.tasks.map((t) => `${t.task}  ${t.adopted ? 'adopted' : `not adopted: ${t.why}`}`)]
      : [`gates ${a.result} on ${a.target} at ${a.commit.slice(0, 12)}: nothing recorded`, ...renderVerify(a.verify).slice(1)];
    return { code: EXIT[exit], data, errors: reasons, text: `${forTerminal(lines.join('\n'))}\n` };
  }
  if (flags.ready && ids.length) return { code: EXIT.USAGE, errors: [{ code: 'unexpected-argument', message: '--ready takes the ready tasks itself: give no IDs', hint: `${names.bin} task merge --ready` }] };
  if (!flags.ready && ids.length === 0) return { code: EXIT.USAGE, errors: [{ code: 'missing-argument', message: 'task merge: missing <id>', hint: `${names.bin} task merge <id…> | --ready` }] };
  if (flags.ready || ids.length > 1) {
    if (flags.branch !== undefined) return { code: EXIT.USAGE, errors: [{ code: 'unexpected-flag', message: '--branch applies to one ID only', hint: `${names.bin} task merge <id> --branch <branch>` }] };
    const b = batchMerge({ cwd: io.cwd, env: io.env, names, ids, ready: Boolean(flags.ready), version: version ?? null });
    const { exit, reasons, ...data } = b;
    const lines = b.tasks.length === 0 ? ['no task is ready to merge'] : b.tasks.map((t) => `${t.task}  ${t.outcome === 'merged' ? 'merged' : `${t.outcome}: ${t.why}`}`);
    if (b.tasks.length) lines.push(`gate runs: ${b.gateRuns} · batch ${b.batch}${b.commit ? ` · ${b.target} at ${b.commit.slice(0, 12)}` : ''}`);
    return { code: EXIT[exit], data, errors: reasons, text: `${forTerminal(lines.join('\n'))}\n` };
  }
  const r = mergeTask({ cwd: io.cwd, env: io.env, names, id: ids[0], branch: flags.branch, version: version ?? null });
  const { exit, reasons, ...data } = r;
  let lines;
  if (r.merged) lines = [`merged ${r.branch} for ${r.task} as ${r.commit.slice(0, 12)}`, ...renderVerify(r.verify).slice(1)];
  else if (r.upToDate) lines = [`${r.branch} is already merged: nothing to do`];
  else if (r.verify) lines = [`merge of ${r.branch} aborted: the outcome gates are ${r.result}`, ...renderVerify(r.verify).slice(1)];
  else lines = [`merge of ${r.branch} aborted${r.conflicts.length ? `: conflicts in ${some(r.conflicts)}` : ''}`];
  return { code: EXIT[exit], data, errors: reasons, text: `${forTerminal(lines.join('\n'))}\n` };
});

export const reviewRecord = typed(({ args, flags, names, io }) => {
  if (typeof flags.from !== 'string' || flags.from === '') {
    return { code: EXIT.USAGE, errors: [{ code: 'missing-flag', message: 'review record needs --from <file>: the typed review JSON', hint: `${names.bin} review record ${args.id} --from <file>` }] };
  }
  const r = recordReview({ cwd: io.cwd, env: io.env, names, id: args.id, from: flags.from });
  if (r.invalid) {
    const hint = 'the file must match templates/review.schema.json in the plugin; nothing was written';
    return { code: EXIT.USAGE, data: { task: args.id, written: false }, errors: r.invalid.map((message) => ({ code: 'invalid-review', message, hint })) };
  }
  const { verdict, reviewer, findings } = r.doc;
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  const text = `${r.task}: review r${r.round} recorded: ${verdict} by ${reviewer.id} (${reviewer.kind}), ${findings.length} findings (${blocking} blocking): ${r.file}`;
  return { data: { task: r.task, round: r.round, file: r.file, verdict, reviewer, findings: findings.length, blocking }, text: `${forTerminal(text)}\n` };
});

const testLine = (t) => `  ${t.id}${t.file ? `  ${t.file}` : ''}${t.skipped ? '  skipped' : ''}`;

export const baselineShow = typed(({ names, io }) => {
  const { doc, valid } = showBaseline({ cwd: io.cwd, env: io.env, names });
  if (doc === null) return { data: { baseline: null, valid: null }, text: `no baseline yet: the first passing verify writes it, or ${names.bin} baseline pin --decision <D>\n` };
  const skipped = doc.tests.filter((t) => t.skipped).length;
  const lines = [
    `baseline: ${doc.tests.length} tests (${skipped} skipped), ${doc.failing.length} failing; collector ${doc.collector}; head ${doc.head ? doc.head.slice(0, 12) : '-'}; collected ${doc.collectedAt}${doc.pinnedBy ? `; pinned by ${doc.pinnedBy}` : ''}; sha256 ${valid ? 'matches' : 'DOES NOT MATCH the content'}`,
    ...doc.tests.map(testLine),
    ...(doc.failing.length ? ['failing (pre-existing):', ...doc.failing.map((f) => `  ${f}`)] : []),
  ];
  const errors = valid ? [] : [{ code: 'baseline-invalid', message: 'the baseline does not match its sha256: it was changed outside verify and baseline pin', hint: `restore it from git, or ${names.bin} baseline pin --decision <D>` }];
  return { code: valid ? EXIT.OK : EXIT.FAIL, data: { baseline: doc, valid }, errors, text: `${forTerminal(lines.join('\n'))}\n` };
});

export const baselinePin = typed(({ flags, names, io }) => {
  const r = pinBaseline({ cwd: io.cwd, env: io.env, names, decision: flags.decision });
  const d = r.doc;
  const was = r.previous ? `; was ${r.previous.total} tests by ${r.previous.collector}${r.previous.valid ? '' : ' (sha256 not matching)'}` : '';
  const text = `baseline pinned by ${r.decision}: ${d.tests.length} tests (${d.tests.filter((t) => t.skipped).length} skipped), ${d.failing.length} failing; collector ${d.collector}${was}`;
  return { data: { decision: r.decision, baseline: d, previous: r.previous, output: r.output }, text: `${forTerminal(text)}\n` };
});
