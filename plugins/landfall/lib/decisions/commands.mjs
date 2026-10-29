// Command handlers of the decisions unit (spec §7.10, §8.2), loaded by their rows in lib/cli/commands.mjs:
// `decide` (with --allows-test-removal: the test IDs verify may see removed or newly skipped; kind test-removal unless
// --kind says otherwise), `decisions supersede`, `decisions retire` (change files: consent is checked by the CLI first) and
// `decisions check`, `decisions show`, `decisions find` (read-only). Context comes from io (cwd, env), never from
// process state (COD-9). A StateError becomes its exit code with the error and hint unchanged.
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { PATTERNS, StateError, open, resolve } from '../state/index.mjs';
import { checkDecisions, stateRel } from './check.mjs';
import { citedIn, contextLine, inside, realTarget, relevantDecisions } from './context.mjs';
import { DECISION, parseRecord, recordErrors } from './record.mjs';
import { readRecords, summarize } from './records.mjs';
import { authorHandle, createDecision, retireDecision } from './write.mjs';

const guarded = (fn) => (ctx) => {
  try {
    return fn(ctx);
  } catch (err) {
    if (err instanceof StateError) return { code: EXIT[err.exit], errors: [err] };
    throw err;
  }
};
const usage = (code, message, hint = '') => ({ code: EXIT.USAGE, errors: [{ code, message, hint }] });
const here = ({ io, names }) => resolve({ cwd: io.cwd, env: io.env, names });
// A record's path as shown: relative to the worktree when the state directory is inside it, else absolute.
const fileOf = (where, id) => {
  const own = stateRel(where.worktree, where.dir);
  return own ? `${own}/${DECISION.path(id)}` : join(where.dir, DECISION.path(id));
};

function requireActive(where, names) {
  if (!where.active) throw new StateError('inactive', 'REFUSED', `${where.repo}: decisions are recorded only in an active repository`, { hint: `activate it first: ${names.bin} init` });
}

// Comma-separated values; a comma inside {…} belongs to a glob.
export function splitList(value) {
  if (value === undefined) return [];
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of String(value)) {
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Test IDs of --allows-test-removal: comma-separated, where a comma inside a JSON ID (["file","title",1]: brackets
// and strings) belongs to the ID; a JSON ID is written in its canonical form (no spaces), the form verify prints.
export function splitTestIds(value) {
  if (value === undefined) return [];
  const out = [];
  let cur = '';
  let depth = 0;
  let str = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (str) {
      if (c === '\\') { cur += c + (value[++i] ?? ''); continue; }
      if (c === '"') str = false;
    } else if (c === '"') str = true;
    else if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  const canonical = (id) => {
    if (!id.startsWith('[')) return id;
    try { const v = JSON.parse(id); return Array.isArray(v) ? JSON.stringify(v) : id; } catch { return id; }
  };
  return [...new Set(out.map((s) => s.trim()).filter(Boolean).map(canonical))];
}

const FILE_MAX = 65536;
const FILE_KEYS = ['title', 'why', 'cost', 'scope', 'kind', 'supersedes', 'allowsTestRemoval', 'task', 'remaining'];

// --from-file <json>: the fields of a decision as a JSON object (title, why, cost, scope, kind, supersedes,
// allowsTestRemoval, task, remaining; lists as arrays or comma-separated text); a flag given on the command line wins.
function fromFile(flags, io) {
  const file = isAbsolute(flags.fromFile) ? flags.fromFile : join(io.cwd, flags.fromFile);
  let doc;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > FILE_MAX) return { error: usage('decision-file-unreadable', `${flags.fromFile} is not a regular file of at most ${FILE_MAX} bytes`, 'give a JSON file with title, why and cost') };
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: usage('decision-file-unreadable', `${flags.fromFile} cannot be read as JSON: ${String(err.message).slice(0, 120)}`, 'give a JSON file with title, why and cost') };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: usage('decision-file-unreadable', `${flags.fromFile} does not hold a JSON object`, 'give a JSON object with title, why and cost') };
  const unknown = Object.keys(doc).filter((k) => !FILE_KEYS.includes(k));
  if (unknown.length) return { error: usage('invalid-value', `${flags.fromFile}: unknown field ${unknown[0]}`, `fields: ${FILE_KEYS.join(', ')}`) };
  const merged = { ...flags };
  for (const k of FILE_KEYS) {
    if (doc[k] === undefined || merged[k] !== undefined) continue;
    const v = doc[k];
    if (Array.isArray(v)) merged[k] = k === 'allowsTestRemoval' ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(',') : v.map(String).join(',');
    else if (typeof v === 'string') merged[k] = v;
    else return { error: usage('invalid-value', `${flags.fromFile}: ${k} must be text${k === 'scope' || k === 'supersedes' || k === 'allowsTestRemoval' || k === 'remaining' ? ' or a list' : ''}`, 'fix the file; nothing was written') };
  }
  return { flags: merged };
}

