// The collector context and the test inventory of a verify run (split from run.mjs, T-MG-141).
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from '../profile/index.mjs';
import { byCodeUnit } from './inventory.mjs';
import { parseReport } from './reporters.mjs';
import { SKIP_DIRS, scanRepo } from './scan.mjs';

export const SOURCE_MAX = 1024 * 1024;

// The collector context: repository files (tracked and untracked, not ignored; never the state directory) and a
// reader that opens only those, as plain files of at most 1 MB.
export function context(where, env, rel) {
  let files = null;
  let known = null;
  const list = () => (files ??= listFiles(where.worktree, { env, exclude: rel }).filter((f) => !SKIP_DIRS.test(f)));
  const read = (path) => {
    known ??= new Set(list());
    if (!known.has(path)) return null;
    try {
      const file = join(where.worktree, path);
      const st = lstatSync(file);
      return st.isFile() && st.size <= SOURCE_MAX ? readFileSync(file, 'utf8') : null;
    } catch {
      return null;
    }
  };
  return { repo: where.worktree, files: list, read };
}

export function inventoryOf(runs, ctx) {
  const tests = runs.filter((r) => r.kind === 'test');
  const parts = [];
  let weak = false;
  let scan = tests.length === 0;
  for (const run of tests) {
    // a run reused from the gate cache carries the inventory its report collected (null: its output was no report)
    const inv = run.report !== undefined ? run.report : parseReport(run.output, ctx);
    if (inv) parts.push({ ...inv, run });
    else { scan = true; weak = true; }
  }
  if (scan) parts.push({ ...scanRepo(ctx), run: null });
  const byId = new Map();
  for (const p of parts) {
    for (const t of p.tests) {
      const cur = byId.get(t.id);
      byId.set(t.id, cur ? { ...cur, skipped: cur.skipped && t.skipped, focused: cur.focused || t.focused } : t);
    }
  }
  const collector = [...new Set(parts.map((p) => p.collector))].sort(byCodeUnit).join('+');
  return { collector, tests: [...byId.values()].sort((a, b) => byCodeUnit(a.id, b.id)), parts, weak };
}
