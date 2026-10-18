// CLI contract (spec §8.1, §8.2, REV-54, REV-58, GC8): lib/cli/commands.mjs is the single source of commands,
// flags and exit codes. With --json every command prints exactly one envelope line; help and docs/cli.md are
// generated from the table; hooks registered in lib/hooks/registry.mjs (generated hooks/hooks.json) accept
// malformed input and allow. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';
import { WALL_CEILING_MS, assertFast, cpuProbe, measured } from './helpers/cpu-time.mjs';

// No child of this file sees the real HOME or the calling session (tests/helpers/isolated-env.mjs).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const out = (r) => `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

function locate(dir = root) {
  const plugins = join(dir, 'plugins');
  const hits = existsSync(plugins) ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json'))) : [];
  assert.equal(hits.length, 1, `expected exactly one plugins/*/lib/name.json in ${dir}, found ${hits.length}`);
  const pluginDir = join(plugins, hits[0]);
  return { pluginDir, pluginRel: `plugins/${hits[0]}`, names: readJson(join(pluginDir, 'lib', 'name.json')) };
}
const { pluginDir, pluginRel, names } = locate();
const VERSION = readJson(join(pluginDir, '.claude-plugin', 'plugin.json')).version;
const LAUNCHER = join(pluginDir, 'bin', names.bin);
const PLUGIN_ID = `${names.plugin}@${names.marketplace}`;
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);

// The spec §8.1 table, verbatim.
const SPEC_EXIT_CODES = [[0, 'OK'], [1, 'FAIL'], [2, 'USAGE'], [3, 'WAIT'], [4, 'DONE'], [5, 'STALLED'], [6, 'BUDGET'], [7, 'REFUSED'], [8, 'ENV'], [70, 'INTERNAL']];
const NAME_OF = new Map(SPEC_EXIT_CODES);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A scratch directory whose PATH holds only a `node` symlink (for the fake claude shebang) ahead of the system
// directories. The directory of the running node is not on it: setup-node, nvm and Volta put a global `claude`
// right next to `node`, and a real claude must never answer a fake-only test. The rest of the env (a throwaway
// HOME, no variable of the calling session) comes from the isolated-env helper.
const SYSTEM_DIRS = ['/usr/bin', '/bin'];
function strayClaude(pathValue, allowedDir) {
  return pathValue.split(delimiter).filter((d) => d && d !== allowedDir).map((d) => join(d, 'claude')).filter((p) => {
    try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
  });
}
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  const path = [bin, ...SYSTEM_DIRS].join(delimiter);
  assert.deepEqual(strayClaude(path, bin), [], 'a claude outside the fake bin is reachable on the scratch PATH');
  const iso = isolatedEnv();
  t.after(iso.cleanup);
  const env = { ...iso.env, PATH: path };
  return { dir, bin, env };
}

test('scratch PATH: only the fake claude is reachable, even when a claude sits next to node', (t) => {
  const { dir, bin, env } = scratch(t);
  assert.ok(!env.PATH.split(delimiter).includes(dirname(process.execPath)) || SYSTEM_DIRS.includes(dirname(process.execPath)), 'the node directory is not on PATH');
  // The guard fires on a stray claude next to node (the setup-node layout).
  const nodeDir = join(dir, 'node-dir');
  mkdirSync(nodeDir);
  symlinkSync(process.execPath, join(nodeDir, 'node'));
  writeFileSync(join(nodeDir, 'claude'), '#!/bin/sh\necho 2.1.300\n');
  chmodSync(join(nodeDir, 'claude'), 0o755);
  assert.deepEqual(strayClaude([bin, nodeDir, ...SYSTEM_DIRS].join(delimiter), bin), [join(nodeDir, 'claude')]);
  // With only the fake removed, doctor finds no claude at all.
  fakeClaude(bin, { list: healthyList(), details: null });
  rmSync(join(bin, 'claude'));
  const r = cli(['doctor', '--json'], { env });
  assert.equal(r.status, 8, out(r));
});

