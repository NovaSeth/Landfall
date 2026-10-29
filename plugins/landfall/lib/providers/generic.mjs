// Generic adapter (spec §7.12, the successor of OTHER_CLI): a CLI the user declares with `providers add <id> --argv
// '<template>' --sandbox-map reviewer=…,implementer=…`, kept in plugin data providers.json. The template is split on
// whitespace (no shell, no quoting); a word is literal or exactly one of {cwd} {sandbox} {out} {model} ({model} is
// dropped when no model is set). The brief goes to stdin. The roles are the keys of the sandbox map, and each role's
// sandbox value is passed through {sandbox}. A word or sandbox value that names a bypass or full-access mode is
// refused. {sandbox} is mandatory, and a word that hard-codes a sandbox or write mode is refused (SF-AB-5). Every load
// checks the entry again (B-4): a role whose mode fails checkValue, or a reviewer mapped to a write mode, is dropped; a
// template that fails parseTemplate leaves no role; the reason is the adapter's note (providers list). The provider's
// own environment names (--env) are kept as envNames (B-6); a name that changes how a program loads (LOADER_ENV) is
// refused on add, and on load it drops the whole env list with a note (T-MG-91). The CLI is trusted as logged in (no probe is declared);
// each output line is the run's last line.
import { StateError } from '../state/index.mjs';
import { LAST_LINE, ROLES } from './kind.mjs';
import { cleanLine, versionOf } from './probe.mjs';

const PLACEHOLDERS = Object.freeze(['{cwd}', '{sandbox}', '{out}', '{model}']);
const BYPASS = /danger|bypass|yolo|full[-_]?access|skip[-_]?permissions/i;
const VALUE = /^[A-Za-z0-9._:=/-]{1,40}$/;
// A write mode (never the reviewer's) and a flag that takes a sandbox or approval mode (only {sandbox} may follow it).
const WRITE = /workspace[-_]?write|auto[-_]?edit|accept[-_]?edits|full[-_]?auto|^(?:rw|write|read[-_]?write)$/i;
const MODE_FLAG = /^(?:-s|--sandbox|--mode|--approval-mode|--ask-for-approval|--permission-mode)(=.*)?$/;
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
export const ENV_MAX = 20;
// Names that change how a program, its interpreter or git loads code or configuration: never passed to a provider.
export const LOADER_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|GIT_[A-Z0-9_]*)$/;
const usage = (code, message, hint) => new StateError(code, 'USAGE', message, { hint });
const refuse = (what) => usage('unsafe-mode', `${what} names a mode that lifts the sandbox or the approvals; an external run never gets one`, 'declare the read-only and workspace-write modes of the CLI');

// null when a mode or model value is plain, else the reason: 'unsafe-mode' (a bypass or full-access word) or
// 'invalid-value' (a leading "-", or not 1-40 of [A-Za-z0-9._:=/-]). Used by providers add, every load and the
// supervisor's model check (B-3).
export function checkValue(value) {
  if (typeof value !== 'string') return 'invalid-value';
  if (BYPASS.test(value)) return 'unsafe-mode';
  return VALUE.test(value) && !value.startsWith('-') ? null : 'invalid-value';
}

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
  if (!words.includes('{sandbox}')) throw usage('invalid-value', '--argv has no {sandbox}: the mode of each role must come from --sandbox-map', "such as --argv 'mycli --mode {sandbox} {cwd}'");
  words.forEach((w, i) => {
    const flag = MODE_FLAG.exec(w);
    if (WRITE.test(w) || (flag && (flag[1] !== undefined || words[i + 1] !== '{sandbox}'))) throw usage('unsafe-mode', `--argv word ${w.slice(0, 60)} hard-codes a sandbox or write mode`, 'pass the mode as {sandbox} from --sandbox-map');
  });
  return words;
}

