// Architecture boundaries (spec §4.2, §4.3, GC2, GC10): import graph and call-site scan of the plugin code.
// The checker runs on the real plugin (no violations) and on one planted violation per rule (each must be
// found: a checker that finds nothing proves nothing, REV-45). Also: the minimal boundary owners git, fsx and
// proc behave as their contract says; package.json files carry no dependencies; `npm test` includes e2e.
// This file holds no plugin name or path: both come from lib/name.json.
// Limits of the static scan: a proc binding passed through a variable (`const r = run; r(x)`) is not traced, a
// global-config name built from fragments (`'CLAUDE' + '.md'`) is not caught, and the `unit` passed to proc.run
// is checked at run time (owners), not against the caller's directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { lex } from './helpers/lex.mjs';

// No test here touches the real HOME: git (through lib/git) and the plugin run with a throwaway HOME and global git
// config, without the calling session (tests/helpers/isolated-env.mjs).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function locate(dir = root) {
  const plugins = join(dir, 'plugins');
  const hits = existsSync(plugins) ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json'))) : [];
  assert.equal(hits.length, 1, `expected exactly one plugins/*/lib/name.json in ${dir}, found ${hits.length}`);
  return { pluginDir: join(plugins, hits[0]), names: readJson(join(plugins, hits[0], 'lib', 'name.json')) };
}
const { pluginDir, names } = locate();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
// INT-1 (GC6): the default risk globs are data in one file; no other plugin file holds one of them.
const RISK_LIST = 'lib/router/thresholds.json';
const RISK_GLOBS = readJson(join(pluginDir, ...RISK_LIST.split('/'))).riskPaths;
const jsonStrings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(jsonStrings) : []);
// S2: the one output writer. Every other file returns what to print; the launcher writes only its own stderr line.
const OUTPUT_WRITER = 'lib/cli/output.mjs';

// Units of spec §4.2; `name` is lib/name.json.
const UNITS = new Set(['cli', 'state', 'profile', 'engine', 'router', 'verify', 'loop', 'sched', 'lanes', 'decisions', 'receipts',
  'providers', 'gen', 'method', 'hooks', 'guard', 'ui', 'git', 'fsx', 'proc', 'import1x', 'mirror', 'text', 'secrets']);
// §4.3: hooks import directly only these units (and Node built-ins), and never reach the HOOK_NEVER units at all.
const HOOK_IMPORTS = new Set(['hooks', 'state', 'method', 'decisions', 'sched', 'loop', 'guard', 'text']);
const HOOK_NEVER = new Set(['providers', 'gen', 'lanes', 'receipts']);
// §4.3: the only unit allowed to spawn each external program (basename of the literal first argument).
const SPAWN_OWNER = { git: 'git', gh: 'mirror', codex: 'providers', gemini: 'providers' };
// Units that may call lib/proc with a computed program (provider argv comes from configuration).
const DYNAMIC_SPAWN_UNITS = new Set(['providers']);
// GC2: files that may name global config files, to read them only (they must contain no write call).
const GLOBAL_CONFIG_READERS = new Set(['lib/cli/doctor.mjs']);
const GLOBAL_CONFIG = /claude\.md|settings(\.local)?\.json/i;
const SPAWN_NAMES = '(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|run)';
const WRITE_CALL = /(?<![\w$])(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|cp|cpSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|truncate|truncateSync|ftruncate|ftruncateSync|symlink|symlinkSync|link|linkSync|mkdir|mkdirSync|writeAtomic|createExclusive)\s*\(/;

const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);

// Unit of a plugin file: lib/<unit>/…, `name` for lib/name.json, `bin` for the launcher.
function unitOf(pluginRoot, file) {
  const rel = relative(pluginRoot, file).split(sep);
  if (rel[0] === 'bin') return 'bin';
  if (rel[0] === 'lib') return rel.length === 2 ? rel[1].replace(/\.\w+$/, '') : rel[1];
  return null;
}
const programOf = (literal) => basename(literal).replace(/\.exe$/i, '').toLowerCase();

