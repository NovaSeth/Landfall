// Machine trust (T-MG-77 slice B): which gate sets and threshold overrides of a repository this machine runs or counts.
// A cloned repository can ship <state dir>/profile.json (gate commands run by sh -c) and config.json (threshold
// overrides that move the router's classes). Neither runs nor counts until this machine set or trusted it.
//   trust.json (machine data dir, schema 1): { repos: { <repoKey>: { gates: [sha…], overrides: [sha…], adoptedAt? } } },
//   at most TRUST_MAX shas per list, newest last. Atomic replace under its own lock (trust.lock in the machine data dir).
//   repoKey: the first 32 hex characters of sha256(real path of the state dir's git common dir); a state dir outside
//   any git repository (a linked one) uses its own real path.
//   gatesSha: sha256 of the gates as verify identifies them (name, cmd, timeoutS, kind, in order).
//   overridesSha: sha256 of the canonical JSON (keys sorted) of config.json `thresholds`.
// Trusted without asking:
//   - a gate set or overrides written through lib/state on this machine (store.mjs records them when they change);
//   - adoption, the lossless migration for existing users, on machine-side evidence only (fix round 1, AR-2): a
//     repository without an entry whose state dir is linked in this machine's projects.json (`init --state-dir`; the
//     entry's stateDir has the state dir's real path) and whose local/ is not foreign (an unknown owner, when git gives
//     no answer, is foreign: nothing is adopted). Nothing in the repository counts: an unmarked local/ alone is not
//     enough. A repository whose shipped local/ was moved aside has an entry without adoption, written before the
//     rename (store.mjs moveAside), and so has one linked by `init --state-dir` from this release on (activation.mjs
//     trustLink, fix round 2, AR-3): adoption covers only links made before this release.
// Everything else needs the `trust` command at a terminal.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { withLock, writeAtomic } from '../fsx/index.mjs';
import { git } from '../git/index.mjs';
import { checkWrite, parseDoc } from './document.mjs';
import { StateError, guarded } from './errors.mjs';
import { MACHINE_KINDS } from './kinds.mjs';
import { localForeign } from './machine.mjs';
import { readProjects } from './resolve.mjs';
import { MIGRATIONS } from './migrations/index.mjs';
import { format } from './schema.mjs';
import { upgradeDoc } from './upgrade.mjs';

export const TRUST_MAX = 50;
export const TRUST_HINT = 'run `! {bin} trust` in Claude Code, or `{bin} trust` in a terminal';
const TRUST = MACHINE_KINDS.trust;
const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

// The identity of a gate set: what verify runs, in order (lib/verify gatesSha is this function).
export const gatesShaOf = (gates) => sha256(JSON.stringify((gates ?? []).map((g) => [g.name, g.cmd, g.timeoutS, g.kind])));

const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};
export const overridesShaOf = (thresholds) => sha256(canonical(thresholds ?? {}));

// What a state document text holds for trust: the gates of profile.json, the thresholds of config.json.
const parsed = (text) => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };
export const gatesOfText = (text) => (Array.isArray(parsed(text)?.gates) ? parsed(text).gates : []);
export const thresholdsOfText = (text) => {
  const t = parsed(text)?.thresholds;
  return t && typeof t === 'object' && !Array.isArray(t) ? t : {};
};

const repoKeys = new Map();
export function repoKey(stateDir, { env = process.env } = {}) {
  if (repoKeys.has(stateDir)) return repoKeys.get(stateDir);
  let root;
  const r = git(['rev-parse', '--git-common-dir'], { cwd: stateDir, env: { ...env, LC_ALL: 'C' }, timeoutMs: 2000 });
  if (!r.error && r.status === 0 && r.stdout.trim()) {
    const dir = r.stdout.trim();
    root = isAbsolute(dir) ? dir : resolvePath(stateDir, dir);
  } else root = stateDir;
  try { root = realpathSync(root); } catch { /* as given */ }
  const key = sha256(root).slice(0, 32);
  repoKeys.set(stateDir, key);
  return key;
}

