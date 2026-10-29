// External runs hardening, provider output (T-MG-86, audit 2.4.0 B-1, B-5, SF-AB-6, SF-AB-7, SF-AB-8): what a provider
// prints becomes a clean, redacted state string before it reaches the run log or the record, the supervisor survives
// any line, and output is split per stream with a pending buffer of at most 64 KiB. The hostile fake provider is
// tests/fixtures/providers/fake-hostile.mjs. The program is the absolute path resolved at exec time and recorded in
// the run, and the record's model is checked before it reaches argv (B-2, B-3). The out directory is bound to the run
// by its device and inode (SF-AB-10), and the review brief is read without following a link (SF-AB-1). This file holds
// no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const exec = await lib('providers/exec.mjs');
const registry = await lib('providers/registry.mjs');
const generic = await lib('providers/generic.mjs');
const FAKE = join(root, 'tests', 'fixtures', 'providers', 'fake-provider.mjs');
const HOSTILE = join(root, 'tests', 'fixtures', 'providers', 'fake-hostile.mjs');
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const TERMINAL = new Set(['done', 'failed', 'timeout', 'stopped']);
const TOKEN = ['gh', 'p_', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'].join('');

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

async function cli(args, { cwd, env }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main([...args, '--json', '--yes'], { io });
  const stdout = out.join('');
  return { code, e: stdout ? JSON.parse(stdout) : null, stderr: err.join('') };
}
const show = (r) => `exit ${r.code}\n${JSON.stringify(r.e)}\n${r.stderr}`;

async function project(t, { envExtra = {} } = {}) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'runs-hard-' });
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data'), ...envExtra };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, env, ['add', 'a.txt']);
  git(repo, env, ['commit', '-q', '-m', 'start']);
  const p = { base: iso.base, repo: realpathSync(repo), cwd: repo, env };
  p.state = join(p.repo, names.stateDir);
  p.runsDir = join(p.state, 'local', 'runs');
  p.cli = (args) => cli(args, { cwd: p.cwd, env: p.env });
  p.ok = async (args) => { const r = await p.cli(args); assert.equal(r.code, 0, `${args.join(' ')}\n${show(r)}`); return r; };
  p.record = (id) => JSON.parse(readFileSync(join(p.runsDir, `${id}.json`), 'utf8'));
  p.log = (id) => JSON.parse(readFileSync(join(p.runsDir, `${id}.log`), 'utf8'));
  p.records = () => (existsSync(p.runsDir) ? readdirSync(p.runsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(p.runsDir, f), 'utf8'))) : []);
  p.until = async (what, fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(p.records().map((r) => [r.runId, r.status, r.error]))}`);
      await pause(50);
    }
  };
  p.ended = (id, ms = 15000) => p.until(`${id} to end`, () => TERMINAL.has(p.record(id).status) && p.record(id), ms);
  p.externalLeases = () => (existsSync(join(p.env.CLAUDE_PLUGIN_DATA, 'leases')) ? readdirSync(join(p.env.CLAUDE_PLUGIN_DATA, 'leases')).filter((f) => f.startsWith('external-')) : []);
  t.after(async () => {
    for (const r of p.records()) if (Number.isInteger(r.pid) && alive(r.pid) && !TERMINAL.has(r.status)) { try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ } }
    for (const r of p.records()) if (Number.isInteger(r.pid) && r.pid !== process.pid) await p.until(`supervisor ${r.pid} to end`, () => !alive(r.pid), 15000).catch(() => {});
    iso.cleanup();
  });
  await p.ok(['init']);
  for (const title of ['Parser', 'Lexer']) await p.ok(['task', 'new', title]);
  for (const id of ['T-TU-1', 'T-TU-2']) {
    await p.ok(['route', id, '--paths', 'src/a.js', '--loc', '10']);
    await p.ok(['brief', id, '--write']);
    await p.ok(['task', 'set', id, 'started', '--branch', 'main', '--base', git(repo, env, ['rev-parse', 'HEAD'])]);
    await p.ok(['review', 'brief', id, '--write']);
  }
  await p.ok(['providers', 'add', 'fakeok', '--argv', `${process.execPath} ${FAKE} ok {out} {sandbox} {cwd}`, '--sandbox-map', 'reviewer=read-only,implementer=workspace-write']);
  for (const mode of ['esc', 'flood', 'secret', 'mixed']) {
    await p.ok(['providers', 'add', `h${mode}`, '--argv', `${process.execPath} ${HOSTILE} ${mode} {out} {sandbox} {cwd}`, '--sandbox-map', 'reviewer=read-only']);
  }
  return p;
}
const startRun = (p, task, provider) => p.cli(['exec', '--task', task, '--role', 'reviewer', '--provider', provider]);
async function runTo(p, provider, task = 'T-TU-1') {
  const r = await startRun(p, task, provider);
  assert.equal(r.code, 0, show(r));
  return p.ended(r.e.data.runId);
}

// ---- B-1 / SF-AB-8: control characters never stop the supervisor ----

test('B-1: a provider printing ESC[31m and a tab ends done, never stuck running, and leaks no lease; the log is clean', async (t) => {
  const p = await project(t);
  const rec = await runTo(p, 'hesc');
  assert.equal(rec.status, 'done', JSON.stringify(rec));
  // The record ends before the supervisor's finally releases the lease: wait for the release, a leak still times out.
  await p.until('the external lease to be released', () => p.externalLeases().length === 0);
  const lines = p.log(rec.runId).lines;
  assert.ok(lines.includes('red status'), JSON.stringify(lines));
  assert.ok(lines.includes('col1 col2'), JSON.stringify(lines));
  for (const l of [...lines, rec.lastLine]) assert.doesNotMatch(l, /[\u0000-\u001f\u007f]/, `clean: ${JSON.stringify(l)}`);
});

// ---- B-5 / SF-AB-7: one bounded pending buffer per stream ----

test('B-5: the line splitter keeps at most 64 KiB pending; 10 MiB without a newline is one truncated line, in bounded time', () => {
  const got = [];
  const s = exec.lineSplitter((line, truncated) => got.push({ length: line.length, truncated }));
  const piece = Buffer.from('x'.repeat(64 * 1024));
  let peak = 0;
  const began = Date.now();
  for (let i = 0; i < 160; i++) { s.feed(piece); peak = Math.max(peak, s.pending()); }
  s.feed(Buffer.from('\nnext\n'));
  s.end();
  const ms = Date.now() - began;
  assert.equal(exec.PENDING_MAX, 64 * 1024);
  assert.ok(peak <= exec.PENDING_MAX, `pending peaked at ${peak}`);
  assert.deepEqual(got, [{ length: exec.PENDING_MAX, truncated: true }, { length: 4, truncated: false }]);
  assert.ok(ms < 2000, `${ms} ms`);
});

test('B-5: a multi-byte character split across chunks stays whole; end() emits the unterminated rest', () => {
  const got = [];
  const s = exec.lineSplitter((line) => got.push(line));
  for (const b of Buffer.from('zażółć\nreszta')) s.feed(Buffer.from([b]));
  s.end();
  assert.deepEqual(got, ['zażółć', 'reszta']);
});

test('B-5: stdout and stderr have their own buffers (interleaved pieces stay whole lines); a 10 MiB flood ends done', async (t) => {
  const p = await project(t);
  const mixed = await runTo(p, 'hmixed');
  assert.equal(mixed.status, 'done');
  const lines = p.log(mixed.runId).lines;
  assert.ok(lines.includes('{"out":"whole"}'), JSON.stringify(lines));
  assert.ok(lines.includes('err-line'), JSON.stringify(lines));
  const flood = await runTo(p, 'hflood', 'T-TU-2');
  assert.equal(flood.status, 'done', JSON.stringify(flood));
  const fl = p.log(flood.runId).lines;
  assert.ok(fl.includes('after the flood'), JSON.stringify(fl.map((l) => l.slice(0, 40))));
  await p.until('the external lease to be released', () => p.externalLeases().length === 0);
});

// ---- SF-AB-6: redaction before storage ----

test('SF-AB-6: a token-shaped provider line is masked in the record and the log', async (t) => {
  const p = await project(t);
  const rec = await runTo(p, 'hsecret');
  assert.equal(rec.status, 'done');
  const raw = readFileSync(join(p.runsDir, `${rec.runId}.log`), 'utf8') + readFileSync(join(p.runsDir, `${rec.runId}.json`), 'utf8');
  assert.ok(!raw.includes(TOKEN.slice(0, 20)), 'neither the token nor a prefix of it is stored');
  assert.ok(p.log(rec.runId).lines.some((l) => l.startsWith('leaked ') && l.endsWith(' here')), JSON.stringify(p.log(rec.runId).lines));
});

test('SF-AB-6: a project pattern (secrets-patterns.txt) in the provider output is masked in the record and the log', async (t) => {
  const p = await project(t);
  writeFileSync(join(p.state, 'secrets-patterns.txt'), 'red st[a-z]+\n');
  const rec = await runTo(p, 'hesc');
  assert.equal(rec.status, 'done', JSON.stringify(rec));
  const raw = readFileSync(join(p.runsDir, `${rec.runId}.log`), 'utf8') + readFileSync(join(p.runsDir, `${rec.runId}.json`), 'utf8');
  assert.ok(!raw.includes('red status'), 'the project pattern match is not stored');
  assert.ok(p.log(rec.runId).lines.includes('col1 col2'), JSON.stringify(p.log(rec.runId).lines));
});

test('SF-AB-6: an unreadable project pattern file fails closed: the run fails and no provider starts', async (t) => {
  const p = await project(t);
  mkdirSync(join(p.state, 'secrets-patterns.txt'));
  const r = await startRun(p, 'T-TU-1', 'hesc');
  assert.equal(r.code, 0, show(r));
  const rec = await p.ended(r.e.data.runId);
  assert.equal(rec.status, 'failed');
  assert.equal(rec.error, 'project-patterns-unreadable');
  assert.equal(existsSync(`${rec.outFile}.args`), false, 'no provider was started');
  assert.deepEqual(p.externalLeases(), []);
});

// ---- B-6 / SF-AB-12: a minimal provider environment ----

test('B-6: GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY and another provider\'s key never reach the provider; the base and lease variables do', async (t) => {
  const p = await project(t, { envExtra: { GITHUB_TOKEN: 'SYNTH-not-a-token', AWS_SECRET_ACCESS_KEY: 'SYNTH-not-a-key', OPENAI_API_KEY: 'SYNTH-other', LANG: 'C.UTF-8', LC_ALL: 'C' } });
  const rec = await runTo(p, 'hesc');
  const { env } = JSON.parse(readFileSync(`${rec.outFile}.args`, 'utf8'));
  for (const k of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'CLAUDE_PLUGIN_DATA', 'GIT_CONFIG_GLOBAL']) assert.equal(env[k], undefined, `${k} must not pass`);
  assert.equal(env.HOME, p.env.HOME);
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.LC_ALL, 'C');
  assert.ok(Object.keys(env).some((k) => /_SLOT$/.test(k)), `the lease variables pass: ${Object.keys(env).join(' ')}`);
  // Node or the OS may add its own variables to a child (macOS: __CF_USER_TEXT_ENCODING); nothing else passes.
  for (const k of Object.keys(env)) assert.match(k, /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z_]+|[A-Z0-9_]+_(?:SLOT|PORT_BASE|PORT_MAX|DB_NAME)|__CF_USER_TEXT_ENCODING)$/, `unexpected ${k}`);
});

test('B-6: the env allowlists: codex OPENAI_*/CODEX_*/proxies, gemini GEMINI_*/GOOGLE_*/proxies, a generic adapter its declared names', () => {
  const parent = { PATH: '/usr/bin:.:/bin:', HOME: '/h', USER: 'u', LC_CTYPE: 'C', OPENAI_API_KEY: 'a', CODEX_HOME: 'b', GEMINI_API_KEY: 'c', GOOGLE_CLOUD_PROJECT: 'd', HTTPS_PROXY: 'e', GITHUB_TOKEN: 'f', MY_TOOL_KEY: 'g', NODE_OPTIONS: '--require x' };
  const lease = { X_SLOT: '1' };
  const codex = registry.BUILTINS.find((a) => a.id === 'codex');
  const gemini = registry.BUILTINS.find((a) => a.id === 'gemini');
  const base = { PATH: '/usr/bin:/bin', HOME: '/h', USER: 'u', LC_CTYPE: 'C', X_SLOT: '1' };
  assert.deepEqual(exec.childEnv(codex, parent, lease), { ...base, OPENAI_API_KEY: 'a', CODEX_HOME: 'b', HTTPS_PROXY: 'e' });
  assert.deepEqual(exec.childEnv(gemini, parent, lease), { ...base, GEMINI_API_KEY: 'c', GOOGLE_CLOUD_PROJECT: 'd', HTTPS_PROXY: 'e' });
  const mine = generic.fromEntry('mycli', { argv: 'mycli {sandbox}', sandboxMap: { reviewer: 'ro' }, env: ['MY_TOOL_KEY'] });
  assert.deepEqual(exec.childEnv(mine, parent, lease), { ...base, MY_TOOL_KEY: 'g' });
});

test('B-6: providers add stores validated --env names; a bad name is a usage error', (t) => {
  const iso = isolatedEnv({ prefix: 'runs-hard-env-' });
  t.after(() => iso.cleanup());
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  const entry = registry.addProvider({ names, env, id: 'mycli', argv: 'mycli {sandbox}', sandboxMap: 'reviewer=ro', envNames: 'MY_TOOL_KEY,MY_TOOL_URL' });
  assert.deepEqual(entry.env, ['MY_TOOL_KEY', 'MY_TOOL_URL']);
  assert.deepEqual(registry.adapters({ names, env }).find((a) => a.id === 'mycli').envNames, ['MY_TOOL_KEY', 'MY_TOOL_URL']);
  for (const bad of ['my-key', '1X', 'A,,B', 'A=B']) assert.throws(() => registry.addProvider({ names, env, id: 'other', argv: 'x {sandbox}', sandboxMap: 'reviewer=ro', envNames: bad }), (err) => err.exit === 'USAGE', bad);
});

test('T-MG-91: exec with no sandbox mapping for the role (a stale detection cache) refuses before it records a run', async (t) => {
  const p = await project(t);
  await p.ok(['providers', '--refresh']);
  const file = join(p.env.CLAUDE_PLUGIN_DATA, 'providers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.generic.fakeok.sandboxMap = { implementer: 'workspace-write' };
  writeFileSync(file, JSON.stringify(doc));
  const r = await startRun(p, 'T-TU-1', 'fakeok');
  assert.notEqual(r.code, 0, show(r));
  assert.equal(r.e.errors[0].code, 'role-unavailable', show(r));
  assert.match(r.e.errors[0].hint, /providers --refresh/);
  assert.deepEqual(p.records(), []);
});

// ---- B-2: the absolute program path ----

test('B-2: with "." first on PATH a repository-shipped ./codex never runs; the run spawns the resolved absolute path', async (t) => {
  const p = await project(t);
  const binDir = join(p.base, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'codex'), `#!${process.execPath}\nprocess.argv.splice(2, 0, 'codex');\nimport(${JSON.stringify(pathToFileURL(FAKE).href)});\n`, { mode: 0o700 });
  const marker = join(p.base, 'repo-codex-ran');
  writeFileSync(join(p.repo, 'codex'), `#!/bin/sh\necho ran > ${marker}\nexit 0\n`, { mode: 0o755 });
  p.env.PATH = `.::${binDir}:${p.env.PATH}`;
  const r = await p.ok(['exec', '--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'codex']);
  const rec = await p.ended(r.e.data.runId);
  assert.equal(existsSync(marker), false, 'the repository codex did not run');
  assert.equal(rec.status, 'done', JSON.stringify(rec));
  assert.equal(rec.bin, join(binDir, 'codex'));
});

