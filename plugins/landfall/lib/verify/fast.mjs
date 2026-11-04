// Fast verify (T-MG-182, D-MG-60): `verify <id>` runs a subset instead of the whole profile test gate; `task merge`
// always runs the full gate set once on the integrated tree, the only full run per task.
// The subset (fastPlan): the test files the task's change adds or changes, plus the test files mapped to each other
// changed path, run by node:test with the tap reporter (one gate per ≤ 300-character command), plus the profile's
// fastGuards (each its own gate, kind `guard`: pass or fail, no inventory). The mapping, the simplest sound one: a
// changed path maps to the test files named `<d>.test.<ext>` or `<d>-*.test.<ext>`, where <d> is the name of the
// directory the path is in (lib/verify/run.mjs → tests/verify-*.test.mjs). Documents and images (the router's
// weightless paths) need no test.
// Full instead (the reason is recorded in verify.json `mode.why`): --full · a critical task · no comparable change ·
// no single node:test gate with the tap reporter (the only runner verify knows how to narrow) · a changed path matching
// a risk glob, package.json, tests/helpers/** or scripts/** · a changed path no test file maps to · a test path a shell
// word cannot hold safely · fastGuards this machine does not trust (they run like gates: `trust` records them).
import { basename, dirname } from 'node:path';
import { riskMatcher } from '../router/classify.mjs';
import { weightless } from '../router/index.mjs';
import { gatesShaOf } from '../state/index.mjs';
import { fastGuardsOf } from '../profile/index.mjs';
import { scannerOf } from './scan.mjs';

export const SHARED_GLOBS = Object.freeze(['package.json', '**/package.json', 'tests/helpers/**', 'scripts/**']);
const CMD_MAX = 300;
const FILES_MAX = 200;
const GUARD_TIMEOUT_S = 600;
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const NODE_TEST = /\.test\.[cm]?[jt]s$/;
const RUNNER = 'node --test --test-reporter=tap';

// The fastGuards of the profile as gates (kind guard): their identity is what `trust` records and verify checks.
export const guardGates = (profile) => fastGuardsOf(profile).map((cmd, i) => ({ name: `guard-${i + 1}`, cmd, timeoutS: GUARD_TIMEOUT_S, kind: 'guard' }));

const isTest = (p) => scannerOf(p) !== null && NODE_TEST.test(p);
const quote = (p) => `'${p}'`;

// The node:test gates for `files`, each command at most 300 characters (the verify.json limit of a gate's cmd).
export function testGates(files, timeoutS) {
  const gates = [];
  let cur = [];
  const flush = () => { if (cur.length) gates.push({ name: `fast-test-${gates.length + 1}`, cmd: `${RUNNER} ${cur.map(quote).join(' ')}`, timeoutS, kind: 'test' }); cur = []; };
  for (const f of files) {
    if (cur.length && `${RUNNER} ${[...cur, f].map(quote).join(' ')}`.length > CMD_MAX) flush();
    cur.push(f);
  }
  flush();
  return gates;
}

// { kind: 'fast' | 'full', why, files (fast: the test files selected), gates (fast: the gates to run) }.
// `repoFiles`: the files of the worktree now (tracked and untracked); `trusted(gates)`: whether this machine trusts a set.
export function fastPlan({ profile, change, full = false, critical = false, riskPaths = [], repoFiles = [], trusted = () => false }) {
  const fullBecause = (why) => ({ kind: 'full', why, files: [], gates: profile.gates });
  if (full) return fullBecause('--full');
  if (critical) return fullBecause('a critical task runs the full suite');
  if (!change) return fullBecause('no change against the base to select tests from');
  const tests = profile.gates.filter((g) => g.kind === 'test');
  if (tests.length !== 1 || !tests[0].cmd.includes('--test-reporter=tap')) return fullBecause('no single node:test gate with the tap reporter to narrow');
  const risky = riskMatcher(riskPaths);
  const shared = riskMatcher(SHARED_GLOBS);
  const hit = change.paths.find((p) => risky(p) || shared(p));
  if (hit) return fullBecause(`a shared or risk path changed: ${hit}`);
  const testFiles = repoFiles.filter(isTest);
  const picked = new Set();
  for (const p of change.paths) {
    if (isTest(p)) { picked.add(p); continue; }
    if (weightless(p)) continue;
    const d = basename(dirname(p));
    const mapped = d && d !== '.' ? testFiles.filter((f) => { const b = basename(f); return b.startsWith(`${d}-`) || b.startsWith(`${d}.test.`); }) : [];
    if (!mapped.length) return fullBecause(`no test file maps to ${p}`);
    for (const f of mapped) picked.add(f);
  }
  const files = [...picked].sort();
  if (files.length > FILES_MAX) return fullBecause(`over ${FILES_MAX} test files selected`);
  const unsafe = files.find((f) => !SAFE_PATH.test(f) || f.length > CMD_MAX - RUNNER.length - 3);
  if (unsafe) return fullBecause(`a test path cannot be passed safely: ${unsafe.slice(0, 80)}`);
  const guards = guardGates(profile);
  if (guards.some((g) => g.cmd.length > CMD_MAX)) return fullBecause('a fastGuards command is over 300 characters');
  if (guards.length && !trusted(guards)) return fullBecause('the fastGuards are not trusted on this machine (trust records them)');
  const present = new Set(repoFiles);
  const gates = [...testGates(files.filter((f) => present.has(f)), tests[0].timeoutS), ...guards];
  // a verify that would run nothing at all is no check: the full set runs
  if (!gates.length && !files.length) return fullBecause('no test file and no fastGuards selected');
  return { kind: 'fast', why: `${files.length} test file${files.length === 1 ? '' : 's'} of the change${guards.length ? ` and ${guards.length} fastGuards` : ''}`, files, gates };
}

export const guardsSha = (profile) => {
  const g = guardGates(profile);
  return g.length ? gatesShaOf(g) : null;
};