// { reviewer?, implementer? } of "role=value,…"; at least one role, each once.
export function parseSandboxMap(text) {
  const out = {};
  for (const part of String(text ?? '').split(',')) {
    const m = /^([a-z]+)=(.*)$/.exec(part.trim());
    if (!m || !ROLES.includes(m[1])) throw usage('invalid-value', `--sandbox-map ${part.slice(0, 60)}: expected role=mode with role ${ROLES.join(' or ')}`, 'such as reviewer=read-only,implementer=workspace-write');
    if (Object.hasOwn(out, m[1])) throw usage('invalid-value', `--sandbox-map names ${m[1]} twice`, 'one mode per role');
    const bad = checkValue(m[2]);
    if (bad === 'unsafe-mode' || (m[1] === 'reviewer' && WRITE.test(m[2]))) throw refuse(`--sandbox-map ${m[1]}`);
    if (bad) throw usage('invalid-value', `--sandbox-map ${m[1]}=${m[2].slice(0, 40)}: expected 1-40 letters, digits or . _ : = / -, not starting with -`, 'such as read-only');
    out[m[1]] = m[2];
  }
  return out;
}

// The environment names of --env "NAME,…": at most ENV_MAX, each [A-Z_][A-Z0-9_]*, once.
export function parseEnvNames(text) {
  const list = String(text ?? '').split(',').map((x) => x.trim());
  if (list.length > ENV_MAX) throw usage('limit-exceeded', `--env names ${list.length} variables, the limit is ${ENV_MAX}`, 'name only what the CLI needs to log in');
  for (const n of list) if (!ENV_NAME.test(n)) throw usage('invalid-value', `--env ${n.slice(0, 40) || '(empty)'}: expected a variable name of A-Z, 0-9 and _`, 'such as --env MYCLI_API_KEY,MYCLI_URL');
  if (new Set(list).size !== list.length) throw usage('invalid-value', '--env names a variable twice', 'name each once');
  const loader = list.find((n) => LOADER_ENV.test(n));
  if (loader) throw usage('invalid-value', `--env ${loader}: it changes how a program loads, so it never passes to a provider`, 'name only what the CLI needs to log in');
  return list;
}

// The roles of a declared sandbox map that pass the add-time checks again, and a note naming the dropped ones.
function checkedRoles(map) {
  const kept = {};
  const dropped = [];
  for (const r of ROLES) {
    if (!Object.hasOwn(map ?? {}, r)) continue;
    let ok = false;
    try { ok = typeof map[r] === 'string' && parseSandboxMap(`${r}=${map[r]}`)[r] === map[r]; } catch { ok = false; }
    if (ok) kept[r] = map[r];
    else dropped.push(r);
  }
  return { kept, note: dropped.length ? `${dropped.join(' and ')} dropped: an unsafe or invalid mode in providers.json` : null };
}

// The adapter of a declared entry { argv, sandboxMap, env? }, checked again on every load (B-4, SF-AB-5): it never
// throws; a bad entry is an adapter with no runnable role and a note.
export function fromEntry(id, entry) {
  let words = null;
  let note = null;
  try { words = parseTemplate(entry?.argv); } catch (err) { note = `no role can run: ${String(err?.message ?? err).slice(0, 200)}`; }
  const roles = words ? checkedRoles(entry?.sandboxMap) : { kept: {}, note };
  const stored = Array.isArray(entry?.env) ? entry.env.filter((n) => typeof n === 'string' && ENV_NAME.test(n)).slice(0, ENV_MAX) : [];
  const loaders = stored.filter((n) => LOADER_ENV.test(n));
  const envNames = loaders.length ? [] : stored;
  const envNote = loaders.length ? `env dropped: ${loaders.join(', ')} in providers.json changes how a program loads` : null;
  const program = words ? words[0] : String(entry?.argv ?? '').trim().split(/\s+/)[0] || id;
  const sandboxes = Object.freeze(roles.kept);
  return Object.freeze({
    id,
    kind: 'generic',
    bins: Object.freeze([program]),
    sandboxes,
    envNames: Object.freeze(envNames),
    note: [roles.note, envNote].filter(Boolean).join('; ') || null,
    detect: ({ env }) => versionOf(program, env),
    auth: () => 'ok',
    argv: ({ sandbox, cwd, outFile, model }) => (words ?? []).flatMap((w) => {
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
