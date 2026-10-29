// Decision records (spec §7.10, §5.1, SD-9, SD-21, SD-22, SC17, GC5): one Markdown file per decision under the
// state directory, IDs D-<H>-<n> from lib/state (per handle, above origin/main and tombstones, never reused),
// supersede and retire (tombstone, file kept), `decisions check` over the citations in tracked files (local and
// through the npx channel), `show` and `find`, and the edit hook that injects the decisions cited in or scoped
// to the touched file within 1,200 characters, once per file and session.
// This file holds no plugin name, path or literal decision ID: names come from lib/name.json and IDs are built by
// D(), so a scan of tracked files for citations never finds one here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IDENTITY, isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';
import { assertFast, measured } from './helpers/cpu-time.mjs';

// Every child of this file (git, npm, npx, the launcher) and the code under test get a throwaway HOME (S1).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pluginRel = (() => {
  const hits = readdirSync(join(root, 'plugins')).filter((d) => existsSync(join(root, 'plugins', d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return `plugins/${hits[0]}`;
})();
const pluginDir = join(root, pluginRel);
const names = readJson(join(pluginDir, 'lib', 'name.json'));
const VERSION = readJson(join(pluginDir, '.claude-plugin', 'plugin.json')).version;
const LAUNCHER = join(pluginDir, 'bin', names.bin);
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const { main } = await lib('cli/main.mjs');
const { EXIT } = await lib('cli/commands.mjs');
const AT = '2026-10-15T05:42:00.000Z';
const D = (n, h = 'AB') => ['D', h, n].join('-');
const BUDGET = 1200;

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, ...opts });
const out = (r) => `exit ${r.status ?? r.code}${r.error ? ` (${r.error.message})` : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
function git(cwd, args, env) {
  const r = run('git', args, { cwd, env });
  assert.equal(r.status, 0, `git ${args.join(' ')}\n${out(r)}`);
  return r.stdout;
}

// A git repository with an active state directory and the handle AB registered for the repository's git email.
function fixture(t, { active = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'decisions-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: join(base, 'data') };
  delete env.CI;
  git(repo, ['-c', 'init.defaultBranch=main', 'init', '-q'], env);
  git(repo, ['config', 'user.name', IDENTITY.name], env);
  git(repo, ['config', 'user.email', IDENTITY.email], env);
  writeFileSync(join(repo, '.gitignore'), `${names.stateDir}/local/\n`);
  const dir = join(repo, names.stateDir);
  if (active) {
    const store = state.open(dir, { names });
    store.write('state', null, { codename: names.codename, createdWith: VERSION, activatedAt: AT });
    state.registerHandle(store, { name: IDENTITY.name, email: IDENTITY.email, handle: 'AB' });
  }
  const cli = async (args, { tty = false, extraEnv = {} } = {}) => {
    const io = { stdout: '', stderr: '', stdinIsTTY: tty, env: { ...env, ...extraEnv }, cwd: repo, stdin: null };
    io.out = (s) => { io.stdout += s; };
    io.err = (s) => { io.stderr += s; };
    const code = await main(args, { io });
    return { code, stdout: io.stdout, stderr: io.stderr, json: args.includes('--json') ? JSON.parse(io.stdout) : null };
  };
  const write = (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  const add = () => git(repo, ['add', '-A'], env);
  const recordFile = (id) => join(dir, 'decisions', `${id}.md`);
  const record = (id) => readFileSync(recordFile(id), 'utf8');
  const decide = async (title, more = []) => {
    const r = await cli(['decide', '--title', title, '--why', `Because ${title}. More detail.`, '--cost', 'low, easy to change', ...more, '--yes', '--json']);
    assert.equal(r.code, 0, out(r));
    return r.json.data.id;
  };
  return { base, repo, dir, env, cli, write, add, recordFile, record, decide };
}

// A record written by hand (frontmatter fields override the defaults; null drops a line).
function recordText(id, fields = {}, body = '## Why\n\nA reason. Second sentence.\n\n## Cost if wrong\n\nlow, revert it\n') {
  const f = { schema: '1', id, title: `Title of ${id}`, status: 'active', kind: 'general', date: '2026-10-15', author: 'AB', supersedes: '[]', supersededBy: 'null', scope: '[]', allowsTestRemoval: '[]', ...fields };
  return `---\n${Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`;
}

const errorCodes = (r) => r.json.errors.map((e) => e.code);

// ---- decide ----

test('decide writes one record file under the state directory: frontmatter of §5.1 and the What / Why / Cost if wrong / Alternatives body', async (t) => {
  const f = fixture(t);
  const r = await f.cli(['decide', '--title', 'Use SQLite for local state', '--why', 'One file and no server. Easy backups.', '--cost', 'medium, a migration to a server database later', '--scope', 'src/db/**,lib/*.sql', '--yes', '--json']);
  assert.equal(r.code, 0, out(r));
  const { warnings, ...data } = r.json.data;
  assert.deepEqual(data, { id: D(1), file: `${names.stateDir}/decisions/${D(1)}.md`, supersedes: [] });
  assert.deepEqual(warnings.map((w) => w.code), ['remote-unchecked'], 'no origin/main: said so (review r1 minor 3)');
  const text = f.record(D(1));
  const date = /\ndate: (\d{4}-\d{2}-\d{2})\n/.exec(text)?.[1];
  assert.ok(date && !Number.isNaN(Date.parse(date)), `date line in\n${text}`);
  assert.equal(text, [
    '---', 'schema: 1', `id: ${D(1)}`, 'title: Use SQLite for local state', 'status: active', 'kind: general', `date: ${date}`, 'author: AB',
    'supersedes: []', 'supersededBy: null', 'scope: [src/db/**, lib/*.sql]', 'allowsTestRemoval: []', '---', '',
    '## What', '', 'Use SQLite for local state', '', '## Why', '', 'One file and no server. Easy backups.', '',
    '## Cost if wrong', '', 'medium, a migration to a server database later', '', '## Alternatives', '', 'None recorded.', '',
  ].join('\n'));
  const second = await f.cli(['decide', '--title', 'Second', '--why', 'w', '--cost', 'c', '--kind', 'gate-change', '--yes']);
  assert.equal(second.code, 0, out(second));
  assert.equal(second.stdout, `${D(2)} created: ${names.stateDir}/decisions/${D(2)}.md\n`);
  assert.match(second.stderr, /^warning: no origin\/main: /m, 'the warning goes to stderr in text mode');
  assert.match(f.record(D(2)), /\nkind: gate-change\n/);
});

test('decide refuses without consent, in an inactive repository, without a registered handle and on invalid values; it writes nothing', async (t) => {
  const f = fixture(t);
  const ok = ['--title', 'T', '--why', 'w', '--cost', 'c'];
  const consent = await f.cli(['decide', ...ok, '--json']);
  assert.equal(consent.code, EXIT.REFUSED, out(consent));
  const bad = [
    [['--why', 'w', '--cost', 'c'], 'missing-flag'],
    [['--title', 'T', '--cost', 'c'], 'missing-flag'],
    [['--title', 'T', '--why', 'w'], 'missing-flag'],
    [['--title', 'x'.repeat(121), '--why', 'w', '--cost', 'c'], 'limit-exceeded'],
    [[...ok, '--kind', 'nope'], 'invalid-value'],
    [[...ok, '--scope', Array.from({ length: 21 }, (_, i) => `d${i}/**`).join(',')], 'limit-exceeded'],
    [[...ok, '--scope', `${'a'.repeat(121)}/**`], 'limit-exceeded'],
    [[...ok, '--supersedes', D(9)], 'unknown-decision'],
    [[...ok, '--supersedes', 'not-an-id'], 'invalid-value'],
  ];
  for (const [args, code] of bad) {
    const r = await f.cli(['decide', ...args, '--yes', '--json']);
    assert.equal(r.code, EXIT.USAGE, `${args.join(' ')}\n${out(r)}`);
    assert.ok(errorCodes(r).includes(code), `${args.join(' ')}: ${code} in ${JSON.stringify(r.json.errors)}`);
  }
  git(f.repo, ['config', 'user.email', 'someone-else@example.com'], f.env);
  const stranger = await f.cli(['decide', ...ok, '--yes', '--json']);
  assert.equal(stranger.code, EXIT.USAGE, out(stranger));
  assert.ok(errorCodes(stranger).includes('handle-unknown'), JSON.stringify(stranger.json.errors));
  assert.equal(existsSync(join(f.dir, 'decisions')), false, 'no record was written');

  const inactive = fixture(t, { active: false });
  const r = await inactive.cli(['decide', ...ok, '--yes', '--json']);
  assert.equal(r.code, EXIT.REFUSED, out(r));
  assert.ok(errorCodes(r).includes('inactive'), JSON.stringify(r.json.errors));
  assert.equal(existsSync(inactive.dir), false, 'nothing written in an inactive repository');
});

test('the next number is above the highest of the local files, origin/main and the tombstones (SD-9, GC5)', async (t) => {
  const f = fixture(t);
  const remote = join(f.base, 'remote.git');
  git(f.base, ['-c', 'init.defaultBranch=main', 'init', '-q', '--bare', remote], f.env);
  git(f.repo, ['remote', 'add', 'origin', remote], f.env);
  f.add();
  git(f.repo, ['commit', '-qm', 'base'], f.env);
  mkdirSync(join(f.dir, 'decisions'), { recursive: true });
  writeFileSync(f.recordFile(D(5)), recordText(D(5)));
  f.add();
  git(f.repo, ['commit', '-qm', 'decision from another machine'], f.env);
  git(f.repo, ['push', '-q', 'origin', 'main'], f.env);
  git(f.repo, ['reset', '-q', '--hard', 'HEAD~1'], f.env);
  assert.equal(existsSync(f.recordFile(D(5))), false, 'the local checkout is behind origin/main');
  const after = await f.cli(['decide', '--title', 'After the remote one', '--why', 'w', '--cost', 'c', '--yes', '--json']);
  assert.equal(after.code, 0, out(after));
  assert.deepEqual([after.json.data.id, after.json.data.warnings], [D(6), []]);
  const retire = await f.cli(['decisions', 'retire', D(6), '--yes', '--json']);
  assert.equal(retire.code, 0, out(retire));
  rmSync(f.recordFile(D(6)));
  assert.equal(await f.decide('After the tombstone'), D(7), 'a retired number is never reused');
});

// ---- supersede and retire ----

test('supersede: the new record lists the old one; the old one gets status superseded and supersededBy, nothing else changes', async (t) => {
  const f = fixture(t);
  await f.decide('First');
  const before = f.record(D(1));
  const r = await f.cli(['decisions', 'supersede', D(1), '--title', 'Second', '--why', 'w', '--cost', 'c', '--yes', '--json']);
  assert.equal(r.code, 0, out(r));
  assert.deepEqual({ ...r.json.data, warnings: undefined }, { id: D(2), file: `${names.stateDir}/decisions/${D(2)}.md`, supersedes: [D(1)], warnings: undefined });
  assert.match(f.record(D(2)), new RegExp(`\\nsupersedes: \\[${D(2 - 1)}\\]\\n`));
  assert.equal(f.record(D(1)), before.replace('\nstatus: active\n', '\nstatus: superseded\n').replace('\nsupersededBy: null\n', `\nsupersededBy: ${D(2)}\n`));

  const again = await f.cli(['decide', '--title', 'Third', '--why', 'w', '--cost', 'c', '--supersedes', D(1), '--yes', '--json']);
  assert.equal(again.code, EXIT.USAGE, out(again));
  assert.ok(errorCodes(again).includes('not-active'), JSON.stringify(again.json.errors));
  assert.match(again.json.errors[0].hint, new RegExp(D(2)), 'the hint names the successor');

  const viaDecide = await f.cli(['decide', '--title', 'Third', '--why', 'w', '--cost', 'c', '--supersedes', D(2), '--yes', '--json']);
  assert.equal(viaDecide.code, 0, out(viaDecide));
  assert.match(f.record(D(2)), new RegExp(`\\nstatus: superseded\\nkind: general\\n[\\s\\S]*\\nsupersededBy: ${D(3)}\\n`));
});

test('retire keeps the file with status retired and writes a tombstone; retiring again changes nothing; unknown IDs are usage errors', async (t) => {
  const f = fixture(t);
  await f.decide('To retire');
  const r = await f.cli(['decisions', 'retire', D(1), '--reason', 'the vendor API replaced it', '--yes', '--json']);
  assert.equal(r.code, 0, out(r));
  assert.match(f.record(D(1)), /\nstatus: retired\n/);
  const tomb = readJson(join(f.dir, 'tombstones', `${D(1)}.json`));
  assert.deepEqual([tomb.id, tomb.by, tomb.reason], [D(1), 'AB', 'the vendor API replaced it']);
  const files = [f.record(D(1)), readFileSync(join(f.dir, 'tombstones', `${D(1)}.json`), 'utf8')];
  const again = await f.cli(['decisions', 'retire', D(1), '--yes', '--json']);
  assert.equal(again.code, 0, out(again));
  assert.deepEqual([f.record(D(1)), readFileSync(join(f.dir, 'tombstones', `${D(1)}.json`), 'utf8')], files);
  for (const id of [D(9), 'X-1']) {
    const u = await f.cli(['decisions', 'retire', id, '--yes', '--json']);
    assert.equal(u.code, EXIT.USAGE, `${id}\n${out(u)}`);
  }
  const consent = await f.cli(['decisions', 'retire', D(1), '--json']);
  assert.equal(consent.code, EXIT.REFUSED, out(consent));
});

// ---- check (SC17) ----

test('check (SC17): exit 1 on a cited unknown, retired or superseded ID; superseded is strict with --ci or CI and a warning locally', async (t) => {
  const f = fixture(t);
  await f.decide('Active one');
  await f.decide('Retired one');
  assert.equal((await f.cli(['decisions', 'retire', D(2), '--yes'])).code, 0);
  await f.decide('Superseded one');
  assert.equal((await f.cli(['decisions', 'supersede', D(3), '--title', 'Successor', '--why', 'w', '--cost', 'c', '--yes'])).code, 0);
  f.write('src/a.js', `// ${D(1)}: keep it\nconst a = 1; // ${D(4)}\n`);
  f.add();
  const clean = await f.cli(['decisions', 'check', '--json']);
  assert.equal(clean.code, 0, out(clean));
  assert.deepEqual([clean.json.data.records, clean.json.data.citations], [4, 2]);

  const cases = [[D(9), 'unknown-decision'], [D(2), 'retired-decision'], [D(0), 'unknown-decision']];
  for (const [id, code] of cases) {
    f.write('src/b.js', `export {};\n// see ${id} for this\n`);
    f.add();
    const r = await f.cli(['decisions', 'check', '--json']);
    assert.equal(r.code, EXIT.FAIL, `${id}\n${out(r)}`);
    assert.deepEqual(errorCodes(r), [code], id);
    assert.match(r.json.errors[0].message, new RegExp(`^src/b\\.js:2: `), 'file and line');
  }

  f.write('src/b.js', `// ${D(3)}\n`);
  f.add();
  const local = await f.cli(['decisions', 'check']);
  assert.equal(local.code, 0, out(local));
  assert.match(local.stdout, new RegExp(`^warning: src/b\\.js:1: cites ${D(3)}, superseded by ${D(4)}$`, 'm'));
  for (const [args, extraEnv] of [[['--ci'], {}], [[], { CI: 'true' }]]) {
    const r = await f.cli(['decisions', 'check', ...args, '--json'], { extraEnv });
    assert.equal(r.code, EXIT.FAIL, `${args} ${JSON.stringify(extraEnv)}\n${out(r)}`);
    assert.deepEqual(errorCodes(r), ['superseded-decision']);
  }

  // Not scanned: untracked files and the state directory's own files (records, task history).
  f.write('src/b.js', 'export {};\n');
  f.write('notes/draft.md', `${D(9)}\n`);
  f.write(`${names.stateDir}/tasks/T-AB-1/brief.md`, `Cites ${D(2)} and ${D(9)}.\n`);
  git(f.repo, ['add', 'src', `${names.stateDir}/tasks`], f.env);
  const ignored = await f.cli(['decisions', 'check', '--ci', '--json']);
  assert.equal(ignored.code, 0, out(ignored));

  const inactive = fixture(t, { active: false });
  inactive.write('README.md', `${D(9)}\n`);
  inactive.add();
  const none = await inactive.cli(['decisions', 'check', '--json']);
  assert.equal(none.code, 0, out(none));
  assert.equal(none.json.data.active, false);
});

test('check: duplicate IDs, frontmatter schema errors and supersedes cycles exit 1; the checker reports each', async (t) => {
  const f = fixture(t);
  const dir = join(f.dir, 'decisions');
  mkdirSync(dir, { recursive: true });
  const put = (id, text) => writeFileSync(join(dir, `${id}.md`), text);
  const check = async () => f.cli(['decisions', 'check', '--json']);
  put(D(1), recordText(D(1)));
  assert.equal((await check()).code, 0);

  const schemaErrors = [
    recordText(D(2), { status: 'maybe' }),
    recordText(D(2), { title: null }),
    recordText(D(2), { schema: '2' }),
    recordText(D(2), { color: 'blue' }),
    recordText(D(2), { scope: `[${Array.from({ length: 21 }, (_, i) => `d${i}/**`).join(', ')}]` }),
    recordText(D(2), { supersededBy: D(1) }),
    recordText(D(2), { status: 'superseded' }),
    recordText(D(2), { supersedes: `[${D(8)}]` }),
    recordText(D(2), { date: 'yesterday' }),
    'no frontmatter at all\n',
  ];
  for (const text of schemaErrors) {
    put(D(2), text);
    const r = await check();
    assert.equal(r.code, EXIT.FAIL, `${text}\n${out(r)}`);
    assert.ok(errorCodes(r).includes('invalid-decision'), `${text}\n${JSON.stringify(r.json.errors)}`);
  }
  rmSync(join(dir, `${D(2)}.md`));

  put(D(3), recordText(D(4)));
  put(D(4), recordText(D(4)));
  const dup = await check();
  assert.equal(dup.code, EXIT.FAIL, out(dup));
  assert.ok(errorCodes(dup).includes('duplicate-decision'), JSON.stringify(dup.json.errors));
  rmSync(join(dir, `${D(3)}.md`));
  rmSync(join(dir, `${D(4)}.md`));

  put(D(5), recordText(D(5), { status: 'superseded', supersedes: `[${D(6)}]`, supersededBy: D(6) }));
  put(D(6), recordText(D(6), { status: 'superseded', supersedes: `[${D(5)}]`, supersededBy: D(5) }));
  const cycle = await check();
  assert.equal(cycle.code, EXIT.FAIL, out(cycle));
  assert.ok(errorCodes(cycle).includes('supersedes-cycle'), JSON.stringify(cycle.json.errors));
});

// ---- show and find ----

test('show prints a record; find lists records by words and by path; unknown or malformed IDs are usage errors', async (t) => {
  const f = fixture(t);
  await f.decide('Use SQLite for local state', ['--scope', 'src/db/**']);
  await f.decide('Log in JSON lines', ['--scope', 'src/**']);
  const show = await f.cli(['decisions', 'show', D(1)]);
  assert.equal(show.code, 0, out(show));
  assert.equal(show.stdout, f.record(D(1)));
  const json = await f.cli(['decisions', 'show', D(1), '--json']);
  assert.deepEqual([json.json.data.id, json.json.data.status, json.json.data.title], [D(1), 'active', 'Use SQLite for local state']);
  for (const id of [D(9), 'nope']) assert.equal((await f.cli(['decisions', 'show', id])).code, EXIT.USAGE, id);

  const words = await f.cli(['decisions', 'find', 'sqlite', '--json']);
  assert.equal(words.code, 0, out(words));
  assert.deepEqual(words.json.data.decisions.map((d) => d.id), [D(1)]);
  const all = await f.cli(['decisions', 'find', '--json']);
  assert.deepEqual(all.json.data.decisions.map((d) => d.id), [D(1), D(2)]);
  f.write('src/db/x.sql', 'select 1;\n');
  const byPath = await f.cli(['decisions', 'find', '--path', 'src/db/x.sql']);
  assert.equal(byPath.code, 0, out(byPath));
  assert.deepEqual(byPath.stdout.trim().split('\n').map((l) => l.split(' ')[0]), [D(1), D(2)], 'most specific scope first');
  assert.equal(byPath.stdout.split('\n')[0], `${D(1)} (active): Use SQLite for local state — why: Because Use SQLite for local state. — cost if wrong: low`);
});

// ---- edit hook (SC17, SD-22) ----

function hook(f, input, extraEnv = {}) {
  // GC8 on a loaded machine (S3): the limit applies to the hook's CPU time, wall time is only a ceiling.
  const r = measured((p) => run(process.execPath, [...p.nodeArgs, LAUNCHER, 'hook', 'decisions-context'], { cwd: f.repo, env: { ...f.env, ...extraEnv, ...p.env }, input: JSON.stringify(input) }));
  assert.equal(r.status, 0, out(r));
  assertFast(assert, r, 'hook');
  if (r.stdout === '') return null;
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  return parsed.hookSpecificOutput.additionalContext;
}
const edit = (f, rel, session = 's1', tool = 'Edit') => ({ session_id: session, cwd: f.repo, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: join(f.repo, rel) } });

test('edit hook (SC17): injects the decisions cited in the touched file and the active ones scoped to it: cited first, then the most specific scope', async (t) => {
  const f = fixture(t);
  await f.decide('Keep the schema in one file');
  await f.decide('Everything is UTF-8', ['--scope', '**']);
  await f.decide('Sources stay small', ['--scope', 'src/**']);
  await f.decide('Plain SQL, no ORM', ['--scope', 'src/db/*.sql']);
  await f.decide('Docs in English', ['--scope', 'docs/**']);
  await f.decide('Old rule for sources', ['--scope', 'src/**']);
  assert.equal((await f.cli(['decisions', 'retire', D(6), '--yes'])).code, 0);
  f.write('src/db/a.sql', `-- ${D(1)}: one schema file\nselect 1;\n`);
  const context = hook(f, edit(f, 'src/db/a.sql'));
  assert.ok(context !== null, 'context injected');
  const lines = context.split('\n');
  assert.deepEqual(lines.map((l) => l.split(' ')[0]), [D(1), D(4), D(3), D(2)]);
  assert.equal(lines[0], `${D(1)} (active): Keep the schema in one file — why: Because Keep the schema in one file. — cost if wrong: low`);
  assert.ok(context.length <= BUDGET);
  // A new file (Write) has no citations yet: only the scoped decisions.
  const created = hook(f, edit(f, 'src/db/new.sql', 's2', 'Write'));
  assert.deepEqual(created.split('\n').map((l) => l.split(' ')[0]), [D(4), D(3), D(2)]);
});

test('edit hook (SC17): the injection stays within 1,200 characters in whole lines and names what it left out', async (t) => {
  const f = fixture(t);
  const long = (n) => `${'Long title '.repeat(10)}${n}`.slice(0, 120);
  for (let n = 1; n <= 15; n++) {
    const r = await f.cli(['decide', '--title', long(n), '--why', `${'A very long reason that keeps going '.repeat(8)}.`, '--cost', `${'expensive '.repeat(30)}`, '--scope', 'src/**', '--yes']);
    assert.equal(r.code, 0, out(r));
  }
  f.write('src/x.js', `// ${D(15)} ${D(14)}\n`);
  const context = hook(f, edit(f, 'src/x.js'));
  assert.ok(context.length <= BUDGET, `${context.length} chars`);
  const lines = context.split('\n');
  assert.ok(lines.length >= 3, `several decisions fit: ${lines.length}`);
  assert.deepEqual(lines.slice(0, 2).map((l) => l.split(' ')[0]), [D(15), D(14)], 'cited first');
  for (const line of lines.slice(0, -1)) assert.match(line, /^D-AB-\d+ \(active\): /);
  assert.match(lines.at(-1), new RegExp(`^\\+\\d+ more: ${names.bin} decisions find --path src/x\\.js$`));
});

test('edit hook: once per file and session; no output in an inactive repository, outside the repository, without decisions or for a file over 256 KB', async (t) => {
  const f = fixture(t);
  f.write('src/a.js', `// ${D(1)}\n`);
  f.write('src/b.js', `// ${D(1)}\n`);
  assert.equal(hook(f, edit(f, 'src/a.js')), null, 'no decisions yet');
  await f.decide('Cited');
  assert.match(hook(f, edit(f, 'src/a.js')), new RegExp(`^${D(1)} `));
  assert.equal(hook(f, edit(f, 'src/a.js')), null, 'already injected for this file in this session');
  assert.match(hook(f, edit(f, 'src/b.js')), new RegExp(`^${D(1)} `), 'another file');
  assert.match(hook(f, edit(f, 'src/a.js', 's2')), new RegExp(`^${D(1)} `), 'another session');
  f.write('src/big.js', `// ${D(1)}\n${'x'.repeat(256 * 1024)}\n`);
  assert.equal(hook(f, edit(f, 'src/big.js', 's3')), null, 'a file over 256 KB is not read');
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'decisions-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'x.js'), `// ${D(1)}\n`);
  assert.equal(hook(f, { ...edit(f, 'src/a.js', 's4'), tool_input: { file_path: join(outside, 'x.js') } }), null, 'outside the repository');
  assert.equal(hook(f, { ...edit(f, 'src/a.js', 's5'), tool_input: { file_path: 'src/a.js' } }) !== null, true, 'a relative path resolves against cwd');
  const { cwd: _, ...noCwd } = edit(f, 'src/a.js', 's6');
  assert.equal(hook(f, { ...noCwd, tool_input: { file_path: 'src/a.js' } }), null, 'a relative path without cwd in the input is not guessed from the process');

  const inactive = fixture(t, { active: false });
  inactive.write('src/a.js', `// ${D(1)}\n`);
  assert.equal(hook(inactive, edit(inactive, 'src/a.js')), null);
  assert.equal(existsSync(inactive.dir), false, 'zero footprint in an inactive repository');
});

test('edit hook: the scope index under local/ is rebuilt when a decision file changes', async (t) => {
  const f = fixture(t);
  await f.decide('Old title', ['--scope', 'src/**']);
  f.write('src/a.js', 'export {};\n');
  assert.match(hook(f, edit(f, 'src/a.js', 's1')), /Old title/);
  const index = join(f.dir, 'local', 'decisions-index.json');
  assert.ok(existsSync(index), 'index written');
  writeFileSync(f.recordFile(D(1)), f.record(D(1)).replace('title: Old title', 'title: New title'));
  const later = new Date(Date.now() + 5000);
  utimesSync(f.recordFile(D(1)), later, later);
  assert.match(hook(f, edit(f, 'src/a.js', 's2')), /New title/);
  assert.match(readFileSync(index, 'utf8'), /New title/);
});

// ---- review r1: hidden characters, CRLF records, retire order ----

// The code points the review reproduced (tag characters, Arabic letter mark, soft hyphen, Mongolian vowel separator)
// and the ANSI escape: each makes a record invalid with the code point named, never reaches the hook's output, and
// is refused by decide.
const SMUGGLED = [0xe0041, 0xe0042, 0x061c, 0x00ad, 0x180e, 0x1b];
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

test('hidden characters (review r1): a record carrying one fails check with the code point named, in the title or the body', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'decisions'), { recursive: true });
  for (const cp of SMUGGLED) {
    const ch = String.fromCodePoint(cp);
    for (const [where, text] of [['title', recordText(D(1), { title: JSON.stringify(`tagged ${ch} end`) })], ['body', recordText(D(1), {}, `## Why\n\nWhy ${ch} hidden.\n`)]]) {
      writeFileSync(f.recordFile(D(1)), text);
      const r = await f.cli(['decisions', 'check', '--json']);
      assert.equal(r.code, EXIT.FAIL, `${hex(cp)} in the ${where}\n${out(r)}`);
      assert.ok(r.json.errors.some((e) => e.code === 'invalid-decision' && e.message.includes(hex(cp))), `${hex(cp)} named: ${JSON.stringify(r.json.errors)}`);
    }
  }
});

test('hidden characters (review r1): decide refuses them; the hook output never carries them, even from a stale index', async (t) => {
  const f = fixture(t);
  for (const cp of SMUGGLED) {
    for (const flag of ['--title', '--why', '--cost', '--scope']) {
      const args = { '--title': 'T', '--why': 'w', '--cost': 'c', '--scope': 'src/**' };
      args[flag] = `${args[flag]}${String.fromCodePoint(cp)}x`;
      const r = await f.cli(['decide', ...Object.entries(args).flat(), '--yes', '--json']);
      assert.equal(r.code, EXIT.USAGE, `${flag} with ${hex(cp)}\n${out(r)}`);
      assert.match(r.json.errors[0].message, new RegExp(hex(cp).replace('+', '\\+')), 'code point named');
    }
  }
  assert.equal(existsSync(join(f.dir, 'decisions')), false, 'nothing written');

  await f.decide('Clean title', ['--scope', 'src/**']);
  f.write('src/a.js', 'export {};\n');
  assert.match(hook(f, edit(f, 'src/a.js', 's1')), /Clean title/);
  // An index written by an older plugin (or by hand) with the characters the state schema lets through (tag block,
  // U+061C, U+00AD, U+180E): it still reads as valid, and the hook cleans its output anyway.
  const index = join(f.dir, 'local', 'decisions-index.json');
  const doc = JSON.parse(readFileSync(index, 'utf8'));
  doc.decisions[0].title = `Clean title ${SMUGGLED.filter((cp) => cp !== 0x1b).map((cp) => String.fromCodePoint(cp)).join('')} end`;
  doc.decisions[0].why = `Why \u{E0041}\u{E0042} here.`;
  writeFileSync(index, `${JSON.stringify(doc, null, 2)}\n`);
  const context = hook(f, edit(f, 'src/a.js', 's2'));
  assert.match(context, /Clean title {2}end/, 'served from the planted index');
  const leaked = [...context].map((c) => c.codePointAt(0)).filter((cp) => /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u.test(String.fromCodePoint(cp)) && cp !== 0x0a);
  assert.deepEqual(leaked.map(hex), [], 'no hidden code point in additionalContext');
});

test('show and find print no terminal escape or hidden character from a record (review r1)', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'decisions'), { recursive: true });
  writeFileSync(f.recordFile(D(1)), recordText(D(1), {}, '## Why\n\nA reason \u001b]0;pwned\u0007\u001b[2Jhere\u{E0041}.\n'));
  const show = await f.cli(['decisions', 'show', D(1)]);
  assert.equal(show.code, 0, out(show));
  assert.doesNotMatch(show.stdout, /[\u001b\u0007\u{E0041}]/u);
  assert.match(show.stdout, /A reason here\./);
});

test('CRLF records (review r1): retire and supersede work on a record checked out with CRLF line endings', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'decisions'), { recursive: true });
  writeFileSync(f.recordFile(D(1)), recordText(D(1)).replace(/\n/g, '\r\n'));
  writeFileSync(f.recordFile(D(2)), recordText(D(2)).replace(/\n/g, '\r\n'));
  const retire = await f.cli(['decisions', 'retire', D(1), '--yes', '--json']);
  assert.equal(retire.code, 0, out(retire));
  assert.match(f.record(D(1)), /\nstatus: retired\n/);
  assert.ok(existsSync(join(f.dir, 'tombstones', `${D(1)}.json`)));
  const sup = await f.cli(['decisions', 'supersede', D(2), '--title', 'Next', '--why', 'w', '--cost', 'c', '--yes', '--json']);
  assert.equal(sup.code, 0, out(sup));
  assert.match(f.record(D(2)), new RegExp(`\\nstatus: superseded\\n[\\s\\S]*\\nsupersededBy: ${D(3)}\\n`));
  const check = await f.cli(['decisions', 'check', '--json']);
  assert.equal(check.code, 0, out(check));
});

test('retire writes no tombstone when the record cannot be rewritten (review r1)', { skip: process.getuid?.() === 0 }, async (t) => {
  const f = fixture(t);
  await f.decide('Stays');
  const folder = join(f.dir, 'decisions');
  chmodSync(folder, 0o555);
  let r;
  try { r = await f.cli(['decisions', 'retire', D(1), '--yes', '--json']); } finally { chmodSync(folder, 0o755); }
  assert.notEqual(r.code, 0, out(r));
  assert.equal(existsSync(join(f.dir, 'tombstones', `${D(1)}.json`)), false, 'no tombstone without the status change');
  assert.match(f.record(D(1)), /\nstatus: active\n/);
  const check = await f.cli(['decisions', 'check', '--json']);
  assert.equal(check.code, 0, out(check));
});

// ---- record format ----

test('record frontmatter round-trips: quotes, colons, brackets, commas in globs, empty lists and signals', async () => {
  const { formatRecord, parseRecord } = await lib('decisions/index.mjs');
  const doc = {
    schema: 1, id: D(12), title: '[draft] "quoted": a title, with: colons', status: 'superseded', kind: 'tier', date: '2026-10-15', author: 'AB',
    supersedes: [D(3), D(4)], supersededBy: D(13), scope: ['src/{a,b}/**', 'lib/*.mjs', 'docs/a b.md'], allowsTestRemoval: ['suite > case, one'],
    signals: { contributors: 3, modules: 12 }, legacy: 'R7',
  };
  const text = formatRecord(doc, '## Why\n\nBecause.\n');
  const parsed = parseRecord(text, `${D(12)}.md`);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.doc, doc);
  assert.equal(parsed.body, '## Why\n\nBecause.\n');
  for (const title of ['null', '', ' padded ']) {
    const p = parseRecord(formatRecord({ ...doc, title }, ''), `${D(12)}.md`);
    assert.equal(p.doc.title, title, JSON.stringify(title));
  }
});

test('context lines carry no control, zero-width or bidi characters from a record body (security guide 3.7)', async () => {
  const { contextLine, summarize } = await lib('decisions/index.mjs');
  const doc = { id: D(1), title: 'Plain title', status: 'active', scope: [] };
  const body = '## Why\n\nHidden\u202e\u200b\u2066 reason\u0007 here.\tMore.\n\n## Cost if wrong\n\nhigh\u200f\u0000 cost, later\n';
  const line = contextLine(summarize({ doc, body }));
  assert.equal(line, `${D(1)} (active): Plain title — why: Hidden reason here. — cost if wrong: high cost`);
});

// ---- npx channel (SD-21) ----

test('npx channel (SD-21): the packed CLI runs `decisions check` in a repository: exit 1 on a retired citation, 0 when clean', { timeout: 300000 }, async (t) => {
  const f = fixture(t);
  const iso = isolatedEnv();
  t.after(iso.cleanup);
  const env = { ...iso.env, PATH: `${dirname(process.execPath)}${delimiter}${iso.env.PATH}`, npm_config_offline: 'true' };
  delete env.CI;
  if (run('npm', ['--version'], { env }).status !== 0) {
    if (process.env[`${names.envPrefix}REQUIRE_TOOLS`]) assert.fail(`npm not on PATH (${names.envPrefix}REQUIRE_TOOLS)`);
    return t.skip('npm not on PATH');
  }
  await f.decide('Kept');
  await f.decide('Dropped');
  assert.equal((await f.cli(['decisions', 'retire', D(2), '--yes'])).code, 0);
  f.write('src/a.js', `// ${D(1)}\n// ${D(2)}\n`);
  f.add();
  const packed = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', f.base], { cwd: root, env });
  assert.equal(packed.status, 0, out(packed));
  const tarball = join(f.base, JSON.parse(packed.stdout)[0].filename);
  const npx = (args) => run('npx', ['--yes', '--package', tarball, names.bin, ...args], { cwd: f.repo, env });
  const failing = npx(['decisions', 'check', '--ci', '--json']);
  assert.equal(failing.status, EXIT.FAIL, out(failing));
  assert.deepEqual(JSON.parse(failing.stdout).errors.map((e) => e.code), ['retired-decision']);
  f.write('src/a.js', `// ${D(1)}\n`);
  f.add();
  const passing = npx(['decisions', 'check', '--ci']);
  assert.equal(passing.status, 0, out(passing));
});

test('C-1: scope globs match linearly: a backtracking glob on a 63-char path answers fast', async () => {
  const { globMatch, relevantDecisions, scopeProblem } = await import(pathToFileURL(join(pluginDir, 'lib', 'decisions', 'context.mjs')).href);
  const path = `${'a'.repeat(60)}.ts`;
  const started = performance.now();
  assert.equal(globMatch(`${'*a'.repeat(6)}*b`, path), false);
  assert.equal(globMatch('*a*a*a*a*a*a*.ts', path), true);
  assert.ok(performance.now() - started < 50, `took ${Math.round(performance.now() - started)} ms`);
  // The semantics stay: `**` any depth, `*` and `?` inside a segment, `{a,b}` alternatives.
  const cases = [['src/**', 'src/a/b.ts', true], ['src/**', 'src', false], ['**', 'a/b', true], ['**/x.ts', 'x.ts', true], ['**/x.ts', 'a/b/x.ts', true],
    ['src/*.ts', 'src/a/b.ts', false], ['src/?.ts', 'src/a.ts', true], ['src/?.ts', 'src/ab.ts', false], ['a/*/c', 'a/b/c', true], ['a/*/c', 'a//c', true],
    ['*.{ts,js}', 'x.js', true], ['*.{ts,js}', 'x.md', false], ['src/**/x', 'src/x', true], ['src/**/x', 'src/a/b/x', true], ['a**b', 'aXb', true], ['a**b', 'a/b', true], ['A.ts', 'a.ts', false]];
  for (const [g, p, want] of cases) assert.equal(globMatch(g, p), want, `${g} vs ${p}`);
  // A glob over 200 characters or with more than 16 wildcards matches nothing and is reported.
  assert.equal(globMatch('*a'.repeat(17), 'a'.repeat(30)), false);
  assert.equal(globMatch(`${'a'.repeat(201)}`, 'a'.repeat(201)), false);
  assert.match(scopeProblem('*a'.repeat(17)), /wildcard/);
  assert.match(scopeProblem('a'.repeat(201)), /200/);
  assert.equal(scopeProblem('src/**'), null);
  const records = [{ id: 'D-AB-1', status: 'active', scope: ['*a'.repeat(17)] }, { id: 'D-AB-2', status: 'active', scope: ['**'] }];
  assert.deepEqual(relevantDecisions(records, { path: 'aaaa' }).map((r) => r.id), ['D-AB-2']);
});

