// 3-way merge of a generated file (spec §7.14 step 4, SD-35): `git merge-file -p ours base theirs` through lib/git
// (the only unit that spawns git). The three inputs go to a private temporary directory (0700, files 0600) outside
// the repository, which is removed afterwards. Trivial cases (one side unchanged, both sides equal) are decided
// without git. Status: 'clean' (text = result) · 'conflict' (overlapping edits) · 'error' (git missing or failing,
// content git cannot merge as text); 'error' is never a guess, callers treat it like a conflict.
// mergeChecked adds the hunk-survival check and the line-count invariant: a clean merge that does not keep every
// user hunk, or whose line counts do not add up, is 'lost-hunk'.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../git/index.mjs';
import { countsAddUp, survives } from './diff.mjs';

const MAX_CONFLICTS = 127; // git merge-file exits with the conflict count, capped at 127; anything else is an error

export function merge3({ ours, base, theirs, env = process.env }) {
  if (ours === base || ours === theirs) return { status: 'clean', text: theirs };
  if (theirs === base) return { status: 'clean', text: ours };
  if ([ours, base, theirs].some((s) => s.includes('\0'))) return { status: 'error', text: null };
  const dir = mkdtempSync(join(tmpdir(), 'gen-merge-'));
  try {
    for (const [name, text] of [['ours', ours], ['base', base], ['theirs', theirs]]) writeFileSync(join(dir, name), text, { mode: 0o600 });
    const r = git(['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', 'ours', 'base', 'theirs'], { cwd: dir, env });
    if (r.error || r.status === null) return { status: 'error', text: null };
    if (r.status === 0) return { status: 'clean', text: r.stdout };
    if (r.status >= 1 && r.status <= MAX_CONFLICTS) return { status: 'conflict', text: null };
    return { status: 'error', text: null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function mergeChecked({ ours, base, theirs, env, merge = merge3 }) {
  const m = merge({ ours, base, theirs, env });
  if (m.status !== 'clean') return m;
  return survives(base, ours, m.text).ok && countsAddUp(base, ours, theirs, m.text) ? m : { status: 'lost-hunk', text: null };
}
