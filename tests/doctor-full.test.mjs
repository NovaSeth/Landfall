// Doctor, full report (spec §7.19 NICE 3, SD-4, SD-5, U3): next to the v0 checks the install e2e test pins
// (claude-code, plugin, hooks), one row per item of the report: release, heartbeat, bin-path, state, profile, flags,
// providers, scheduler, context, permissions, protection; each { id, status ok|warn|fail|skip, detail, hint }. The
// release check is offline-safe (unknown on a network error, 2 s cap); doctor is read-only always; exit 0 healthy
// (warnings allowed) · 1 problems found · 8 environment (claude or git missing; the report is still listed).
// The launcher runs with a fake `claude` on a PATH of system directories, a throwaway HOME and no variable of the
// calling session (tests/helpers/isolated-env.mjs). This file holds no plugin name or path: both come from
// lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

// No child of this file sees the real HOME or the calling session.
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const out = (r) => `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

function locate() {
  const plugins = join(root, 'plugins');
  const hits = existsSync(plugins) ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json'))) : [];
  assert.equal(hits.length, 1, `expected exactly one plugins/*/lib/name.json, found ${hits.length}`);
  const pluginDir = join(plugins, hits[0]);
  return { pluginDir, names: readJson(join(pluginDir, 'lib', 'name.json')) };
}
const { pluginDir, names } = locate();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const VERSION = readJson(join(pluginDir, '.claude-plugin', 'plugin.json')).version;
const LAUNCHER = join(pluginDir, 'bin', names.bin);
const PLUGIN_ID = `${names.plugin}@${names.marketplace}`;
const { HOOKS } = await lib('hooks/registry.mjs');
const EVENTS = [...new Set(HOOKS.map((h) => h.event))];

const ROW_IDS = ['release', 'heartbeat', 'bin-path', 'state', 'profile', 'flags', 'providers', 'scheduler', 'context', 'permissions', 'protection'];
const STATUSES = ['ok', 'warn', 'fail', 'skip'];
const RULES = [`Bash(${names.bin} exec:*)`, `Bash(${names.bin} wait:*)`]; // U3
const SYSTEM_DIRS = ['/usr/bin', '/bin'];
const IDENTITY = '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n';

function onPath(name, pathValue) {
  for (const dir of String(pathValue ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, name);
    try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

// Shape of `claude plugin details` in Claude Code 2.1.300 (as in tests/cli-contract.test.mjs).
const detailsText = (events, alwaysOn = '~0 tok') => [
  `${names.plugin} ${VERSION}`, '  Description: test', `  Source: ${PLUGIN_ID}`, '', 'Component inventory', '  Skills (0)', '  Agents (0)',
  events.length ? `  Hooks (${events.length})  ${events.join(', ')}  (harness-only — no model context cost)` : '  Hooks (0)',
  '  MCP servers (0)', '  LSP servers (0)', '', 'Projected token cost', `  Always-on:   ${alwaysOn}   added to every session`, '',
].join('\n');
const healthyList = () => JSON.stringify([{ id: PLUGIN_ID, version: VERSION, scope: 'user', enabled: true }]);

// Fake `claude`: canned answers to the calls doctor makes (marketplaces null: that call fails); anything else exits 64.
function fakeClaude(bin, { version = '2.1.300 (Claude Code)', list = healthyList(), details = detailsText(EVENTS), marketplaces = null } = {}) {
  const answers = JSON.stringify({ version, list, details, marketplaces, id: PLUGIN_ID });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
const o = ${answers};
if (a === '--version') process.stdout.write(o.version + '\\n');
else if (a === 'plugin list --json') process.stdout.write(o.list);
else if (a === 'plugin details ' + o.id && o.details !== null) process.stdout.write(o.details);
else if (a === 'plugin marketplace list --json' && o.marketplaces !== null) process.stdout.write(o.marketplaces);
else { process.stderr.write('fake claude: unexpected ' + a + '\\n'); process.exit(64); }
`);
  chmodSync(join(bin, 'claude'), 0o755);
}

// A throwaway HOME, a bin/ with `node` (for the fake's shebang) ahead of the system directories, a work directory
// outside any git repository.
function scratch(t) {
  const iso = isolatedEnv({ gitConfig: IDENTITY, prefix: 'doctor-full-' });
  t.after(iso.cleanup);
  const bin = join(iso.base, 'bin');
  const work = join(iso.base, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  symlinkSync(process.execPath, join(bin, 'node'));
  return { base: iso.base, bin, work, env: { ...iso.env, PATH: [bin, ...SYSTEM_DIRS].join(delimiter) } };
}

const cli = (s, cwd, args, env = s.env) => spawnSync(process.execPath, [LAUNCHER, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
function doctor(s, { cwd = s.work, env = s.env } = {}) {
  const start = Date.now();
  const r = cli(s, cwd, ['doctor', '--json'], env);
  const ms = Date.now() - start;
  assert.equal(r.stdout.split('\n').length, 2, `one envelope line\n${out(r)}`);
  const e = JSON.parse(r.stdout);
  return { r, e, ms, row: (id) => e.data.rows?.find((x) => x.id === id) ?? assert.fail(`no ${id} row in ${JSON.stringify(e.data)}`) };
}

const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}\n${out(r)}`);
  return r.stdout;
};
function repo(parent, name) {
  const dir = join(parent, name);
  mkdirSync(dir);
  gitIn(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  gitIn(dir, 'add', 'README.md');
  gitIn(dir, '-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
  return dir;
}

// path -> content hash (files), link target (symlinks) or 'dir'.
function snapshot(base) {
  const snap = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(base, p);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) snap.set(rel, `link:${readlinkSync(p)}`);
      else if (st.isDirectory()) { snap.set(rel, 'dir'); walk(p); }
      else snap.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(base);
  return snap;
}
const changed = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();

test('full report: the v0 checks stay as pinned, one row per item with a status and a fix hint; healthy exits 0', (t) => {
  const s = scratch(t);
  fakeClaude(s.bin);
  const before = snapshot(s.base);
  const { r, e, row } = doctor(s);
  assert.equal(r.status, 0, out(r));
  assert.deepEqual(e.data.checks.map((c) => [c.id, c.ok]), [['claude-code', true], ['plugin', true], ['hooks', true]]);
  for (const c of e.data.checks) assert.ok(typeof c.hint === 'string' && c.hint.length > 0, `${c.id}: fix hint`);
  assert.deepEqual(e.data.rows.map((x) => x.id), ROW_IDS);
  for (const x of e.data.rows) {
    assert.deepEqual(Object.keys(x), ['id', 'status', 'detail', 'hint'], x.id);
    assert.ok(STATUSES.includes(x.status), `${x.id}: status ${x.status}`);
    assert.ok(typeof x.detail === 'string' && x.detail.length > 0, `${x.id}: detail`);
    assert.ok(typeof x.hint === 'string' && x.hint.length > 0 && x.hint.length <= 200, `${x.id}: fix hint ≤ 200: ${x.hint}`);
  }
  // Items whose source is not in this version, or not reachable here.
  assert.deepEqual(['heartbeat', 'providers', 'scheduler', 'protection'].map((id) => row(id).status), ['skip', 'skip', 'skip', 'skip']);
  assert.match(row('heartbeat').detail, /not recorded/);
  assert.match(row('providers').detail, /not available/);
  assert.ok(row('protection').detail.includes(`${names.claimRefPrefix}*`), row('protection').detail);
  assert.equal(row('release').status, 'skip');
  assert.match(row('release').detail, /unknown/);
  assert.ok(row('release').detail.includes(VERSION), 'the installed version is shown');
  assert.equal(row('bin-path').status, 'warn');
  for (const id of ['state', 'profile', 'flags']) {
    assert.equal(row(id).status, 'skip', id);
    assert.match(row(id).detail, /not in a git repository/, id);
  }
  assert.equal(row('context').status, 'ok');
  assert.match(row('context').detail, /\b0 tok\b/);
  assert.equal(row('permissions').status, 'warn');
  for (const rule of RULES) assert.ok(row('permissions').hint.includes(rule), row('permissions').hint);

  // Human mode: every row on stdout, a fix line under each warning; stderr stays empty when healthy.
  const human = cli(s, s.work, ['doctor']);
  assert.equal(human.status, 0, out(human));
  assert.equal(human.stderr, '');
  for (const x of e.data.rows) assert.match(human.stdout, new RegExp(`^ {2}(ok {2}|warn|skip|FAIL) {2}${x.id} +\\S`, 'm'), x.id);
  assert.ok(human.stdout.includes(`fix: ${row('permissions').hint}`), human.stdout);
  assert.deepEqual(changed(before, snapshot(s.base)), [], 'doctor wrote nothing (read-only)');
});

test('floor (SD-5) and always-on cost: below the floor fails; over the SC3 budget warns; unreadable is unknown', (t) => {
  const s = scratch(t);
  fakeClaude(s.bin, { version: '2.1.299 (Claude Code)' });
  let d = doctor(s);
  assert.equal(d.r.status, 1, out(d.r));
  assert.ok(d.e.errors.some((x) => x.code === 'claude-code-too-old'));
  assert.deepEqual(d.e.data.rows.map((x) => x.id), ROW_IDS, 'the report is complete when a check fails');

  fakeClaude(s.bin, { details: detailsText(EVENTS, '~840 tok') });
  d = doctor(s);
  assert.equal(d.r.status, 0, out(d.r));
  assert.deepEqual([d.row('context').status, /\b840 tok\b/.test(d.row('context').detail)], ['ok', true], d.row('context').detail);

  fakeClaude(s.bin, { details: detailsText(EVENTS, '~1.2k tok') });
  d = doctor(s);
  assert.equal(d.r.status, 0, 'a cost over budget is a warning');
  assert.equal(d.row('context').status, 'warn');
  assert.match(d.row('context').detail, /1200 tok.*1000/);

  fakeClaude(s.bin, { details: 'unrecognised\n' });
  d = doctor(s);
  assert.equal(d.r.status, 1, 'hooks not readable');
  assert.equal(d.row('context').status, 'skip');
  assert.match(d.row('context').detail, /unknown/);
});

test('release (SD-4): the newest <plugin>--v<x.y.z> tag of the marketplace source; a newer one warns with the update command', (t) => {
  const s = scratch(t);
  const market = repo(s.base, 'market');
  const tag = (name) => gitIn(market, 'tag', name);
  const listed = (entry) => JSON.stringify([{ name: 'other', source: 'directory', path: s.work }, { name: names.marketplace, ...entry, installLocation: market }]);
  fakeClaude(s.bin, { marketplaces: listed({ source: 'directory', path: market }) });
  let d = doctor(s);
  assert.equal(d.row('release').status, 'skip', 'no release tag yet');
  assert.match(d.row('release').detail, /unknown/);

  tag(`${names.plugin}--v${VERSION}`);
  d = doctor(s);
  assert.equal(d.row('release').status, 'ok', JSON.stringify(d.row('release')));
  assert.ok(d.row('release').detail.includes(VERSION));

  const major = Number(VERSION.split('.')[0]);
  const newer = `${major + 1}.0.0`;
  tag(`${names.plugin}--v${newer}`);
  tag(`${names.plugin}--v${major + 2}.0.0-rc.1`); // a pre-release is no release
  tag(`other--v${major + 3}.0.0`); // another plugin of the marketplace
  tag(`v${major + 4}.0.0`);
  d = doctor(s);
  assert.equal(d.r.status, 0, `an available update is a warning\n${out(d.r)}`);
  assert.equal(d.row('release').status, 'warn');
  assert.ok(d.row('release').detail.includes(newer), d.row('release').detail);
  for (const n of [2, 3, 4]) assert.ok(!d.row('release').detail.includes(`${major + n}.0.0`), d.row('release').detail);
  assert.ok(d.row('release').hint.includes(`claude plugin update ${PLUGIN_ID}`), d.row('release').hint);

  // Unreachable source, marketplace not listed, unreadable list: unknown, never a failure.
  for (const marketplaces of [listed({ source: 'directory', path: join(s.base, 'gone') }), JSON.stringify([{ name: 'other', source: 'directory', path: market }]), 'not json']) {
    fakeClaude(s.bin, { marketplaces });
    d = doctor(s);
    assert.equal(d.r.status, 0, out(d.r));
    assert.equal(d.row('release').status, 'skip', marketplaces);
    assert.match(d.row('release').detail, /unknown/);
  }
});

test('release: a source that does not answer is unknown within the 2 s cap (offline-safe)', (t) => {
  const s = scratch(t);
  const realGit = onPath('git', process.env.PATH);
  assert.ok(realGit, 'git on PATH');
  const market = repo(s.base, 'market');
  gitIn(market, 'tag', `${names.plugin}--v${VERSION}`);
  // git on the doctor's PATH: ls-remote hangs (a network that never answers), everything else is the real git.
  writeFileSync(join(s.bin, 'git'), `#!/bin/sh\ncase " $* " in *" ls-remote "*) exec sleep 30;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(s.bin, 'git'), 0o755);
  fakeClaude(s.bin, { marketplaces: JSON.stringify([{ name: names.marketplace, source: 'directory', path: market, installLocation: market }]) });
  const d = doctor(s);
  assert.equal(d.r.status, 0, out(d.r));
  assert.equal(d.row('release').status, 'skip');
  assert.match(d.row('release').detail, /unknown/);
  assert.ok(d.ms < 12000, `doctor took ${d.ms} ms; the release check is capped at 2 s`);
});

test('release helpers: the git remote of a marketplace entry, and the newest release tag', async () => {
  const { marketplaceRemote, latestTag } = await lib('cli/doctor.mjs');
  assert.equal(marketplaceRemote({ name: 'm', source: 'github', repo: 'owner/repo' }), 'https://github.com/owner/repo.git');
  assert.equal(marketplaceRemote({ source: 'git', url: 'https://example.com/r.git' }), 'https://example.com/r.git');
  assert.equal(marketplaceRemote({ source: 'git', url: 'git@example.com:o/r.git' }), 'git@example.com:o/r.git');
  assert.equal(marketplaceRemote({ source: 'directory', path: '/abs/market' }), '/abs/market');
  const refused = [null, {}, { source: 'url', url: 'https://example.com/marketplace.json' }, { source: 'git', url: '--upload-pack=touch /tmp/x' },
    { source: 'git', url: 'ext::sh -c touch% /tmp/x' }, { source: 'directory', path: 'relative/market' }, { source: 'github', repo: 'no-slash' }];
  for (const entry of refused) assert.equal(marketplaceRemote(entry), null, JSON.stringify(entry));

  const p = names.plugin;
  const ls = [`a\trefs/tags/${p}--v1.9.0`, `b\trefs/tags/${p}--v1.10.0`, `c\trefs/tags/${p}--v2.0.0-rc.1`, `d\trefs/tags/other--v9.0.0`, 'e\trefs/tags/v9.0.0', `f\trefs/heads/${p}--v8.0.0`, ''].join('\n');
  assert.deepEqual(latestTag(ls, p), [1, 10, 0], 'numeric order; pre-releases, other plugins and branches ignored');
  assert.equal(latestTag('', p), null);
});

test('bin/ on PATH: ok when the first <bin> on PATH is this launcher (or a link to it); missing or another one warns', (t) => {
  const s = scratch(t);
  fakeClaude(s.bin);
  const withPath = (...dirs) => ({ env: { ...s.env, PATH: [...dirs, s.env.PATH].join(delimiter) } });
  let d = doctor(s);
  assert.equal(d.row('bin-path').status, 'warn');
  assert.match(d.row('bin-path').detail, /not on PATH/);

  d = doctor(s, withPath(join(pluginDir, 'bin')));
  assert.equal(d.row('bin-path').status, 'ok', JSON.stringify(d.row('bin-path')));

  const linked = join(s.base, 'linked');
  mkdirSync(linked);
  symlinkSync(LAUNCHER, join(linked, names.bin));
  d = doctor(s, withPath(linked));
  assert.equal(d.row('bin-path').status, 'ok', 'a link to the launcher (npm bin) is this launcher');

  const other = join(s.base, 'other');
  mkdirSync(other);
  writeFileSync(join(other, names.bin), '#!/bin/sh\nexit 0\n');
  chmodSync(join(other, names.bin), 0o755);
  d = doctor(s, withPath(other, join(pluginDir, 'bin')));
  assert.equal(d.row('bin-path').status, 'warn');
  assert.ok(d.row('bin-path').detail.includes(join(other, names.bin)), d.row('bin-path').detail);
  assert.equal(d.r.status, 0, 'a warning only');
});

test('state, profile and flags of an active repository; read-only; a newer or broken state.json fails', async (t) => {
  const s = scratch(t);
  fakeClaude(s.bin);
  const { KINDS } = await lib('state/index.mjs');
  const project = repo(s.base, 'project');
  let d = doctor(s, { cwd: project });
  for (const id of ['state', 'profile', 'flags']) {
    assert.equal(d.row(id).status, 'skip', id);
    assert.match(d.row(id).detail, /not active/, id);
  }

  const init = cli(s, project, ['init', '--yes']);
  assert.equal(init.status, 0, out(init));
  const before = snapshot(project);
  d = doctor(s, { cwd: project });
  assert.equal(d.r.status, 0, out(d.r));
  assert.equal(d.row('state').status, 'ok');
  assert.match(d.row('state').detail, new RegExp(`schema ${KINDS.state.version}\\b`));
  assert.equal(d.row('profile').status, 'warn');
  assert.match(d.row('profile').detail, /never scanned/);
  assert.ok(d.row('profile').hint.includes(`${names.bin} profile observe`), d.row('profile').hint);
  assert.equal(d.row('flags').status, 'ok');
  assert.match(d.row('flags').detail, /engine shadow \(default\)/);
  assert.deepEqual(changed(before, snapshot(project)), [], 'doctor wrote nothing in the repository or its state');

  const observe = cli(s, project, ['profile', 'observe', '--yes']);
  assert.equal(observe.status, 0, out(observe));
  d = doctor(s, { cwd: project });
  assert.equal(d.row('profile').status, 'ok', JSON.stringify(d.row('profile')));

  const stateFile = join(project, names.stateDir, 'state.json');
  const doc = readJson(stateFile);
  writeFileSync(join(project, names.stateDir, 'config.json'), JSON.stringify({ schema: 1, flags: { engine: 'on', lanes: 'on' } }, null, 2));
  d = doctor(s, { cwd: project });
  assert.equal(d.row('flags').status, 'ok');
  assert.match(d.row('flags').detail, /engine on/);
  assert.match(d.row('flags').detail, /lanes on/);

  writeFileSync(stateFile, JSON.stringify({ ...doc, schema: KINDS.state.version + 1 }, null, 2));
  d = doctor(s, { cwd: project });
  assert.equal(d.r.status, 1, out(d.r));
  assert.equal(d.row('state').status, 'fail');
  const newer = d.e.errors.find((x) => x.code === 'schema-newer');
  assert.ok(newer && newer.hint.includes('claude plugin update'), JSON.stringify(d.e.errors));
  assert.equal(d.row('flags').status, 'skip');

  writeFileSync(stateFile, '{ not json');
  d = doctor(s, { cwd: project });
  assert.equal(d.r.status, 1, out(d.r));
  assert.equal(d.row('state').status, 'fail');
  assert.ok(d.e.errors.some((x) => x.code === 'state-invalid'), JSON.stringify(d.e.errors));
});

test('permissions (U3): advice until the settings allow both rules; doctor never writes settings', (t) => {
  const s = scratch(t);
  fakeClaude(s.bin);
  const project = repo(s.base, 'project');
  let d = doctor(s, { cwd: project });
  assert.equal(d.row('permissions').status, 'warn');
  for (const rule of RULES) assert.ok(d.row('permissions').detail.includes(rule), d.row('permissions').detail);

  const user = join(s.env.CLAUDE_CONFIG_DIR, 'settings.json');
  mkdirSync(dirname(user), { recursive: true });
  writeFileSync(user, JSON.stringify({ permissions: { allow: [RULES[0]] } }));
  d = doctor(s, { cwd: project });
  assert.equal(d.row('permissions').status, 'warn');
  assert.ok(d.row('permissions').detail.includes(RULES[1]) && !d.row('permissions').detail.includes(RULES[0]), d.row('permissions').detail);

  mkdirSync(join(project, '.claude'));
  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: [RULES[1]] } }));
  const before = snapshot(s.base);
  d = doctor(s, { cwd: project });
  assert.equal(d.row('permissions').status, 'ok', JSON.stringify(d.row('permissions')));
  assert.deepEqual(changed(before, snapshot(s.base)), [], 'settings and HOME untouched');

  writeFileSync(user, '{ broken');
  d = doctor(s, { cwd: project });
  assert.equal(d.r.status, 0, out(d.r));
  assert.equal(d.row('permissions').status, 'warn', 'an unreadable settings file allows nothing');
});

test('environment: claude or git missing exits 8 and the report is still listed', (t) => {
  const s = scratch(t);
  let d = doctor(s); // no claude on PATH
  assert.equal(d.r.status, 8, out(d.r));
  assert.equal(d.e.errors[0].code, 'claude-missing');
  assert.deepEqual(d.e.data.rows.map((x) => x.id), ROW_IDS);
  assert.equal(d.row('context').status, 'skip');
  const human = cli(s, s.work, ['doctor']);
  assert.equal(human.status, 8);
  assert.match(human.stdout, /^ {2}skip {2}context /m, 'the human report is printed too');

  fakeClaude(s.bin);
  d = doctor(s, { env: { ...s.env, PATH: s.bin } }); // node and the fake claude only: no git
  assert.equal(d.r.status, 8, out(d.r));
  assert.ok(d.e.errors.some((x) => x.code === 'git-missing'), JSON.stringify(d.e.errors));
  assert.deepEqual(d.e.data.rows.map((x) => x.id), ROW_IDS);
});