// --from-verify <task>: the tests the task's latest verify saw removed or newly skipped become allowsTestRemoval; the
// title defaults to what they are; the kind is test-removal; the scope lists their files. verify.json is read as text
// through the store (the verify unit owns its kind).
function fromVerify(flags, store, names) {
  const id = String(flags.fromVerify);
  if (!PATTERNS.taskId.test(id)) return { error: usage('invalid-value', `--from-verify ${id.slice(0, 40)}: not a task ID`, 'a task ID is T-<handle>-<number>') };
  let v;
  try { v = JSON.parse(store.readText(`tasks/${id}/verify.json`) ?? 'null'); } catch { v = null; }
  if (!v || typeof v !== 'object' || !v.inventory) return { error: { code: EXIT.FAIL, errors: [{ code: 'verify-missing', message: `${id} has no verify record to take the removed tests from`, hint: `run ${names.bin} verify ${id} first` }] } };
  const ids = [...new Set([...(v.inventory.removed ?? []), ...(v.inventory.newlySkipped ?? [])])];
  if (!ids.length) return { error: { code: EXIT.FAIL, errors: [{ code: 'nothing-to-allow', message: `the latest verify of ${id} saw no test removed or newly skipped`, hint: 'nothing to allow; a renamed test needs no decision' }] } };
  const files = [...new Set(ids.map((x) => { try { const a = JSON.parse(x); return Array.isArray(a) && typeof a[0] === 'string' && a[0] !== '' ? a[0] : null; } catch { return null; } }).filter(Boolean))];
  const given = splitTestIds(flags.allowsTestRemoval);
  const merged = {
    ...flags,
    allowsTestRemoval: [...new Set([...given, ...ids])].join(','),
    title: flags.title ?? `${id}: ${ids.length} ${ids.length === 1 ? 'test' : 'tests'} removed or newly skipped`,
    kind: flags.kind ?? 'test-removal',
    scope: flags.scope ?? (files.length ? files.join(',') : undefined),
  };
  return { flags: merged };
}

function create({ flags: given, names, io }, supersedes) {
  let flags = given;
  if (flags.fromFile !== undefined) {
    const r = fromFile(flags, io);
    if (r.error) return r.error;
    flags = r.flags;
  }
  const where = here({ io, names });
  requireActive(where, names);
  const store = open(where.dir, { names });
  if (flags.fromVerify !== undefined) {
    const r = fromVerify(flags, store, names);
    if (r.error) return r.error;
    flags = r.flags;
  }
  const missing = ['title', 'why', 'cost'].filter((k) => typeof flags[k] !== 'string' || flags[k].trim() === '');
  if (missing.length) {
    return { code: EXIT.USAGE, errors: missing.map((k) => ({ code: 'missing-flag', message: `--${k} <text> is required`, hint: `${names.bin} decide --title <what> --why <why> --cost <cost if wrong>` })) };
  }
  const handle = authorHandle({ store, where, names, env: io.env });
  const allowsTestRemoval = splitTestIds(flags.allowsTestRemoval);
  const kind = flags.kind ?? (allowsTestRemoval.length ? 'test-removal' : flags.task !== undefined ? 'review-close' : undefined);
  const review = flags.task !== undefined || flags.remaining !== undefined ? { task: flags.task, remaining: splitList(flags.remaining) } : {};
  const input = { title: flags.title.trim(), why: flags.why, cost: flags.cost, scope: splitList(flags.scope), kind, supersedes, allowsTestRemoval, ...review };
  const result = createDecision({ store, where, names, env: io.env, handle, input });
  const lines = [`${result.id} created: ${result.file}`, ...result.supersedes.map((old) => `${old} superseded by ${result.id}`)];
  if (result.filed) lines.push(`filed: ${result.filed.length ? result.filed.join(', ') : 'none'}`);
  return { data: result, text: `${lines.join('\n')}\n`, warnings: result.warnings.map((w) => w.message) };
}

