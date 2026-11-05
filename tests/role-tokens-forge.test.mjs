// T-MG-194 (SEC-13, A6, A7): the forge corpus of T-MG-187 review r2 F1-F4, run through /bin/sh against the plugin's launcher.
// An implementer-typed context has no token, while the repository holds a live orchestrator and a live reviewer entry: the
// CLI refuses every spelling (token-required or token-role) and the task documents stay byte-identical. With the reviewer
// token on stdin the same review record succeeds once and is then refused (token-unknown). Workers are bounded to 2 (COD-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  return join(plugins, readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')))[0]);
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const { spellings } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'role-tokens-forge.json'), 'utf8'));
const AT = '2026-11-05T05:42:00.000Z';
const WORKERS = 2;
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

const base = realpathSync(mkdtempSync(join(tmpdir(), 'role-forge-')));
test.after(() => rmSync(base, { recursive: true, force: true }));
const repo = join(base, 'repo');
const bin = join(base, 'bin');
mkdirSync(repo);
mkdirSync(bin);
mkdirSync(join(base, 'home'));
const launcher = join(pluginDir, 'bin', names.bin);
const cased = { LC: names.bin[0].toUpperCase() + names.bin.slice(1), LU: names.bin.toUpperCase() };
for (const name of [names.bin, `${names.bin}.mjs`, cased.LC, cased.LU]) {
  try { symlinkSync(launcher, join(bin, name)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
const env = { ...ISO.env, HOME: join(base, 'home'), PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}` };
const sh = (cmd, opts = {}) => spawnSync('/bin/sh', ['-c', cmd], { cwd: repo, env, encoding: 'utf8', ...opts });
const git = (...a) => { const r = spawnSync('git', a, { cwd: repo, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git('-c', 'init.defaultBranch=main', 'init', '-q');
git('config', 'user.name', 'Test User');
git('config', 'user.email', 'test@example.com');
writeFileSync(join(repo, 'a.txt'), 'a');
git('add', '-A');
git('commit', '-q', '-m', 'base');
const head = git('rev-parse', 'HEAD');
const dir = join(repo, names.stateDir);
const store = state.open(dir, { names });
store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
const id = state.allocateId(store, { prefix: 'T', handle, build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: 'standard', classHistory: [{ class: 'standard', reason: 'standard: test', at: AT }], status: 'new', round: 0, events: [], base: head, branch: null }) });
state.setTask({ cwd: repo, env, names, id, state: 'dispatched', options: { executor: 'claude:reviewer', base: head } });
const file = join(base, 'review.json');
writeFileSync(file, JSON.stringify({ verdict: 'approved', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings: [] }));
const host = state.holderOf(process.pid);
const orch = state.mint({ dir, names, role: 'orchestrator', session: 's1', host }).token;
const reviewer = state.mint({ dir, names, role: 'reviewer', session: 's1', agent: 'ag1', host }).token;
assert.ok(orch && reviewer);

const COMMANDS = {
  dispatch: `task set ${id} dispatched --executor claude:reviewer --base ${head} --yes --json`,
  review: `review record ${id} --from ${file} --yes --json`,
};
const has = (prog) => sh(`command -v ${prog}`).status === 0;
const dump = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort().map((f) => `${f}:${(() => { try { return readFileSync(join(d, f), 'utf8'); } catch { return ''; } })()}`).join('\n') : '');
const tasks = () => dump(join(dir, 'tasks'));
const all = [];

const build = (s, args, n) => {
  const fill = (t) => t.replaceAll('{L}', names.bin).replaceAll('{LC}', cased.LC).replaceAll('{LU}', cased.LU).replaceAll('{A}', args).replaceAll('{BIN}', bin).replaceAll('{TMP}', base).replaceAll('{N}', String(n));
  let cmd = fill(s.tpl);
  for (let i = 0; i < (s.wrap ?? 0); i++) cmd = `sh -c ${quote(cmd)}`;
  return cmd;
};
const run = (cmd) => new Promise((done) => {
  const c = spawn('/bin/sh', ['-c', cmd], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => c.kill(), 60000);
  c.on('close', (code) => { clearTimeout(timer); done({ code, out, err }); });
});
const envelope = (out) => { try { return JSON.parse(out.trim().split('\n').pop()); } catch { return null; } };

test('every spelling of the forge corpus is refused by the CLI and changes no task document (A6)', { timeout: 600000 }, async () => {
  const jobs = [];
  for (const [kind, args] of Object.entries(COMMANDS)) {
    spellings.forEach((s, i) => jobs.push({ s, kind, cmd: build(s, args, `${kind}${i}`) }));
  }
  assert.ok(jobs.length >= 64);
  const before = tasks();
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if ((job.s.needs ?? []).some((p) => !has(p.replaceAll('{LC}', cased.LC).replaceAll('{LU}', cased.LU)))) { results.push({ ...job, skipped: 'missing program' }); continue; }
      const r = await run(job.cmd);
      all.push(r.out, r.err);
      results.push({ ...job, ...r, env: envelope(r.out) });
    }
  }));
  const reached = results.filter((r) => r.env?.errors?.length);
  for (const r of results.filter((x) => !x.skipped)) {
    if (!r.env?.errors?.length) {
      assert.ok(r.s.optional, `${r.s.id} (${r.kind}) did not reach the CLI: ${r.cmd}\n${r.out}${r.err}`);
      continue;
    }
    assert.ok(['token-required', 'token-role'].includes(r.env.errors[0].code), `${r.s.id} (${r.kind}): ${JSON.stringify(r.env.errors[0])}`);
  }
  assert.ok(reached.length >= 50, `${reached.length} spellings reached the CLI, at least 50 must`);
  assert.equal(tasks(), before, 'the task documents are byte-identical');
});

test('the reviewer token on stdin records the review once; the orchestrator token dispatches; a token on argv is refused (A6, A7)', () => {
  const cli = (argv, input) => {
    const r = spawnSync(launcher, argv, { cwd: repo, env, input, encoding: 'utf8' });
    all.push(r.stdout, r.stderr);
    return { code: r.status, env: envelope(r.stdout) };
  };
  const rec = ['review', 'record', id, '--from', file, '--yes', '--json'];
  const first = cli([...rec, '--token', '-'], reviewer);
  assert.equal(first.code, 0, JSON.stringify(first.env));
  const second = cli([...rec, '--token', '-'], reviewer);
  assert.deepEqual([second.code, second.env.errors[0].code], [7, 'token-unknown']);
  const dispatch = cli(['task', 'set', id, 'dispatched', '--executor', 'claude:reviewer', '--base', head, '--yes', '--json', '--token', '-'], orch);
  assert.equal(dispatch.code, 0, JSON.stringify(dispatch.env));
  const argv = cli([...rec, '--token', orch]);
  assert.deepEqual([argv.code, argv.env.errors[0].code], [2, 'token-on-argv']);
});

// T-MG-199 (R2): a provider started the way exec starts it (a detached supervisor, which starts a detached provider,
// while the parent exits) is outside the holder's tree once it is reparented. The copied tokens are then refused.
const CHAIN = `
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [mode, cfgText] = process.argv.slice(2);
const cfg = JSON.parse(cfgText);
const self = new URL(import.meta.url).pathname;
if (mode === 'start') spawn(process.execPath, [self, 'supervise', cfgText], { detached: true, stdio: 'ignore' }).unref();
if (mode === 'supervise') { spawn(process.execPath, [self, 'provide', cfgText], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => {}, 30000); }
if (mode === 'provide') {
  const inTree = () => {
    const rows = new Map(spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout.split('\\n').map((l) => l.trim().split(/\\s+/).map(Number)).filter((r) => r.length === 2));
    for (let p = process.pid, i = 0; p > 1 && i < 64; i++) { if (p === cfg.holder) return true; p = rows.get(p); if (p === undefined) return false; }
    return false;
  };
  const deadline = Date.now() + 15000;
  while (inTree() && Date.now() < deadline) spawnSync('sleep', ['0.1']);
  const out = { attached: inTree() };
  for (const [k, argv, input] of cfg.calls) {
    const r = spawnSync(cfg.launcher, argv, { cwd: cfg.cwd, env: process.env, input, encoding: 'utf8' });
    out[k] = { code: r.status, out: r.stdout.trim().split('\\n').pop() };
  }
  writeFileSync(cfg.result, JSON.stringify(out));
  process.exit(0);
}
`;

test('a provider started the way landfall exec starts it cannot dispatch or record with a stolen token (R2)', { timeout: 60000 }, async () => {
  const stolen = state.mint({ dir, names, role: 'reviewer', session: 's1', agent: 'ag-r2', host }).token;
  assert.ok(stolen);
  const chain = join(base, 'chain.mjs');
  const result = join(base, 'chain-result.json');
  writeFileSync(chain, CHAIN);
  const rec = ['review', 'record', id, '--from', file, '--yes', '--json', '--token', '-'];
  const set = ['task', 'set', id, 'dispatched', '--executor', 'claude:reviewer', '--base', head, '--yes', '--json', '--token', '-'];
  const cfg = { holder: process.pid, launcher, cwd: repo, result, calls: [['record', rec, stolen], ['dispatch', set, orch]] };
  const before = tasks();
  spawnSync(process.execPath, [chain, 'start', JSON.stringify(cfg)], { env, stdio: 'ignore' });
  const deadline = Date.now() + 40000;
  while (!existsSync(result) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(result), 'the provider reported');
  const out = JSON.parse(readFileSync(result, 'utf8'));
  all.push(JSON.stringify(out));
  assert.equal(out.attached, false, 'the provider left the holder\'s tree');
  for (const k of ['record', 'dispatch']) {
    assert.equal(out[k].code, 7, `${k}: ${out[k].out}`);
    assert.equal(JSON.parse(out[k].out).errors[0].code, 'token-caller');
  }
  assert.equal(tasks(), before, 'the task documents are byte-identical');
  assert.ok(state.authorize({ dir, names, token: stolen, need: 'reviewer' }).hash, 'the reviewer token was not spent');
});

test('no output, event or state file holds a token (A7)', () => {
  const grep = [...all, dump(dir)].join('\n');
  assert.ok(!grep.includes('lf1_'));
});
