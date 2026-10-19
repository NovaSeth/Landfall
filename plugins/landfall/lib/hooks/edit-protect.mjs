// PreToolUse Edit|Write|MultiEdit: state-file protection (spec §7.13, FLW-7, PRI-8), run by the `decisions-context`
// registry row before the decision context (one process per edit). It denies a direct edit of a command-owned state file
// of an active repository (the one list in lib/guard/protect.mjs; the project rules stay editable) with the command to
// use, and for a decision record only a change of its frontmatter `status` (its body stays editable; a second status
// line counts as a change). Input read: tool_input.file_path, and for a decision record the edit itself (Write:
// content; Edit: old_string, new_string, replace_all; MultiEdit: edits[]), to compare the status before and after.
// The state is found through lib/state (git bounded by the budget) from the file's directory and from the session's cwd
// (a linked state directory), after following links on the way. In a linked worktree the state is its project's, and the
// worktree's checked-out copy of an in-repo state directory (lib/state resolve `copy`) is guarded by the same rules: a
// write there never reaches the state. A state that cannot be resolved (machine data
// unreadable, git missing or slow) denies an edit inside its in-repo state directory, or, when even that is unknown, of a
// path ending in an owned file or under a segment named like the state directory (fail closed, findings-r1 C3, r2 A-I1). Not a state file, no active state, or malformed input
// → null (the decision context runs). An edit that cannot apply (old_string not in the file) is left to Claude Code.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parseRecord } from '../decisions/index.mjs';
import { inside, ownedFile, ownedTail, realPath } from '../guard/protect.mjs';
import { stateDirName } from '../state/index.mjs';
import { loadNames, stateOf } from './loop-state.mjs';

const REASON_MAX = 300;
const deny = (reason) => ({
  stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason.slice(0, REASON_MAX) } })}\n`,
});
const clip = (s, n) => (s.length <= n ? s : `…${s.slice(s.length - n + 1)}`);

// rel of `file` in the worktree copy of `where` or in its state directory, or null. The copy first: an executor's
// worktree under local/worktrees/ of the state directory holds its own copy.
const inState = (where, file) => [where.copy, where.dir].reduce((rel, d) => rel ?? (d ? inside(realPath(d), file) : null), null);

// The state holding the real path `file`: { where, rel } (active) · { unknown, rel } (cannot be resolved) · null.
// Candidates: the file's nearest existing directory, then the session's cwd.
function owner(file, cwd, env, names, deadline) {
  let dir = dirname(file);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const repos = [];
  for (const c of [dir, cwd]) {
    if (!c || repos.some((r) => inside(r, realPath(c)) !== null)) continue; // a repository already resolved
    const s = stateOf(c, env, deadline);
    if (s.unknown) {
      const rel = s.fallback ? inState(s.fallback, file) : null;
      const named = !s.fallback && (ownedTail(file) || file.toLowerCase().split(sep).includes(stateDirName(names).toLowerCase()));
      if (rel !== null || named) return { unknown: s.unknown, rel: rel ?? file, where: s.fallback ?? null };
      if (s.fallback) repos.push(s.fallback.repo);
      continue;
    }
    if (!s.where) continue;
    repos.push(s.where.repo);
    if (!s.where.active) continue;
    const rel = inState(s.where, file);
    if (rel !== null) return { where: s.where, rel };
  }
  return null;
}

// The frontmatter status of a decision record text (null without one; a status the parser refuses, such as a second
// status line, is its own value, so it never equals a valid one).
const statusOf = (text) => {
  const { doc, errors } = parseRecord(text, 'x.md');
  if (errors.some((e) => /: status\b/.test(e))) return '(invalid status)';
  return typeof doc?.status === 'string' ? doc.status : null;
};
const replaceIn = (text, { old_string: a, new_string: b, replace_all: all }) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || !text.includes(a)) return undefined;
  if (all === true) return text.split(a).join(b);
  const k = text.indexOf(a);
  return text.slice(0, k) + b + text.slice(k + a.length);
};
// The record after the edit, or undefined when the edit cannot apply (Claude Code refuses it) or is malformed.
function afterEdit(input, before) {
  const ti = input.tool_input;
  if (input.tool_name === 'Write') return typeof ti.content === 'string' ? ti.content : undefined;
  if (before === null) return undefined;
  if (input.tool_name === 'MultiEdit') {
    if (!Array.isArray(ti.edits) || ti.edits.length === 0) return undefined;
    let text = before;
    for (const e of ti.edits) { text = e && typeof e === 'object' ? replaceIn(text, e) : undefined; if (text === undefined) return undefined; }
    return text;
  }
  return replaceIn(before, ti);
}

// (hook input, { env, deadline }) → a deny { stdout } or null.
export function editProtect(input, { env = process.env, deadline = Infinity } = {}) {
  const raw = input.tool_input?.file_path;
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) return null;
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : null;
  if (!isAbsolute(raw) && !cwd) return null; // never resolved against this process's own directory
  const names = loadNames();
  const file = realPath(isAbsolute(raw) ? raw : join(cwd, raw));
  const hit = owner(file, cwd, env, names, deadline);
  if (hit?.unknown) {
    const shownU = clip(hit.where ? relative(hit.where.worktree, file) : file, 80);
    return deny(`FLW-7: blocked an edit of \`${shownU}\`: the state of this repository cannot be resolved (${clip(String(hit.unknown), 40)}), `
      + `and the file is in its state directory. Instead repair it (\`${names.bin} doctor\`) and retry.`);
  }
  const owned = hit && ownedFile(hit.rel);
  if (!owned || owned.edit) return null;
  const rel = relative(hit.where.worktree, file);
  const shown = clip(rel.startsWith('..') || isAbsolute(rel) ? file : rel, 80);
  const id = clip(owned.id ?? '<id>', 24);
  if (owned.field !== 'status') {
    return deny(`${owned.rule}: blocked a direct edit of \`${shown}\`: only \`${names.bin}\` commands write this state file, and the loop reads `
      + `only what they write. Instead use ${owned.use(names.bin, id)}.`);
  }
  let before = null;
  if (existsSync(file)) {
    try { before = readFileSync(file, 'utf8'); } catch (e) {
      return deny(`PRI-8: blocked an edit of \`${shown}\`: its status cannot be checked (${e.code ?? 'unreadable'}). Instead use ${owned.use(names.bin, id)}.`);
    }
  }
  const after = afterEdit(input, before);
  if (after === undefined) return null;
  const from = before === null ? null : statusOf(before);
  const to = statusOf(after);
  if (before !== null && from === to) return null;
  if (before === null) {
    return deny(`PRI-8: blocked creating the decision record \`${shown}\` by hand: a record gets its ID and status from the command. `
      + `Instead create it with \`${names.bin} decide\`.`);
  }
  return deny(`PRI-8: blocked changing the status of ${id} by hand (${from ?? 'none'} to ${clip(String(to ?? 'none'), 20)}): a decision changes only `
    + `through a superseding or retiring record. Instead use ${owned.use(names.bin, id)}; the body stays editable.`);
}
