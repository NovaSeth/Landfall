// Activation lifecycle (spec §7.2, SD-6, SD-7, SD-36, SC2, REV-58): `init`, `decline`, `deactivate` and the
// activation rule. Before `init` no command leaves a file in the repository or HOME (SC2); trivial work never
// activates (only `init` creates state, and the rule never asks for it on trivial work); an opt-out is stored in
// machine data keyed by the repository's real path and survives new processes. The StateError → envelope
// mapping of lib/cli/main.mjs is tested here too (once for every command).
// Commands run through the real command table (lib/cli/main.mjs) in a throwaway repository and HOME; the
// persistence cases also through the launcher in a child process.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (and git run by the code under test) gets a throwaway HOME and environment (S1).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const VERSION = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const LAUNCHER = join(pluginDir, 'bin', names.bin);
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const { main } = await lib('cli/main.mjs');
const { COMMANDS } = await lib('cli/commands.mjs');

const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const identity = (name, email) => `[user]\n\tname = ${name}\n\temail = ${email}\n`;
const USER = { name: 'Test User', email: 'test@example.com', handle: 'TU' };

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const status = (dir, env) => git(dir, env, ['status', '--porcelain', '--untracked-files=all']);

// A repository with one commit; the git identity comes from the throwaway global git config of its own HOME.
function repo(t, { gitConfig = identity(USER.name, USER.email) } = {}) {
  const iso = isolatedEnv({ gitConfig, prefix: 'activation-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  writeFileSync(join(dir, 'src', 'app.txt'), 'app\n');
  git(dir, iso.env, ['add', '-A']);
  git(dir, iso.env, ['commit', '-qm', 'init']);
  return { base: iso.base, dir, home: iso.home, env: iso.env, store: join(dir, names.stateDir), dataDir: state.machineDataDir(names, iso.env) };
}
// Another developer: the same HOME (machine) with another git identity.
function developer(env, base, name, email) {
  const file = join(base, `${email}.gitconfig`);
  writeFileSync(file, identity(name, email));
  return { ...env, GIT_CONFIG_GLOBAL: file };
}

async function cli(args, { cwd, env, tty = false, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, out: json ? JSON.parse(stdout) : stdout, stderr: err.join('') };
}
const launch = (env, cwd, args) => spawnSync(process.execPath, [LAUNCHER, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
const show = (r) => JSON.stringify(r.out ?? r);

// Every path under dir (but .git) with its content: a file's text, a directory's marker, a link's target.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (rel === '.git') continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = 'link';
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(p); } else out[rel] = readFileSync(p, 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
const projects = (r) => state.readProjects(r.dataDir, names).projects;
const filesUnder = (dir) => Object.entries(snapshot(dir)).filter(([, v]) => v !== 'dir').map(([k]) => k).sort();

// ---- SC2: zero footprint before init ----

test('SC2: before init no command writes into the repository or HOME; refusals and reads leave both byte-identical', async (t) => {
  const r = repo(t);
  const before = { repo: snapshot(r.dir), home: snapshot(r.home) };
  const runs = [
    [['task', 'list'], 0],
    [['task', 'show', `T-${USER.handle}-1`], 2],
    [['task', 'new', 'Fix the login form', '--yes'], 7],
    [['task', 'new', 'Fix the login form', '--kind', 'gate', '--lane', 'auth', '--yes'], 7],
    [['task', 'set', `T-${USER.handle}-1`, 'blocked', '--reason', 'waiting for the API', '--yes'], 7],
    [['init'], 7], // no terminal and no --yes: refused before anything is read or written (REV-58)
    [['init', '--state-dir', join(r.base, 'outside')], 7],
    [['decline'], 7],
    [['deactivate'], 7],
  ];
  for (const cwd of [r.dir, join(r.dir, 'src')]) {
    for (const [args, code] of runs) {
      const res = await cli(args, { cwd, env: r.env });
      assert.equal(res.code, code, `${args.join(' ')} in ${relative(r.dir, cwd) || '.'}: ${show(res)}`);
    }
  }
  const list = await cli(['task', 'list'], { cwd: r.dir, env: r.env });
  assert.deepEqual([list.out.data.active, list.out.data.tasks], [false, []], 'an inactive repository lists no tasks');
  const refused = await cli(['task', 'new', 'x', '--yes'], { cwd: r.dir, env: r.env });
  assert.deepEqual([refused.out.exit, refused.out.errors[0].code], ['REFUSED', 'inactive']);
  assert.match(refused.out.errors[0].hint, new RegExp(`${names.bin} init`));
  assert.deepEqual(snapshot(r.dir), before.repo, 'repository unchanged');
  assert.deepEqual(snapshot(r.home), before.home, 'HOME unchanged: no machine data either');
  assert.equal(status(r.dir, r.env), '', 'git status clean');
  assert.ok(!existsSync(r.store), 'no state directory');
  assert.ok(!existsSync(join(r.base, 'outside')), 'a refused --state-dir creates nothing');
});

test('SC2 through the launcher: a fresh process in an unknown repository writes nothing for reads and refused writes', (t) => {
  const r = repo(t);
  const before = { repo: snapshot(r.dir), home: snapshot(r.home) };
  for (const [args, code] of [[['task', 'list', '--json'], 0], [['task', 'new', 'x', '--yes', '--json'], 7], [['init', '--json'], 7]]) {
    const res = launch(r.env, r.dir, args);
    assert.equal(res.status, code, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.equal(res.stdout.trim().split('\n').length, 1, 'one envelope line');
  }
  assert.deepEqual(snapshot(r.dir), before.repo);
  assert.deepEqual(snapshot(r.home), before.home);
});

// ---- SD-6: the activation rule ----

test('SD-6: trivial work never activates; a decline keeps every class vanilla; an active repository continues', () => {
  const CLASSES = ['trivial', 'standard', 'critical'];
  for (const cls of CLASSES) {
    assert.equal(state.activationStep({ active: false, declined: false }, cls), cls === 'trivial' ? 'vanilla' : 'activate', `unknown, ${cls}`);
    assert.equal(state.activationStep({ active: false, declined: true }, cls), 'vanilla', `declined, ${cls}`);
    assert.equal(state.activationStep({ active: true, declined: false }, cls), 'continue', `active, ${cls}`);
    assert.equal(state.activationStep({ active: true, declined: true }, cls), 'continue', `active wins over an old decline, ${cls}`);
  }
  assert.equal(state.activationStep({ active: true, declined: false }, null), 'continue', 'an active repository needs no class');
  for (const bad of [null, undefined, 'huge', 'Trivial']) {
    assert.throws(() => state.activationStep({ active: false, declined: false }, bad), TypeError, `class ${bad}`);
  }
});

// ---- init ----

test('init: consent required; activation writes state.json, .gitignore and team/<H>.json and nothing else', async (t) => {
  const r = repo(t);
  const refused = await cli(['init'], { cwd: r.dir, env: r.env });
  assert.deepEqual([refused.code, refused.out.errors[0].code], [7, 'consent-required']);
  assert.ok(!existsSync(r.store));

  const res = await cli(['init', '--yes'], { cwd: join(r.dir, 'src'), env: r.env });
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.out.data.activated, res.out.data.handle, res.out.data.dir, res.out.data.linked], [true, USER.handle, r.store, false]);
  assert.deepEqual(filesUnder(r.store), ['.gitignore', 'state.json', `team/${USER.handle}.json`], 'exactly the activation files');
  const doc = JSON.parse(readFileSync(join(r.store, 'state.json'), 'utf8'));
  assert.deepEqual({ ...doc, activatedAt: 'x' }, { schema: state.KINDS.state.version, codename: names.codename, createdWith: VERSION, activatedAt: 'x' });
  assert.match(doc.activatedAt, ISO_TIME);
  const team = JSON.parse(readFileSync(join(r.store, 'team', `${USER.handle}.json`), 'utf8'));
  assert.equal(team.emailSha256, createHash('sha256').update(USER.email).digest('hex'));
  for (const f of filesUnder(r.store)) assert.ok(!readFileSync(join(r.store, f), 'utf8').includes(USER.email), `${f}: no plain email`);
  // .gitignore: local/ and crash leftovers of atomic writes (.*.tmp) never show up in git.
  const ignore = readFileSync(join(r.store, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('local/') && ignore.includes('.*.tmp'), ignore.join('|'));
  mkdirSync(join(r.store, 'local', 'ids'), { recursive: true });
  writeFileSync(join(r.store, 'local', 'ids', 'x.json'), '{}\n');
  writeFileSync(join(r.store, `.state.json.${process.pid}.0123abcd.tmp`), 'partial');
  writeFileSync(join(r.store, 'team', `.${USER.handle}.json.${process.pid}.0123abcd.tmp`), 'partial');
  const rel = names.stateDir;
  assert.deepEqual(status(r.dir, r.env).trim().split('\n').sort(), [`?? ${rel}/.gitignore`, `?? ${rel}/state.json`, `?? ${rel}/team/${USER.handle}.json`]);
  assert.deepEqual(projects(r), {}, 'an in-repository state directory needs no machine data');
});

test('init: idempotent; a second developer gets the next free handle; --handle chooses one; a decline is cleared', async (t) => {
  const r = repo(t);
  assert.equal((await cli(['decline', '--yes'], { cwd: r.dir, env: r.env })).code, 0);
  assert.ok(projects(r)[r.dir]?.declinedAt, 'declined first');
  const first = await cli(['init', '--yes'], { cwd: r.dir, env: r.env });
  assert.equal(first.code, 0, show(first));
  assert.equal(projects(r)[r.dir], undefined, 'an explicit init clears the decline');
  const files = snapshot(r.store);
  const again = await cli(['init', '--yes'], { cwd: r.dir, env: r.env });
  assert.equal(again.code, 0, show(again));
  assert.deepEqual([again.out.data.activated, again.out.data.handle, again.out.data.registered], [false, USER.handle, false]);
  assert.deepEqual(snapshot(r.store), files, 'a repeated init changes no byte');
  // Same initials, another email: next letters of the last word (TU → TUS).
  const other = developer(r.env, r.base, 'Tom Usher', 'tom@example.com');
  const second = await cli(['init', '--yes'], { cwd: r.dir, env: other });
  assert.deepEqual([second.code, second.out.data.activated, second.out.data.handle, second.out.data.registered], [0, false, 'TUS', true], show(second));
  const third = await cli(['init', '--yes', '--handle', 'QX'], { cwd: r.dir, env: developer(r.env, r.base, 'Quinn Xu', 'q@example.com') });
  assert.deepEqual([third.code, third.out.data.handle], [0, 'QX'], show(third));
  const taken = await cli(['init', '--yes', '--handle', 'QX'], { cwd: r.dir, env: developer(r.env, r.base, 'Q Other', 'q2@example.com') });
  assert.deepEqual([taken.code, taken.out.errors[0].code], [2, 'handle-taken'], show(taken));
  const bad = await cli(['init', '--yes', '--handle', 'q1'], { cwd: r.dir, env: r.env });
  assert.deepEqual([bad.code, bad.out.errors[0].code], [2, 'invalid-key'], show(bad));
  assert.deepEqual(readdirSync(join(r.store, 'team')).sort(), ['QX.json', 'TU.json', 'TUS.json']);
});

test('init refuses before writing: no git email, not a repository, newer state schema', async (t) => {
  const noEmail = repo(t, { gitConfig: '[user]\n\tname = Test User\n' });
  const a = await cli(['init', '--yes'], { cwd: noEmail.dir, env: noEmail.env });
  assert.deepEqual([a.code, a.out.errors[0].code], [2, 'email-required'], show(a));
  assert.ok(!existsSync(noEmail.store), 'nothing written');
  assert.equal(status(noEmail.dir, noEmail.env), '');

  const r = repo(t);
  const outside = join(r.base, 'not-a-repo');
  mkdirSync(outside);
  const b = await cli(['init', '--yes'], { cwd: outside, env: r.env });
  assert.deepEqual([b.code, b.out.exit], [8, 'ENV'], show(b));
  assert.deepEqual(readdirSync(outside), []);

  mkdirSync(r.store);
  const newer = `${JSON.stringify({ schema: state.KINDS.state.version + 1, future: true })}\n`;
  writeFileSync(join(r.store, 'state.json'), newer);
  const c = await cli(['init', '--yes'], { cwd: r.dir, env: r.env });
  assert.deepEqual([c.code, c.out.errors[0].code], [7, 'schema-newer'], show(c));
  assert.deepEqual(snapshot(r.store), { 'state.json': newer }, 'zero bytes written (SC10)');
});

test('init --state-dir links an external directory by the real path (SD-7, SD-36): the repository stays clean', async (t) => {
  const r = repo(t);
  const external = join(r.base, 'control', 'state');
  // Relative to the current directory, run from a subdirectory reached through a symbolic link.
  const alias = join(r.base, 'alias');
  symlinkSync(r.dir, alias);
  const res = await cli(['init', '--yes', '--state-dir', relative(join(alias, 'src'), external)], { cwd: join(alias, 'src'), env: r.env });
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.out.data.dir, res.out.data.linked, res.out.data.activated], [external, true, true]);
  assert.deepEqual(projects(r), { [realpathSync(r.dir)]: { stateDir: external } });
  assert.deepEqual(filesUnder(external), ['.gitignore', 'state.json', `team/${USER.handle}.json`]);
  assert.ok(!existsSync(r.store), 'no state directory in the repository');
  assert.equal(status(r.dir, r.env), '', 'git status clean');
  const where = state.resolve({ cwd: r.dir, env: r.env, names });
  assert.deepEqual([where.dir, where.linked, where.active], [external, true, true]);
  // Tasks land in the linked directory.
  const task = await cli(['task', 'new', 'Linked task', '--yes'], { cwd: r.dir, env: r.env });
  assert.equal(task.code, 0, show(task));
  assert.ok(existsSync(join(external, 'tasks', task.out.data.id, 'task.json')));
  assert.equal(status(r.dir, r.env), '');
  // Linked and active: another directory is refused; the same one is idempotent.
  const other = await cli(['init', '--yes', '--state-dir', join(r.base, 'elsewhere')], { cwd: r.dir, env: r.env });
  assert.deepEqual([other.code, other.out.errors[0].code], [1, 'already-active'], show(other));
  assert.ok(!existsSync(join(r.base, 'elsewhere')));
  assert.deepEqual(projects(r), { [realpathSync(r.dir)]: { stateDir: external } });
  const same = await cli(['init', '--yes', '--state-dir', external], { cwd: r.dir, env: r.env });
  assert.deepEqual([same.code, same.out.data.activated], [0, false], show(same));
  // A file is not a directory.
  const plain = repo(t);
  writeFileSync(join(plain.base, 'file'), 'x');
  const notDir = await cli(['init', '--yes', '--state-dir', join(plain.base, 'file')], { cwd: plain.dir, env: plain.env });
  assert.deepEqual([notDir.code, notDir.out.errors[0].code], [2, 'invalid-value'], show(notDir));
  assert.deepEqual(projects(plain), {});
});

test('init into the repository while it is active in a linked directory (and the reverse) is refused', async (t) => {
  const r = repo(t);
  assert.equal((await cli(['init', '--yes'], { cwd: r.dir, env: r.env })).code, 0);
  const linked = await cli(['init', '--yes', '--state-dir', join(r.base, 'ext')], { cwd: r.dir, env: r.env });
  assert.deepEqual([linked.code, linked.out.errors[0].code], [1, 'already-active'], show(linked));
  assert.deepEqual(projects(r), {}, 'no link recorded');
  assert.ok(!existsSync(join(r.base, 'ext')));
});

// ---- decline: opt-out persists ----

test('opt-out persists: decline is keyed by the real path, survives new processes and keeps every class vanilla', async (t) => {
  const r = repo(t);
  const before = { repo: snapshot(r.dir), home: snapshot(r.home) };
  const res = await cli(['decline', '--yes'], { cwd: join(r.dir, 'src'), env: r.env });
  assert.equal(res.code, 0, show(res));
  assert.equal(res.out.data.repo, r.dir);
  const entry = projects(r)[realpathSync(r.dir)];
  assert.match(entry.declinedAt, ISO_TIME);
  assert.deepEqual(Object.keys(entry), ['declinedAt'], 'plugin data only');
  assert.deepEqual(snapshot(r.dir), before.repo, 'nothing in the repository');
  const home = snapshot(r.home);
  for (const p of Object.keys(home)) if (!(p in before.home)) assert.ok(join(r.home, p).startsWith(r.dataDir) || r.dataDir.startsWith(join(r.home, p)), `only machine data: ${p}`);
  // A new process, through a symbolic link to a subdirectory, sees the same opt-out.
  const alias = join(r.base, 'alias');
  symlinkSync(join(r.dir, 'src'), alias);
  const again = launch(r.env, alias, ['decline', '--yes', '--json']);
  assert.equal(again.status, 0, again.stderr);
  const env = JSON.parse(again.stdout);
  assert.deepEqual([env.data.repo, env.data.declinedAt, env.data.changed], [r.dir, entry.declinedAt, false], 'already declined: the first time is kept');
  const probe = launch(r.env, alias, ['task', 'new', 'Refactor the cart', '--yes', '--json']);
  assert.equal(probe.status, 7, probe.stdout);
  const where = state.resolve({ cwd: alias, env: r.env, names });
  assert.equal(where.declined, true);
  for (const cls of ['trivial', 'standard', 'critical']) assert.equal(state.activationStep(where, cls), 'vanilla');
  assert.deepEqual(snapshot(r.dir), before.repo);
  assert.equal(status(r.dir, r.env), '');
});

test('decline in an active repository is refused with a hint to deactivate; nothing changes', async (t) => {
  const r = repo(t);
  assert.equal((await cli(['init', '--yes'], { cwd: r.dir, env: r.env })).code, 0);
  const files = snapshot(r.store);
  const res = await cli(['decline', '--yes'], { cwd: r.dir, env: r.env });
  assert.deepEqual([res.code, res.out.errors[0].code], [1, 'active'], show(res));
  assert.match(res.out.errors[0].hint, new RegExp(`${names.bin} deactivate`));
  assert.deepEqual(snapshot(r.store), files);
  assert.deepEqual(projects(r), {});
});

// ---- deactivate ----

test('deactivate removes untracked state, records the opt-out, and a later init starts again', async (t) => {
  const r = repo(t);
  assert.equal((await cli(['init', '--yes'], { cwd: r.dir, env: r.env })).code, 0);
  assert.equal((await cli(['task', 'new', 'Some work', '--yes'], { cwd: r.dir, env: r.env })).code, 0);
  mkdirSync(join(r.store, 'local', 'runs'), { recursive: true });
  writeFileSync(join(r.store, 'local', 'runs', 'r1.log'), 'log\n');
  const refused = await cli(['deactivate'], { cwd: r.dir, env: r.env });
  assert.equal(refused.code, 7, 'consent');
  assert.ok(existsSync(join(r.store, 'state.json')));
  const res = await cli(['deactivate', '--yes'], { cwd: join(r.dir, 'src'), env: r.env });
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.out.data.removed, res.out.data.dir], [true, r.store]);
  assert.ok(!existsSync(r.store), 'state directory gone');
  assert.equal(status(r.dir, r.env), '', 'git status clean');
  assert.match(projects(r)[r.dir].declinedAt, ISO_TIME, 'the opt-out is remembered');
  assert.equal(state.activationStep(state.resolve({ cwd: r.dir, env: r.env, names }), 'critical'), 'vanilla');
  // Nothing left to remove: still OK, nothing changes.
  const again = await cli(['deactivate', '--yes'], { cwd: r.dir, env: r.env });
  assert.deepEqual([again.code, again.out.data.removed], [0, false], show(again));
  const restart = await cli(['init', '--yes'], { cwd: r.dir, env: r.env });
  assert.deepEqual([restart.code, restart.out.data.activated], [0, true], show(restart));
  assert.equal(projects(r)[r.dir], undefined);
});

