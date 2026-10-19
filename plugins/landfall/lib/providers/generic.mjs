// Generic adapter (spec §7.12, the successor of OTHER_CLI): a CLI the user declares with `providers add <id> --argv
// '<template>' --sandbox-map reviewer=…,implementer=…`, kept in plugin data providers.json. The template is split on
// whitespace (no shell, no quoting); a word is literal or exactly one of {cwd} {sandbox} {out} {model} ({model} is
// dropped when no model is set). The brief goes to stdin. The roles are the keys of the sandbox map, and each role's
// sandbox value is passed through {sandbox}. A word or sandbox value that names a bypass or full-access mode is
// refused. The CLI is trusted as logged in (no probe is declared); each output line is the run's last line.
import { StateError } from '../state/index.mjs';
import { LAST_LINE, ROLES } from './kind.mjs';
import { cleanLine, versionOf } from './probe.mjs';

const PLACEHOLDERS = Object.freeze(['{cwd}', '{sandbox}', '{out}', '{model}']);
const BYPASS = /danger|bypass|yolo|full[-_]?access|skip[-_]?permissions/i;
const VALUE = /^[A-Za-z0-9._:=/-]{1,40}$/;
const usage = (code, message, hint) => new StateError(code, 'USAGE', message, { hint });
const refuse = (what) => usage('unsafe-mode', `${what} names a mode that lifts the sandbox or the approvals; an external run never gets one`, 'declare the read-only and workspace-write modes of the CLI');

// The words of a template; a usage error names what is wrong.
export function parseTemplate(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw usage('invalid-value', '--argv is empty', "such as --argv 'mycli run --dir {cwd} --mode {sandbox} -o {out}'");
  if (String(text).length > 1000) throw usage('limit-exceeded', '--argv is longer than 1000 characters', 'shorten it');
  for (const w of words) {
    if (BYPASS.test(w)) throw refuse(`--argv word ${w.slice(0, 60)}`);
    if (/[{}]/.test(w) && !PLACEHOLDERS.includes(w)) throw usage('invalid-value', `--argv word ${w.slice(0, 60)}: a placeholder is a whole word, one of ${PLACEHOLDERS.join(' ')}`, 'separate it with spaces');
  }
  if (PLACEHOLDERS.includes(words[0])) throw usage('invalid-value', '--argv starts with a placeholder; it must start with the program', 'such as mycli or /usr/local/bin/mycli');
  return words;
}

// { reviewer?, implementer? } of "role=value,…"; at least one role, each once.
export function parseSandboxMap(text) {
  const out = {};
  for (const part of String(text ?? '').split(',')) {
    const m = /^([a-z]+)=(.*)$/.exec(part.trim());
    if (!m || !ROLES.includes(m[1])) throw usage('invalid-value', `--sandbox-map ${part.slice(0, 60)}: expected role=mode with role ${ROLES.join(' or ')}`, 'such as reviewer=read-only,implementer=workspace-write');
    if (Object.hasOwn(out, m[1])) throw usage('invalid-value', `--sandbox-map names ${m[1]} twice`, 'one mode per role');
    if (BYPASS.test(m[2])) throw refuse(`--sandbox-map ${m[1]}`);
    if (!VALUE.test(m[2])) throw usage('invalid-value', `--sandbox-map ${m[1]}=${m[2].slice(0, 40)}: expected 1-40 letters, digits or . _ : = / -`, 'such as read-only');
    out[m[1]] = m[2];
  }
  return out;
}

// The adapter of a declared entry { argv, sandboxMap }.
export function fromEntry(id, entry) {
  const words = parseTemplate(entry.argv);
  const sandboxes = Object.freeze(Object.fromEntries(ROLES.filter((r) => Object.hasOwn(entry.sandboxMap, r)).map((r) => [r, entry.sandboxMap[r]])));
  return Object.freeze({
    id,
    kind: 'generic',
    bins: Object.freeze([words[0]]),
    sandboxes,
    detect: ({ env }) => versionOf(words[0], env),
    auth: () => 'ok',
    argv: ({ sandbox, cwd, outFile, model }) => words.flatMap((w) => {
      if (w === '{cwd}') return [cwd];
      if (w === '{sandbox}') return [sandbox];
      if (w === '{out}') return [outFile];
      if (w === '{model}') return model ? [model] : [];
      return [w];
    }),
    parse: (line) => {
      const lastLine = cleanLine(line, LAST_LINE);
      return lastLine ? { lastLine } : {};
    },
  });
}
