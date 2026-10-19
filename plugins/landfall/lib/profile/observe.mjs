// Observation scan (spec §7.3): repository signals → observed facts, gate candidates and risk globs. One
// `git ls-files` lists tracked and untracked, not ignored files (≤ 2 s on 10k files, tests/profile.test.mjs);
// only root manifests are read, each a plain file (never a link) of ≤ 256 KB. Read-only.
// Observed: stack (manifests at depth ≤ 2), gates (root manifests: npm scripts test/lint/typecheck/build with the
// lockfile's package manager, `make test`, pytest, `go test ./...`, `cargo test`; a test script running node:test
// gets the TAP reporter through NODE_OPTIONS, a single jest or vitest command JSON output, so verify reads runtime
// results instead of scanning sources, verify review r1 #6), ui (*.tsx, *.jsx, *.vue,
// *.svelte, *.swift, HTML-like files under templates/), backend (migrations/, prisma/, schema.sql, ORM configs),
// ci (provider or none), otherHarnesses (.codex/, .cursor/, GEMINI.md, AGENTS.md), risk globs (the router's
// defaults, the one list, plus the directories of package.json `bin` and `exports`). ui and backend are observed
// only when present: their absence in a young repository answers nothing.
import { lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { git } from '../git/index.mjs';
import { DEFAULT_RISK_PATHS } from '../router/index.mjs';
import { CONFIDENCE_OF, LIMITS, ProfileError, cleanText, hasForbidden } from './keys.mjs';

export const SCANNER = 2; // bump when detection changes, so cached observations are scanned again
// The fact keys this scan observes; an observed fact of another key (set by an agent) is never dropped by a scan.
export const SCANNED_KEYS = Object.freeze(['stack', 'ui', 'backend', 'ci', 'otherHarnesses']);
const MAX_READ = 256 * 1024;
export const GATE_TIMEOUT_S = 1800;

const MANIFESTS = [
  [/^package\.json$/, 'node'], [/^tsconfig\.json$/, 'typescript'], [/^(?:pyproject\.toml|setup\.py|requirements\.txt)$/, 'python'],
  [/^go\.mod$/, 'go'], [/^Cargo\.toml$/, 'rust'], [/^Gemfile$/, 'ruby'], [/^(?:pom\.xml|build\.gradle(?:\.kts)?)$/, 'java'],
  [/^Package\.swift$/, 'swift'], [/^composer\.json$/, 'php'],
];
const UI = /\.(?:tsx|jsx|vue|svelte|swift)$|(?:^|\/)templates\/(?:.*\/)?[^/]+\.(?:html?|jinja2?|j2|hbs|ejs|erb|twig|njk)$/;
const BACKEND = /(?:^|\/)(?:migrations|prisma)\/|(?:^|\/)(?:schema\.sql|ormconfig\.(?:json|js|ts|ya?ml)|knexfile\.(?:js|ts)|drizzle\.config\.(?:js|ts)|alembic\.ini|\.sequelizerc|mikro-orm\.config\.(?:js|ts))$/;
const CI = [
  [/^\.github\/workflows\/[^/]+\.ya?ml$/, 'github-actions'], [/^\.gitlab-ci\.ya?ml$/, 'gitlab-ci'], [/^\.circleci\/config\.ya?ml$/, 'circleci'],
  [/^azure-pipelines\.ya?ml$/, 'azure-pipelines'], [/^bitbucket-pipelines\.ya?ml$/, 'bitbucket-pipelines'], [/^Jenkinsfile$/, 'jenkins'], [/^\.buildkite\//, 'buildkite'],
];
const HARNESSES = [['.codex/', 'codex'], ['.cursor/', 'cursor'], ['GEMINI.md', 'gemini'], ['AGENTS.md', 'agents-md']];
const NPM_GATES = [['test', 'test'], ['lint', 'lint'], ['typecheck', 'typecheck'], ['build', 'build']];

const MAX_ENTRY_DEPTH = 8;
const MAX_ENTRY_PATHS = 200;

// Evidence text: repository text made safe to store, clipped to the evidence limit.
function clip(text, max = LIMITS.evidence) {
  const chars = [...cleanText(text)];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}
const depth = (p) => p.split('/').length - 1;

// Tracked and untracked (not ignored) files of the repository, relative, `/`-separated, sorted; paths under
// `exclude` (the state directory when it lives in the repository) are left out.
export function listFiles(repo, { env, exclude = null } = {}) {
  const r = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, env });
  if (r.error === 'missing') throw new ProfileError('git-missing', 'ENV', 'git is not on PATH', { hint: 'install git and put it on PATH' });
  if (r.status !== 0) throw new ProfileError('scan-failed', 'ENV', `git ls-files failed in ${repo}: ${clip(r.stderr.trim() || r.error || `exit ${r.status}`, 200)}`, { hint: 'check that the repository is readable' });
  const prefix = exclude ? `${exclude}/` : null;
  return [...new Set(r.stdout.split('\0').filter((p) => p && !(prefix && p.startsWith(prefix))))].sort();
}