test('review r1 F3: the wildcard limit counts the tokenizer units: a run of 34 stars is 17 wildcards and is refused', async () => {
  const { globMatch, scopeProblem } = await import(pathToFileURL(join(pluginDir, 'lib', 'decisions', 'context.mjs')).href);
  assert.match(scopeProblem('*'.repeat(34)) ?? '', /wildcard/);
  assert.equal(globMatch('*'.repeat(34), 'src/index.ts'), false);
  assert.match(scopeProblem('*'.repeat(33)) ?? '', /wildcard/, '33 stars are 17 units: 16 pairs and one');
  assert.equal(scopeProblem('*'.repeat(32)), null, '32 stars are 16 units');
});

test('review r1 F1: record validation reports a refused scope glob', async () => {
  const { recordErrors } = await import(pathToFileURL(join(pluginDir, 'lib', 'decisions', 'record.mjs')).href);
  const doc = { schema: 1, id: 'D-AB-1', kind: 'general', author: 'AB', date: '2026-10-01', status: 'active', title: 'T', scope: ['src/**'] };
  assert.deepEqual(recordErrors(doc, 'D-AB-1.md'), []);
  assert.match(recordErrors({ ...doc, scope: ['*a'.repeat(17)] }, 'D-AB-1.md').join('\n'), /more than 16 wildcards/);
});

