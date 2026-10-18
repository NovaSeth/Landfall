// `<bin> status` (spec §8.2, §12, §7.2, §7.4, §7.7): the read-only view of a repository, also what `<bin>` prints with
// no command (`--help` keeps the help): activation state with the state directory and whether it is linked, the tier
// from the engine (evaluated, never recorded), open tasks with the next step of the loop's step table (lib/loop),
// the loop record and the leases held for the project. At most 25 lines of text; --json carries the same data.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const loop = await lib('loop/index.mjs');
const sched = await lib('sched/index.mjs');
const BIN = names.bin;
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const CALM = Object.freeze({ cores: 10, load1: 1, loadMeasurable: true, totalBytes: 32 * 2 ** 30, availBytes: 20 * 2 ** 30, memMethod: 'vm_stat' });

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

async function cli(args, { cwd, env, json = false }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, out: json ? JSON.parse(stdout) : stdout, stderr: err.join('') };
}
const show = (r) => `exit ${r.code}\n${typeof r.out === 'string' ? r.out : JSON.stringify(r.out)}\n${r.stderr}`;

// A repository with one commit under a throwaway HOME and machine data directory.
function repository(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'status-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const p = { base: iso.base, repo: realpathSync(repo), cwd: repo, env };
  p.run = async (args, opts = {}) => {
    const r = await cli([...args, '--yes'], { ...p, ...opts });
    assert.equal(r.code, 0, `${args.join(' ')}\n${show(r)}`);
    return r;
  };
  return p;
}

// Every file under dir with its size and mtime, to show that status writes nothing.
const tree = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).sort().map((f) => {
  const st = statSync(join(dir, f));
  return `${f} ${st.isDirectory() ? 'd' : `${st.size} ${st.mtimeMs}`}`;
}) : []);

test('no command prints the status (exit 0) in an active repository: state directory, tier, tasks with their next step', async (t) => {
  const p = repository(t);
  await p.run(['init']);
  await p.run(['task', 'new', 'Parser']);
  await p.run(['task', 'new', 'Second task']);
  await p.run(['route', 'T-TU-2', '--paths', 'src/a.js', '--loc', '10']);
  const before = [...tree(join(p.repo, names.stateDir)), ...tree(join(p.base, 'data'))];

  const r = await cli([], p);
  assert.equal(r.code, 0, show(r));
  const text = r.out;
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length <= 25, `at most 25 lines:\n${text}`);
  assert.equal(lines[0], p.repo);
  assert.match(text, new RegExp(`^State: active · ${join(p.repo, names.stateDir).replace(/[/.]/g, '\\$&')} \\(in the repository\\)$`, 'm'));
  assert.match(text, /^Tier: L0 \S+ \(engine shadow\)/m, 'the tier line comes from the engine');
  assert.match(text, /^Tasks: 2 open of 2$/m);
  // Each row is the loop table's step for the task.
  assert.match(text, new RegExp(`^  T-TU-1  new  new, not routed → classify it: \`${BIN} route T-TU-1 --paths <p,…> --loc <n>\` \\(FLW-3\\)$`, 'm'));
  assert.match(text, new RegExp(`^  T-TU-2  new  trivial, not dispatched → write the brief \\(\`${BIN} brief T-TU-2\`\\)`, 'm'));
  assert.doesNotMatch(text, /^Loop:/m, 'no loop record, no loop line');
  assert.doesNotMatch(text, /^Leases:/m, 'no lease, no lease line');
  assert.deepEqual([...tree(join(p.repo, names.stateDir)), ...tree(join(p.base, 'data'))], before, 'status writes nothing');

  // `status` is the same command; --json carries the same data in one envelope.
  const named = await cli(['status'], p);
  assert.equal(named.out, text);
  const j = await cli([], { ...p, json: true });
  assert.deepEqual([j.code, j.out.command, j.out.ok], [0, 'status', true], show(j));
  const d = j.out.data;
  assert.deepEqual([d.repo, d.state.status, d.state.dir, d.state.linked], [p.repo, 'active', join(p.repo, names.stateDir), false]);
  assert.equal(d.tier.tier, 'L0');
  assert.equal(d.tier.mode, 'shadow');
  assert.deepEqual(d.tasks.map((x) => [x.id, x.status, x.class]), [['T-TU-1', 'new', null], ['T-TU-2', 'new', 'trivial']]);
  assert.deepEqual(d.steps.map((s) => [s.task, s.kind, s.rules]), [['T-TU-1', 'action', ['FLW-3']], ['T-TU-2', 'action', ['FLW-3', 'ORC-4']]]);
  assert.deepEqual([d.loop, d.leases], [null, []]);
  // The help stays behind --help.
  const help = await cli(['--help'], p);
  assert.match(help.out, new RegExp(`^usage: ${BIN} <command> \\[options\\]`));
  assert.match(help.out, /^ {2}status {2,}\S/m, 'status is listed in the help');
});