test('B-2: the provider PATH keeps only absolute entries', () => {
  assert.equal(exec.childPath('.::/usr/bin:rel/bin:/bin:'), '/usr/bin:/bin');
  assert.equal(exec.childPath(undefined), '');
});

// ---- run-supervise: a record bound to its run ----

// A run record rewritten for T-TU-2 in a fresh private temp directory, bound by its device and inode as exec binds it
// (bind: false leaves the binding out), so only `change` differs from a record exec wrote.
async function rewritten(t, change, { bind = true } = {}) {
  const p = await project(t);
  const base = await runTo(p, 'fakeok');
  const outDir = mkdtempSync(join(tmpdir(), `${names.bin}-run-`));
  writeFileSync(join(outDir, 'brief.md'), readFileSync(`${base.outFile}.prompt`), { mode: 0o600 });
  const st = lstatSync(outDir, { bigint: true });
  const runId = 'fakeok-T-TU-2-reviewer-1';
  const rec = { ...base, runId, task: 'T-TU-2', status: 'starting', pid: null, endedAt: null, error: null, outFile: join(outDir, 'out.json'), ...(bind ? { outDirId: `${st.dev}:${st.ino}` } : {}), ...change(p, outDir) };
  writeFileSync(join(p.runsDir, `${runId}.json`), `${JSON.stringify(rec)}\n`);
  const r = await p.cli(['run-supervise', runId]);
  return { p, r, rec: p.record(runId), outFile: rec.outFile };
}