// T-MG-78: review-close also preserves the remaining findings as typed backlog records.
async function reviewedTask(f) {
  const { openStore, reviewKey } = await lib('verify/kinds.mjs');
  const made = await f.cli(['task', 'new', 'Reviewed task', '--yes', '--json']);
  assert.equal(made.code, 0, out(made));
  const task = made.json.data.id;
  const store = openStore(f.dir, names);
  const findings = ['F1', 'N1'].map((id, i) => ({ id, severity: i ? 'minor' : 'blocking', path: 'src/a.mjs', line: 56, rule: 'COD-2', text: `${id}: preserve the whole finding` }));
  for (const round of [1, 2]) store.write('review', reviewKey(task, round), { verdict: 'needs-fixes', reviewer: { kind: 'external', id: 'reviewer' }, findings });
  const close = (remaining) => f.cli(['decide', '--kind', 'review-close', '--task', task, '--remaining', remaining, '--title', 'Close review at cap', '--why', 'Fix the remaining findings later', '--cost', 'Known issues remain tracked', '--yes', '--json']);
  return { task, store, findings, close };
}

test('review-close files blocking and minor findings from the latest round idempotently', async (t) => {
  const f = fixture(t);
  const r = await reviewedTask(f);
  const first = await r.close('F1,N1');
  assert.equal(first.code, 0, out(first));
  assert.deepEqual(first.json.data.filed, ['B-AB-1', 'B-AB-2']);
  const filed = r.store.list('finding').map((id) => r.store.read('finding', id));
  assert.deepEqual(filed.map((x) => [x.task, x.round, x.finding, x.severity, x.text]), r.findings.map((x) => [r.task, 2, x.id, x.severity, x.text]));
  const again = await r.close('F1,N1');
  assert.equal(again.code, 0, out(again));
  assert.deepEqual(again.json.data.filed, []);
  assert.deepEqual(r.store.list('finding').map((id) => r.store.read('finding', id)), filed);
  const printed = await f.cli(['decide', '--kind', 'review-close', '--task', r.task, '--remaining', 'F1,N1', '--title', 'Close again', '--why', 'Keep tracked', '--cost', 'low', '--yes']);
  assert.match(printed.stdout, /filed:/);
});

test('review-close refuses an unknown latest-review ID or omitted blocking finding before writing anything', async (t) => {
  for (const remaining of ['F1,UNKNOWN', 'N1']) {
    const f = fixture(t);
    const r = await reviewedTask(f);
    const before = r.store.entries('local/ids').map((name) => [name, r.store.readText(`local/ids/${name}`)]);
    const refused = await r.close(remaining);
    assert.equal(refused.code, 2, out(refused));
    assert.deepEqual(r.store.entries('decisions'), []);
    assert.deepEqual(r.store.entries('findings'), []);
    assert.deepEqual(r.store.entries('local/ids').map((name) => [name, r.store.readText(`local/ids/${name}`)]), before);
  }
});