// Fake `claude`: canned answers to the three calls doctor makes; anything else exits 64.
function fakeClaude(binDir, { version = '2.1.300 (Claude Code)', list, details }) {
  const answers = JSON.stringify({ version, list, details, id: PLUGIN_ID });
  writeFileSync(join(binDir, 'claude'), `#!/usr/bin/env node
const a = process.argv.slice(2);
const o = ${answers};
if (a.length === 1 && a[0] === '--version') process.stdout.write(o.version + '\\n');
else if (a.join(' ') === 'plugin list --json') process.stdout.write(o.list);
else if (a[0] === 'plugin' && a[1] === 'details' && a.length === 3 && o.details !== null && a[2] === o.id) process.stdout.write(o.details);
else if (a[0] === 'plugin' && a[1] === 'details') { process.stderr.write('Plugin "' + a[2] + '" not found.\\n'); process.exit(1); }
else { process.stderr.write('fake claude: unexpected ' + a.join(' ') + '\\n'); process.exit(64); }
`);
  chmodSync(join(binDir, 'claude'), 0o755);
}
const listJson = (entries) => JSON.stringify(entries, null, 2);
const healthyList = () => listJson([{ id: PLUGIN_ID, version: VERSION, scope: 'user', enabled: true }]);
// Shape of `claude plugin details` in Claude Code 2.1.300 (captured from a real run, see context-cost test).
const detailsText = (events, alwaysOn = '~0 tok') => [
  `${names.plugin} ${VERSION}`,
  '  Description: test',
  `  Source: ${PLUGIN_ID}`,
  '',
  'Component inventory',
  '  Skills (0)',
  '  Agents (0)',
  events.length ? `  Hooks (${events.length})  ${events.join(', ')}  (harness-only — no model context cost)` : '  Hooks (0)',
  '  MCP servers (0)',
  '  LSP servers (0)',
  '',
  'Projected token cost',
  `  Always-on:   ${alwaysOn}   added to every session`,
  '',
].join('\n');
async function registryEvents() {
  const { HOOKS } = await lib('hooks/registry.mjs');
  return [...new Set(HOOKS.map((h) => h.event))];
}

const cli = (args, opts = {}) => spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', timeout: 30000, ...opts });

// One line, valid envelope, exit name matching the process status.
function envelopeOf(r) {
  assert.ok(r.stdout.endsWith('\n'), `envelope ends with a newline\n${out(r)}`);
  const lines = r.stdout.slice(0, -1).split('\n');
  assert.equal(lines.length, 1, `exactly one stdout line\n${out(r)}`);
  const env = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(env), ['cli', 'command', 'ok', 'code', 'exit', 'data', 'errors']);
  assert.equal(env.cli, 1);
  assert.equal(typeof env.command, 'string');
  assert.equal(env.code, r.status, 'envelope code equals the exit status');
  assert.equal(env.exit, NAME_OF.get(env.code), 'exit name matches the code');
  assert.equal(env.ok, env.code === 0);
  assert.ok(env.data && typeof env.data === 'object' && !Array.isArray(env.data), 'data is an object');
  assert.ok(Array.isArray(env.errors));
  for (const e of env.errors) {
    assert.deepEqual(Object.keys(e), ['code', 'message', 'hint']);
    assert.match(e.code, KEBAB);
    assert.ok(e.message.length > 0 && e.message.length <= 300, `message ≤ 300: ${e.message}`);
    assert.ok(typeof e.hint === 'string' && e.hint.length <= 200, `hint ≤ 200: ${e.hint}`);
  }
  if (env.code !== 0) assert.ok(env.errors.length > 0, 'a non-zero exit carries at least one error');
  assert.equal(r.stderr, '', '--json keeps stderr empty');
  return env;
}

test('exit codes are the spec §8.1 table, defined once in the command table module', async () => {
  const { EXIT_CODES, EXIT } = await lib('cli/commands.mjs');
  assert.deepEqual(EXIT_CODES.map((e) => [e.code, e.name]), SPEC_EXIT_CODES);
  for (const e of EXIT_CODES) assert.ok(typeof e.meaning === 'string' && e.meaning.length > 0, `${e.name}: meaning`);
  assert.deepEqual(EXIT, Object.fromEntries(SPEC_EXIT_CODES.map(([c, n]) => [n, c])));
});

test('command table rows are well formed; doctor is public, hook is internal and fails open', async () => {
  const { COMMANDS, EXIT } = await lib('cli/commands.mjs');
  const seen = new Set();
  for (const row of COMMANDS) {
    assert.match(row.name, /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/, 'command name');
    assert.ok(!seen.has(row.name), `${row.name}: unique`); seen.add(row.name);
    assert.ok(typeof row.summary === 'string' && row.summary.length > 0 && row.summary.length <= 120, `${row.name}: summary ≤ 120`);
    assert.ok(Array.isArray(row.args) && Array.isArray(row.flags), `${row.name}: args and flags arrays`);
    assert.ok(row.exits.length > 0 && row.exits.every((n) => n in EXIT), `${row.name}: exits name codes from the table`);
    assert.equal(typeof row.load, 'function', `${row.name}: implementation loaded on demand`);
  }
  const doctor = COMMANDS.find((r) => r.name === 'doctor');
  assert.ok(doctor && !doctor.hidden && !doctor.mutating, 'doctor: public, read-only');
  assert.deepEqual(doctor.exits, ['OK', 'FAIL', 'ENV']);
  const hook = COMMANDS.find((r) => r.name === 'hook');
  assert.ok(hook && hook.hidden && hook.failOpen, 'hook: hidden from help, fails open (GC8)');
});

