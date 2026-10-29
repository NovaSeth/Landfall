// `decisions check` (spec §7.10, SD-21, SC17, GC5): validates the records of a state directory and every citation
// in the repository's tracked files. Problems (each { code, message, hint }):
//   invalid-decision    frontmatter schema error, wrong file name, a supersedes/supersededBy reference that is
//                       unknown or not mirrored by the other record
//   duplicate-decision  one ID in more than one record file
//   supersedes-cycle    records that supersede each other in a cycle
//   unknown-decision    a cited ID without a record or tombstone (also a match that is not a valid ID)
//   retired-decision    a cited ID that is retired or tombstoned
//   superseded-decision a cited superseded ID: an error when strict (--ci or CI set), otherwise a warning
// Citations are read from `git ls-files` (tracked files) outside the state directory: records reference each other
// structurally (checked above) and task history may keep citing what it cited. Binary files, symbolic links and
// files over SCAN_MAX are not read (counted in `skipped`).
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git/index.mjs';
import { PATTERNS, StateError, open } from '../state/index.mjs';
import { inside } from './context.mjs';
import { citationPattern } from './citation.mjs';
import { readRecords } from './records.mjs';

export const SCAN_MAX = 8 * 1024 * 1024;

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// The state directory relative to the repository with `/`, or null when it is linked from outside.
export const stateRel = (repo, dir) => inside(repo, dir);

function recordProblems(records, invalid, tombstoned) {
  const problems = [];
  const add = (code, message, hint) => problems.push({ code, message, hint });
  for (const r of invalid) for (const e of r.errors) add('invalid-decision', e, 'fix the frontmatter of that record (see the record format in the CLI reference)');
  const files = new Map();
  for (const r of [...records.map((x) => ({ name: x.name, id: x.id })), ...invalid.filter((x) => x.id)]) {
    files.set(r.id, [...(files.get(r.id) ?? []), r.name]);
  }
  for (const [id, list] of files) if (list.length > 1) add('duplicate-decision', `${id} is recorded in ${list.length} files: ${list.join(', ')}`, 'keep one record per ID; give the other one a new ID');
  const byId = new Map(records.map((r) => [r.id, r.doc]));
  for (const { name, doc } of records) {
    for (const old of doc.supersedes ?? []) {
      const target = byId.get(old);
      if (!target) add('invalid-decision', `${name}: supersedes ${old}, which has no valid record`, 'remove the reference or restore that record');
      else if (target.supersededBy !== doc.id) add('invalid-decision', `${name}: supersedes ${old}, but ${old} has supersededBy ${target.supersededBy ?? 'null'}`, `set supersededBy: ${doc.id} in ${old}`);
    }
    if (doc.supersededBy) {
      const next = byId.get(doc.supersededBy);
      if (!next) add('invalid-decision', `${name}: supersededBy ${doc.supersededBy}, which has no valid record`, 'restore that record or fix the reference');
      else if (!(next.supersedes ?? []).includes(doc.id)) add('invalid-decision', `${name}: supersededBy ${doc.supersededBy}, but ${doc.supersededBy} does not list ${doc.id} in supersedes`, `add ${doc.id} to supersedes in ${doc.supersededBy}`);
    }
  }
  // Cycles over supersedes edges (each reported once, from its smallest ID).
  const color = new Map();
  const reported = new Set();
  const visit = (id, path) => {
    color.set(id, 'open');
    for (const next of byId.get(id)?.supersedes ?? []) {
      if (!byId.has(next)) continue;
      if (color.get(next) === 'open') {
        const cycle = path.slice(path.indexOf(next));
        const key = [...cycle].sort(natural).join(' ');
        if (!reported.has(key)) { reported.add(key); add('supersedes-cycle', `supersedes cycle: ${[...cycle, next].join(' → ')}`, 'a decision can only supersede older ones; remove one reference'); }
      } else if (!color.has(next)) visit(next, [...path, next]);
    }
    color.set(id, 'done');
  };
  for (const id of [...byId.keys()].sort(natural)) if (!color.has(id)) visit(id, [id]);
  for (const id of tombstoned) if (byId.get(id) && byId.get(id).status !== 'retired') add('invalid-decision', `${id} has a tombstone but status ${byId.get(id).status}`, `run the retire command for ${id} again`);
  return problems;
}

// { active, strict, records, files, citations, skipped, problems: [...], warnings: [...] }.
export function checkDecisions({ where, names, env, strict = false }) {
  if (!where.active) return { active: false, strict, records: 0, files: 0, citations: 0, skipped: 0, problems: [], warnings: [] };
  const { records, invalid, names: present } = readRecords(where.dir);
  const tombstoned = new Set(open(where.dir, { names }).list('tombstone').filter((k) => k.startsWith('D-')));
  const problems = recordProblems(records, invalid, tombstoned);
  const warnings = [];
  const byId = new Map(records.map((r) => [r.id, r.doc]));

  const listed = git(['ls-files', '-z'], { cwd: where.worktree, env }); // the code of this checkout
  if (listed.error === 'missing') throw new StateError('git-missing', 'ENV', 'git is not on PATH', { hint: 'install git and put it on PATH' });
  if (listed.status !== 0) throw new StateError('git-failed', 'ENV', `git ls-files failed: ${listed.stderr.trim().slice(0, 200)}`, { hint: 'run it inside a git work tree' });
  const own = stateRel(where.repo, where.dir);
  let files = 0;
  let citations = 0;
  let skipped = 0;
  for (const rel of listed.stdout.split('\0')) {
    if (!rel || (own && (rel === own || rel.startsWith(`${own}/`)))) continue;
    const abs = join(where.worktree, rel);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    if (st.size > SCAN_MAX) { skipped++; continue; }
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) { skipped++; continue; }
    const text = buf.toString('utf8');
    if (!text.includes('D-')) continue;
    let found = 0;
    text.split('\n').forEach((line, i) => {
      for (const [id] of line.matchAll(citationPattern())) {
        found++;
        const at = `${rel}:${i + 1}`;
        const doc = byId.get(id);
        if (!PATTERNS.decisionId.test(id) || (!present.has(id) && !tombstoned.has(id))) {
          problems.push({ code: 'unknown-decision', message: `${at}: ${id} is unknown`, hint: `no such record; fix the citation or record it with '${names.bin} decide'` });
        } else if (tombstoned.has(id) || doc?.status === 'retired') {
          problems.push({ code: 'retired-decision', message: `${at}: cites retired ${id}`, hint: `remove the citation; '${names.bin} decisions show ${id}' tells why it was retired` });
        } else if (doc?.status === 'superseded') {
          const p = { code: 'superseded-decision', message: `${at}: cites ${id}, superseded by ${doc.supersededBy}`, hint: `cite ${doc.supersededBy} instead` };
          (strict ? problems : warnings).push(p);
        }
      }
    });
    if (found) { files++; citations += found; }
  }
  return { active: true, strict, records: records.length, files, citations, skipped, problems, warnings };
}
