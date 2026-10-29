// Gate output redacted with the secrets patterns (T-MG-48, T-MG-75, SEC-5): every matched secret is replaced by its
// masked form before the output is written (verify.json, the log, the gate cache, the baseline) or printed. The
// patterns are the built-in ones and the project's own (<state dir>/secrets-patterns.txt, read as the secrets scan
// reads it). Every gate run in verify goes through runRedacted: there is no other way to run a gate here.
import { join } from 'node:path';
import { readRegularFile } from '../fsx/index.mjs';
import { PATTERN_FILE, mask, matchLine, projectPatterns } from '../secrets/index.mjs';
import { runGate } from './gates.mjs';

const PATTERN_FILE_MAX = 65536;

// The project patterns of the state directory `where.dir`: none without the file. A file that cannot be read (a link,
// too large) or a line that is no pattern costs only those patterns; the built-in ones still apply, and the secrets
// scan reports the broken file.
export function projectRedactions(where) {
  let buf;
  try {
    buf = readRegularFile(join(where.dir, PATTERN_FILE), { max: PATTERN_FILE_MAX });
  } catch {
    return [];
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  return projectPatterns(buf.toString('latin1')).patterns;
}

export function redact(text, extra = []) {
  return String(text).split('\n').map((line) => {
    let out = line;
    for (let m = matchLine(out, extra); m; m = matchLine(out, extra)) {
      const at = out.indexOf(m.text, m.index);
      out = `${out.slice(0, at)}${mask(m.text)}${out.slice(at + m.text.length)}`;
      if (out.length > line.length * 2 + 100) break;
    }
    return out;
  }).join('\n');
}

// A gate run with its output redacted: what the inventory, the gate cache, the log and the CLI output all see.
export const redacted = (run, extra = []) => ({ ...run, output: redact(run.output, extra) });

// runGate with its output redacted by the built-in and the project patterns (`extra`: projectRedactions(where)).
export const runRedacted = (gate, { cwd, env, extra = [] }) => redacted(runGate(gate, { cwd, env }), extra);
