// `review record <id> --from <file>` (spec §5.1, §8.2, SD-47; method REV-17): a typed review result becomes the next
// round tasks/<id>/review-r<k>.json. The Markdown review is a rendering and closes nothing.
//   - Input: a regular file (never a link) of at most 1 MB holding JSON, validated against templates/review.schema.json
//     (the output schema external reviewers get, so it is the one contract), then written through the review kind of
//     lib/state, which validates it again (atomic, locked). Invalid input: exit 2, one error per failing field.
//   - Only the task's owner records, only while the task is open (done and cancelled tasks take no further state).
//   - The round is the next free number, created exclusively (two records never share a round); the task gets the
//     event `review` { round, verdict, reviewer: kind }.
// The validator knows exactly the JSON Schema keywords the schema uses; any other keyword is an error, never ignored.
// An external review comes from its run (D4): `--kind external --run <runId>` reads the out file of a done reviewer
// run of the task (lib/runs record; a regular file, no link followed, capped) and stores the run ID and the sha256 of
// the out file's bytes, with reviewer { kind: external, id: <provider>:reviewer } from the record. A `--from` file
// never makes a review external: one that claims kind external is refused. Known limit: the reviewer id of a claude
// review is what the file says.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { authorHandle, stateRel } from '../decisions/index.mjs';
import { readRegularFile } from '../fsx/index.mjs';
import { RUN_ID, ownOutDir, runsStore } from '../runs/index.mjs';
import { KINDS, StateError } from '../state/index.mjs';
import { VERIFY_KINDS, reviewKey } from './kinds.mjs';
import { activeWhere, storeOf, unknownTask } from './run.mjs';

const INPUT_MAX = 1024 * 1024;
const ROUND_MAX = 999; // review-r<k>: k has at most three digits (the review kind's key)
const ERRORS_MAX = 10;
const SCHEMA_FILE = new URL('../../templates/review.schema.json', import.meta.url);
const KEYWORDS = new Set(['$schema', 'title', 'description', 'type', 'enum', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern']);

const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });
const fail = (code, message, hint = '') => new StateError(code, 'FAIL', message, { hint });
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (type, v) => type === typeOf(v) || (type === 'number' && typeof v === 'number');
const field = (path, key) => (path === '' ? key : `${path}.${key}`);