test('deactivate with tracked state removes nothing and prints the git rm command; after git rm it completes', async (t) => {
  const r = repo(t);
  assert.equal((await cli(['init', '--yes'], { cwd: r.dir, env: r.env })).code, 0);
  git(r.dir, r.env, ['add', names.stateDir]);
  git(r.dir, r.env, ['commit', '-qm', 'track state']);
  mkdirSync(join(r.store, 'local'), { recursive: true });
  writeFileSync(join(r.store, 'local', 'note.json'), '{}\n');
  const files = snapshot(r.store);
  const res = await cli(['deactivate', '--yes'], { cwd: r.dir, env: r.env });
  assert.deepEqual([res.code, res.out.errors[0].code], [1, 'state-tracked'], show(res));
  assert.ok(res.out.errors[0].hint.includes(`git rm -r ${names.stateDir}`), res.out.errors[0].hint);
  assert.deepEqual(snapshot(r.store), files, 'nothing removed');
  assert.deepEqual(projects(r), {}, 'a refusal records nothing');
  const human = await cli(['deactivate', '--yes'], { cwd: r.dir, env: r.env, json: false });
  assert.equal(human.code, 1);
  assert.ok(human.stderr.includes(`git rm -r ${names.stateDir}`), human.stderr);
  git(r.dir, r.env, ['rm', '-r', '-q', names.stateDir]);
  const done = await cli(['deactivate', '--yes'], { cwd: r.dir, env: r.env });
  assert.deepEqual([done.code, done.out.data.removed], [0, true], show(done));
  assert.ok(!existsSync(r.store));
});