test('B-2/B-3 control: a record as exec wrote it runs', async (t) => {
  const { r, rec } = await rewritten(t, () => ({}));
  assert.equal(r.code, 0, show(r));
  assert.equal(rec.status, 'done', JSON.stringify(rec));
});

for (const model of ['--dangerously-skip-permissions', '-x', 'has space', 'yolo']) {
  test(`B-3: a record whose model is ${JSON.stringify(model)} is run-tampered`, async (t) => {
    const { r, rec, outFile } = await rewritten(t, () => ({ model }));
    assert.equal(r.code, 1, show(r));
    assert.equal(rec.error, 'run-tampered');
    assert.equal(existsSync(`${outFile}.args`), false, 'no provider was started');
  });
}

test('B-2: a record whose binary is not the resolution of the adapter\'s program is run-tampered', async (t) => {
  const { r, rec, outFile } = await rewritten(t, () => ({ bin: '/bin/sh' }));
  assert.equal(r.code, 1, show(r));
  assert.equal(rec.error, 'run-tampered');
  assert.equal(existsSync(`${outFile}.args`), false, 'no provider was started');
});

test('B-2: a record without a binary (written by 2.4.1) is run-tampered, with the hint to start the run again', async (t) => {
  const { r, rec, outFile } = await rewritten(t, () => ({ bin: undefined }));
  assert.equal(r.code, 1, show(r));
  assert.equal(rec.error, 'run-tampered');
  assert.match(r.e.errors[0].hint, /start the run again/);
  assert.equal(existsSync(`${outFile}.args`), false, 'no provider was started');
});