function scan(pluginRoot) {
  const violations = [];
  const add = (rule, file, detail) => violations.push(`${rule}: ${relative(pluginRoot, file).split(sep).join('/')}: ${detail}`);
  const libDir = join(pluginRoot, 'lib');
  for (const entry of existsSync(libDir) ? readdirSync(libDir) : []) {
    const p = join(libDir, entry);
    if (statSync(p).isDirectory() ? !UNITS.has(entry) : entry !== 'name.json') add('unknown-unit', p, `lib/${entry} is not a §4.2 unit`);
  }
  const files = [...walk(libDir).filter((f) => /\.(mjs|js|cjs)$/.test(f)), ...walk(join(pluginRoot, 'bin'))];
  const graph = new Map(); // file → resolved relative import targets
  for (const file of files) {
    const unit = unitOf(pluginRoot, file);
    const rel = relative(pluginRoot, file).split(sep).join('/');
    const { code, literals } = lex(readFileSync(file, 'utf8'));
    const lit = (k) => literals[Number(k)];
    const strings = literals.filter((v) => typeof v === 'string');

    // Imports: static, re-exports, side-effect and dynamic; a computed specifier cannot be checked.
    const specs = [];
    for (const re of [/\bimport\s+[^;()§]*?\bfrom\s*§(\d+)§/g, /\bexport\s+[^;()§]*?\bfrom\s*§(\d+)§/g, /\bimport\s*§(\d+)§/g, /\bimport\s*\(\s*§(\d+)§\s*\)/g]) {
      for (const m of code.matchAll(re)) specs.push(lit(m[1]));
    }
    if (unit !== 'bin' && /\bimport\s*\(\s*(?!§\d+§\s*\))/.test(code)) add('external-import', file, 'import() with a computed specifier');
    const targets = [];
    for (const spec of specs) {
      if (typeof spec !== 'string') continue;
      if (spec.startsWith('node:')) {
        if (!builtinModules.includes(spec.slice(5))) add('external-import', file, spec);
        continue;
      }
      if (!spec.startsWith('./') && !spec.startsWith('../')) { add('external-import', file, `${spec} (bare specifier: use node: built-ins or plugin files)`); continue; }
      const target = resolve(dirname(file), spec);
      if (relative(pluginRoot, target).startsWith('..')) { add('external-import', file, `${spec} leaves the plugin directory`); continue; }
      targets.push(target);
      if (unit === 'hooks' && !HOOK_IMPORTS.has(unitOf(pluginRoot, target))) add('hooks-import', file, `${spec} (unit ${unitOf(pluginRoot, target)})`);
    }
    graph.set(file, targets);

    // Spawning: child_process only in git and proc (any mention: import, import(), createRequire).
    if (unit !== 'git' && unit !== 'proc' && strings.some((s) => s === 'child_process' || s === 'node:child_process')) add('spawn-owner', file, 'child_process outside git and proc');
    // Literal programs go to their owner unit only (absolute paths and .exe too).
    for (const m of code.matchAll(new RegExp(`(?<![\\w$])${SPAWN_NAMES}\\s*\\(\\s*§(\\d+)§`, 'g'))) {
      const value = lit(m[1]);
      const owner = typeof value === 'string' ? SPAWN_OWNER[programOf(value)] : undefined;
      if (owner && owner !== unit) add('spawn-owner', file, `spawns ${value} outside lib/${owner}`);
    }
    // Calls of lib/proc bindings: the program must be a string literal (owner-checked) unless the unit is allowed.
    const procImports = [...code.matchAll(/\bimport\s+([^;()§]*?)\s*\bfrom\s*§(\d+)§/g)]
      .filter((m) => typeof lit(m[2]) === 'string' && lit(m[2]).startsWith('.') && unitOf(pluginRoot, resolve(dirname(file), lit(m[2]))) === 'proc' && unit !== 'proc');
    for (const [, clause] of procImports) {
      const callees = [];
      const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
      if (ns) callees.push(`${ns[1]}\\.[\\w$]+`);
      const named = /\{([^}]*)\}/.exec(clause);
      if (named) for (const part of named[1].split(',')) { const b = part.trim().split(/\s+as\s+/).pop(); if (b) callees.push(b.replace(/\$/g, '\\$')); }
      for (const callee of callees) {
        for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${callee}\\s*\\(\\s*(§(\\d+)§)?`, 'g'))) {
          const value = m[2] === undefined ? undefined : lit(m[2]);
          if (typeof value !== 'string') { if (!DYNAMIC_SPAWN_UNITS.has(unit)) add('spawn-owner', file, 'proc call with a computed program'); continue; }
          const owner = SPAWN_OWNER[programOf(value)];
          if (owner && owner !== unit) add('spawn-owner', file, `spawns ${value} outside lib/${owner}`);
        }
      }
    }

    // Atomic and O_EXCL file operations: lib/fsx only.
    if (unit !== 'fsx' && (/\bO_EXCL\b|(?<![\w$])(?:rename|renameSync|fsync|fsyncSync)\s*\(/.test(code) || strings.some((s) => /^[wa]x\+?$/.test(s)))) add('atomic-owner', file, 'atomic or O_EXCL file operation outside lib/fsx');
    const writesFiles = WRITE_CALL.test(code) || [...code.matchAll(/(?<![\w$])open(?:Sync)?\s*\([^;]*?,\s*§(\d+)§/g)].some((m) => /^(?:[wa]|r\+)/.test(lit(m[1]) ?? ''));
    // lib/method is read-only (§4.2): no write call and no import of another unit (only Node built-ins and its own files).
    if (unit === 'method') {
      if (writesFiles) add('method-read-only', file, 'write call in the read-only method unit');
      for (const target of targets) if (unitOf(pluginRoot, target) !== 'method') add('method-read-only', file, `imports lib/${unitOf(pluginRoot, target)} (the method unit reads only its own files)`);
    }
    // lib/text (review I8 r1): a pure leaf every unit may use for output; no I/O, no write, no import but its own files.
    if (unit === 'text') {
      if (writesFiles) add('text-leaf', file, 'write call in the pure text unit');
      for (const spec of specs) {
        if (typeof spec === 'string' && !(spec.startsWith('.') && unitOf(pluginRoot, resolve(dirname(file), spec)) === 'text')) add('text-leaf', file, `imports ${spec} (the text unit imports only its own files)`);
      }
    }
    // One output writer (S2): stdout, stderr and the console only in lib/cli/output.mjs (the launcher: stderr only).
    if (rel !== OUTPUT_WRITER) {
      const how = [];
      if (/\bconsole\s*\.\s*[\w$]+/.test(code)) how.push('console');
      if (/\bprocess\s*\.\s*stdout\b/.test(code) || (unit !== 'bin' && /\bprocess\s*\.\s*stderr\b/.test(code))) how.push('a process stream');
      if (/(?<![\w$])writeSync\s*\(\s*[12]\s*,/.test(code)) how.push('writeSync to fd 1 or 2');
      if (/\bio\s*\.\s*(?:out|err)\s*\(/.test(code)) how.push('io.out or io.err');
      if (how.length) add('output-owner', file, `writes output through ${how.join(', ')} outside ${OUTPUT_WRITER}`);
    }
    // One default risk-path list (INT-1): no source file spells a default risk glob; lib/router reads the list.
    if (strings.some((s) => RISK_GLOBS.includes(s))) add('risk-paths-owner', file, `a default risk glob outside ${RISK_LIST} (one list, GC6)`);
    // State directory: lib/state only.
    if (unit !== 'state' && /\bstateDir\b/.test(code)) add('state-owner', file, 'state directory referenced outside lib/state');
    // Leases: lib/sched only (any lease path literal).
    if (unit !== 'sched' && strings.some((s) => /(^|\/)leases(\/|$)/.test(s))) add('lease-owner', file, 'lease path outside lib/sched');
    // GC2: global config file names only in listed read-only files, which hold no write call.
    if (strings.some((s) => GLOBAL_CONFIG.test(s))) {
      if (!GLOBAL_CONFIG_READERS.has(rel)) add('global-config-write', file, 'names CLAUDE.md or settings*.json outside the read-only allowlist (GC2)');
      else if (writesFiles) add('global-config-write', file, 'allowlisted global-config reader contains a write call (GC2)');
    }
  }
  for (const file of walk(libDir).filter((f) => f.endsWith('.json'))) {
    let strings = [];
    try { strings = jsonStrings(JSON.parse(readFileSync(file, 'utf8'))); } catch { /* not JSON: nothing to compare */ }
    if (relative(pluginRoot, file).split(sep).join('/') !== RISK_LIST && strings.some((s) => RISK_GLOBS.includes(s))) add('risk-paths-owner', file, `a default risk glob outside ${RISK_LIST} (one list, GC6)`);
  }
  // Hooks never reach providers, gen, lanes or receipts, also through other units.
  for (const file of files.filter((f) => unitOf(pluginRoot, f) === 'hooks')) {
    const seen = new Set([file]);
    const queue = [[file, []]];
    while (queue.length) {
      const [cur, chain] = queue.shift();
      for (const next of graph.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const path = [...chain, relative(pluginRoot, next).split(sep).join('/')];
        if (HOOK_NEVER.has(unitOf(pluginRoot, next))) { if (chain.length) add('hooks-import', file, `reaches ${path.join(' → ')}`); continue; }
        queue.push([next, path]);
      }
    }
  }
  return { violations, files: files.map((f) => relative(pluginRoot, f).split(sep).join('/')) };
}

test('the plugin code respects the §4.3 boundaries', () => {
  const { violations, files } = scan(pluginDir);
  assert.deepEqual(violations, []);
  // Not vacuous: the CLI core and the boundary owners exist and were scanned.
  for (const unit of ['cli', 'hooks', 'proc', 'git', 'fsx', 'method', 'text']) assert.ok(files.some((f) => f.startsWith(`lib/${unit}/`) && f.endsWith('.mjs')), `lib/${unit}/*.mjs scanned`);
  assert.ok(files.includes(OUTPUT_WRITER), 'the output writer scanned');
  assert.ok(files.some((f) => f.startsWith('bin/')), 'launcher scanned');
});

test('one default risk-path list (INT-1, GC6): the router reads it from its data file; the profile uses the router\'s', async () => {
  assert.ok(RISK_GLOBS.length > 0, `${RISK_LIST} holds the default risk globs`);
  const router = await lib('router/index.mjs');
  assert.deepEqual(router.DEFAULT_RISK_PATHS, RISK_GLOBS);
  const profile = await lib('profile/index.mjs');
  assert.ok(!Object.keys(profile).some((k) => /RISK/.test(k)), 'the profile exports no list of its own');
  const empty = mkdtempSync(join(tmpdir(), 'risk-list-'));
  try { assert.deepEqual(profile.observeFiles(empty, []).riskPaths, RISK_GLOBS, 'an observation starts from the router defaults'); } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('lexer: string literals are data, comments vanish, regex and template literals keep code intact', () => {
  const { code, literals } = lex("const g = 'src/*';\nrun('gh', [x]); // c\nconst h = 'x/*'; /* c */ const r = /https?:\\/\\//; f(`a${g('b')}`);\n");
  assert.deepEqual(literals, ['src/*', 'gh', 'x/*', null, 'b', 'a']); // a template is registered after its expressions
  assert.match(code, /run\(§1§, \[x\]\);/);
  assert.doesNotMatch(code, /\/\*|\/\/ c/);
  assert.match(code, /f\(§5§ g\(§4§\) \);/);
});

// One planted violation per rule and code shape; the checker must report exactly that rule.
const PLANTED = [
  ['external-import', 'lib/cli/a.mjs', "import x from 'left-pad';\n"],
  ['external-import', 'lib/cli/a.mjs', "import x from '../../../outside.mjs';\n"],
  ['external-import', 'lib/cli/a.mjs', "const m = await import('node:no-such-builtin');\n"],
  ['external-import', 'lib/cli/a.mjs', 'const m = await import(name);\n'],
  ['hooks-import', 'lib/hooks/a.mjs', "import { exec } from '../providers/index.mjs';\n"],
  ['hooks-import', 'lib/hooks/a.mjs', "export { x } from '../cli/main.mjs';\n"],
  ['hooks-import', 'lib/hooks/a.mjs', "import {\n  x,\n} from '../cli/main.mjs';\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "import { spawnSync } from 'node:child_process';\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "const cp = createRequire(import.meta.url)('child_process');\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "run('git', ['status']);\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "run('/usr/bin/git', ['status']);\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "run(\n  'gh',\n  ['pr', 'list'],\n);\n"],
  ['spawn-owner', 'lib/proc/a.mjs', "spawnSync('git', ['status']);\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "proc.run('gh', ['pr', 'list']);\n"],
  ['spawn-owner', 'lib/lanes/a.mjs', "run('codex', ['exec']);\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "import { run } from '../proc/index.mjs';\nconst prog = 'gh';\nrun(prog, ['pr']);\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "import { run as sh } from '../proc/index.mjs';\nsh(name, []);\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "import { run as sh } from '../proc/index.mjs';\nsh('gemini', []);\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "import * as proc from '../proc/index.mjs';\nproc.run(cmd, []);\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "const g = 'src/*';\nrun('gh', ['pr']);\nconst h = 'x/*';\n/* c */\n"],
  ['spawn-owner', 'lib/cli/a.mjs', "const re = /https?:\\/\\//;\nrun('gh', []);\n"],
  ['atomic-owner', 'lib/state/a.mjs', "openSync(p, 'wx');\n"],
  ['atomic-owner', 'lib/cli/a.mjs', 'renameSync(a, b);\n'],
  ['state-owner', 'lib/cli/a.mjs', 'const d = names.stateDir;\n'],
  ['global-config-write', 'lib/gen/a.mjs', "writeFileSync(join(home, '.claude', 'CLAUDE.md'), text);\n"],
  ['global-config-write', 'lib/gen/a.mjs', "fsx.writeAtomic(join(repo, '.claude', 'settings.local.json'), text);\n"],
  ['global-config-write', 'lib/gen/a.mjs', "const target = join(home, '.claude', 'CLAUDE.md');\nwriteFileSync(target, text);\n"],
  ['global-config-write', 'lib/gen/a.mjs', "writeFileSync(\n  join(repo, '.claude', 'settings.json'),\n  text,\n);\n"],
  ['global-config-write', 'lib/gen/a.mjs', "rmSync(join(repo, '.claude', 'settings.json'));\n"],
  ['global-config-write', 'lib/cli/doctor.mjs', "const s = readFileSync(join(h, '.claude', 'settings.json'), 'utf8');\nconst p = x;\nunlinkSync(p);\n"],
  ['global-config-write', 'lib/cli/doctor.mjs', "const s = readFileSync(join(h, 'settings.json'), 'utf8');\nconst fd = openSync(p, 'a');\n"],
  ['lease-owner', 'lib/providers/a.mjs', "writeFileSync(join(data, 'leases', id), '');\n"],
  ['lease-owner', 'lib/providers/a.mjs', "const dir = join(data, 'leases');\nconst fd = openSync(join(dir, id), 'w');\n"],
  ['unknown-unit', 'lib/utils/a.mjs', 'export const x = 1;\n'],
  ['method-read-only', 'lib/method/a.mjs', "writeFileSync(join(dir, 'index.json'), text);\n"],
  ['method-read-only', 'lib/method/a.mjs', "const fd = openSync(indexFile, 'w');\n"],
  ['method-read-only', 'lib/method/a.mjs', "import { writeAtomic } from '../fsx/index.mjs';\n"],
  ['method-read-only', 'lib/method/a.mjs', "export { topLevel } from '../git/index.mjs';\n"],
  ['text-leaf', 'lib/text/a.mjs', "import { readFileSync } from 'node:fs';\n"],
  ['text-leaf', 'lib/text/a.mjs', "import { x } from '../state/index.mjs';\n"],
  ['text-leaf', 'lib/text/a.mjs', "const m = await import('../decisions/index.mjs');\n"],
  ['text-leaf', 'lib/text/a.mjs', "writeFileSync(p, text);\n"],
  ['risk-paths-owner', 'lib/profile/a.mjs', "export const DEFAULTS = Object.freeze(['**/auth/**', '**/*.sql']);\n"],
  ['risk-paths-owner', 'lib/router/a.mjs', "const extra = ['.github/workflows/**'];\n"],
  ['risk-paths-owner', 'lib/profile/defaults.json', '{"riskPaths":["**/migrations/**"]}\n'],
  ['output-owner', 'lib/cli/a.mjs', 'process.stdout.write(text);\n'],
  ['output-owner', 'lib/state/a.mjs', 'process.stderr.write(message);\n'],
  ['output-owner', 'lib/router/a.mjs', 'const out = process.stdout;\nout.write(x);\n'],
  ['output-owner', 'lib/decisions/a.mjs', 'console.log(title);\n'],
  ['output-owner', 'lib/hooks/a.mjs', 'console.error(e);\n'],
  ['output-owner', 'lib/profile/a.mjs', "export const warn = (io, w) => io.err(`warning: ${w}\\n`);\n"],
  ['output-owner', 'lib/cli/a.mjs', 'writeSync(1, text);\n'],
  ['output-owner', `bin/${names.bin}`, "process.stdout.write('x');\n"],
];

function plant(files) {
  const fixture = mkdtempSync(join(tmpdir(), 'arch-'));
  mkdirSync(join(fixture, 'lib'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(fixture, rel)), { recursive: true });
    writeFileSync(join(fixture, rel), content);
  }
  try { return scan(fixture).violations; } finally { rmSync(fixture, { recursive: true, force: true }); }
}

test('the boundary checker finds each planted violation (REV-45)', () => {
  for (const [rule, rel, content] of PLANTED) {
    const violations = plant({ [rel]: content });
    assert.equal(violations.length, 1, `${rule} in ${rel}: ${JSON.stringify(violations)}\n${content}`);
    assert.ok(violations[0].startsWith(`${rule}: `), `${rule} expected, got ${violations[0]}`);
  }
  // Transitive: hooks → state (allowed) → providers.
  const chain = plant({ 'lib/hooks/a.mjs': "import { x } from '../state/s.mjs';\n", 'lib/state/s.mjs': "import { y } from '../providers/p.mjs';\n", 'lib/providers/p.mjs': 'export const y = 1;\n' });
  assert.deepEqual(chain, ['hooks-import: lib/hooks/a.mjs: reaches lib/state/s.mjs → lib/providers/p.mjs']);
});

test('the boundary checker accepts the allowed shapes (comments, owners, literals, read-only readers)', () => {
  assert.deepEqual(plant({
    'lib/hooks/a.mjs': "// run('git', []) writeFileSync('CLAUDE.md')\nimport { x } from '../state/index.mjs';\nimport { readFileSync } from 'node:fs';\n",
    'lib/git/index.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['status']);\n",
    'lib/cli/a.mjs': "import { run } from '../proc/index.mjs';\nconst v = run('claude', ['--version'], { unit: 'cli' });\nconst g = 'src/*';\nconst t = `x ${row.run(a)}`;\n",
    'lib/cli/doctor.mjs': "const s = readFileSync(join(h, '.claude', 'settings.json'), 'utf8');\nconst fd = openSync(p, 'r');\n",
    'lib/providers/a.mjs': "import { run } from '../proc/index.mjs';\nrun(argv[0], argv.slice(1), { unit: 'providers' });\n",
    'lib/mirror/a.mjs': "import { run } from '../proc/index.mjs';\nrun('gh', ['pr', 'list'], { unit: 'mirror' });\n",
    'lib/sched/a.mjs': "writeFileSync(join(data, 'leases', id), '');\n",
    'lib/method/a.mjs': "import { readFileSync } from 'node:fs';\nimport { x } from './b.mjs';\nconst t = readFileSync(join(dir, 'index.json'), 'utf8');\n",
    'lib/text/a.mjs': "import { x } from './b.mjs';\nexport const clean = (s) => x(s).replace(/a/g, '');\n",
    'lib/router/thresholds.json': '{"riskPaths":["**/auth/**","**/*.sql"]}\n',
    'lib/cli/output.mjs': "export const io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };\nexport const print = (io, t) => io.out(t);\n",
    [`bin/${names.bin}`]: "process.stderr.write(`internal error: ${m}\\n`);\nconst tty = process.stdin.isTTY;\n",
    'lib/profile/a.mjs': "// defaults such as '**/auth/**' come from the router\nimport { DEFAULT_RISK_PATHS } from '../router/index.mjs';\nconst own = ['lib/**'];\n",
  }), []);
});

test('package.json files carry no dependencies (GC10); the plugin package.json only sets CommonJS for bin/', () => {
  const pkg = readJson(join(root, 'package.json'));
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) assert.equal(pkg[k], undefined, `package.json ${k}`);
  assert.deepEqual(readJson(join(pluginDir, 'package.json')), { type: 'commonjs' });
});

test('`npm test` runs the e2e suites too', () => {
  const script = readJson(join(root, 'package.json')).scripts.test;
  assert.match(script, /(^|\s)tests\/\*\.test\.mjs(\s|$)/);
  assert.match(script, /(^|\s)tests\/e2e\/\*\.test\.mjs(\s|$)/);
});

// Boundary owners (§4.2): proc spawns other programs, git spawns git, fsx does atomic and O_EXCL writes.
test('proc.run: captures output, reports missing programs and timeouts, refuses git and checks program owners', async () => {
  const { run } = await lib('proc/index.mjs');
  const as = { unit: 'cli' };
  const ok = run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], as);
  assert.deepEqual([ok.status, ok.stdout, ok.stderr, ok.error], [3, 'out', 'err', null]);
  const input = run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { ...as, input: 'piped' });
  assert.equal(input.stdout, 'piped');
  assert.equal(run('no-such-program-zz9', [], as).error, 'missing');
  assert.equal(run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { ...as, timeoutMs: 200 }).error, 'timeout');
  for (const cmd of ['git', '/usr/bin/git', 'git.exe']) assert.throws(() => run(cmd, ['--version'], { unit: 'git' }), /lib\/git/);
  assert.throws(() => run(process.execPath, ['-e', '0']), /unit/, 'the calling unit is explicit');
  // Owned programs run only for their owner unit (nonexistent paths: the owner check comes before spawning).
  const missingDir = join(tmpdir(), 'no-such-dir-zz9');
  for (const [program, owner] of [['gh', 'mirror'], ['codex', 'providers'], ['gemini', 'providers']]) {
    assert.throws(() => run(join(missingDir, program), [], as), new RegExp(`lib/${owner}`), `${program} from cli`);
    assert.equal(run(join(missingDir, program), [], { unit: owner }).error, 'missing', `${program} from ${owner}`);
  }
});

test('git: runs git with a working directory; topLevel finds the repository root or null', async (t) => {
  const { git, topLevel } = await lib('git/index.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'git-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outside = join(dir, 'outside');
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  mkdirSync(outside);
  const init = git(['init', '-q'], { cwd: repo });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(topLevel(join(repo, 'sub')), realpathSync(repo));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dir };
  assert.equal(topLevel(outside, { env }), null);
  assert.equal(git(['--version']).status, 0);
});

test('fsx: writeAtomic replaces content without leftovers; createExclusive never overwrites', async (t) => {
  const { writeAtomic, createExclusive } = await lib('fsx/index.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fsx-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  writeAtomic(file, 'one');
  writeAtomic(file, 'two');
  assert.equal(readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(readdirSync(dir), ['state.json'], 'no temporary files left');
  const lock = join(dir, 'lock');
  assert.equal(createExclusive(lock, 'a'), true);
  assert.equal(createExclusive(lock, 'b'), false);
  assert.equal(readFileSync(lock, 'utf8'), 'a');
  assert.throws(() => createExclusive(join(dir, 'missing-dir', 'x'), 'c'), /ENOENT/);
});
