// `<bin> review brief <id> [--round <k>] [--scope <ids>] [--write [--force]]` (ORC-5, REV-6): the review brief of a task
// rendered from templates/task/review-brief.md of the plugin and the state: the range pinned to HEAD (round 1: the task
// base; a later round: the HEAD the previous review brief pinned), the diff (-U10, the state directory left out) saved to
// local/review/<id>-r<k>.diff in the state directory, the changed files, the acceptance points of the task brief, the risks
// (profile risk paths, the profile's review focus, decisions cited in the changed files), the previous round's findings
// and the rule IDs of the reviewer. It ends with the marker line of lib/cli/brief.mjs: --write stores
// tasks/<id>/review-r<k>-brief.md through lib/state; a file edited by hand is kept (exit 1) unless --force.
// Exit 0 · 1 no such task, not routed, no base, a dirty tree, a failed diff, a hand-written brief kept · 2 a bad round or
// scope, --force without --write · 7 inactive repository or no consent · 8 not a git repository.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { citedIn, readRecords, stateRel, summarize } from '../decisions/index.mjs';
import { git } from '../git/index.mjs';
import { briefRules } from '../method/index.mjs';
import { openStore as profileStore } from '../profile/index.mjs';
import { globMatch } from '../router/index.mjs';
import { KINDS, open, resolve, writeTaskText } from '../state/index.mjs';
import { codeState } from '../verify/run.mjs';
import { openStore } from '../verify/index.mjs';
import { seal, unedited } from './brief.mjs';
import { EXIT } from './commands.mjs';

const DIFF_MAX = 4 * 1024 * 1024;
const DECISION_LINES = 20;
const NO_ACCEPTANCE = '(no acceptance points in the brief: name them by hand)';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fail = (code, message, hint) => ({ code: EXIT.FAIL, errors: [{ code, message, hint }] });
const usage = (code, message, hint) => ({ code: EXIT.USAGE, errors: [{ code, message, hint }] });

// Literal replacement of the template's placeholders in one pass (a value is never filled again); a placeholder the
// template lacks is a bug in the template or here.
export function renderReviewBrief(template, fills) {
  for (const ph of Object.keys(fills)) {
    if (!template.includes(ph)) throw new Error(`templates/task/review-brief.md has no ${JSON.stringify(ph)}: the template and lib/cli/review-brief.mjs disagree`);
  }
  const once = new RegExp(Object.keys(fills).map(escape).join('|'), 'g');
  const text = template.replace(once, (m) => fills[m]);
  return text.endsWith('\n') ? text : `${text}\n`;
}

// The numbered items of the `## Acceptance` section of a task brief.
function acceptanceOf(text) {
  if (text === null) return [];
  const out = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) inside = line.startsWith('## Acceptance');
    else if (inside && /^\d+\. /.test(line)) out.push(line);
  }
  return out;
}