test('status in a declined, a non-activated and a linked repository; outside git exit 8 with a hint', async (t) => {
  const p = repository(t);
  let r = await cli([], p);
  assert.equal(r.code, 0, show(r));
  assert.match(r.out, new RegExp(`^State: not active · '${BIN} init' activates it$`, 'm'));
  assert.match(r.out, /^Tier: L0 /m, 'an inactive repository is evaluated from L0');
  assert.doesNotMatch(r.out, /^Tasks:/m);
  let j = await cli(['status'], { ...p, json: true });
  assert.deepEqual([j.out.data.state.status, j.out.data.tasks, j.out.data.steps], ['not-active', [], []]);

  await p.run(['decline']);
  r = await cli([], p);
  assert.equal(r.code, 0, show(r));
  assert.match(r.out, new RegExp(`^State: declined · '${BIN} init' starts tracking explicitly$`, 'm'));
  j = await cli(['status'], { ...p, json: true });
  assert.equal(j.out.data.state.status, 'declined');
  assert.equal(existsSync(join(p.repo, names.stateDir)), false, 'nothing written into the repository');

  const ext = join(p.base, 'external-state');
  await p.run(['init', '--state-dir', ext]);
  r = await cli([], p);
  assert.equal(r.code, 0, show(r));
  assert.match(r.out, new RegExp(`^State: active · ${realpathSync(ext).replace(/[/.]/g, '\\$&')} \\(linked\\)$`, 'm'));
  j = await cli(['status'], { ...p, json: true });
  assert.deepEqual([j.out.data.state.status, j.out.data.state.linked], ['active', true]);

  const outside = join(p.base, 'not-a-repo');
  mkdirSync(outside);
  for (const args of [[], ['status']]) {
    const o = await cli(args, { ...p, cwd: outside });
    assert.equal(o.code, 8, show(o));
    assert.match(o.stderr, /is not inside a git repository\n {2}hint: run it inside a git repository/);
    const oj = await cli(args, { ...p, cwd: outside, json: true });
    assert.deepEqual([oj.code, oj.out.command, oj.out.exit, oj.out.errors[0].code], [8, 'status', 'ENV', 'not-a-repo']);
  }
});