let cached = null;
export const reviewSchema = () => (cached ??= JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')));

// The messages "<field>: <what is wrong>" of `value` against the JSON Schema subset `schema` ([] when valid).
export function schemaErrors(schema, value, path = '') {
  const at = path || 'document';
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) throw new Error(`review schema: unsupported keyword ${k} at ${at}`);
  if (schema.type !== undefined && ![].concat(schema.type).some((t) => fits(t, value))) return [`${at}: expected ${[].concat(schema.type).join(' or ')}, got ${typeOf(value)}`];
  const out = [];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    const n = [...value].length;
    if (schema.minLength !== undefined && n < schema.minLength) out.push(`${at}: at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && n > schema.maxLength) out.push(`${at}: ${n} characters, the limit is ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) out.push(`${at}: holds characters the schema does not allow (line breaks, control, zero-width or bidi characters)`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: ${value.length} items, the limit is ${schema.maxItems}`);
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: at least ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => out.push(...schemaErrors(schema.items, item, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) out.push(`${field(path, k)}: missing`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, k)) out.push(...schemaErrors(schema.properties[k], v, field(path, k)));
      else if (schema.additionalProperties === false) out.push(`${field(path, k)}: unknown field`);
    }
  }
  return out;
}

export const reviewErrors = (value) => schemaErrors(reviewSchema(), value);

export const EXTERNAL_HINT = 'use --run <runId> (the review of an external run comes from its record)';
const refused = (code, message, hint = '') => new StateError(code, 'REFUSED', message, { hint });

// { value, bytes } of the input file; USAGE when it is not a readable regular file of at most 1 MB holding JSON.
function readInput(cwd, from) {
  const file = isAbsolute(from) ? from : join(cwd, from);
  let bytes;
  let text;
  try {
    bytes = readRegularFile(file, { max: INPUT_MAX });
    text = bytes.toString('utf8');
  } catch (err) {
    if (err.code === 'ENOTREGULAR') throw usage('review-unreadable', `${from} is not a regular file`, 'give the path of the review JSON file (links are not followed)');
    if (err.code === 'ETOOBIG') throw usage('review-unreadable', `${from} is over the limit of ${INPUT_MAX} bytes`, 'a review holds at most 1000 findings');
    throw usage('review-unreadable', `${from} cannot be read (${err.code ?? err.message})`, 'give the path of the review JSON file');
  }
  try {
    return { value: JSON.parse(text), bytes };
  } catch (err) {
    throw usage('invalid-review', `${from} is not JSON: ${err.message}`.slice(0, 300), 'the file holds one JSON object: {"verdict", "reviewer", "findings"}');
  }
}

// The done reviewer run `run` of task `id` (lib/runs record) whose out file is in the directory exec bound to the run
// (lib/runs ownOutDir, the check run-supervise makes); USAGE for a malformed or unknown ID, REFUSED otherwise.
function reviewerRun(where, names, id, run) {
  if (typeof run !== 'string' || !RUN_ID.test(run)) throw usage('invalid-value', `--run ${String(run).slice(0, 80)}: not a run ID`, `'${names.bin} runs' lists the runs`);
  const rec = runsStore(where.dir, names).read('run', run);
  if (rec === null) throw usage('run-unknown', `no run ${run} in ${where.dir}`, `'${names.bin} runs' lists the runs`);
  const why = rec.task !== id ? `it belongs to ${rec.task}` : rec.role !== 'reviewer' ? `it is an ${rec.role} run` : rec.status !== 'done' ? `its status is ${rec.status}` : rec.outFile === null ? 'it has no out file'
    : !ownOutDir(rec) ? 'its out file is not out.json in the private temp directory exec bound to the run' : '';
  if (why) throw refused('run-not-reviewable', `${run} is not a done reviewer run of ${id}: ${why}`, `'${names.bin} exec --task ${id} --role reviewer' starts one`);
  return rec;
}

// { invalid: [messages] } for input that breaks the schema, else { task, round, key, file, doc } after the write.
// `from`: a claude review file; `run`: the run ID of an external review (its out file is the input).
export function recordReview({ cwd, env, names, id, from, run, at = new Date().toISOString() }) {
  const where = activeWhere({ cwd, env, names });
  KINDS.task.path(id);
  const rec = run === undefined ? null : reviewerRun(where, names, id, run);
  const { value: input, bytes } = readInput(cwd, rec ? rec.outFile : from);
  const invalid = reviewErrors(input);
  if (invalid.length) return { invalid: invalid.slice(0, ERRORS_MAX) };
  if (!rec && input.reviewer.kind === 'external') throw refused('external-needs-run', `${from} claims an external reviewer: a file alone never makes a review external`, EXTERNAL_HINT);
  const store = storeOf(where, names);
  const task = store.read('task', id);
  if (task === null) throw unknownTask(id, where, names);
  const handle = authorHandle({ store, where, names, env });
  const open = (t) => {
    if (t.owner !== handle) throw fail('not-owner', `${id} belongs to ${t.owner}; only its owner records its reviews`, `ask ${t.owner}`);
    if (t.status === 'done' || t.status === 'cancelled') throw fail('task-closed', `${id} is ${t.status}: a closed task takes no further state`, `'${names.bin} task new' starts a new task`);
  };
  open(task);
  const doc = rec
    ? { verdict: input.verdict, reviewer: { kind: 'external', id: `${rec.provider}:reviewer` }, findings: input.findings, run: rec.runId, sha256: createHash('sha256').update(bytes).digest('hex') }
    : { verdict: input.verdict, reviewer: input.reviewer, findings: input.findings };
  const taken = store.list('review').filter((k) => k.startsWith(`${id}/`)).map((k) => Number(k.slice(k.lastIndexOf('-r') + 2)));
  let round = Math.max(0, ...taken) + 1;
  while (round <= ROUND_MAX && !store.create('review', reviewKey(id, round), doc)) round++;
  if (round > ROUND_MAX) throw usage('limit-exceeded', `${id} has ${ROUND_MAX} review rounds, the limit`, 'start a new task');
  store.update('task', id, (cur) => {
    open(cur);
    return { ...cur, events: [...cur.events, { at, by: handle, event: 'review', data: { round, verdict: doc.verdict, reviewer: doc.reviewer.kind } }] };
  });
  const rel = stateRel(where.worktree, where.dir); // shown from the worktree, absolute outside it
  const path = `tasks/${reviewKey(id, round)}.json`;
  return { task: id, round, key: reviewKey(id, round), file: rel ? `${rel}/${path}` : join(where.dir, path), doc: { schema: VERIFY_KINDS.review.version, ...doc } };
}