test('a new command is one table row: variadic IDs parse, help lists it, --json wraps its data', async () => {
  const { COMMANDS } = await lib('cli/commands.mjs');
  const { main } = await lib('cli/main.mjs');
  const row = { name: 'echo-ids', summary: 'Echo rule IDs.', args: [{ name: 'ID', variadic: true, required: true }], flags: [], exits: ['OK', 'USAGE'],
    load: async () => ({ args }) => ({ data: { ids: args.ID }, text: `${args.ID.join(' ')}\n` }) };
  const commands = [...COMMANDS, row];
  const io = memoryIo();
  assert.equal(await main(['echo-ids', 'REV-54', 'GC8', '--json'], { commands, io }), 0);
  const env = JSON.parse(io.stdout);
  assert.deepEqual([env.command, env.data], ['echo-ids', { ids: ['REV-54', 'GC8'] }]);
  const help = memoryIo();
  assert.equal(await main(['--help'], { commands, io: help }), 0);
  assert.match(help.stdout, /echo-ids\s+Echo rule IDs\./);
  const missing = memoryIo();
  assert.equal(await main(['echo-ids', '--json'], { commands, io: missing }), 2, 'required variadic argument missing → USAGE');
  assert.equal(JSON.parse(missing.stdout).errors[0].code, 'missing-argument');
});

function memoryIo({ stdinIsTTY = false, env = process.env, cwd = process.cwd() } = {}) {
  const io = { stdout: '', stderr: '', stdinIsTTY, env, cwd, stdin: null };
  io.out = (s) => { io.stdout += s; };
  io.err = (s) => { io.stderr += s; };
  return io;
}

test('--json: version, help, doctor and every usage error print exactly one envelope line', (t) => {
  const { bin, env } = scratch(t);
  fakeClaude(bin, { list: healthyList(), details: null });
  const cases = [
    [['--version', '--json'], 0, 'version'],
    [['--json', '--help'], 0, 'help'],
    [['--json'], 0, 'status'], // no command: the default command (spec §8.2)
    [['doctor', '--json'], 1, 'doctor'], // hooks not registered in the fake
    [['--json', 'doctor'], 1, 'doctor'],
    [['no-such-command', '--json'], 2, 'no-such-command'],
    [['doctor', '--frobnicate', '--json'], 2, 'doctor'],
    [['doctor', 'extra-arg', '--json'], 2, 'doctor'],
    [['--frobnicate', '--json'], 2, 'help'],
  ];
  for (const [args, code, command] of cases) {
    const r = cli(args, { env });
    assert.equal(r.status, code, `${args.join(' ')}\n${out(r)}`);
    const e = envelopeOf(r);
    assert.equal(e.command, command, args.join(' '));
  }
  assert.deepEqual(envelopeOf(cli(['--version', '--json'], { env })).data, { name: names.bin, version: VERSION });
  assert.equal(envelopeOf(cli(['no-such-command', '--json'], { env })).errors[0].code, 'unknown-command');
  assert.equal(envelopeOf(cli(['doctor', '--frobnicate', '--json'], { env })).errors[0].code, 'unknown-flag');
  assert.equal(envelopeOf(cli(['doctor', 'extra-arg', '--json'], { env })).errors[0].code, 'unexpected-argument');
});

test('human mode: help lists public commands only, version line, usage errors on stderr with exit 2', (t) => {
  const { env } = scratch(t);
  const help = cli(['--help'], { env });
  assert.equal(help.status, 0, out(help));
  assert.match(help.stdout, new RegExp(`^usage: ${names.bin} <command> \\[options\\]\\n`));
  assert.match(help.stdout, /^ {2}doctor {2,}\S/m, 'doctor listed');
  assert.doesNotMatch(help.stdout, /^ {2}hook\b/m, 'internal hook command hidden from help');
  for (const [code, name] of SPEC_EXIT_CODES) assert.ok(help.stdout.includes(`${code} ${name}`), `help shows exit ${code} ${name}`);
  const none = cli([], { env });
  assert.equal(none.status, 0, out(none));
  assert.match(none.stdout, /^State: /m, 'no command prints the status (spec §8.2), not the help');
  assert.notEqual(none.stdout, help.stdout);
  assert.equal(cli(['-h'], { env }).stdout, help.stdout);

  for (const flag of ['--version', '-V']) {
    const v = cli([flag], { env });
    assert.equal(v.status, 0, out(v));
    assert.equal(v.stdout, `${names.bin} ${VERSION}\n`);
  }
  const doctorHelp = cli(['doctor', '--help'], { env });
  assert.equal(doctorHelp.status, 0, out(doctorHelp));
  assert.match(doctorHelp.stdout, new RegExp(`^usage: ${names.bin} doctor \\[--json\\]\\n`));
  assert.match(doctorHelp.stdout, /Exit codes: 0 OK · 1 FAIL · 8 ENV/);

  for (const args of [['no-such-command'], ['--frobnicate'], ['doctor', '--frobnicate']]) {
    const r = cli(args, { env });
    assert.equal(r.status, 2, `${args.join(' ')}\n${out(r)}`);
    assert.equal(r.stdout, '', 'usage errors print nothing on stdout');
    assert.match(r.stderr, new RegExp(`^${names.bin}: `));
    assert.match(r.stderr, /usage/i);
  }
});

