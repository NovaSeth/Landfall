// Writing decision records (spec §7.10, SD-9, GC5), all through lib/state:
// - new: the ID comes from allocateId (prefix D, the developer's handle), which creates the record file exclusively
//   with its complete text under the store lock. Its number is above every local record and tombstone and above
//   the handle's records and tombstones on origin/main: the series' high-water mark (the state `counter` kind) is
//   raised to the origin/main maximum first.
// - supersede: the new record lists the old ones in `supersedes`; then each old record gets `status: superseded`
//   and `supersededBy` (the only edit of another record), its other bytes unchanged.
// - retire: `status: retired` first, then a tombstone (lib/state retireId) keeps the number from reuse; the file
//   stays. A failed rewrite leaves no tombstone (review r1); both steps are idempotent, so a retire cut short is
//   finished by running it again.
// Records are read with CR LF normalized to LF (a rewrite writes LF). Input with hidden characters (lib/text) is
// refused, so a record never carries what a reader cannot see.
// Shared gap (reported): lib/state has no public call that replaces a decision record's text, so rewrite() below
// uses the store's internal locked(), assertWritable(), readText() and writeText() (atomic replace through lib/fsx
// under the store lock). A crash between allocation and rewrite leaves the new record listing an old one that is
// still active; `decisions check` reports that pair.
import { join, relative, sep } from 'node:path';
import { fileSelection, reviewSelection } from '../findings/index.mjs';
import { git } from '../git/index.mjs';
import { PATTERNS, StateError, allocateId, check, emailHash, gitIdentity, readProjects, retireId } from '../state/index.mjs';
import { codePointName, hidden } from '../text/clean.mjs';
import { DECISION, formatRecord, parseRecord, recordErrors, setFields } from './record.mjs';
import { stateRel } from './check.mjs';

const usage = (code, message, hint = '') => new StateError(code, 'USAGE', message, { hint });

// The developer's handle: the one linked for this repository in machine data, else the registered team handle
// whose email hash matches the repository's git user.email.
export function authorHandle({ store, where, names, env }) {
  const linked = where.dataDir ? readProjects(where.dataDir, names).projects[where.repo]?.handle : undefined;
  let handle = linked;
  if (!handle) {
    const { email } = gitIdentity(where.repo, { env });
    const hash = email ? emailHash(email) : null;
    handle = hash ? store.list('team').find((h) => store.read('team', h)?.emailSha256 === hash) : undefined;
  }
  if (!handle || store.read('team', handle) === null) {
    throw new StateError('handle-unknown', 'USAGE', handle ? `handle ${handle} is not registered in this repository` : 'no developer handle is registered for this git user.email', { hint: `register one: ${names.bin} init --handle <H>` });
  }
  return handle;
}

// Highest number of the handle's D series on origin/main (records and tombstones); null when it cannot be read.
function remoteHigh({ where, handle, env }) {
  const own = stateRel(where.repo, where.dir);
  if (!own) return null;
  const r = git(['ls-tree', '-r', '--name-only', 'origin/main', '--', `${own}/decisions`, `${own}/tombstones`], { cwd: where.repo, env });
  if (r.status !== 0) return null;
  const re = new RegExp(`/(?:decisions/D-${handle}-([1-9]\\d{0,5})\\.md|tombstones/D-${handle}-([1-9]\\d{0,5})\\.json)$`);
  let top = 0;
  for (const line of r.stdout.split('\n')) {
    const m = re.exec(line);
    if (m) top = Math.max(top, Number(m[1] ?? m[2]));
  }
  return top;
}

// The record of `id` as parsed text ({ doc, text }); USAGE when it is missing or invalid.
function current(store, id) {
  const text = store.readText(DECISION.path(id))?.replace(/\r\n/g, '\n') ?? null;
  if (text === null) throw usage('unknown-decision', `${id} has no record`, 'list the records with the decisions find command');
  const { doc, errors } = parseRecord(text, `${id}.md`);
  const all = doc ? [...errors, ...recordErrors(doc, `${id}.md`)] : errors;
  if (all.length) throw new StateError('invalid-decision', 'FAIL', all[0], { hint: 'fix the record first (decisions check lists every problem)' });
  return { doc, text };
}

// Sets frontmatter fields of an existing record under the store lock; true when the file changed. `active`: the record
// must still be active under the lock (a concurrent supersede or retire won: refuse instead of overwriting).
function rewrite(store, id, fields, { active = false, by = null } = {}) {
  return store.locked(() => {
    store.assertWritable();
    const { doc: before, text } = current(store, id);
    if (active && before.status !== 'active') throw new StateError('not-active', 'FAIL', `${id} became ${before.status} meanwhile; ${by} lists it in supersedes but it was not changed`, { hint: `retire ${by}, or set its pair by hand; decisions check shows the pair` });
    const next = setFields(text, fields);
    if (next === null) throw new StateError('invalid-decision', 'FAIL', `${id}: the frontmatter block cannot be found`, { hint: 'fix the record first (decisions check lists every problem)' });
    if (next === text) return false;
    const { doc, errors } = parseRecord(next, `${id}.md`);
    const all = [...errors, ...recordErrors(doc, `${id}.md`)];
    if (all.length) throw new StateError('invalid-decision', 'FAIL', all[0], { hint: 'fix the record first (decisions check lists every problem)' });
    store.writeText(DECISION.path(id), next);
    return true;
  });
}