test('status shows the loop record and the leases held for the project; other projects\' leases are left out', async (t) => {
  const p = repository(t);
  await p.run(['init']);
  await p.run(['task', 'new', 'Parser']);
  await p.run(['loop', 'start']);
  const ctx = (cwd, task) => ({ names, env: p.env, cwd, task, owner: { sessionId: 'session-1', key: `toolu_${task ?? 'none'}` }, readings: CALM });
  const mine = sched.acquire('agent', ctx(p.repo, 'T-TU-1'));
  assert.equal(mine.ok, true, JSON.stringify(mine));
  const otherRepo = join(p.base, 'other');
  mkdirSync(otherRepo);
  const other = sched.acquire('agent', ctx(otherRepo, 'T-ZZ-9'));
  assert.equal(other.ok, true, JSON.stringify(other));

  const r = await cli([], p);
  assert.equal(r.code, 0, show(r));
  const l = loop.showLoop({ cwd: p.repo, env: p.env, names }).loop;
  assert.match(r.out, new RegExp(`^Loop: loop ${l.id}: running since ${l.startedAt.replace(/[.]/g, '\\.')}; unchanged for 0 ticks$`, 'm'));
  assert.match(r.out, /^ {6}tick 0 of 200, \d+ of 480 min, \$0\.00 of \$25\.00 spent \(estimate\); fix rounds per task 2$/m);
  const lease = mine.lease;
  assert.match(r.out, new RegExp(`^Leases: 1$`, 'm'));
  assert.match(r.out, new RegExp(`^  agent-${lease.slot}  live  T-TU-1  ports ${lease.ports[0]}-${lease.ports[1]}  db ${lease.db}$`, 'm'));
  assert.doesNotMatch(r.out, /T-ZZ-9/, 'a lease of another project is not shown');
  const j = await cli(['status'], { ...p, json: true });
  assert.equal(j.out.data.loop.id, l.id);
  assert.deepEqual(j.out.data.leases.map((x) => [x.kind, x.slot, x.task, x.status]), [['agent', lease.slot, 'T-TU-1', 'live']]);
  assert.ok(r.out.trimEnd().split('\n').length <= 25);
});

test('status: many open tasks stay within 25 lines; the rest is counted with the command that lists them', async (t) => {
  const p = repository(t);
  await p.run(['init']);
  for (let i = 1; i <= 30; i++) await p.run(['task', 'new', `Task ${i}`]);
  const r = await cli([], p);
  assert.equal(r.code, 0, show(r));
  const lines = r.out.trimEnd().split('\n');
  assert.ok(lines.length <= 25, `${lines.length} lines`);
  assert.match(r.out, /^Tasks: 30 open of 30$/m);
  const shown = lines.filter((x) => /^ {2}T-TU-\d+ {2}/.test(x)).length;
  assert.ok(shown >= 10, `${shown} rows shown`);
  assert.match(r.out, new RegExp(`^  … ${30 - shown} more: \`${BIN} task list\`$`, 'm'));
  const j = await cli(['status'], { ...p, json: true });
  assert.equal(j.out.data.tasks.length, 30, 'the envelope holds every open task');
});

test('status: the engine evaluates without recording; an engine turned off is shown, not refused', async (t) => {
  const p = repository(t);
  await p.run(['init']);
  const shadow = join(p.repo, names.stateDir, 'local', 'shadow.jsonl');
  // Enough source lines for L1: `tier` would log the change in shadow mode; status only reports it.
  const big = Array.from({ length: 5200 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  mkdirSync(join(p.repo, 'src'));
  for (const f of ['a', 'b']) writeFileSync(join(p.repo, 'src', `${f}.js`), big);
  git(p.repo, p.env, ['add', 'src']);
  git(p.repo, p.env, ['commit', '-q', '-m', 'code']);
  const r = await cli([], p);
  assert.equal(r.code, 0, show(r));
  assert.match(r.out, new RegExp(`^Tier: L0 \\S+ \\(engine shadow\\) · change due: L0 → L1, recorded by \`${BIN} tier\`$`, 'm'));
  assert.equal(existsSync(shadow), false, 'status logged nothing');
  const j = await cli(['status'], { ...p, json: true });
  assert.deepEqual(j.out.data.tier.change, { from: 'L0', to: 'L1' });

  const state = await lib('state/index.mjs');
  const store = state.open(join(p.repo, names.stateDir), { names });
  store.update('state', null, (doc) => ({ ...doc, flags: { ...doc.flags, engine: 'off' } }));
  const off = await cli([], p);
  assert.equal(off.code, 0, show(off));
  assert.match(off.out, /^Tier: engine off \(flags\.engine in state\.json\)$/m);
  assert.equal((await cli(['status'], { ...p, json: true })).out.data.tier, null);
});
