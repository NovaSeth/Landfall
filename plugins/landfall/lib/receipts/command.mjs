// `receipt` command (spec §5.1, §7.11, §8.1, §8.2, ruling R70): the receipt of a task (--task) or of one external run
// (--run), the totals of the current loop (--loop) or the totals since a day per class or executor (--since, --by).
// --task in an active repository saves receipts/<task>.json through lib/state (saveReceipt: no write when
// unchanged, never fewer tokens than the saved one); in an inactive repository it prints only and writes nothing
// (GC2). --loop: costSince from the loop's start up to its exit (the measure of its cost cap); no loop record → exit 1.
// --since: totalsSince over the saved receipts and the run records; no selector in an active repository means --since
// the activation day (data.defaulted). --loop and --since write nothing.
// Data that could not be read or priced: exit 1 with the numbers found and data.receipt.partial (data.partial for
// --loop and --since; spec §8.1). --json carries the integer fields (micro-dollars, milliseconds); the text derives
// USD and seconds from them. Errors from lib/state (unknown task, not a repository, held lock) reach the CLI unchanged.
// Printed text holds labels and numbers only (model, agent type, provider, run ID), never transcript text.
import { EXIT } from '../cli/commands.mjs';
import { showLoop } from '../loop/index.mjs';
import { open, resolve } from '../state/index.mjs';
import { forTerminal } from '../text/clean.mjs';
import { PRICES, costSince, runReceipt, saveReceipt, taskReceipt, totalsSince } from './index.mjs';

const fail = (code, message, hint) => ({ code: EXIT.USAGE, errors: [{ code, message, hint }] });
const usd = (micro) => (micro === null ? '-' : (micro / 1e6).toFixed(6));
const seconds = (ms) => (ms === null ? '-' : String(ms / 1000));
const COLUMNS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const HEAD = ['input', 'output', 'cache read', 'cache write'];

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd()).join('\n');
}

function taskText(r, file) {
  const head = `receipt ${r.task} · class ${r.class ?? '-'} · rounds ${r.rounds ?? '-'} · ${r.startedAt ?? '-'} → ${r.endedAt ?? '-'}${r.wallMs === null ? '' : ` (${seconds(r.wallMs)} s)`}`;
  const rows = [['agent', 'model', ...HEAD, 'USD (estimate)']];
  for (const a of r.byAgent) rows.push([a.agentType, a.model, ...COLUMNS.map((k) => String(a.tokens[k])), usd(a.costMicroUsd)]);
  rows.push(['total', '', ...COLUMNS.map((k) => String(r.tokens[k])), usd(r.costMicroUsd)]);
  const lines = [head, table(rows)];
  if (r.external.length) {
    lines.push('external runs:');
    for (const e of r.external) {
      const tokens = e.tokens ? COLUMNS.map((k, i) => `${HEAD[i]} ${e.tokens[k]}`).join(' · ') : `tokens: ${e.tokensReason}`;
      lines.push(`  ${e.runId}  ${e.provider}  ${e.model ?? '-'}  ${tokens}  USD ${usd(e.costMicroUsd)}  ${seconds(e.wallMs)} s  exit ${e.exit ?? '-'}`);
    }
  }
  lines.push(`prices of ${r.priceTable} (estimate) · source ${r.source}${r.partial ? ' · PARTIAL: a lower bound' : ''}${file ? ` · saved: ${file}` : ''}`);
  return `${forTerminal(lines.join('\n'))}\n`;
}

function runText(r) {
  const tokens = r.tokens ? COLUMNS.map((k, i) => `${HEAD[i]} ${r.tokens[k]}`).join(' · ') : `tokens: ${r.tokensReason}`;
  return `${forTerminal(`run ${r.runId} · task ${r.task} · ${r.provider} · ${r.model ?? '-'} · ${r.status}\n${tokens} · USD ${usd(r.costMicroUsd)} (estimate) · ${seconds(r.wallMs)} s · exit ${r.exit ?? '-'}`)}\n`;
}

const tokenLine = (t) => COLUMNS.map((k, i) => `${HEAD[i]} ${t[k]}`).join(' · ');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function loopReceipt(ctx) {
  const { where, loop } = showLoop(ctx);
  if (!loop) {
    return { code: EXIT.FAIL, errors: [{ code: 'no-loop', message: where.active ? `no loop record in ${where.dir}` : `${where.repo} is not active: it has no loop`, hint: `the first '${ctx.names.bin} tick' starts a loop` }] };
  }
  const c = costSince(loop.startedAt, { ...ctx, where, until: loop.exitAt });
  const state = loop.exit ? `ended ${loop.exit} at ${loop.exitAt}` : 'running';
  const text = `loop ${loop.id} · since ${loop.startedAt} (${state}) · ${tokenLine(c.tokens)} · USD ${usd(c.costMicroUsd)} (estimate)${c.partial ? ' · PARTIAL: a lower bound' : ''}\n`
    + `every request of the repository's transcripts and every external run in that time · prices of ${PRICES.date}\n`;
  return {
    code: c.partial ? EXIT.FAIL : EXIT.OK,
    data: { loop: { id: loop.id, startedAt: loop.startedAt, exit: loop.exit, exitAt: loop.exitAt }, tokens: c.tokens, costMicroUsd: c.costMicroUsd, partial: c.partial },
    errors: c.problems,
    text: forTerminal(text),
  };
}