test('doctor: healthy when Claude Code ≥ floor, the plugin is enabled and every registry hook event is registered', async (t) => {
  const { dir, bin, env } = scratch(t);
  const events = await registryEvents();
  fakeClaude(bin, { list: healthyList(), details: detailsText(events) });
  const r = cli(['doctor', '--json'], { env, cwd: dir });
  assert.equal(r.status, 0, out(r));
  const e = envelopeOf(r);
  assert.equal(e.command, 'doctor');
  assert.deepEqual(e.data.checks.map((c) => [c.id, c.ok]), [['claude-code', true], ['plugin', true], ['hooks', true]]);
  assert.deepEqual(e.data.claudeCode, { version: '2.1.300', floor: '2.1.300' });
  assert.deepEqual(e.data.plugin, { id: PLUGIN_ID, enabled: true, version: VERSION });
  assert.deepEqual(e.data.hooks.missing, []);
  assert.deepEqual([...e.data.hooks.expected].sort(), [...events].sort());
  assert.equal(e.data.alwaysOnTokens, 0);
  assert.deepEqual(readdirSync(dir).sort(), ['bin'], 'doctor wrote nothing into the working directory (read-only)');

  const human = cli(['doctor'], { env, cwd: dir });
  assert.equal(human.status, 0, out(human));
  assert.match(human.stdout, /^ {2}ok {4}claude-code {2}2\.1\.300/m);
  assert.match(human.stdout, /^ {2}ok {4}plugin/m);
  assert.match(human.stdout, /^ {2}ok {4}hooks/m);
  assert.equal(human.stderr, '');

  // Versions compare numerically: 2.1.1000 is above the 2.1.300 floor.
  fakeClaude(bin, { version: '2.1.1000 (Claude Code)', list: healthyList(), details: detailsText(events) });
  assert.equal(cli(['doctor', '--json'], { env }).status, 0);
});

test('doctor: each failed check exits 1 with its error code; claude missing exits 8', async (t) => {
  const { bin, env } = scratch(t);
  const events = await registryEvents();
  const failing = [
    ['claude-code-too-old', { version: '2.1.299 (Claude Code)', list: healthyList(), details: detailsText(events) }],
    ['claude-code-too-old', { version: '1.9.999 (Claude Code)', list: healthyList(), details: detailsText(events) }],
    ['claude-code-version-unknown', { version: 'garbage', list: healthyList(), details: detailsText(events) }],
    ['plugin-not-loaded', { list: listJson([]), details: null }],
    ['plugin-not-loaded', { list: listJson([{ id: PLUGIN_ID, version: VERSION, scope: 'user', enabled: false }]), details: detailsText(events) }],
    ['plugin-not-loaded', { list: 'not json', details: detailsText(events) }],
    ['hooks-not-registered', { list: healthyList(), details: detailsText(events.slice(1)) }],
    ['hooks-not-registered', { list: healthyList(), details: detailsText([]) }],
    ['hooks-not-registered', { list: healthyList(), details: 'unrecognised output\n' }],
  ];
  for (const [code, answers] of failing) {
    fakeClaude(bin, answers);
    const r = cli(['doctor', '--json'], { env });
    assert.equal(r.status, 1, `${code}\n${out(r)}`);
    const e = envelopeOf(r);
    assert.ok(e.errors.some((x) => x.code === code), `${code} expected in ${JSON.stringify(e.errors)}`);
    const human = cli(['doctor'], { env });
    assert.equal(human.status, 1);
    assert.match(human.stdout, /^ {2}FAIL /m);
    assert.match(human.stderr, /hint: /);
  }
  rmSync(join(bin, 'claude'));
  const missing = cli(['doctor', '--json'], { env });
  assert.equal(missing.status, 8, out(missing));
  assert.equal(envelopeOf(missing).errors[0].code, 'claude-missing');
});