// A root file's text when it is a plain file (not a link) of ≤ 256 KB, else null.
function readRoot(repo, name) {
  try {
    const st = lstatSync(join(repo, name));
    if (!st.isFile() || st.size > MAX_READ) return null;
    return readFileSync(join(repo, name), 'utf8');
  } catch {
    return null;
  }
}
const jsonOf = (text) => {
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
};

// Directory globs of package entry points ('./bin/x.js' → 'bin/**'; a root file stays itself).
function publicGlobs(pkg) {
  // Iterative and bounded: a manifest is repository content, so its depth and size are not trusted.
  const paths = [];
  const stack = [[pkg.exports, 0], [pkg.bin, 0]];
  while (stack.length && paths.length < MAX_ENTRY_PATHS) {
    const [v, d] = stack.pop();
    if (typeof v === 'string') paths.push(v);
    else if (v && typeof v === 'object' && d < MAX_ENTRY_DEPTH) for (const x of Object.values(v).reverse()) stack.push([x, d + 1]);
  }
  const globs = [];
  for (const p of paths) {
    if (hasForbidden(p)) continue;
    const rel = posix.normalize(p.replace(/^\.\//, '').replace(/\*.*$/, ''));
    if (!rel || rel.startsWith('..') || rel.startsWith('/') || rel === '.') continue;
    const dir = p.replace(/^\.\//, '').includes('*') ? rel.replace(/\/$/, '') : posix.dirname(rel);
    const glob = dir === '.' || dir === '' ? rel : `${dir}/**`;
    if (glob.length <= LIMITS.glob) globs.push(glob);
  }
  return globs;
}

// The test gate of a package script: node:test gets the TAP reporter through NODE_OPTIONS (also inside a chain; a
// reporter after the file patterns would be ignored), a single jest or vitest command JSON output after npm's `--`.
function testGate(pm, body) {
  const run = `${pm} run test`;
  if (/(?:^|[;&|(]\s*)(?:npx\s+)?node\s+(?:\S+\s+)*?--test\b/.test(body) && !/--test-reporter/.test(body)) return `NODE_OPTIONS="$NODE_OPTIONS --test-reporter=tap" ${run}`;
  const single = !/[;&|]/.test(body);
  const pass = pm === 'npm' ? `${run} --` : run;
  if (single && /^\s*(?:npx\s+)?jest\b/.test(body) && !/--json\b/.test(body)) return `${pass} --json`;
  if (single && /^\s*(?:npx\s+)?vitest\b/.test(body) && !/--reporter\b/.test(body)) return `${pass} --reporter=json`;
  return run;
}

function gatesOf(repo, files, has) {
  const gates = [];
  const add = (name, cmd, kind) => { if (!gates.some((g) => g.name === name)) gates.push({ name, cmd, timeoutS: GATE_TIMEOUT_S, kind }); };
  const pkg = has('package.json') ? jsonOf(readRoot(repo, 'package.json') ?? '') : null;
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
  for (const [script, kind] of NPM_GATES) {
    const body = scripts[script];
    if (typeof body !== 'string' || !body.trim() || (script === 'test' && /no test specified/.test(body))) continue;
    add(script, script === 'test' ? testGate(pm, body) : `${pm} run ${script}`, kind);
  }
  if (has('Makefile') && /^test\s*:/m.test(readRoot(repo, 'Makefile') ?? '')) add('make-test', 'make test', 'test');
  const python = ['pyproject.toml', 'setup.cfg', 'tox.ini', 'requirements.txt'].some((f) => has(f) && /pytest/.test(readRoot(repo, f) ?? ''));
  if (python || has('pytest.ini') || has('conftest.py')) add('pytest', 'pytest', 'test');
  if (has('go.mod')) add('go-test', 'go test ./...', 'test');
  if (has('Cargo.toml')) add('cargo-test', 'cargo test', 'test');
  return { gates, pkg };
}

// The observation of a file list (relative paths of the repository at `repo`).
export function observeFiles(repo, files) {
  const set = new Set(files);
  const has = (f) => set.has(f);
  const facts = {};

  const stack = new Map();
  for (const f of files) {
    if (depth(f) > 2) continue;
    const base = posix.basename(f);
    for (const [re, name] of MANIFESTS) if (re.test(base) && !stack.has(name)) stack.set(name, f);
  }
  const { gates, pkg } = gatesOf(repo, files, has);
  if (pkg && (pkg.dependencies?.typescript || pkg.devDependencies?.typescript) && !stack.has('typescript')) stack.set('typescript', 'package.json');
  if (stack.size) {
    const value = [...stack.keys()].sort();
    facts.stack = { value, evidence: clip([...new Set(value.map((k) => stack.get(k)))].sort().join(', ')), confidence: CONFIDENCE_OF.manifest };
  }

  const ui = files.find((f) => UI.test(f));
  if (ui) facts.ui = { value: true, evidence: clip(ui), confidence: CONFIDENCE_OF.files };
  const backend = files.find((f) => BACKEND.test(f));
  if (backend) facts.backend = { value: true, evidence: clip(backend), confidence: CONFIDENCE_OF.files };

  let ci = null;
  for (const [re, name] of CI) {
    const hit = files.find((f) => re.test(f));
    if (hit) { ci = { value: name, evidence: clip(hit), confidence: CONFIDENCE_OF.manifest }; break; }
  }
  facts.ci = ci ?? { value: 'none', evidence: `no CI configuration among ${files.length} files`, confidence: CONFIDENCE_OF.manifest };

  const harnesses = [];
  for (const [path, name] of HARNESSES) {
    const found = path.endsWith('/') ? files.some((f) => f.startsWith(path)) || isDir(join(repo, path)) : has(path) || isFile(join(repo, path));
    if (found) harnesses.push([name, path]);
  }
  harnesses.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  facts.otherHarnesses = { value: harnesses.map(([n]) => n), evidence: harnesses.length ? clip(harnesses.map(([, p]) => p).sort().join(', ')) : 'none found', confidence: CONFIDENCE_OF.manifest };

  const riskPaths = [...new Set([...DEFAULT_RISK_PATHS, ...(pkg ? publicGlobs(pkg) : [])])].slice(0, LIMITS.riskPaths);
  return { facts, gates: gates.slice(0, LIMITS.gates), riskPaths, files: files.length };
}

function isDir(p) {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return lstatSync(p).isFile(); } catch { return false; }
}

// The observation of the repository at `repo` (its real top level).
export const observe = (repo, { env, exclude = null } = {}) => observeFiles(repo, listFiles(repo, { env, exclude }));
