// The gate cache (T-MG-46): a passing gate set is run once per tree. Key = sha256 of the tree the gates run on, the
// gate set (gatesSha: name, cmd, timeoutS, kind), the collectors that read the output, and the plugin version. Value
// (local/gate-cache/<key>.json, machine-local, never committed): each gate's verify.json entry, its output tail and
// the inventory its report collected. Only a set in which every gate passed is stored; an entry older than 24 h is
// ignored. The tree is HEAD's when `git status --porcelain --untracked-files=all` is empty; a merge in progress has
// its merged tree in the index, so there the index tree (git write-tree) stands, as long as nothing is unstaged or
// untracked. Any other state of the worktree has no key: the gates run.
import { StateError } from '../state/index.mjs';
import { tailLines } from './gates.mjs';
import { hashOf } from './inventory.mjs';
import { REPORTERS } from './reporters.mjs';

export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The tree the gates run on, or null when the worktree is not that tree. `staged`: the index is the tree (a merge).
export function treeOf(gitIn, { staged = false } = {}) {
  const st = gitIn(['status', '--porcelain', '--untracked-files=all']);
  if (st.status !== 0) return null;
  const lines = st.stdout.split('\n').filter(Boolean);
  if (lines.some((l) => !staged || l.startsWith('??') || l[1] !== ' ')) return null;
  const t = gitIn(staged ? ['write-tree'] : ['rev-parse', 'HEAD^{tree}']);
  return t.status === 0 && /^[0-9a-f]{40,64}$/.test(t.stdout.trim()) ? t.stdout.trim() : null;
}

// The collectors that read gate output: a reporter added or changed reads the same output differently.
export const COLLECTORS = REPORTERS.join('+');
export const cacheKey = ({ tree, gatesSha, version }) => hashOf(JSON.stringify([tree, gatesSha, COLLECTORS, version ?? null]));

// The stored gate list is the current one: the same gates in the same order, by name, command and kind.
const sameGates = (runs, gates) => runs.length === gates.length && gates.every((g, k) => runs[k].name === g.name && runs[k].cmd === g.cmd && runs[k].kind === g.kind);

// The stored runs for `key` as runGate results ({ gate, output, kind, report }), with `at`; null without a usable
// entry. An entry is usable only when its content repeats the key (tree, gatesSha, collectors, version: the key
// recomputed from the file equals the file's name), lists exactly the current gates, holds passes only and is at most
// MAX_AGE_MS old; a file that does not parse or fails its schema is no entry. A mismatch is a miss, never a pass.
export function lookup(st, { key, tree, gatesSha, version, gates, at }) {
  let doc;
  try {
    doc = st.read('gateCache', key);
  } catch (err) {
    if (err instanceof StateError) return null; // a corrupt entry is no entry
    throw err;
  }
  if (!doc) return null;
  const fits = doc.tree === tree && doc.gatesSha === gatesSha && doc.collectors === COLLECTORS && (doc.version ?? null) === (version ?? null)
    && cacheKey(doc) === key && sameGates(doc.runs, gates) && doc.runs.every((r) => r.result === 'pass');
  if (!fits || !(Date.parse(at) - Date.parse(doc.at) <= MAX_AGE_MS)) return null;
  return { at: doc.at, runs: doc.runs.map(({ kind, tail, report = null, ...gate }) => ({ gate, kind, output: tail.join('\n'), report })) };
}

// Stores the runs under `key` when every gate passed; `report(run)` gives a test run's collected inventory (null when
// its output is no report). The key fields are stored with the runs, so a read can check them. Returns whether an
// entry was written.
export function store(st, key, { tree, gatesSha, version, at, runs, report }) {
  if (runs.length === 0 || runs.some((r) => r.gate.result !== 'pass')) return false;
  const doc = {
    tree, gatesSha, collectors: COLLECTORS, version: version ?? null, at,
    runs: runs.map((r) => {
      const collected = r.kind === 'test' ? report(r) : null;
      return { ...r.gate, kind: r.kind, tail: tailLines(r.output), ...(collected ? { report: collected } : {}) };
    }),
  };
  st.write('gateCache', key, doc);
  return true;
}