test('deactivate of a linked state directory removes the link, keeps its files and records the opt-out', async (t) => {
  const r = repo(t);
  const external = join(r.base, 'ext');
  assert.equal((await cli(['init', '--yes', '--state-dir', external], { cwd: r.dir, env: r.env })).code, 0);
  const files = snapshot(external);
  const res = await cli(['deactivate', '--yes'], { cwd: r.dir, env: r.env });
  assert.equal(res.code, 0, show(res));
  assert.deepEqual([res.out.data.removed, res.out.data.unlinked, res.out.data.dir], [false, true, external]);
  assert.deepEqual(snapshot(external), files, 'external files kept');
  assert.deepEqual(Object.keys(projects(r)[r.dir]), ['declinedAt'], 'link removed, opt-out recorded');
  const where = state.resolve({ cwd: r.dir, env: r.env, names });
  assert.deepEqual([where.linked, where.active, where.declined], [false, false, true]);
});

test('deactivate in an unknown repository records the opt-out and removes nothing', async (t) => {
  const r = repo(t);
  const before = snapshot(r.dir);
  const res = await cli(['deactivate', '--yes'], { cwd: r.dir, env: r.env });
  assert.deepEqual([res.code, res.out.data.removed], [0, false], show(res));
  assert.deepEqual(snapshot(r.dir), before);
  assert.ok(projects(r)[r.dir].declinedAt);
});

