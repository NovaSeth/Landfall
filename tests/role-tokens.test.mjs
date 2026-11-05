// T-MG-194 (SEC-13, spec 2026-11-05 role tokens): the token kind and its functions: mint, authorize, consume, revoke,
// live, holderOf. Hosts are explicit { pid, start } (the test seam: no environment variable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  return join(plugins, readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')))[0]);
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const T = await lib('state/tokens.mjs');
const state = await lib('state/index.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-11-05T05:42:00.000Z';
const FORMAT = /^lf1_[A-Za-z0-9_-]{43}$/;
const NOW = new Date();
const me = T.holderOf(process.pid);

function store(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'role-tokens-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'state');
  state.open(dir, { names }).write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  return { base, dir };
}
// A live process other than this one, with its identity as a holder.
function sleeper(t) {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => child.kill());
  return { pid: child.pid, ...(({ start }) => ({ start }))(T.holderOf(child.pid)) };
}
const fails = (code) => (e) => e instanceof state.StateError && e.code === code && e.exit !== 'USAGE';
const orch = (dir, extra = {}) => T.mint({ dir, names, role: 'orchestrator', session: 's1', host: me, ...extra });
const agent = (dir, role = 'reviewer', extra = {}) => T.mint({ dir, names, role, session: 's1', agent: `a-${Math.random().toString(36).slice(2, 8)}`, host: me, ...extra });

test('mint: 47 characters, only the sha256 is stored, authorize accepts it as the orchestrator', (t) => {
  const { dir } = store(t);
  const { token } = orch(dir);
  assert.match(token, FORMAT);
  const text = readFileSync(join(dir, 'local', 'token.json'), 'utf8');
  assert.ok(!text.includes(token) && text.includes('"schema": 1'));
  assert.equal(T.authorize({ dir, names, token, need: 'orchestrator' }).role, 'orchestrator');
  assert.equal(T.live({ dir, names }).session, 's1');
});

test('unknown, expired and dead-holder tokens are refused with their own code', (t) => {
  const { dir } = store(t);
  const { token } = orch(dir);
  assert.throws(() => T.authorize({ dir, names, token: `lf1_${'A'.repeat(43)}`, need: 'orchestrator' }), fails('token-unknown'));
  assert.throws(() => T.authorize({ dir, names, token, need: 'orchestrator', now: new Date(NOW.getTime() + 8 * 86400000) }), fails('token-expired'));
  const b = store(t);
  const dead = orch(b.dir, { host: { pid: 2147483000, start: '1' } });
  assert.throws(() => T.authorize({ dir: b.dir, names, token: dead.token, need: 'orchestrator' }), fails('token-expired'));
  assert.equal(T.live({ dir: b.dir, names }), null);
});

test('one orchestrator: a live other holder keeps it, a dead one is taken over, the same holder re-mints and revokes the old token', (t) => {
  const { dir } = store(t);
  const other = sleeper(t);
  const first = orch(dir, { host: other });
  assert.match(first.token, FORMAT);
  assert.deepEqual(orch(dir, { session: 's2' }).none, 'held');
  assert.equal(T.authorize({ dir, names, token: first.token, need: 'orchestrator' }).role, 'orchestrator');
  const again = orch(dir, { host: other });
  assert.throws(() => T.authorize({ dir, names, token: first.token, need: 'orchestrator' }), fails('token-unknown'));
  assert.equal(T.authorize({ dir, names, token: again.token, need: 'orchestrator' }).role, 'orchestrator');
  const b = store(t);
  orch(b.dir, { host: { pid: 2147483000, start: '1' } });
  assert.match(orch(b.dir).token, FORMAT);
});

test('agent tokens: only for the live orchestrator session and holder, one use, revoked by agent id, capped at 64', (t) => {
  const { dir } = store(t);
  assert.equal(agent(dir).none, 'no-orchestrator');
  orch(dir);
  assert.equal(agent(dir, 'reviewer', { session: 'other' }).none, 'no-orchestrator');
  assert.equal(agent(dir, 'reviewer', { host: sleeper(t) }).none, 'no-orchestrator');
  const a = agent(dir, 'security-reviewer', { agent: 'agent-1' });
  const r = T.authorize({ dir, names, token: a.token, need: 'reviewer' });
  assert.equal(r.role, 'security-reviewer');
  T.consume({ dir, names, hash: r.hash });
  assert.throws(() => T.consume({ dir, names, hash: r.hash }), fails('token-unknown'));
  const b = agent(dir, 'reviewer', { agent: 'agent-2' });
  T.revoke({ dir, names, agent: 'agent-2' });
  assert.throws(() => T.authorize({ dir, names, token: b.token, need: 'reviewer' }), fails('token-unknown'));
  for (let i = 0; i < 64; i++) assert.match(agent(dir).token, FORMAT);
  assert.equal(agent(dir).none, 'full');
});