// ---- SF-AB-10: the out directory bound to the run ----

test('SF-AB-10: exec binds the run to its own 0700 temp directory by device and inode; the out file is out.json', async (t) => {
  const p = await project(t);
  const rec = await runTo(p, 'fakeok');
  assert.equal(rec.status, 'done', JSON.stringify(rec));
  const dir = dirname(rec.outFile);
  const st = lstatSync(dir, { bigint: true });
  assert.equal(rec.outFile, join(dir, 'out.json'));
  assert.equal(rec.outDirId, `${st.dev}:${st.ino}`);
  assert.equal(Number(st.mode) & 0o777, 0o700);
  assert.equal(realpathSync(dirname(dir)), realpathSync(tmpdir()));
});

test('SF-AB-10: a record pointing to another 0700 temp directory (not the one exec bound) is run-tampered', async (t) => {
  const { r, rec, outFile } = await rewritten(t, () => ({}), { bind: false });
  assert.equal(r.code, 1, show(r));
  assert.equal(rec.error, 'run-tampered');
  assert.equal(existsSync(`${outFile}.args`), false, 'no provider was started');
});

test('SF-AB-10: a record whose outDirId names another directory is run-tampered', async (t) => {
  const { r, rec, outFile } = await rewritten(t, (p) => { const st = lstatSync(p.base, { bigint: true }); return { outDirId: `${st.dev}:${st.ino}` }; });
  assert.equal(r.code, 1, show(r));
  assert.equal(rec.error, 'run-tampered');
  assert.equal(existsSync(`${outFile}.args`), false, 'no provider was started');
});

