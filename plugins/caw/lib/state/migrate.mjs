// Forward migrations of a store (spec §5.4, SD-10, GC9, REV-57). Every file of a known kind (outside local/)
// whose schema is older than its kind is upgraded through the chain (lib/state/upgrade.mjs).
// Under the store lock: plan the whole store first (a newer store or file refuses with exit 7, a corrupt file
// or a result that fails its schema stops with state-invalid, exit 1), then copy the original bytes of each file
// to local/backup/<stamp>/<path> and replace the file atomically; state.json (the store schema) last. A dry run
// returns the plan without taking the lock.
// A step that carries data to another single-file kind (its `carry`, lib/state/migrations/index.mjs) adds a step for
// that file (created when absent), written before the source; nothing is carried when the target already holds it.
// Files at the current schema and files of other kinds are never touched otherwise.
// A run killed at any point leaves every file whole (old or new); a re-run finishes the rest, and a run with
// nothing older writes nothing (idempotent, re-runnable).
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { invalidState } from './document.mjs';
import { newerSchema } from './errors.mjs';
import { unsafe } from './store.mjs';
import { format, validate } from './schema.mjs';
import { upgradeDoc } from './upgrade.mjs';

const ID = /^(\d{3})-([a-z][a-z0-9]*)-([a-z0-9-]+)$/;
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// Problems of a migration list against the kinds ([] when sound): ids NNN-<kind>-<name> in increasing order,
// known kinds, steps n → n + 1 within the kind's version, one step per schema, no gap from 1 to the version.
export function checkChain(kinds, migrations) {
  const problems = [];
  const seen = new Map();
  let last = 0;
  for (const m of migrations) {
    const id = String(m?.id);
    const parts = ID.exec(id);
    if (!parts) { problems.push(`${id}: the id is not NNN-<kind>-<name>`); continue; }
    if (Number(parts[1]) <= last) problems.push(`${id}: ids must increase in list order`);
    last = Math.max(last, Number(parts[1]));
    if (parts[2] !== m.kind) problems.push(`${id}: the id names kind ${parts[2]}, the step migrates ${m.kind}`);
    const kind = Object.values(kinds).find((k) => k.name === m.kind);
    if (!kind) { problems.push(`${id}: unknown kind ${m.kind}`); continue; }
    if (typeof m.up !== 'function') problems.push(`${id}: up is not a function`);
    if (!Number.isInteger(m.from) || m.from < 1 || m.to !== m.from + 1) problems.push(`${id}: a step goes from schema n >= 1 to n + 1`);
    if (m.to > kind.version) problems.push(`${id}: goes beyond ${kind.name} schema ${kind.version}`);
    if (m.carry !== undefined) {
      const target = Object.values(kinds).find((k) => k.name === m.carry?.kind);
      if (!target || target.keyPattern || kind.keyPattern || target.name === kind.name) problems.push(`${id}: carry goes from a single-file kind to another known single-file kind`);
      if (typeof m.carry?.into !== 'function') problems.push(`${id}: carry.into is not a function`);
    }
    const froms = seen.get(kind.name) ?? new Set();
    if (froms.has(m.from)) problems.push(`${id}: a second step from ${kind.name} schema ${m.from}`);
    froms.add(m.from);
    seen.set(kind.name, froms);
  }
  for (const kind of Object.values(kinds)) {
    for (let v = 1; v < kind.version; v++) if (!seen.get(kind.name)?.has(v)) problems.push(`${kind.name}: no step from schema ${v}`);
  }
  return problems;
}

// Paths of all files under the store except local/ (relative, '/'-separated). A symbolic link anywhere, or an
// entry whose name matches a state file only when case is ignored, is refused (never followed, never skipped).
function files(store) {
  const out = [];
  const kinds = Object.values(store.kinds);
  const walk = (rel) => {
    for (const name of store.entries(rel)) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === 'local') continue;
      const st = lstatSync(join(store.dir, r), { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) {
        if (!kinds.some((k) => k.match.test(r)) && kinds.some((k) => new RegExp(k.match.source, 'i').test(r))) {
          throw unsafe(join(store.dir, r), 'differs in case from the name of a state file');
        }
        out.push(r);
      }
    }
  };
  walk('');
  return out;
}

