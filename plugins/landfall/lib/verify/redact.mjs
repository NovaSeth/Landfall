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

// The [start, end) spans of every match of every pattern in `line` (latin1), overlapping ones merged (merge).
// A line is redacted when the scanner (matchLine) marks it or a project span is found. Built-in patterns run over the
// whole line. A built-in match of 1024 bytes or more has reached a bounded probe
// (VALUE_LIMIT): its span runs on to the end of the value (a closing quote, whitespace or the end of the line), so no
// suffix beyond the probe shows. Project patterns run in WINDOW-byte windows that overlap by OVERLAP bytes, so a
// match anywhere in the line is found at a linear cost; a match found in any window is masked.
const PROBE = 1024;
const WINDOW = 4096;
const OVERLAP = 2048;
const VALUE_END = /["' \t\n\v\f\r]/;
const valueEnd = (line, e) => { while (e < line.length && !VALUE_END.test(line[e])) e++; return e; };
const globalOf = (re) => new RegExp(re.source, `${re.flags.replace(/[gy]/g, '')}g`);

function collect(found, line, re, text, offset, bounded) {
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') { re.lastIndex += 1; continue; }
    const s = offset + m.index;
    const e = s + m[0].length;
    found.push([s, bounded && m[0].length >= PROBE ? valueEnd(line, e) : e]);
  }
}

function builtInSpans(line) {
  const found = [];
  for (const p of PATTERNS) collect(found, line, globalOf(p.re), line, 0, true);
  return found;
}

function projectSpans(line, extra) {
  const found = [];
  for (const p of extra) {
    const re = globalOf(p.re);
    for (let offset = 0; offset < line.length; offset += WINDOW - OVERLAP) {
      re.lastIndex = 0;
      collect(found, line, re, line.slice(offset, offset + WINDOW), offset, false);
      if (offset + WINDOW >= line.length) break;
    }
  }
  return found;
}

function merge(found) {
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const s of found) {
    const last = merged[merged.length - 1];
    if (last && s[0] === last[0] && s[1] === last[1]) continue;
    if (last && s[0] < last[1]) { last[1] = Math.max(last[1], s[1]); last[2] = true; }
    else merged.push([s[0], s[1], false]);
  }
  return merged;
}

// A line longer than LINE_MAX bytes keeps its first LINE_MAX bytes (redacted as any line); the rest is masked whole.
const LINE_MAX = 1024 * 1024;
const hidden = (n) => `${'*'.repeat(8)} (${n} chars)`;

export function redact(text, extra = []) {
  return String(text).split('\n').map((line) => {
    let bytes = bytesOf(line);
    let tail = '';
    if (bytes.length > LINE_MAX) {
      tail = hidden(textOf(bytes.slice(LINE_MAX)).length);
      bytes = bytes.slice(0, LINE_MAX);
    }
    const project = projectSpans(bytes, extra);
    if (!project.length && !matchLine(bytes, extra)) return textOf(bytes) + tail;
    const found = merge([...builtInSpans(bytes), ...project]);
    // The scanner marks the line but no span was found (a probe the span regexes cannot see): mask the whole line.
    if (!found.length) return hidden(textOf(bytes).length) + tail;
    let out = '';
    let at = 0;
    for (const [s, e, joined] of found) {
      const hit = textOf(bytes.slice(s, e));
      // A merged span (overlapping matches) is masked completely: no prefix of one match shows inside another's.
      out += `${textOf(bytes.slice(at, s))}${joined ? hidden(hit.length) : mask(hit)}`;
      at = e;
    }
    return out + textOf(bytes.slice(at)) + tail;
  }).join('\n');
}

// A gate run with its output redacted: what the inventory, the gate cache, the log and the CLI output all see.
export const redacted = (run, extra = []) => ({ ...run, output: redact(run.output, extra) });

// runGate with its output redacted by the built-in and the project patterns (`extra`: projectRedactions(where)).
export const runRedacted = (gate, { cwd, env, extra = [] }) => redacted(runGate(gate, { cwd, env }), extra);