test('doctor output parsers: version, numeric comparison and `claude plugin details`', async () => {
  const { parseVersion, compareVersions, parseDetails, CLAUDE_CODE_FLOOR } = await lib('cli/doctor.mjs');
  assert.deepEqual(parseVersion('2.1.300 (Claude Code)\n'), [2, 1, 300]);
  assert.equal(parseVersion('Claude Code'), null);
  assert.ok(compareVersions([2, 1, 1000], [2, 1, 300]) > 0);
  assert.ok(compareVersions([2, 0, 999], [2, 1, 0]) < 0);
  assert.equal(compareVersions([2, 1, 300], parseVersion(CLAUDE_CODE_FLOOR)), 0);
  assert.deepEqual(parseDetails(detailsText(['SessionStart', 'PreToolUse'])), { hookEvents: ['SessionStart', 'PreToolUse'], alwaysOnTokens: 0 });
  assert.deepEqual(parseDetails(detailsText([], '~840 tok')), { hookEvents: [], alwaysOnTokens: 840 });
  assert.equal(parseDetails(detailsText([], '~1,234 tok')).alwaysOnTokens, 1234);
  assert.equal(parseDetails(detailsText([], '~1.2k tok')).alwaysOnTokens, 1200);
  assert.equal(parseDetails('x 1.0.0\n'), null, 'unrecognised output is null, never zero');
});

test('the Claude Code floor (SD-5) is the version CI installs', async () => {
  const { CLAUDE_CODE_FLOOR } = await lib('cli/doctor.mjs');
  const ci = readFileSync(join(root, '.github', 'workflows', 'tests.yml'), 'utf8');
  const pins = [...ci.matchAll(/@anthropic-ai\/claude-code@([\w.-]+)/g)].map((m) => m[1]);
  assert.ok(pins.length > 0, 'CI installs a pinned Claude Code');
  assert.deepEqual([...new Set(pins)], [CLAUDE_CODE_FLOOR]);
});

test('consent (REV-58): a mutating command without a terminal and without --yes is refused (7)', async () => {
  const { COMMANDS } = await lib('cli/commands.mjs');
  const { main } = await lib('cli/main.mjs');
  let runs = 0;
  const row = { name: 'write-thing', summary: 'Changes files.', args: [], flags: [], mutating: true, exits: ['OK', 'REFUSED'],
    load: async () => () => { runs++; return { data: { wrote: true }, text: 'wrote\n' }; } };
  const commands = [...COMMANDS, row];

  const refused = memoryIo({ stdinIsTTY: false });
  assert.equal(await main(['write-thing', '--json'], { commands, io: refused }), 7);
  const e = JSON.parse(refused.stdout);
  assert.deepEqual([e.exit, e.errors[0].code], ['REFUSED', 'consent-required']);
  assert.match(e.errors[0].hint, /--yes/);
  assert.equal(runs, 0, 'refused before running');
  const refusedHuman = memoryIo({ stdinIsTTY: false });
  assert.equal(await main(['write-thing'], { commands, io: refusedHuman }), 7);
  assert.match(refusedHuman.stderr, /--yes/);

  for (const [args, tty] of [[['write-thing', '--yes'], false], [['write-thing', '-y', '--json'], false], [['write-thing'], true]]) {
    const io = memoryIo({ stdinIsTTY: tty });
    assert.equal(await main(args, { commands, io }), 0, `${args.join(' ')} tty=${tty}`);
  }
  assert.equal(runs, 3);
  const readOnly = memoryIo({ stdinIsTTY: false });
  assert.equal(await main(['--version'], { commands, io: readOnly }), 0, 'read-only commands need no consent');
});

test('consent per form (I4.1): `mutating` may be a function of the parsed flags; help and docs come from the same function', async () => {
  const { COMMANDS } = await lib('cli/commands.mjs');
  const { main } = await lib('cli/main.mjs');
  const { renderCommandHelp, synopsis } = await lib('cli/help.mjs');
  const seen = [];
  const row = { name: 'plan-thing', summary: 'Plans or applies.', args: [], exits: ['OK', 'REFUSED'],
    flags: [{ flag: '--dry-run', summary: 'show only' }, { flag: '--target', value: 'name', summary: 'where' }],
    mutating: (flags) => { seen.push({ ...flags }); return !flags.dryRun; },
    load: async () => ({ flags }) => ({ data: { applied: !flags.dryRun }, text: 'done\n' }) };
  const commands = [...COMMANDS, row];
  const refused = memoryIo();
  assert.equal(await main(['plan-thing', '--target', 'x', '--json'], { commands, io: refused }), 7, 'the applying form needs consent');
  assert.equal(JSON.parse(refused.stdout).errors[0].code, 'consent-required');
  assert.deepEqual(seen.at(-1), { target: 'x' }, 'the function gets the parsed flags');
  const dry = memoryIo();
  assert.equal(await main(['plan-thing', '--dry-run', '--target', 'x', '--json'], { commands, io: dry }), 0, 'the read-only form needs no consent');
  assert.deepEqual(JSON.parse(dry.stdout).data, { applied: false });
  assert.equal(await main(['plan-thing', '--yes', '--json'], { commands, io: memoryIo() }), 0, '--yes consents to the applying form');

  const ctx = { names, exitCodes: (await lib('cli/commands.mjs')).EXIT_CODES };
  const help = renderCommandHelp(row, ctx);
  assert.match(help, /^Changes files: needs a terminal or --yes, otherwise exit 7 REFUSED\. Read-only with --dry-run: no consent needed\.$/m);
  assert.match(synopsis(row, names.bin), /\[--yes\]/);
  const flipped = { ...row, mutating: (flags) => Boolean(flags.target) };
  assert.match(renderCommandHelp(flipped, ctx), /^Read-only\. Changes files with --target: needs a terminal or --yes, otherwise exit 7 REFUSED\.$/m, 'help follows the function');
  const never = { ...row, mutating: () => false };
  assert.match(renderCommandHelp(never, ctx), /^Read-only\.$/m);
  assert.doesNotMatch(synopsis(never, names.bin), /--yes/, 'no form changes files: no --yes in the synopsis');
});

