// Reading decision records (spec §4.2, §7.10): every `decisions/*.md` of a state directory, parsed and checked, and
// the scope index `local/decisions-index.json` for the edit hook. Reads go straight to the files (only writes are
// reserved to lib/state); like the store, a record that is a symbolic link is refused, never followed.
// Index (SD-22): { files: {<name>: {mtime (ns), size}}, decisions: [summary] } of the valid records. It is rebuilt when
// the set of record files or any file's mtime or size differs; the rebuild is written through lib/state under the
// store lock, best effort (a held lock or a newer index only skips the write: the fresh summaries are still used).
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS, PATTERNS, defineKind } from '../state/index.mjs';
import { FILE_NAME, STATUSES, clip, firstClause, firstSentence, flat, hiddenErrors, parseRecord, recordErrors, sections } from './record.mjs';

export const WHY_MAX = 120; // characters of the first sentence of Why kept for a context line
export const COST_MAX = 60; // characters of the first clause of Cost if wrong

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const missing = (err) => err.code === 'ENOENT' || err.code === 'ENOTDIR';

// Records of the state directory `dir`: { records: [{ id, name, doc, body }] (valid ones, natural order),
// invalid: [{ name, id (the frontmatter id, when there is one), errors }], names: Set of IDs that have a record file
// (valid or not) }.
export function readRecords(dir) {
  const folder = join(dir, 'decisions');
  const records = [];
  const invalid = [];
  const names = new Set();
  let entries;
  try {
    if (lstatSync(folder).isSymbolicLink()) return { records, invalid: [{ name: 'decisions', errors: ['decisions: is a symbolic link; records are never read through links'] }], names };
    entries = readdirSync(folder).sort(natural);
  } catch (err) {
    if (missing(err)) return { records, invalid, names };
    throw err;
  }
  for (const name of entries) {
    if (name.startsWith('.') || !name.endsWith('.md')) continue; // temporary files of writers, other files
    const m = FILE_NAME.exec(name);
    const file = join(folder, name);
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (!st) continue;
    if (!m) { invalid.push({ name, errors: [`${name}: not a decision file name (D-<H>-<n>.md)`] }); continue; }
    names.add(m[1]);
    if (st.isSymbolicLink() || !st.isFile()) { invalid.push({ name, errors: [`${name}: not a regular file`] }); continue; }
    if (st.size > LIMITS.decisionBytes) { invalid.push({ name, errors: [`${name}: ${st.size} bytes, the limit is ${LIMITS.decisionBytes}`] }); continue; }
    const text = readFileSync(file, 'utf8');
    const { doc, body, errors } = parseRecord(text, name);
    const all = [...errors, ...(doc ? recordErrors(doc, name) : []), ...hiddenErrors(text, doc, name)];
    if (all.length) invalid.push({ name, id: typeof doc?.id === 'string' ? doc.id : null, errors: all });
    else records.push({ id: doc.id, name, doc, body });
  }
  return { records, invalid, names };
}

// The short form a context line needs.
export function summarize({ doc, body }) {
  const s = sections(body);
  return {
    id: doc.id, title: flat(doc.title), status: doc.status, supersededBy: doc.supersededBy ?? null, scope: doc.scope ?? [],
    why: clip(firstSentence(s.why ?? ''), WHY_MAX), cost: clip(firstClause(s['cost if wrong'] ?? ''), COST_MAX),
  };
}

const str = (max, extra = {}) => ({ t: 'str', max, ...extra });
export const INDEX = defineKind('decisionindex', 1, {
  dir: 'local',
  file: () => 'local/decisions-index.json',
  match: /^local\/decisions-index\.json$/,
  fields: {
    files: { t: 'map', max: 1000000, key: str(32, { re: FILE_NAME }), v: { t: 'obj', f: { mtime: str(32, { re: /^\d+$/ }), size: { t: 'int', min: 0 } } } },
    decisions: {
      t: 'arr', max: 1000000,
      of: { t: 'obj', f: {
        id: str(40, { re: PATTERNS.decisionId }), title: str(200, { min: 1 }), status: { t: 'enum', of: STATUSES },
        supersededBy: str(40, { re: PATTERNS.decisionId, null: true }), scope: { t: 'arr', max: 1000, of: str(200, { min: 1 }) },
        why: str(WHY_MAX), cost: str(COST_MAX),
      } },
    },
  },
});
// The kinds of this unit in the state store (lib/state open({ kinds })).
export const STORE_KINDS = Object.freeze({ [INDEX.name]: INDEX });

// mtime (ns) and size of every record file name.
function fingerprint(dir) {
  const folder = join(dir, 'decisions');
  const files = {};
  let entries = [];
  try { entries = readdirSync(folder); } catch (err) { if (!missing(err)) throw err; }
  for (const name of entries) {
    if (!FILE_NAME.test(name)) continue;
    const st = statSync(join(folder, name), { bigint: true, throwIfNoEntry: false });
    if (st) files[name] = { mtime: String(st.mtimeNs), size: Number(st.size) };
  }
  return files;
}

const sameFiles = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] && b[k].mtime === a[k].mtime && b[k].size === a[k].size);
};

// Summaries of the valid records of the store's directory, from the index when it is current.
export function scopeIndex(store, dir) {
  const files = fingerprint(dir);
  let cached = null;
  try { cached = store.read(INDEX.name, null); } catch { cached = null; }
  if (cached && sameFiles(cached.files, files)) return cached.decisions;
  const seen = new Set();
  const decisions = [];
  for (const r of readRecords(dir).records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    decisions.push(summarize(r));
  }
  try { store.write(INDEX.name, null, { files, decisions }); } catch { /* best effort: the summaries are current anyway */ }
  return decisions;
}