const fieldError = (errors) => {
  const e = errors[0];
  return new StateError(e.code, 'USAGE', e.message, { hint: 'shorten or correct the value; nothing was written' });
};

// Creates a record; input { title, why, cost, scope: [globs], kind, supersedes: [ids], allowsTestRemoval: [test ids],
// task and remaining: [finding ids] (review-close) }.
// Returns { id, file, supersedes }.
export function createDecision(options) {
  return options.store.batch((store) => createDecisionLocked({ ...options, store }));
}

function createDecisionLocked({ store, where, names, env, handle, input, today = new Date().toISOString().slice(0, 10) }) {
  const allows = input.allowsTestRemoval ?? [];
  for (const [flag, value] of [['--title', input.title], ['--why', input.why], ['--cost', input.cost], ...(input.scope ?? []).map((g) => ['--scope', g]), ...allows.map((t) => ['--allows-test-removal', t]), ['--task', input.task ?? ''], ...(input.remaining ?? []).map((f) => ['--remaining', f])]) {
    const h = hidden(value)[0];
    if (h) throw usage('invalid-value', `${flag} contains the hidden character ${codePointName(h.codePoint)}`, 'remove it: a record must not hold text a reader cannot see');
  }
  const supersedes = [...new Set(input.supersedes ?? [])];
  for (const id of supersedes) {
    if (!PATTERNS.decisionId.test(id)) throw usage('invalid-value', `not a decision ID: ${id}`, 'a decision ID is D-<handle>-<number>');
    const { doc } = current(store, id);
    if (doc.status !== 'active') {
      throw usage('not-active', `${id} is ${doc.status}; only an active decision can be superseded`, doc.supersededBy ? `supersede its successor ${doc.supersededBy} instead` : 'record a new decision without --supersedes');
    }
  }
  const doc = {
    schema: DECISION.version, id: `D-${handle}-1`, title: input.title, status: 'active', kind: input.kind ?? 'general', date: today, author: handle,
    supersedes, supersededBy: null, scope: input.scope ?? [], allowsTestRemoval: allows,
    ...(input.task !== undefined || input.remaining !== undefined ? { task: input.task, remaining: input.remaining ?? [] } : {}),
  };
  const errors = check(DECISION, doc);
  if (errors.length) throw fieldError(errors);
  if (doc.kind === 'review-close' && !doc.task) throw usage('missing-flag', 'kind review-close needs --task <id>', 'name the task whose review step it closes, and its open blocking findings with --remaining');
  const selection = doc.kind === 'review-close' ? reviewSelection(store, { task: doc.task, ids: doc.remaining ?? [], blocking: true }) : null;
  const body = ['## What', '', input.title, '', '## Why', '', input.why.trim(), '', '## Cost if wrong', '', input.cost.trim(), '', '## Alternatives', '', 'None recorded.', ''].join('\n');

  const high = remoteHigh({ where, handle, env });
  const warnings = high === null ? [{ code: 'remote-unchecked', message: stateRel(where.repo, where.dir) ? 'no origin/main: the number was checked against local records only (fetch first when others record decisions)' : 'the state directory is outside the repository: the number was checked against local records only' }] : [];
  if (high > 0) store.update('counter', `D-${handle}`, (cur) => ((cur?.high ?? 0) >= high ? undefined : { high }));
  const id = allocateId(store, { prefix: 'D', handle, build: (next) => formatRecord({ ...doc, id: next }, body) });
  const filed = selection ? fileSelection(store, selection, handle) : null;
  for (const old of supersedes) rewrite(store, old, { status: 'superseded', supersededBy: id }, { active: true, by: id });
  return { id, file: relative(where.worktree, join(where.dir, DECISION.path(id))).split(sep).join('/'), supersedes, warnings, ...(filed === null ? {} : { filed }) };
}

// Retires a decision: tombstone, then status retired. Returns { id, tombstone (created now), changed (record) }.
export function retireDecision({ store, id, handle, reason = '' }) {
  if (!PATTERNS.decisionId.test(id)) throw usage('invalid-value', `not a decision ID: ${id}`, 'a decision ID is D-<handle>-<number>');
  const hasRecord = store.readText(DECISION.path(id)) !== null;
  if (!hasRecord && store.read('tombstone', id) === null) throw usage('unknown-decision', `${id} has no record`, 'list the records with the decisions find command');
  if (hasRecord) current(store, id);
  const changed = hasRecord ? rewrite(store, id, { status: 'retired' }) : false;
  const tombstone = retireId(store, id, { by: handle, reason });
  return { id, tombstone, changed };
}
