// Edit-time retrieval (spec §7.10, SD-22, SC17, §8.3): which decisions concern a file and the context lines for
// them. A file's decisions are the ones it cites (any status, in order of first citation), then the active ones
// whose `scope` matches its repository-relative path, most specific glob first (more literal characters). Lines:
// `<ID> (<status>): <title> — why: <first sentence> — cost if wrong: <first clause>`, whole lines only, within the
// budget; what does not fit is named in a last line pointing at `<bin> decisions find --path <file>`.
// Globs (relative to the repository root, `/` separators): `**` any depth, `*` and `?` within one path segment,
// `{a,b}` alternatives (not nested); everything else is literal.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { citationPattern } from './record.mjs';

export const CONTEXT_BUDGET = 1200; // characters of additionalContext for decisions (spec §8.3)
export const READ_MAX = 256 * 1024; // a target file is read for citations only up to this size (spec §7.10)

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });

function convert(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const segmentStart = i === 0 || glob[i - 1] === '/';
      i++;
      if (segmentStart && glob[i + 1] === '/') { i++; re += '(?:[^/]*/)*'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) > i) {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map(convert).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

const compiled = new Map();
export function globMatch(glob, path) {
  let re = compiled.get(glob);
  if (!re) { re = new RegExp(`^${convert(glob)}$`); compiled.set(glob, re); }
  return re.test(path);
}
export const specificity = (glob) => glob.replace(/\*|\?|\{[^}]*\}/g, '').length;

// An absolute path with its existing part resolved to the real path ({ dir: the real existing ancestor, path }),
// so it compares with the repository's real path; null when nothing of it exists.
export function realTarget(target) {
  let dir = dirname(target);
  const rest = [basename(target)];
  for (;;) {
    try {
      const real = realpathSync.native(dir);
      return { dir: real, path: join(real, ...rest) };
    } catch {
      const up = dirname(dir);
      if (up === dir) return null;
      rest.unshift(basename(dir));
      dir = up;
    }
  }
}

// `file` relative to `base` with `/` separators, or null when it is not inside it.
export function inside(base, file) {
  const rel = relative(base, file);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel.split(sep).join('/');
}

// Valid-looking citations in a file, in order of first appearance ([] when absent, not a file or over maxBytes).
export function citedIn(file, maxBytes = READ_MAX) {
  let st;
  try { st = statSync(file); } catch { return []; }
  if (!st.isFile() || st.size > maxBytes) return [];
  return [...new Set(readFileSync(file, 'utf8').match(citationPattern()) ?? [])];
}

// records: summaries ({ id, status, scope, … }); path: repository-relative with `/`; cited: IDs in the file.
export function relevantDecisions(records, { path, cited = [] }) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const out = [];
  const taken = new Set();
  for (const id of cited) {
    const r = byId.get(id);
    if (r && !taken.has(id)) { out.push(r); taken.add(id); }
  }
  const scoped = [];
  for (const r of records) {
    if (r.status !== 'active' || taken.has(r.id)) continue;
    let best = -1;
    for (const g of r.scope) if (globMatch(g, path)) best = Math.max(best, specificity(g));
    if (best >= 0) scoped.push({ r, best });
  }
  scoped.sort((a, b) => b.best - a.best || natural(a.r.id, b.r.id));
  return [...out, ...scoped.map((s) => s.r)];
}

export function contextLine(r) {
  const status = r.status === 'superseded' && r.supersededBy ? `superseded by ${r.supersededBy}` : r.status;
  return `${r.id} (${status}): ${r.title}${r.why ? ` — why: ${r.why}` : ''}${r.cost ? ` — cost if wrong: ${r.cost}` : ''}`;
}

// { text, ids }: the lines that fit in `budget` characters (newlines included) and the IDs they carry.
export function renderContext(records, { budget = CONTEXT_BUDGET, path, bin }) {
  const tail = (n) => {
    const line = `+${n} more: ${bin} decisions find --path ${path}`;
    return line.length <= budget / 4 ? line : `+${n} more: ${bin} decisions find --path <file>`;
  };
  const reserve = 1 + tail(records.length).length;
  const lines = [];
  const ids = [];
  let used = 0;
  for (let i = 0; i < records.length; i++) {
    const line = contextLine(records[i]);
    const next = used + (lines.length ? 1 : 0) + line.length;
    if (next + (i < records.length - 1 ? reserve : 0) > budget) break;
    lines.push(line);
    ids.push(records[i].id);
    used = next;
  }
  const left = records.length - ids.length;
  if (left > 0) {
    const line = tail(left);
    if (used + (lines.length ? 1 : 0) + line.length <= budget) lines.push(line);
  }
  return { text: lines.join('\n'), ids };
}
