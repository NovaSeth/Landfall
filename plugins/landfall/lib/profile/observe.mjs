// Observation scan (spec §7.3): repository signals → observed facts, gate candidates and risk globs. One
// `git ls-files` lists tracked and untracked, not ignored files (≤ 2 s on 10k files, tests/profile.test.mjs);
// only root manifests are read, each a plain file (never a link) of ≤ 256 KB. Read-only.
// Observed: stack (manifests at depth ≤ 2), gates (root manifests: npm scripts test/lint/typecheck/build with the
// lockfile's package manager, `make test`, pytest, `go test ./...`, `cargo test`; a test script running node:test
// gets the TAP reporter through NODE_OPTIONS, a single jest or vitest command JSON output, so verify reads runtime
// results instead of scanning sources, verify review r1 #6), ui (*.tsx, *.jsx, *.vue,
// *.svelte, *.swift, HTML-like files under templates/), backend (migrations/, prisma/, schema.sql, ORM configs),
// llm (LLM and agent SDKs among the dependencies of the root manifests), ci (provider or none), otherHarnesses (.codex/, .cursor/, GEMINI.md, AGENTS.md), risk globs (the router's
// defaults, the one list, plus the directories of package.json `bin` and `exports`). ui, backend and llm are observed
// only when present: their absence in a young repository answers nothing.
import { lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { git } from '../git/index.mjs';
import { DEFAULT_RISK_PATHS } from '../router/index.mjs';
import { CONFIDENCE_OF, LIMITS, ProfileError, cleanText, hasForbidden } from './keys.mjs';

export const SCANNER = 3; // bump when detection changes, so cached observations are scanned again
// The fact keys this scan observes; an observed fact of another key (set by an agent) is never dropped by a scan.
export const SCANNED_KEYS = Object.freeze(['stack', 'ui', 'backend', 'llm', 'ci', 'otherHarnesses']);
const MAX_READ = 256 * 1024;
const MAX_ARRAY_LINES = 2000; // a pyproject dependency array that does not close within this many lines counts nothing
const MAX_GATE_BODY = 4096; // the scripts.test body is read up to here
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

// LLM and agent SDKs (frozen; read only by llmOf). package.json: dependencies, peer and optional, never dev.
const NPM_LLM = Object.freeze(['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/bedrock-sdk', '@anthropic-ai/vertex-sdk', 'openai', '@openai/agents', 'ai', 'langchain', 'llamaindex', 'ollama', 'cohere-ai', 'groq-sdk', 'replicate', '@mistralai/mistralai', '@google/genai', '@google/generative-ai', '@huggingface/inference', '@modelcontextprotocol/sdk', '@aws-sdk/client-bedrock-runtime']);
const NPM_LLM_PREFIXES = Object.freeze(['@ai-sdk/', '@langchain/', '@llamaindex/', '@mastra/']);
const PY_LLM = Object.freeze(['anthropic', 'claude-agent-sdk', 'openai', 'openai-agents', 'langchain', 'langchain-core', 'langchain-community', 'langchain-openai', 'langchain-anthropic', 'langgraph', 'llama-index', 'llama-index-core', 'litellm', 'google-genai', 'google-generativeai', 'mistralai', 'cohere', 'mcp', 'fastmcp', 'ollama', 'crewai', 'autogen-agentchat', 'pyautogen', 'pydantic-ai', 'dspy', 'dspy-ai', 'instructor', 'semantic-kernel', 'smolagents', 'haystack-ai']);
const GO_LLM = Object.freeze(['github.com/anthropics/anthropic-sdk-go', 'github.com/openai/openai-go', 'github.com/sashabaranov/go-openai', 'github.com/tmc/langchaingo', 'github.com/mark3labs/mcp-go', 'github.com/modelcontextprotocol/go-sdk', 'google.golang.org/genai', 'github.com/firebase/genkit/go']);
const PY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*/;
const pyNorm = (n) => n.toLowerCase().replace(/[_.]/g, '-');

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
// `node` followed later by `--test` within one command segment (segments end at ; & | or a parenthesis): one pass over
// the tokens, no backtracking.
function nodeTest(body) {
  for (const segment of body.split(/[;&|()]/)) {
    const words = segment.trim().split(/\s+/);
    const at = words[0] === 'npx' ? 1 : 0;
    if (words[at] === 'node' && words.slice(at + 1).some((w) => /^--test(?!\w)/.test(w))) return true;
  }
  return false;
}

function testGate(pm, body) {
  const run = `${pm} run test`;
  if (body.length > MAX_GATE_BODY) return run; // a cut chain could pass for one command: no flag is appended
  if (nodeTest(body) && !/--test-reporter/.test(body)) return `NODE_OPTIONS="$NODE_OPTIONS --test-reporter=tap" ${run}`;
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

// A line without its TOML comment: `#` to the end of the line when outside a quoted string.
function stripToml(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

// A dotted TOML key or table header as segments: split on `.` outside quotes, trimmed, one pair of quotes removed.
// With `stopAtEq` the path ends at the first `=` outside quotes and `rest` is the text after it; no `=` gives null.
function tomlPath(text, stopAtEq) {
  const segs = [];
  let cur = '';
  let q = null;
  let i = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (stopAtEq && c === '=') break;
    if (c === '.') { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (stopAtEq && i >= text.length) return null;
  segs.push(cur);
  const path = segs.map((s) => s.trim().replace(/^(["'])(.*)\1$/, '$2'));
  return { path, rest: stopAtEq ? text.slice(i + 1).trim() : '' };
}

// Dependency names of a pyproject.toml, section-aware: requirement strings inside closed arrays of
// `project.dependencies`, `project.optional-dependencies.*` and `dependency-groups.*`; valued keys of
// `tool.poetry.dependencies` and `tool.poetry.group.*.dependencies`. Keys and headers are decoded (quotes, dotted
// paths) and matched as full paths. Everything else (keywords, descriptions, other tools, comments, unclosed arrays)
// counts nothing.
function pyprojectNames(text) {
  const names = [];
  const lines = text.split(/\r?\n/).map(stripToml);
  let section = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const head = /^\[\[?(.*?)\]\]?$/.exec(line);
    if (head) { section = tomlPath(head[1], false).path; continue; }
    const key = tomlPath(line, true);
    if (!key || key.path.some((s) => s === '')) continue;
    const full = [...section, ...key.path];
    if (full[0] === 'tool' && full[1] === 'poetry') {
      const at = full[2] === 'dependencies' ? 3 : (full[2] === 'group' && full[4] === 'dependencies' ? 5 : -1);
      if (at > 0 && full.length > at && /^["'{[]/.test(key.rest)) names.push(full[at]);
      continue;
    }
    const inArray = (full.length === 2 && full[0] === 'project' && full[1] === 'dependencies')
      || (full.length === 3 && full[0] === 'project' && full[1] === 'optional-dependencies')
      || (full.length === 2 && full[0] === 'dependency-groups');
    if (!inArray || !key.rest.startsWith('[')) continue;
    // Each line is read a bounded number of times: an array that does not close within MAX_ARRAY_LINES lines, before
    // the next table header or by the end of the file counts nothing, and the scan resumes after the lines it read.
    let body = key.rest;
    let j = i;
    let closed = /\]\s*$/.test(body);
    while (!closed && j + 1 < lines.length && j - i + 1 < MAX_ARRAY_LINES) {
      const next = lines[j + 1].trim();
      if (next.startsWith('[')) break;
      j++;
      body += `\n${lines[j]}`;
      closed = /\]\s*$/.test(next);
    }
    if (!closed) { i = j; continue; }
    for (const q of body.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:$|[[<>=!~;@])/.exec((q[1] ?? q[2]).trim());
      if (m) names.push(m[1]);
    }
    i = j;
  }
  return names;
}

// The first LLM or agent SDK among the dependencies of the root manifests, as `<manifest>: <package>`, else null.
function llmOf(repo, files) {
  const root = files.filter((f) => !f.includes('/'));
  if (root.includes('package.json')) {
    const pkg = jsonOf(readRoot(repo, 'package.json') ?? '');
    for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg?.[key];
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
      const hit = Object.keys(deps).find((n) => NPM_LLM.includes(n) || NPM_LLM_PREFIXES.some((p) => n.startsWith(p)));
      if (hit) return `package.json: ${hit}`;
    }
  }
  const pyHit = (names) => names.map((n) => pyNorm(n)).find((n) => PY_LLM.includes(n));
  for (const f of root.filter((n) => /^requirements.*\.txt$/.test(n))) {
    const names = [];
    for (const line of (readRoot(repo, f) ?? '').split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#') || l.startsWith('-')) continue;
      const m = PY_NAME.exec(l);
      if (m) names.push(m[0]);
    }
    const hit = pyHit(names);
    if (hit) return `${f}: ${hit}`;
  }
  if (root.includes('pyproject.toml')) {
    const hit = pyHit(pyprojectNames(readRoot(repo, 'pyproject.toml') ?? ''));
    if (hit) return `pyproject.toml: ${hit}`;
  }
  if (root.includes('go.mod')) {
    let inBlock = false;
    for (const line of (readRoot(repo, 'go.mod') ?? '').split(/\r?\n/)) {
      let l = line.replace(/\/\/.*$/, '').trim();
      if (inBlock) { if (l.startsWith(')')) { inBlock = false; continue; } }
      else if (/^require\s*\(/.test(l)) { inBlock = true; continue; }
      else if (/^require\s+/.test(l)) l = l.replace(/^require\s+/, '');
      else continue;
      const mod = l.split(/\s+/)[0];
      if (GO_LLM.some((p) => mod === p || mod.startsWith(`${p}/`))) return `go.mod: ${mod}`;
    }
  }
  return null;
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
  const llm = llmOf(repo, files);
  if (llm) facts.llm = { value: true, evidence: clip(llm), confidence: CONFIDENCE_OF.manifest };

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
