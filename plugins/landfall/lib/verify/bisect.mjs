// The narrow runs of a batch bisect (T-MG-209): the profile fastGuards, and the test files that failed in the full run,
// on the integration worktree. A narrow run decides which tasks to leave out; the set that merges still passes one full
// gate (FLW-8). A run that cannot be narrowed (a hashed test id, no tap test gate) is left to the caller's full gate.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { emptyProfile } from '../profile/index.mjs';
import { gatesShaOf, isTrusted } from '../state/index.mjs';
import { fingerprint } from './baseline.mjs';
import { context as collectorContext, inventoryOf } from './collect.mjs';
import { guardGates, testGates } from './fast.mjs';
import { runGate } from './gates.mjs';
import { codeState } from './history.mjs';

const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const FILES_MAX = 100;

// The fastGuards of the target profile as gates, [] when there are none or this machine does not trust them.
export function guardsOf({ store, where, names, env }) {
  const guards = guardGates(store.read('profile', null) ?? emptyProfile());
  return guards.length && isTrusted({ dir: where.dir, dataDir: where.dataDir, names, env, kind: 'gates', sha: gatesShaOf(guards) }).trusted ? guards : [];
}

// The only test gate verify knows how to narrow: one node:test gate with the tap reporter.
export function narrowable({ store }) {
  const tests = (store.read('profile', null) ?? emptyProfile()).gates.filter((g) => g.kind === 'test');
  return tests.length === 1 && tests[0].cmd.includes('--test-reporter=tap');
}

// The test files of the new failures of a full gate run (`run.runs`, `run.byTask`): the file of the test id, else the
// one its failure location names (TAP ids carry no file); null when any failure names none or there are too many.
export function failingFiles({ here, env }, run) {
  const prints = new Set([...run.byTask.values()].flatMap((o) => o.doc.failures.new));
  if (prints.size === 0) return null;
  const inv = inventoryOf(run.runs.filter((r) => r.kind === 'test'), collectorContext(here, env, codeState(here, env).rel));
  const rooted = [...new Set([here.worktree, realpathSync(here.worktree)])].map((r) => `${r}/`);
  const files = new Set();
  let matched = 0;
  for (const f of inv.parts.flatMap((p) => p.failing)) {
    if (!prints.has(fingerprint(f))) continue;
    matched += 1;
    let file = '';
    try { file = JSON.parse(f.id)[0]; } catch { file = ''; }
    file = typeof file === 'string' && file !== '' ? file : (/^(.+?)(?::\d+){1,2}$/.exec(rooted.find((r) => f.location.startsWith(r))?.length ? f.location.slice(rooted.find((r) => f.location.startsWith(r)).length) : f.location)?.[1] ?? '');
    if (!SAFE_PATH.test(file)) return null;
    files.add(file);
  }
  return matched >= prints.size && files.size <= FILES_MAX ? files : null;
}

// Run `guards` and the node:test gate over `files` (the ones the tree has) in the integration worktree:
// { state: pass | fail | error, tests (fingerprints not in `known`), why }. Failures in `known` (pinned) do not fail.
export function narrowRun({ store, wt, here, env }, { guards = [], files = null, known = new Set() }) {
  const test = (store.read('profile', null) ?? emptyProfile()).gates.find((g) => g.kind === 'test');
  const present = files ? [...files].filter((f) => existsSync(join(wt, f))).sort() : [];
  const runs = [...guards, ...(present.length ? testGates(present, test.timeoutS) : [])].map((g) => runGate(g, { cwd: wt, env }));
  const broken = runs.find((r) => r.gate.result === 'error');
  if (broken) return { state: 'error', tests: [], why: `gate ${broken.gate.name} could not run`.slice(0, 300) };
  const guard = runs.find((r) => r.kind === 'guard' && r.gate.result !== 'pass');
  if (guard) return { state: 'fail', tests: [], why: `fastGuards fail: ${guard.gate.cmd}`.slice(0, 300) };
  const failed = runs.filter((r) => r.kind === 'test' && r.gate.result !== 'pass');
  if (!failed.length) return { state: 'pass', tests: [], why: null };
  const inv = inventoryOf(runs.filter((r) => r.kind === 'test'), collectorContext(here, env, codeState(here, env).rel));
  const all = inv.parts.flatMap((p) => p.failing.map(fingerprint));
  const fresh = all.filter((p) => !known.has(p));
  const pinned = all.length > 0 && fresh.length === 0 && failed.every((r) => r.gate.result === 'fail');
  return pinned ? { state: 'pass', tests: [], why: null } : { state: 'fail', tests: fresh, why: 'the gates fail' };
}

// The first task whose prefix of `rem` fails, by binary search; `failed` is the known failing run of the whole `rem`,
// `probe(prefix)` runs a prefix. { culprit, blame } or { error } (a run that could not run).
export function culpritOf(rem, failed, probe) {
  let lo = 0;
  let hi = rem.length - 1;
  let blame = failed;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = probe(rem.slice(0, mid + 1));
    if (r.state === 'error') return { error: r };
    if (r.state === 'pass') lo = mid + 1;
    else { hi = mid; blame = r; }
  }
  return { culprit: rem[lo], blame };
}