function sinceReceipt(flags, ctx, defaulted = false) {
  const r = totalsSince(flags.since, flags.by ?? 'class', ctx);
  const warnings = r.where.active ? [] : [{ code: 'not-active', message: `${r.where.repo} is not active: it has no saved receipts or run records`, hint: `${ctx.names.bin} init activates it` }];
  const rows = [[r.by, 'tasks', 'runs', ...HEAD, 'USD (estimate)']];
  for (const g of r.groups) rows.push([g.key, String(g.tasks.length), String(g.runs), ...COLUMNS.map((k) => String(g.tokens[k])), usd(g.costMicroUsd)]);
  const tasks = new Set(r.groups.flatMap((g) => g.tasks)).size;
  rows.push(['total', String(tasks), String(r.groups.reduce((n, g) => n + g.runs, 0)), ...COLUMNS.map((k) => String(r.total.tokens[k])), usd(r.total.costMicroUsd)]);
  const lines = [
    `receipts since ${r.since}${defaulted ? ' (activation)' : ''} by ${r.by} · ${plural(r.receipts, 'saved receipt')}, ${plural(r.runs, 'run')} outside them`,
    table(rows),
    `prices of ${PRICES.date} (estimate) · a task without a saved receipt counts only its external runs (receipt --task saves one)${r.partial ? ' · PARTIAL: a lower bound' : ''}`,
  ];
  const { where, ...totals } = r;
  return {
    code: r.partial ? EXIT.FAIL : EXIT.OK,
    data: { since: totals.since, by: totals.by, groups: totals.groups, total: totals.total, receipts: totals.receipts, runs: totals.runs, partial: totals.partial, warnings, ...(defaulted ? { defaulted: true } : {}) },
    errors: r.problems,
    text: `${forTerminal(lines.join('\n'))}\n`,
    warnings: warnings.map((w) => w.message),
  };
}

export function receipt({ flags, names, io }) {
  const ctx = { cwd: io.cwd, env: io.env, names };
  const given = ['task', 'run', 'loop', 'since'].filter((k) => flags[k] !== undefined);
  if (given.length === 0 && flags.by === undefined) {
    // No selector: in an active repository the default is the work since the activation day.
    const where = resolve({ cwd: io.cwd, env: io.env, names });
    if (where.active) {
      const day = open(where.dir, { names }).read('state', null).activatedAt.slice(0, 10);
      return sinceReceipt({ ...flags, since: day }, ctx, true);
    }
  }
  if (given.length === 0) return fail('missing-flag', 'give --task <id>, --run <id>, --loop or --since <YYYY-MM-DD>', `${names.bin} receipt --task T-AB-1`);
  if (given.length > 1) return fail('conflicting-flags', `${given.map((k) => `--${k}`).join(' and ')} exclude each other`, 'ask for one receipt at a time');
  if (flags.by !== undefined && flags.since === undefined) return fail('missing-flag', '--by groups the totals of --since', `${names.bin} receipt --since 2026-10-01 --by executor`);
  if (flags.loop) return loopReceipt(ctx);
  if (flags.since !== undefined) return sinceReceipt(flags, ctx);
  if (flags.run !== undefined) {
    const { run } = runReceipt(flags.run, ctx);
    return { data: { run }, text: runText(run) };
  }
  const { receipt: r, problems, warnings, where } = taskReceipt(flags.task, ctx);
  let saved = false;
  let file = null;
  if (where.active) {
    const out = saveReceipt(r, { where, names });
    ({ saved, file } = out);
    if (out.kept) warnings.push({ code: 'receipt-kept', message: `the saved receipt of ${r.task} counts more tokens; it was kept`, hint: 'its transcripts are gone from this machine or were never here' });
  } else {
    warnings.push({ code: 'not-saved', message: 'this repository is not activated: the receipt is printed, not saved', hint: `${names.bin} init activates it` });
  }
  return { code: r.partial ? EXIT.FAIL : EXIT.OK, data: { receipt: r, saved, file, warnings }, errors: problems, text: taskText(r, saved ? file : null), warnings: warnings.map((w) => w.message) };
}