export function reviewBrief({ args, flags, names, io, pluginRoot }) {
  const { bin } = names;
  const id = args.id;
  KINDS.task.path(id); // a malformed ID is a usage error (invalid-key)
  let asked = null;
  if (flags.round !== undefined) {
    asked = /^\d+$/.test(String(flags.round)) ? Number(flags.round) : NaN;
    if (!(asked >= 1 && asked <= 999)) return usage('invalid-value', `--round ${String(flags.round).slice(0, 40)}: expected an integer from 1 to 999`, `${bin} review brief ${id} --round 2`);
  }
  if (flags.force && !flags.write) return usage('missing-flag', '--force applies only with --write', `${bin} review brief ${id} --write --force`);
  const where = resolve({ cwd: io.cwd, env: io.env, names });
  if (!where.active) return { code: EXIT.REFUSED, errors: [{ code: 'inactive', message: `${where.repo} is not active: a review brief is rendered from its state`, hint: `'${bin} init' activates it` }] };
  const store = open(where.dir, { names });
  const task = store.read('task', id);
  if (!task) return fail('task-unknown', `no task ${id} in ${where.dir}`, `'${bin} task list' lists the tasks`);
  if (!task.class) return fail('task-unrouted', `${id} is not routed: its class decides the rules of the brief`, `${bin} route ${id} --paths <p,…> --loc <n>`);
  if (!task.base) return fail('base-missing', `${id} has no recorded base: the range of the review starts there`, `${bin} task start ${id} (or '${bin} task set ${id} started --branch <b> --base <sha>')`);

  const vs = openStore(where.dir, names);
  const recorded = vs.list('review').filter((k) => k.startsWith(`${id}/`)).map((k) => Number(k.slice(k.lastIndexOf('-r') + 2)));
  const round = asked ?? Math.max(0, ...recorded) + 1;
  const code = codeState(where, io.env);
  if (code.dirty) return fail('dirty-tree', `${where.worktree} has uncommitted changes: a review brief pins a sha`, 'commit the work, then render the brief');
  if (!code.head) return fail('no-commit', `${where.worktree} has no commit`, 'commit the work, then render the brief');
  const head = code.head;

  let from = task.base;
  if (round > 1) {
    const prev = store.readText(`tasks/${id}/review-r${round - 1}-brief.md`);
    const m = prev === null ? null : /^Range: [0-9a-f]+\.\.([0-9a-f]+)/m.exec(prev);
    if (m) from = m[1];
  }

  const rel = stateRel(where.worktree, where.dir);
  const exclude = rel ? [`:(exclude)${rel}`] : [];
  const env = io.env;
  const diff = git(['diff', '-U10', `${from}..${head}`, '--', '.', ...exclude], { cwd: where.worktree, env });
  if (diff.status !== 0) return fail('diff-failed', `git diff ${from}..${head} failed: ${diff.stderr.trim().slice(0, 200)}`, 'check that the base and HEAD exist in this checkout');
  if (Buffer.byteLength(diff.stdout) > DIFF_MAX) return fail('diff-too-large', `the diff of ${from}..${head} is over ${DIFF_MAX} bytes`, 'review in smaller rounds');
  const names0 = git(['diff', '--name-only', '-z', `${from}..${head}`, '--', '.', ...exclude], { cwd: where.worktree, env });
  if (names0.status !== 0) return fail('diff-failed', `git diff --name-only ${from}..${head} failed: ${names0.stderr.trim().slice(0, 200)}`, 'check that the base and HEAD exist in this checkout');
  const files = names0.stdout.split('\0').filter(Boolean);

  const previous = [];
  let rows = [];
  if (round > 1) {
    const doc = vs.read('review', `${id}/review-r${round - 1}`);
    const all = doc ? [...doc.findings.filter((f) => f.severity === 'blocking'), ...doc.findings.filter((f) => f.severity !== 'blocking')] : [];
    const scope = flags.scope === undefined ? null : String(flags.scope).split(',').map((s) => s.trim()).filter(Boolean);
    if (scope) {
      const bad = scope.filter((s) => !all.some((f) => f.id === s));
      if (bad.length || !scope.length) return usage('invalid-value', `--scope ${bad.join(',') || '(empty)'}: not a finding of round ${round - 1}`, `round ${round - 1} has ${all.map((f) => f.id).join(', ') || 'no findings'}`);
    }
    rows = all.filter((f) => !scope || scope.includes(f.id));
    for (const f of rows) previous.push(f.id);
    rows = rows.map((f) => `| ${f.id} | ${f.severity} | ${f.path}:${f.line ?? '?'} | ${String(f.text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')} |`);
  }

  const acceptance = acceptanceOf(store.readText(`tasks/${id}/brief.md`));
  const profile = profileStore(where.dir, names).read('profile');
  const risks = [];
  for (const file of files) for (const glob of profile?.riskPaths ?? []) if (globMatch(glob, file)) risks.push(`${file}: risk path ${glob}`);
  const focus = profile?.facts?.reviewFocus?.value;
  if (Array.isArray(focus)) for (const item of focus) risks.push(`review focus: ${item}`);
  const titles = new Map(readRecords(where.dir).records.map((r) => [r.doc.id, summarize(r).title]));
  const cited = [];
  for (const file of files) {
    for (const d of citedIn(join(where.worktree, file))) if (titles.has(d)) cited.push(`${d}: ${titles.get(d)} (cited in ${file})`);
  }
  risks.push(...cited.slice(0, DECISION_LINES));
  risks.push('data, writes, authorization and concurrency the diff touches (PRI-6)');

  const diffRel = `local/review/${id}-r${round}.diff`;
  const diffFile = join(where.dir, diffRel);
  // store.writeText is an internal method of the state store (atomic replace); lib/decisions/write.mjs uses it the same way.
  store.locked(() => {
    store.assertWritable();
    store.writeText(diffRel, diff.stdout);
  });

  const taskDir = join(where.dir, 'tasks', id);
  const reportFile = join(taskDir, 'report.md');
  const rules = briefRules({ cls: task.class, role: 'reviewer' });
  const template = readFileSync(join(pluginRoot, 'templates', 'task', 'review-brief.md'), 'utf8');
  const body = renderReviewBrief(template, {
    '<Task title>': task.title,
    '<task ID>': id,
    '<k>': String(round),
    '<trivial | standard | critical>': task.class,
    '<from>': from,
    '<head>': head,
    '<branch>': task.branch ?? '(none recorded)',
    '<brief path>': join(taskDir, 'brief.md'),
    '<report path>': existsSync(reportFile) ? reportFile : '(none yet)',
    '<diff path>': diffFile,
    '<rule IDs>': rules.join(' '),
    '<changed files>': files.length ? files.map((f) => `- ${f}`).join('\n') : '(none)',
    '<acceptance>': acceptance.length ? acceptance.join('\n') : NO_ACCEPTANCE,
    '<previous findings>': round > 1 ? ['| ID | Severity | Where | Finding |', '|---|---|---|---|', ...rows].join('\n') : '(first review: no previous findings)',
    '<risks>': risks.map((r) => `- ${r}`).join('\n'),
    '<schema path>': join(pluginRoot, 'templates', 'review.schema.json'),
    '{{bin}}': bin,
    '{{plugin}}': names.plugin,
  });
  const text = seal(body, bin);
  const data = {
    task: id, round, class: task.class, range: { from, head }, diffFile, files, acceptance, risks, previous, rules, written: null, file: null,
  };
  if (!flags.write) return { data, text };
  const w = writeTaskText({ cwd: io.cwd, env: io.env, names, id, name: 'review-brief', round, text, replace: (cur) => Boolean(flags.force) || unedited(cur) });
  const done = { ...data, written: w.outcome, file: w.file };
  if (w.outcome === 'kept') {
    return { code: EXIT.FAIL, data: done, errors: [{ code: 'brief-hand-written', message: `${w.file} was written or edited by hand: it is kept`, hint: `compare it with '${bin} review brief ${id} --round ${round}'; add --force to replace it` }] };
  }
  return { data: done, text: `${w.outcome}: ${w.file}\n` };
}