test('SF-AB-10: an out file not named out.json is run-tampered', async (t) => {
  const { r, rec } = await rewritten(t, (p, outDir) => ({ outFile: join(outDir, 'other.json') }));
  assert.equal(r.code, 1, show(r));
  assert.equal(rec.error, 'run-tampered');
});

test('SF-AB-10: an out file that is a link is run-tampered', async (t) => {
  const { r, rec } = await rewritten(t, (p, outDir) => { symlinkSync(join(p.repo, 'a.txt'), join(outDir, 'out.json')); return {}; });
  assert.equal(r.code, 1, show(r));
  assert.equal(rec.error, 'run-tampered');
  assert.equal(readFileSync(join(rec.cwd, 'a.txt'), 'utf8'), 'a\n');
});

// ---- SF-AB-1: the review brief is never read through a link ----

const linkBrief = (p) => {
  const outside = join(p.base, 'host-credential.txt');
  writeFileSync(outside, 'SYNTH host secret\n');
  const brief = join(p.state, 'tasks', 'T-TU-1', 'review-r1-brief.md');
  unlinkSync(brief);
  symlinkSync(outside, brief);
};

test('SF-AB-1: a review brief that is a symlink to a file outside is refused and nothing reaches a provider', async (t) => {
  const p = await project(t);
  linkBrief(p);
  const r = await startRun(p, 'T-TU-1', 'fakeok');
  assert.equal(r.code, 1, show(r));
  assert.equal(r.e.errors[0].code, 'review-brief-unsafe');
  assert.deepEqual(p.records(), [], 'no run was recorded');
});

test('SF-AB-1: a review brief named by --round that is a symlink is refused the same way', async (t) => {
  const p = await project(t);
  linkBrief(p);
  const r = await p.cli(['exec', '--task', 'T-TU-1', '--role', 'reviewer', '--provider', 'fakeok', '--round', '1']);
  assert.equal(r.code, 1, show(r));
  assert.equal(r.e.errors[0].code, 'review-brief-unsafe');
  assert.deepEqual(p.records(), [], 'no run was recorded');
});

test('SF-AB-1: a task directory that is a symlink is refused', async (t) => {
  const p = await project(t);
  const dir = join(p.state, 'tasks', 'T-TU-1');
  const moved = join(p.base, 'moved-task');
  spawnSync('mv', [dir, moved]);
  symlinkSync(moved, dir);
  const r = await startRun(p, 'T-TU-1', 'fakeok');
  assert.notEqual(r.code, 0, show(r));
  assert.deepEqual(p.records(), [], 'no run was recorded');
});