export function readTrust(dataDir, names, { write = false } = {}) {
  const file = join(dataDir, TRUST.path());
  let text;
  try {
    text = guarded(() => readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { schema: TRUST.version, repos: {} };
    throw err;
  }
  return parseDoc(TRUST, text, { where: file, names, write, upgrade: (k, d, w) => upgradeDoc(k, d, MIGRATIONS, w) });
}

const noData = () => new StateError('no-machine-data', 'ENV', 'the machine data directory is unknown', { hint: 'set CLAUDE_PLUGIN_DATA or HOME' });
const capped = (list, sha) => [...list.filter((s) => s !== sha), sha].slice(-TRUST_MAX);

// Adds the shas given ({ gates, overrides }: a sha or null) to the entry of `key`; `adoptedAt` marks an adoption and
// adds only where the entry does not exist yet (a concurrent writer's entry wins). Returns the entry.
export function recordTrust({ dataDir, names, key, gates = null, overrides = null, adoptedAt = null }) {
  if (typeof dataDir !== 'string' || dataDir === '') throw noData();
  const file = join(dataDir, TRUST.path());
  return guarded(() => withLock(join(dataDir, 'trust.lock'), () => {
    const doc = readTrust(dataDir, names, { write: true });
    const repos = { ...doc.repos };
    if (adoptedAt && repos[key]) return repos[key];
    const entry = { gates: [...(repos[key]?.gates ?? [])], overrides: [...(repos[key]?.overrides ?? [])], ...(repos[key]?.adoptedAt ? { adoptedAt: repos[key].adoptedAt } : {}) };
    if (gates) entry.gates = capped(entry.gates, gates);
    if (overrides) entry.overrides = capped(entry.overrides, overrides);
    if (adoptedAt) entry.adoptedAt = adoptedAt;
    repos[key] = entry;
    const next = { schema: TRUST.version, repos };
    checkWrite(TRUST, next, { where: file });
    writeAtomic(file, format(TRUST.spec, next));
    return entry;
  }));
}

// The current gate set and overrides of a state directory, read from its files.
function currentOf(stateDir) {
  const read = (rel) => { try { return readFileSync(join(stateDir, rel), 'utf8'); } catch { return null; } };
  const gates = gatesOfText(read('profile.json'));
  const thresholds = thresholdsOfText(read('config.json'));
  return { gates: gates.length ? gatesShaOf(gates) : null, overrides: Object.keys(thresholds).length ? overridesShaOf(thresholds) : null };
}

// Machine-side evidence for adoption: a projects.json entry of this machine links a repository to this state dir.
function linkedHere(stateDir, dataDir, names) {
  let real;
  try { real = realpathSync(stateDir); } catch { return false; }
  let projects;
  try { projects = readProjects(dataDir, names).projects ?? {}; } catch { return false; }
  return Object.values(projects).some((entry) => {
    if (typeof entry?.stateDir !== 'string') return false;
    try { return realpathSync(entry.stateDir) === real; } catch { return false; }
  });
}

// Whether `sha` of `kind` ('gates' | 'overrides') is trusted for the repository of `stateDir`, adopting first when
// the repository has no entry and machine-side evidence says it predates the trust store. { trusted, key, adopted }.
export function isTrusted({ dir: stateDir, dataDir, names, env = process.env, kind, sha, adopt = true, at = new Date().toISOString() }) {
  if (!dataDir) return { trusted: false, key: null, adopted: false };
  const key = repoKey(stateDir, { env });
  let entry = readTrust(dataDir, names).repos[key];
  let adopted = false;
  if (!entry && adopt && linkedHere(stateDir, dataDir, names) && !localForeign(stateDir, { env }).foreign) {
    entry = recordTrust({ dataDir, names, key, ...currentOf(stateDir), adoptedAt: at });
    adopted = entry.adoptedAt === at; // false when a concurrent writer's entry (a move-aside, a link) came first
  }
  return { trusted: Boolean(entry?.[kind]?.includes(sha)), key, adopted };
}