// The canonical text of the upgraded document, or null when the file is at its kind's schema.
function upgradeText(store, kind, rel, text) {
  const where = store.abs(rel);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw invalidState(where, 'not valid JSON');
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Number.isInteger(doc.schema) || doc.schema < 1) throw invalidState(where, 'no integer schema field');
  if (doc.schema > kind.version) throw newerSchema(store.names, where, doc.schema, kind.version);
  if (doc.schema === kind.version) return null;
  const next = upgradeDoc(kind, doc, store.migrations, where);
  const errors = validate(kind.spec, next);
  if (errors.length) throw invalidState(where, `after migration to schema ${kind.version}: ${errors[0].message}`, errors);
  if (kind.key && next[kind.key] !== kind.match.exec(rel)[1]) throw invalidState(where, `${kind.key} does not match the file name after migration`);
  return format(kind.spec, next);
}

function plan(store) {
  const kinds = Object.values(store.kinds);
  const steps = [];
  for (const rel of files(store)) {
    const kind = kinds.find((k) => k.match.test(rel));
    if (!kind) continue;
    const before = store.readText(rel);
    if (before === null) continue;
    const after = upgradeText(store, kind, rel, before);
    if (after === null) continue;
    const from = JSON.parse(before).schema;
    const ids = store.migrations.filter((m) => m.kind === kind.name && m.from >= from).sort((a, b) => a.from - b.from).map((m) => m.id);
    steps.push({ rel, kind, from, to: kind.version, ids, before, after });
  }
  carry(store, steps);
  const stateRel = store.kinds.state.path();
  return steps.sort((a, b) => (a.rel === stateRel) - (b.rel === stateRel) || natural(a.rel, b.rel));
}

// The steps that carry data out of a planned source file: the target's planned or current document with the data
// added (a new step, or the target's own step with the data merged in); nothing when the text would not change.
function carry(store, steps) {
  for (const m of store.migrations) {
    if (!m.carry) continue;
    const src = steps.find((s) => s.kind.name === m.kind && !s.kind.keyPattern && s.from <= m.from);
    const target = Object.values(store.kinds).find((k) => k.name === m.carry.kind && !k.keyPattern);
    if (!src || !target) continue;
    const at = upgradeDoc(src.kind, JSON.parse(src.before), store.migrations, store.abs(src.rel), m.from);
    const rel = target.path();
    const own = steps.find((s) => s.rel === rel);
    const text = own ? own.after : store.readText(rel);
    const cur = text === null ? null : own ? JSON.parse(text) : store.parse(target, rel, text, { write: true });
    const next = m.carry.into(cur === null ? null : structuredClone(cur), at);
    if (next === undefined) continue;
    const errors = validate(target.spec, next);
    if (errors.length) throw invalidState(store.abs(rel), `with what ${m.id} carries from ${src.rel}: ${errors[0].message}`, errors);
    const after = format(target.spec, next);
    if (after === text) continue;
    if (own) Object.assign(own, { after, ids: [...own.ids, m.id] });
    else steps.push({ rel, kind: target, from: cur?.schema ?? null, to: target.version, ids: [m.id], before: text, after });
  }
}

// { steps: [{ rel, kind, from (null: a new file), to, ids }], backup: path of the backup directory inside the store, or null }.
// A dry run plans read-only, without the lock. Otherwise plan and apply hold the store lock, which keeps every
// writer out until the migration is complete; files are written backup first, state.json last.
export function migrate(store, { dryRun = false, at = new Date() } = {}) {
  const report = (steps) => steps.map(({ rel, kind, from, to, ids }) => ({ rel, kind: kind.name, from, to, ids }));
  if (dryRun) {
    store.assertWritable();
    return { steps: report(plan(store)), backup: null };
  }
  return store.locked(() => {
    store.assertWritable();
    const steps = plan(store);
    if (steps.length === 0) return { steps: [], backup: null };
    const backup = `local/backup/${at.toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(3).toString('hex')}`;
    for (const step of steps) {
      if (step.before !== null) store.writeText(`${backup}/${step.rel}`, step.before);
      store.writeText(step.rel, step.after);
    }
    return { steps: report(steps), backup };
  });
}