test('roles: the orchestrator token never serves a review, a reviewer token never a dispatch', (t) => {
  const { dir } = store(t);
  const o = orch(dir);
  const a = agent(dir);
  assert.throws(() => T.authorize({ dir, names, token: o.token, need: 'reviewer' }), fails('token-role'));
  assert.throws(() => T.authorize({ dir, names, token: a.token, need: 'orchestrator' }), fails('token-role'));
});

test('no token: refused while an orchestrator is live (naming the way out), a warning flag when nothing is live', (t) => {
  const { dir } = store(t);
  assert.deepEqual(T.authorize({ dir, names, need: 'orchestrator' }), { warn: true });
  orch(dir);
  assert.throws(() => T.authorize({ dir, names, need: 'orchestrator' }), (e) => fails('token-required')(e) && /s1/.test(e.message) && e.hint !== '');
  const b = store(t);
  orch(b.dir, { host: { pid: 2147483000, start: '1' } });
  assert.deepEqual(T.authorize({ dir: b.dir, names, need: 'reviewer' }), { warn: true });
});

test('a newer, corrupt or unreadable token store fails closed (token-store), also without a token', (t) => {
  for (const content of ['{"schema": 2, "orchestrator": null, "agents": []}\n', '{"schema":', '[]']) {
    const { dir } = store(t);
    mkdirSync(join(dir, 'local'), { recursive: true });
    writeFileSync(join(dir, 'local', 'token.json'), content);
    assert.throws(() => T.authorize({ dir, names, need: 'orchestrator' }), fails('token-store'));
    assert.throws(() => T.authorize({ dir, names, token: `lf1_${'A'.repeat(43)}`, need: 'reviewer' }), fails('token-store'));
    assert.equal(T.mint({ dir, names, role: 'orchestrator', session: 's1', host: me }).none, 'unreadable');
  }
});

test('holderOf skips at most two shells between the hook and the host', () => {
  const chain = { 900: { ppid: 901, comm: '-zsh' }, 901: { ppid: 902, comm: '/bin/sh' }, 902: { ppid: process.pid, comm: 'bash' } };
  const info = (pid) => chain[pid] ?? null;
  assert.equal(T.holderOf(901, info).pid, process.pid, 'sh then bash: the host');
  assert.equal(T.holderOf(900, info), null, 'two levels at most: 902 is not a live host');
  assert.equal(T.holderOf(process.pid, () => ({ ppid: 1, comm: 'claude' })).pid, process.pid, 'not a shell: itself');
  assert.equal(T.holderOf(2147483000, () => null), null, 'a dead process has no holder');
});

// Child processes of the node runtime, run against one store at the same time.
function race(t, dir, body, n) {
  const file = join(dir, '..', `race-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, `const T = await import(${JSON.stringify(pathToFileURL(join(pluginDir, 'lib', 'state', 'tokens.mjs')).href)});
const names = ${JSON.stringify(names)}; const dir = ${JSON.stringify(dir)}; const arg = JSON.parse(process.argv[2]);
let out; try { out = ${body}; } catch (e) { out = { error: e.code }; } console.log(JSON.stringify(out));`);
  return (args) => Promise.all(args.slice(0, n).map((a) => new Promise((done) => {
    const c = spawn(process.execPath, [file, JSON.stringify(a)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => done(JSON.parse(out)));
  })));
}

test('two concurrent session starts from different live hosts leave one orchestrator; two concurrent records spend one token once', async (t) => {
  const { dir } = store(t);
  const hosts = [sleeper(t), sleeper(t)];
  const mints = race(t, dir, "T.mint({ dir, names, role: 'orchestrator', session: arg.s, host: arg.host, lockMs: 10000 })", 2);
  const got = await mints(hosts.map((host, i) => ({ s: `s${i}`, host })));
  assert.equal(got.filter((r) => r.token).length, 1, JSON.stringify(got));
  assert.equal(got.filter((r) => r.none === 'held').length, 1);
  const doc = JSON.parse(readFileSync(join(dir, 'local', 'token.json'), 'utf8'));
  assert.equal(doc.orchestrator.session, got.findIndex((r) => r.token) === 0 ? 's0' : 's1');
  const winner = hosts[got.findIndex((r) => r.token)];
  const a = T.mint({ dir, names, role: 'reviewer', session: doc.orchestrator.session, agent: 'x1', host: winner });
  assert.match(a.token, FORMAT);
  const hash = T.authorize({ dir, names, token: a.token, need: 'reviewer' }).hash;
  const spend = race(t, dir, "(T.consume({ dir, names, hash: arg }), { ok: true })", 2);
  const res = await spend([hash, hash]);
  assert.equal(res.filter((r) => r.ok).length, 1, JSON.stringify(res));
  assert.equal(res.filter((r) => r.error === 'token-unknown').length, 1);
});
