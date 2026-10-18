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

export const cacheKey = ({ tree, gatesSha, version }) => hashOf(JSON.stringify([tree, gatesSha, REPORTERS.join('+'), version ?? null]));

// The stored runs for `key` as runGate results ({ gate, output, kind, report }), with `at`; null without a usable entry.
export function lookup(store, key, at) {
  let doc;
  try {
    doc = store.read('gateCache', key);
  } catch (err) {
    if (err instanceof StateError) return null; // a corrupt entry is no entry
    throw err;
  }
  if (!doc || Date.parse(at) - Date.parse(doc.at) > MAX_AGE_MS) return null;
  return { at: doc.at, runs: doc.runs.map(({ kind, tail, report = null, ...gate }) => ({ gate, kind, output: tail.join('\n'), report })) };
}

// Stores the runs under `key` when every gate passed; `report(run)` gives a test run's collected inventory (null when
// its output is no report). Returns whether an entry was written.
export function store(st, key, { tree, version, at, runs, report }) {
  if (runs.length === 0 || runs.some((r) => r.gate.result !== 'pass')) return false;
  const doc = {
    tree, version: version ?? null, at,
    runs: runs.map((r) => {
      const collected = r.kind === 'test' ? report(r) : null;
      return { ...r.gate, kind: r.kind, tail: tailLines(r.output), ...(collected ? { report: collected } : {}) };
    }),
  };
  st.write('gateCache', key, doc);
  return true;
}
