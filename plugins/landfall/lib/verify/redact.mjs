// Gate output redacted with the secrets patterns (T-MG-48, SEC-5): every matched secret is replaced by its masked form
// before the output is written (verify.json, the log) or printed.
import { mask, matchLine } from '../secrets/index.mjs';

export function redact(text) {
  return String(text).split('\n').map((line) => {
    let out = line;
    for (let m = matchLine(out); m; m = matchLine(out)) {
      const at = out.indexOf(m.text, m.index);
      out = `${out.slice(0, at)}${mask(m.text)}${out.slice(at + m.text.length)}`;
      if (out.length > line.length * 2 + 100) break;
    }
    return out;
  }).join('\n');
}

// A gate run with its output redacted: what the inventory, the gate cache, the log and the CLI output all see.
export const redacted = (run) => ({ ...run, output: redact(run.output) });