export const decide = guarded((ctx) => create(ctx, splitList(ctx.flags.supersedes ?? (ctx.flags.fromFile !== undefined ? fromFile(ctx.flags, ctx.io).flags?.supersedes : undefined))));
export const supersede = guarded((ctx) => create(ctx, [String(ctx.args.id)]));

export const retire = guarded(({ args, flags, names, io }) => {
  const id = String(args.id);
  if (!PATTERNS.decisionId.test(id)) return usage('invalid-value', `not a decision ID: ${id}`, 'a decision ID is D-<handle>-<number>');
  const where = here({ io, names });
  requireActive(where, names);
  const store = open(where.dir, { names });
  const handle = authorHandle({ store, where, names, env: io.env });
  const r = retireDecision({ store, id, handle, reason: flags.reason ?? '' });
  return { data: { ...r, file: fileOf(where, id) }, text: r.tombstone || r.changed ? `${id} retired\n` : `${id} was already retired\n` };
});

const ciSet = (env) => typeof env?.CI === 'string' && !/^(?:|0|false|no)$/i.test(env.CI.trim());

export const check = guarded(({ flags, names, io }) => {
  const where = here({ io, names });
  const strict = Boolean(flags.ci) || ciSet(io.env);
  const r = checkDecisions({ where, names, env: io.env, strict });
  const lines = r.warnings.map((w) => `warning: ${w.message}`);
  lines.push(r.active
    ? `decisions check: ${r.records} records, ${r.citations} citations in ${r.files} files, ${r.problems.length} problems, ${r.warnings.length} warnings${strict ? ' (strict)' : ''}`
    : 'decisions check: no active state directory here; nothing to check');
  const { problems, ...data } = r;
  return { code: problems.length ? EXIT.FAIL : EXIT.OK, data, errors: problems, text: `${lines.join('\n')}\n` };
});

export const show = guarded(({ args, names, io }) => {
  const id = String(args.id);
  if (!PATTERNS.decisionId.test(id)) return usage('invalid-value', `not a decision ID: ${id}`, 'a decision ID is D-<handle>-<number>');
  const where = here({ io, names });
  const file = join(where.dir, DECISION.path(id));
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) {
    const tomb = where.active ? open(where.dir, { names }).read('tombstone', id) : null;
    if (!tomb) return usage('unknown-decision', `${id} has no record`, `list the records with '${names.bin} decisions find'`);
    return { data: { id, status: 'retired', tombstone: tomb }, text: `${id} is retired (${tomb.retiredAt} by ${tomb.by}${tomb.reason ? `: ${tomb.reason}` : ''}); its record file is gone\n` };
  }
  if (!st.isFile()) return { code: EXIT.FAIL, errors: [{ code: 'invalid-decision', message: `${fileOf(where, id)} is not a regular file`, hint: 'records are never read through links' }] };
  const text = readFileSync(file, 'utf8');
  const { doc, errors } = parseRecord(text, `${id}.md`);
  const problems = doc ? [...errors, ...recordErrors(doc, `${id}.md`)] : errors;
  return { data: { id, file: fileOf(where, id), status: doc?.status ?? null, title: doc?.title ?? null, record: doc, problems }, text };
});

export const find = guarded(({ args, flags, names, io }) => {
  const where = here({ io, names });
  let picked = (where.active ? readRecords(where.dir).records : []).map((r) => ({ r, s: summarize(r) }));
  if (flags.path !== undefined) {
    const target = realTarget(isAbsolute(flags.path) ? flags.path : join(io.cwd, flags.path));
    const rel = target && inside(where.worktree, target.path);
    if (!rel) return usage('outside-repository', `${flags.path} is not inside the repository ${where.worktree}`, 'give a path inside the repository');
    const byId = new Map(picked.map((p) => [p.s.id, p]));
    picked = relevantDecisions(picked.map((p) => p.s), { path: rel, cited: citedIn(target.path) }).map((s) => byId.get(s.id));
  }
  const words = (args.words ?? []).map((w) => w.toLowerCase());
  if (words.length) picked = picked.filter(({ r }) => { const text = `${r.id} ${r.doc.title} ${r.body}`.toLowerCase(); return words.every((w) => text.includes(w)); });
  const decisions = picked.map(({ s }) => ({ id: s.id, status: s.status, title: s.title, supersededBy: s.supersededBy, scope: s.scope, file: fileOf(where, s.id) }));
  return { data: { decisions }, text: picked.length ? `${picked.map(({ s }) => contextLine(s)).join('\n')}\n` : 'no matching decision\n' };
});