// ---- StateError → envelope, once in lib/cli/main.mjs ----

test('a StateError thrown by a command becomes its envelope in lib/cli/main.mjs; INTERNAL ones and unlisted exits stay bugs', async () => {
  const row = (name, err, exits) => ({ name, summary: 'Throws a typed error.', args: [], flags: [], exits, load: async () => () => { throw err; } });
  const commands = [
    ...COMMANDS,
    row('typed-refused', new state.StateError('stale-lock', 'REFUSED', 'lock x was left by a process that is gone', { hint: 'run the unlock command' }), ['OK', 'REFUSED']),
    row('typed-internal', new state.StateError('lock-reentry', 'INTERNAL', 'nested lock'), ['OK']),
    row('typed-unlisted', new state.StateError('locked', 'ENV', 'busy'), ['OK']),
    row('plain-error', Object.assign(new Error('looks typed'), { code: 'stale-lock', exit: 'REFUSED' }), ['OK', 'REFUSED']),
  ];
  const run = async (args) => {
    const io = { stdout: '', stderr: '', stdinIsTTY: false, env: process.env, cwd: process.cwd(), stdin: null };
    io.out = (s) => { io.stdout += s; };
    io.err = (s) => { io.stderr += s; };
    return { code: await main(args, { commands, io }), io };
  };
  const json = await run(['typed-refused', '--json']);
  assert.equal(json.code, 7);
  const e = JSON.parse(json.io.stdout);
  assert.deepEqual([e.ok, e.exit, e.errors], [false, 'REFUSED', [{ code: 'stale-lock', message: 'lock x was left by a process that is gone', hint: 'run the unlock command' }]]);
  const human = await run(['typed-refused']);
  assert.equal(human.code, 7);
  assert.match(human.io.stderr, /lock x was left[\s\S]*hint: run the unlock command/);
  for (const name of ['typed-internal', 'typed-unlisted', 'plain-error']) {
    const r = await run([name, '--json']);
    assert.equal(r.code, 70, `${name}: ${r.io.stdout}`);
    assert.equal(JSON.parse(r.io.stdout).errors[0].code, 'internal');
  }
});