test('an exception inside a command is INTERNAL (70) and asks for doctor output; messages are clipped', async () => {
  const { COMMANDS } = await lib('cli/commands.mjs');
  const { main } = await lib('cli/main.mjs');
  const boom = { name: 'boom', summary: 'Throws.', args: [], flags: [], exits: ['OK'], load: async () => () => { throw new Error('kaput'); } };
  const long = { name: 'long-error', summary: 'Long error.', args: [], flags: [], exits: ['FAIL'],
    load: async () => () => ({ code: 1, data: {}, errors: [{ code: 'too-long', message: 'm'.repeat(1000), hint: 'h'.repeat(1000) }] }) };
  const commands = [...COMMANDS, boom, long];
  const io = memoryIo();
  assert.equal(await main(['boom', '--json'], { commands, io }), 70);
  const e = JSON.parse(io.stdout);
  assert.deepEqual([e.exit, e.errors[0].code], ['INTERNAL', 'internal']);
  assert.match(e.errors[0].message, /kaput/);
  assert.ok(e.errors[0].hint.includes(`${names.bin} doctor --json`), e.errors[0].hint);
  const human = memoryIo();
  assert.equal(await main(['boom'], { commands, io: human }), 70);
  assert.match(human.stderr, /kaput/);
  const clipped = memoryIo();
  assert.equal(await main(['long-error', '--json'], { commands, io: clipped }), 1);
  const c = JSON.parse(clipped.stdout).errors[0];
  assert.ok(c.message.length === 300 && c.hint.length === 200, `${c.message.length}/${c.hint.length}`);
});

