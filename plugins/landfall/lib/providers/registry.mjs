// Adapter registry and detection (spec §7.12 Adapters, Detection; §5.3): the built-in adapters in registry order (the
// default role preference while config.json has no executors preferences: lib/config is not merged yet), then the
// generic adapters declared in plugin data providers.json. Detection runs, per adapter, the PATH lookup, `--version`
// and the auth probe (2 s each, probe.mjs) and caches the rows for 1 h in providers.json; `refresh` probes again;
// `write: false` (doctor) never writes. providers.json is read-modify-written under its lock (providers.lock, lib/fsx),
// so a declaration and a cache refresh never lose each other's change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDirs, withLock, writeAtomic } from '../fsx/index.mjs';
import { StateError, check, machineDataDir, serialize } from '../state/index.mjs';
import * as codex from './codex.mjs';
import * as gemini from './gemini.mjs';
import { fromEntry, parseSandboxMap, parseTemplate } from './generic.mjs';
import { PROVIDERS, PROVIDER_ID, ROLES } from './kind.mjs';

export const BUILTINS = Object.freeze([codex, gemini].map((a) => Object.freeze({ ...a, kind: 'builtin' })));
export const CACHE_MS = 60 * 60 * 1000;
const empty = () => ({ schema: PROVIDERS.version, generic: {}, detected: null });
const usage = (code, message, hint) => new StateError(code, 'USAGE', message, { hint });

const dataDirOf = (names, env) => machineDataDir(names, env);

// providers.json of the machine data directory (empty when absent or unreadable: a cache and declarations that are
// broken are declared again, never interpreted); a newer schema refuses writes.
function readFile(dir) {
  if (!dir) return empty();
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(dir, PROVIDERS.path()), 'utf8'));
  } catch {
    return empty();
  }
  if (Number.isInteger(doc?.schema) && doc.schema > PROVIDERS.version) return { ...empty(), newer: doc.schema };
  return check(PROVIDERS, doc).length ? empty() : doc;
}
function update(dir, names, change) {
  if (!dir) throw new StateError('no-machine-data', 'ENV', 'the machine data directory is unknown', { hint: 'set CLAUDE_PLUGIN_DATA or HOME' });
  makeDirs(dir);
  try {
    return withLock(join(dir, 'providers.lock'), () => {
      const cur = readFile(dir);
      if (cur.newer) throw new StateError('schema-newer', 'REFUSED', `${join(dir, PROVIDERS.path())} has schema ${cur.newer}; this plugin knows ${PROVIDERS.version}`, { hint: `update the plugin (${names.bin} doctor)` });
      const next = change(cur);
      writeAtomic(join(dir, PROVIDERS.path()), serialize(PROVIDERS, next));
      return next;
    });
  } catch (err) {
    if (err?.code === 'ELOCKED' || err?.code === 'ESTALE') throw new StateError('providers-busy', 'ENV', err.message, { hint: 'another command holds the providers lock; retry in a moment' });
    throw err;
  }
}

// Every adapter: the built-ins, then the declared generic ones.
export function adapters({ names, env }) {
  const doc = readFile(dataDirOf(names, env));
  return [...BUILTINS, ...Object.entries(doc.generic).map(([id, entry]) => fromEntry(id, entry))];
}

function detectOne(a, env) {
  const d = a.detect({ env });
  const auth = d.found ? a.auth({ env }) : 'missing';
  const roles = ROLES.filter((r) => Object.hasOwn(a.sandboxes, r));
  return { id: a.id, kind: a.kind, found: d.found, path: d.path, version: d.version, auth, roles, sandboxes: roles.map((r) => a.sandboxes[r]), error: d.error };
}

// { at, cached, rows }: the cached rows when fresh (and none was declared since), else a probe of every adapter.
// cacheOnly: answer from the cache only (doctor): a stale or missing cache is reported as notProbed, no CLI is spawned.
export function detectProviders({ names, env, refresh = false, write = true, cacheOnly = false }) {
  const dir = dataDirOf(names, env);
  const doc = readFile(dir);
  const list = [...BUILTINS, ...Object.entries(doc.generic).map(([id, entry]) => fromEntry(id, entry))];
  const d = doc.detected;
  const fresh = d && Date.now() - Date.parse(d.at) < CACHE_MS && d.rows.map((r) => r.id).join() === list.map((a) => a.id).join();
  if (fresh && !refresh) return { at: d.at, cached: true, rows: d.rows };
  if (cacheOnly) return { at: d?.at ?? null, cached: false, rows: [], notProbed: true };
  const at = new Date().toISOString();
  const rows = list.map((a) => detectOne(a, env));
  if (write && dir && !doc.newer) update(dir, names, (cur) => ({ ...cur, detected: { at, rows } }));
  return { at, cached: false, rows };
}

// `providers add`: declares (or replaces) a generic adapter; the detection cache is dropped.
export function addProvider({ names, env, id, argv, sandboxMap }) {
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) throw usage('invalid-value', `provider ID ${String(id).slice(0, 40)}: expected 1-20 lowercase letters or digits`, 'such as mycli');
  if (BUILTINS.some((a) => a.id === id)) throw usage('provider-builtin', `${id} is a built-in adapter`, 'choose another ID for a declared CLI');
  if (argv === undefined) throw usage('missing-flag', 'providers add needs --argv <template>', "such as --argv 'mycli run --dir {cwd} --mode {sandbox} -o {out}'");
  if (sandboxMap === undefined) throw usage('missing-flag', 'providers add needs --sandbox-map <role=mode,…>', 'such as --sandbox-map reviewer=read-only,implementer=workspace-write');
  parseTemplate(argv);
  const map = parseSandboxMap(sandboxMap);
  const entry = { argv: String(argv).trim(), sandboxMap: map, addedAt: new Date().toISOString() };
  update(dataDirOf(names, env), names, (cur) => ({ ...cur, generic: { ...cur.generic, [id]: entry }, detected: null }));
  return { id, ...entry, roles: Object.keys(map) };
}
