// Gate output redacted with the secrets patterns (T-MG-48, T-MG-75, SEC-5): every matched secret is replaced by its
// masked form before the output is written (verify.json, the log, the gate cache, the baseline) or printed. The
// patterns are the built-in ones and the project's own (<state dir>/secrets-patterns.txt, read as the secrets scan
// reads it). Every gate run in verify goes through runRedacted: there is no other way to run a gate here.
// Patterns match bytes (latin1), as in the secrets scan: a line is matched as its UTF-8 bytes, so a pattern with a
// non-ASCII character finds it. The spans are found on the original line and masked once each; a mask is never
// matched again, so a pattern that matches its own mask (tok_.*) ends.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readRegularFile } from '../fsx/index.mjs';
import { PATTERNS, PATTERN_FILE, mask, matchLine, projectPatterns } from '../secrets/index.mjs';
import { StateError } from '../state/index.mjs';
import { runGate } from './gates.mjs';

const PATTERN_FILE_MAX = 65536;

const unreadable = (file, why) => new StateError('project-patterns-unreadable', 'FAIL', `the project pattern file ${file} ${why}; no gate ran`,
  { hint: 'fix or remove the file (no file: the built-in patterns only), then run the command again' });

// The project patterns of the state directory `where.dir`: { extra (the patterns), sha (sha256 of the file's bytes,
// 'none' without the file) }. No file is no project pattern. A file that cannot be read (a link, a directory, too
// large, no permission) or a line that is no pattern throws project-patterns-unreadable (exit FAIL): the command
// refuses before a gate runs, so no output leaves unredacted.
export function readProjectPatterns(where) {
  const file = join(where.dir, PATTERN_FILE);
  let buf;
  try {
    buf = readRegularFile(file, { max: PATTERN_FILE_MAX });
  } catch (err) {
    if (err.code === 'ENOENT') return { extra: [], sha: 'none' };
    throw unreadable(file, `cannot be read (${err.code === 'ETOOBIG' ? `more than ${PATTERN_FILE_MAX} bytes` : err.code ?? err.message})`);
  }
  const sha = createHash('sha256').update(buf).digest('hex');
  const text = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf).toString('latin1');
  const { patterns, errors } = projectPatterns(text);
  if (errors.length) throw unreadable(file, `has an invalid pattern on line ${errors[0].line}: ${errors[0].message}`);
  return { extra: patterns, sha };
}

export const projectRedactions = (where) => readProjectPatterns(where).extra;

const bytesOf = (s) => Buffer.from(s, 'utf8').toString('latin1');
const textOf = (b) => Buffer.from(b, 'latin1').toString('utf8');

// The [start, end) spans of every match of every pattern in `line` (latin1), overlapping ones merged.
function spans(line, extra) {
  const found = [];
  for (const p of [...PATTERNS, ...extra]) {
    const re = new RegExp(p.re.source, `${p.re.flags.replace(/[gy]/g, '')}g`);
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (m[0] === '') { re.lastIndex += 1; continue; }
      found.push([m.index, m.index + m[0].length]);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of found) {
    const last = merged[merged.length - 1];
    if (last && s[0] < last[1]) { last[1] = Math.max(last[1], s[1]); last[2] = true; }
    else merged.push([s[0], s[1], false]);
  }
  return merged;
}

export function redact(text, extra = []) {
  return String(text).split('\n').map((line) => {
    const bytes = bytesOf(line);
    if (!matchLine(bytes, extra)) return line;
    let out = '';
    let at = 0;
    for (const [s, e, joined] of spans(bytes, extra)) {
      const hit = textOf(bytes.slice(s, e));
      // A merged span (overlapping matches) is masked completely: no prefix of one match shows inside another's.
      out += `${textOf(bytes.slice(at, s))}${joined ? `${'*'.repeat(8)} (${hit.length} chars)` : mask(hit)}`;
      at = e;
    }
    return out + textOf(bytes.slice(at));
  }).join('\n');
}

// A gate run with its output redacted: what the inventory, the gate cache, the log and the CLI output all see.
export const redacted = (run, extra = []) => ({ ...run, output: redact(run.output, extra) });

// runGate with its output redacted by the built-in and the project patterns (`extra`: projectRedactions(where)).
export const runRedacted = (gate, { cwd, env, extra = [] }) => redacted(runGate(gate, { cwd, env }), extra);