// Hooks (GC8, spec §7.13, SD-44): hooks.json is generated from the registry and every hook is a no-op that
// accepts any input, prints nothing and exits 0 well under 1 s.
test('hooks.json holds exactly the registry hooks, in exec form through the launcher', async () => {
  const { HOOKS } = await lib('hooks/registry.mjs');
  assert.ok(HOOKS.length >= 9, 'the MUST hooks of spec §7.13 are registered');
  const hooksJson = readJson(join(pluginDir, 'hooks', 'hooks.json'));
  const entries = Object.entries(hooksJson.hooks).flatMap(([event, list]) => list.map((e) => ({ event, ...e })));
  assert.equal(entries.length, HOOKS.length);
  for (const h of HOOKS) {
    assert.match(h.name, KEBAB);
    assert.ok(Number.isInteger(h.timeout) && h.timeout >= 1 && h.timeout <= 10, `${h.name}: timeout in seconds`);
    const e = entries.find((x) => x.hooks[0].args[2] === h.name);
    assert.ok(e, `${h.name} in hooks.json`);
    assert.equal(e.event, h.event);
    assert.equal(e.matcher, h.matcher);
    assert.deepEqual(e.hooks, [{ type: 'command', command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/bin/${names.bin}`, 'hook', h.name], timeout: h.timeout }]);
  }
  const want = [['session-start', 'SessionStart'], ['subagent-start', 'SubagentStart'], ['guard-bash', 'PreToolUse'], ['guard-wakeup', 'PreToolUse'],
    ['decisions-context', 'PreToolUse'], ['admit-agent', 'PreToolUse'], ['bind-agent', 'PostToolUse'], ['release-agent', 'SubagentStop'], ['stop-guard', 'Stop']];
  for (const [name, event] of want) assert.equal(HOOKS.find((h) => h.name === name)?.event, event, name);
});

const MALFORMED = ['', 'not json', '{"truncated":', '[]', 'null', '42', '"str"', '{}', '\u0000\u0001\u0002', 'x'.repeat(2 * 1024 * 1024)];
const wellFormed = (event, dir) => JSON.stringify({ session_id: 's', cwd: dir, hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'git status' }, source: 'startup', transcript_path: join(dir, 't.jsonl') });

// GC8 on a loaded machine (S3): "under 1 s" is the hook's CPU time; wall time is only a ceiling.
test('every registered hook accepts malformed input: exit 0, no output, under 1 s (GC8)', async (t) => {
  const { HOOKS } = await lib('hooks/registry.mjs');
  const { dir, env } = scratch(t);
  for (const h of HOOKS) {
    for (const input of [...MALFORMED, wellFormed(h.event, dir)]) {
      const r = measured((p) => spawnSync(process.execPath, [...p.nodeArgs, LAUNCHER, 'hook', h.name], { encoding: 'utf8', timeout: 30000, env: { ...env, ...p.env }, cwd: dir, input }));
      const label = `${h.name} <- ${JSON.stringify(input.slice(0, 40))}`;
      assert.equal(r.status, 0, `${label}\n${out(r)}`);
      assert.equal(r.stdout, '', `${label}: no output = allow`);
      assertFast(assert, r, label);
    }
  }
  for (const args of [['hook', 'no-such-hook'], ['hook'], ['hook', 'session-start', 'extra', '--frobnicate'], ['hook', 'session-start', '--json']]) {
    const r = cli(args, { env, cwd: dir, input: '{}' });
    assert.equal(r.status, 0, `${args.join(' ')} fails open\n${out(r)}`);
    assert.equal(r.stdout, '', args.join(' '));
  }
});

// Input deadline (S3 ruling, fix round 1): 2 s from the start of reading; still incomplete then → the Bash guard blocks
// (unverifiable), every other hook exits 0 with no output. The internal deadline ends the hook (stdin stays open): CPU
// time under 1 s, wall time from the deadline up to the ceiling (S3: load stretches wall time, not CPU time).
test('a hook whose stdin never closes ends after the 2 s input deadline: the Bash guard blocks, another hook allows', async (t) => {
  const { dir, env } = scratch(t);
  for (const [name, want] of [['guard-bash', 2], ['session-start', 0]]) {
    const probe = cpuProbe();
    const child = spawn(process.execPath, [...probe.nodeArgs, LAUNCHER, 'hook', name], { env: { ...env, ...probe.env }, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { child.kill('SIGKILL'); });
    child.stdin.write('{"session_id":"s",');
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const started = performance.now();
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(`still running after ${WALL_CEILING_MS} ms`), WALL_CEILING_MS);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    const ms = Math.round(performance.now() - started);
    assert.equal(status, want, `${name}: ${stderr}`);
    assert.equal(stdout, '', name);
    if (want === 2) assert.match(stderr, /could not read the whole command in time/);
    assert.ok(ms >= 1900, `${name}: ${ms} ms`);
    assertFast(assert, { ms, cpuMs: probe.read() }, `${name} with open stdin`);
  }
});

// docs/cli.md is generated from the table by scripts/gen-docs.mjs; drift fails here and in `gen-docs --check`.
const GEN_DOCS = join(root, 'scripts', 'gen-docs.mjs');
test('docs/cli.md is generated from the command table (gen-docs --check exits 0)', () => {
  const r = spawnSync(process.execPath, [GEN_DOCS, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, out(r));
});

test('docs/cli.md carries the help verbatim, every command (internal ones too) and every exit code', async () => {
  const { COMMANDS } = await lib('cli/commands.mjs');
  const docs = readFileSync(join(root, 'docs', 'cli.md'), 'utf8');
  const help = cli(['--help']).stdout;
  assert.ok(help.length > 0 && docs.includes(help), 'docs/cli.md embeds `--help` output verbatim');
  for (const row of COMMANDS) {
    const h = cli([...row.name.split(' '), '--help']);
    assert.equal(h.status, 0, `${row.name} --help\n${out(h)}`);
    assert.ok(docs.includes(h.stdout), `${row.name}: command help embedded`);
  }
  for (const [code, name] of SPEC_EXIT_CODES) assert.match(docs, new RegExp(`^\\| ${code} \\| ${name} \\| .+ \\|$`, 'm'), `exit ${code}`);
  assert.match(docs, /^## Internal commands$/m);
});

test('gen-docs: a changed table makes --check fail until docs/cli.md is regenerated; bad flags exit 2', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'gen-docs-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const p of ['package.json', pluginRel, 'docs/cli.md']) cpSync(join(root, p), join(fixture, p), { recursive: true });
  const gen = (args) => spawnSync(process.execPath, [GEN_DOCS, ...args, '--root', fixture], { encoding: 'utf8' });
  assert.equal(gen(['--check']).status, 0, 'fresh copy is up to date');
  const table = join(fixture, pluginRel, 'lib', 'cli', 'commands.mjs');
  const src = readFileSync(table, 'utf8');
  assert.ok(src.includes("summary: '"), 'rows carry a summary literal');
  writeFileSync(table, src.replace("summary: '", "summary: 'Changed. "));
  const stale = gen(['--check']);
  assert.equal(stale.status, 1, out(stale));
  assert.match(stale.stdout, /docs\/cli\.md/);
  assert.equal(gen([]).status, 0);
  assert.equal(gen(['--check']).status, 0);
  assert.match(readFileSync(join(fixture, 'docs', 'cli.md'), 'utf8'), /Changed\. /);
  assert.equal(spawnSync(process.execPath, [GEN_DOCS, '--frobnicate'], { encoding: 'utf8' }).status, 2);
});

// Fix round 1 (findings r1).

test('hooks fail open even when the plugin copy is broken: missing name.json, plugin.json or main.mjs', (t) => {
  const { env } = scratch(t);
  for (const missing of ['lib/name.json', '.claude-plugin/plugin.json', 'lib/cli/main.mjs']) {
    const copy = mkdtempSync(join(tmpdir(), 'broken-plugin-'));
    t.after(() => rmSync(copy, { recursive: true, force: true }));
    cpSync(pluginDir, copy, { recursive: true });
    rmSync(join(copy, missing));
    const launcher = join(copy, 'bin', names.bin);
    const hook = spawnSync(process.execPath, [launcher, 'hook', 'guard-bash'], { encoding: 'utf8', env, input: '{"tool_name":"Bash"}' });
    assert.equal(hook.status, 0, `${missing}: hook fails open\n${out(hook)}`);
    assert.equal(hook.stdout, '', `${missing}: no output = allow`);
    if (missing === 'lib/cli/main.mjs') assert.equal(hook.stderr, '', 'the launcher fails open silently');
    const other = spawnSync(process.execPath, [launcher, '--version'], { encoding: 'utf8', env });
    assert.equal(other.status, 70, `${missing}: other commands still report the broken install\n${out(other)}`);
  }
});

test('a command returning an exit code its row does not list is INTERNAL (70)', async () => {
  const { COMMANDS } = await lib('cli/commands.mjs');
  const { main } = await lib('cli/main.mjs');
  const row = (exits) => ({ name: 'fails', summary: 'Returns FAIL.', args: [], flags: [], exits, load: async () => () => ({ code: 1, errors: [{ code: 'x', message: 'x' }] }) });
  const undeclared = memoryIo();
  assert.equal(await main(['fails', '--json'], { commands: [...COMMANDS, row(['OK'])], io: undeclared }), 70);
  const e = JSON.parse(undeclared.stdout);
  assert.equal(e.errors[0].code, 'internal');
  assert.match(e.errors[0].message, /1 FAIL/);
  const declared = memoryIo();
  assert.equal(await main(['fails', '--json'], { commands: [...COMMANDS, row(['OK', 'FAIL'])], io: declared }), 1);
});

test('usage lines have one source: main.mjs builds none; usage errors repeat the help usage line', (t) => {
  const src = readFileSync(join(pluginDir, 'lib', 'cli', 'main.mjs'), 'utf8');
  assert.doesNotMatch(src, /['"`]usage: /, 'main.mjs takes usage lines from help.mjs');
  const { env } = scratch(t);
  const first = (args) => cli(args, { env }).stdout.split('\n')[0];
  assert.ok(cli(['no-such-command'], { env }).stderr.split('\n').includes(first(['--help'])));
  assert.ok(cli(['doctor', '--frobnicate'], { env }).stderr.split('\n').includes(first(['doctor', '--help'])));
});

test('docs/cli.md envelope example comes from the envelope module: version and key order', async (t) => {
  const { envelope } = await lib('cli/envelope.mjs');
  const docs = readFileSync(join(root, 'docs', 'cli.md'), 'utf8');
  const example = docs.split('\n').find((l) => l.startsWith('{"cli":'));
  assert.ok(example, 'envelope example line');
  const keys = [...example.matchAll(/"(\w+)":/g)].map((m) => m[1]).slice(0, 7);
  assert.deepEqual(keys, Object.keys(envelope({ command: 'x', code: 0 })));
  // A changed envelope version reaches the docs: gen-docs --check reports them stale.
  const fixture = mkdtempSync(join(tmpdir(), 'gen-docs-env-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const p of ['package.json', pluginRel, 'docs/cli.md']) cpSync(join(root, p), join(fixture, p), { recursive: true });
  const file = join(fixture, pluginRel, 'lib', 'cli', 'envelope.mjs');
  const src = readFileSync(file, 'utf8');
  assert.match(src, /ENVELOPE_VERSION = 1;/);
  writeFileSync(file, src.replace('ENVELOPE_VERSION = 1;', 'ENVELOPE_VERSION = 2;'));
  const r = spawnSync(process.execPath, [GEN_DOCS, '--check', '--root', fixture], { encoding: 'utf8' });
  assert.equal(r.status, 1, out(r));
});

test('every hook records a handler time budget within the 800 ms internal deadline (enforced from I3)', async () => {
  const { HOOKS, DEADLINE_MS } = await lib('hooks/registry.mjs');
  assert.equal(DEADLINE_MS, 800);
  for (const h of HOOKS) assert.ok(Number.isInteger(h.budgetMs) && h.budgetMs > 0 && h.budgetMs <= DEADLINE_MS, `${h.name}: budgetMs ${h.budgetMs}`);
});
