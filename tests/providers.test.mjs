// External executor adapters (spec §7.12, U8, U15, §11): the adapter interface { id, bins, detect, auth, argv, parse,
// sandboxes }, the sandbox taken from the role by the CLI and never a bypass flag in an argv builder, token and
// last-line parsing against recorded JSONL (Codex 0.160.0, recorded; Gemini synthetic until a user runs it, U15),
// user-declared generic adapters (`providers add`), detection (PATH, --version and the auth probe, 2 s each, cached
// for 1 h in plugin data) and the selection rule: role preferences filtered by detection and auth, the first wins;
// the dispatch code never names a provider. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { lex } from './helpers/lex.mjs';

const ISO = isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const providers = await lib('providers/index.mjs');
const generic = await lib('providers/generic.mjs');
const { main } = await lib('cli/main.mjs');
const FIXTURES = join(root, 'tests', 'fixtures', 'providers');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean);
const SYSTEM_DIRS = ['/usr/bin', '/bin'];
const BYPASS = /danger|bypass|yolo|full-access|skip-permissions/i;

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'providers-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  const env = { ...ISO.env, PATH: [bin, ...SYSTEM_DIRS].join(delimiter), CLAUDE_PLUGIN_DATA: join(base, 'data') };
  return { base, bin, env };
}
// A fake program on the scratch PATH: a node script; each run appends its arguments to <base>/<name>.calls.
function fakeProgram(s, name, body) {
  const file = join(s.bin, name);
  writeFileSync(file, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(join(s.base, `${name}.calls`))}, process.argv.slice(2).join(' ') + '\\n');\n${body}\n`);
  chmodSync(file, 0o755);
}
const calls = (s, name) => (existsSync(join(s.base, `${name}.calls`)) ? readFileSync(join(s.base, `${name}.calls`), 'utf8').split('\n').filter(Boolean) : []);

async function cli(args, { env, cwd = process.cwd() }) {
  const out = [];
  const err = [];
  const io = { out: (x) => out.push(x), err: (x) => err.push(x), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, e: JSON.parse(out.join('')), stderr: err.join('') };
}

test('every built-in adapter has the interface: id, bins, detect, auth, argv, parse and a sandbox per role', () => {
  assert.ok(providers.BUILTINS.length >= 2, 'built-in adapters are registered');
  for (const a of providers.BUILTINS) {
    assert.match(a.id, /^[a-z0-9]{1,20}$/, 'an ID usable in an agent name');
    assert.ok(Array.isArray(a.bins) && a.bins.length > 0, `${a.id}: bins`);
    for (const fn of ['detect', 'auth', 'argv', 'parse']) assert.equal(typeof a[fn], 'function', `${a.id}: ${fn}()`);
    assert.deepEqual(Object.keys(a.sandboxes).sort(), ['implementer', 'reviewer'], `${a.id}: a sandbox per role`);
  }
});

test('argv: the sandbox comes from the role, the brief from stdin; no builder holds a bypass flag (grep and output)', () => {
  const opts = (role, a) => ({ role, sandbox: a.sandboxes[role], cwd: '/work/repo', promptFile: null, outFile: '/tmp/run.out', schemaFile: role === 'reviewer' ? '/plugin/review.schema.json' : null, model: null, effort: null });
  const codex = providers.BUILTINS.find((a) => a.bins.includes('codex'));
  assert.ok(codex, 'the codex adapter ships');
  assert.deepEqual(codex.sandboxes, { reviewer: 'read-only', implementer: 'workspace-write' });
  assert.deepEqual(codex.argv(opts('reviewer', codex)), ['codex', 'exec', '-s', 'read-only', '-C', '/work/repo', '--json', '-o', '/tmp/run.out', '--output-schema', '/plugin/review.schema.json', '-']);
  assert.deepEqual(codex.argv({ ...opts('implementer', codex), model: 'gpt-5' }), ['codex', 'exec', '-s', 'workspace-write', '-C', '/work/repo', '--json', '-o', '/tmp/run.out', '-m', 'gpt-5', '-']);
  for (const a of providers.BUILTINS) {
    for (const role of ['reviewer', 'implementer']) {
      const argv = a.argv(opts(role, a));
      assert.ok(argv.includes(a.sandboxes[role]), `${a.id} ${role}: the role's sandbox is passed`);
      for (const token of argv) assert.doesNotMatch(token, BYPASS, `${a.id} ${role}: ${token}`);
    }
  }
  // The builders' source: no string literal of any provider module names a bypass flag or mode.
  const dir = join(pluginDir, 'lib', 'providers');
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 4, 'the provider modules are scanned');
  for (const f of files) {
    const { literals } = lex(readFileSync(join(dir, f), 'utf8'));
    for (const s of literals.filter((x) => typeof x === 'string')) assert.doesNotMatch(s, BYPASS, `lib/providers/${f}: ${s}`);
  }
  // A declared generic adapter cannot carry one either.
  for (const bad of ['node x.js --dangerously-skip-permissions {cwd}', 'tool --yolo {cwd}', 'tool -s danger-full-access']) {
    assert.throws(() => generic.parseTemplate(bad), (err) => err.code === 'unsafe-mode', bad);
  }
  assert.throws(() => generic.parseSandboxMap('reviewer=read-only,implementer=danger-full-access'), (err) => err.code === 'unsafe-mode');
});

test('codex parse (recorded 0.160.0 JSONL): tokens without the cached part, the last line, failures and unknown events', () => {
  const codex = providers.BUILTINS.find((a) => a.bins.includes('codex'));
  const results = fixture('codex-review.jsonl').map((l) => codex.parse(l));
  const tokens = results.filter((r) => r.tokens).map((r) => r.tokens);
  assert.deepEqual(tokens, [{ input: 49557 - 24576, output: 81, cached: 24576 }]);
  const lines = results.map((r) => r.lastLine).filter(Boolean);
  assert.equal(lines[0], 'I’ll run `ls` once, then return the requested review.');
  assert.ok(lines.includes('$ /bin/zsh -lc ls'), 'a command shows as its command line');
  assert.equal(lines.at(-1), '{"verdict":"approved","reviewer":{"kind":"external","id":"codex"},"findings":[]}');
  assert.ok(results.every((r) => r.event !== 'unknown'), 'every recorded event is known');
  const failed = fixture('codex-failed.jsonl').map((l) => codex.parse(l));
  assert.equal(failed.filter((r) => r.error).at(-1).error, 'stream disconnected before completion: rate limit reached');
  assert.equal(codex.parse('{"type":"something.new"}').event, 'unknown');
  assert.equal(codex.parse('not json at all').event, 'unknown');
  assert.equal(codex.parse('{"type":"turn.completed"}').tokens, undefined, 'no usage, no tokens');
});

test('gemini parse (fixture only, U15): stream-json tokens and last line; auth is unknown without a probe', () => {
  const gemini = providers.BUILTINS.find((a) => a.bins.includes('gemini'));
  assert.ok(gemini, 'the gemini adapter ships');
  const results = fixture('gemini-stream.jsonl').map((l) => gemini.parse(l));
  assert.deepEqual(results.filter((r) => r.tokens).map((r) => r.tokens), [{ input: 1000, output: 300, cached: 200 }]);
  assert.equal(results.map((r) => r.lastLine).filter(Boolean).at(-1), 'Verdict: approved');
  assert.equal(gemini.auth({ env: {} }), 'unknown');
});

test('generic adapter: a whitespace template with {cwd} {sandbox} {out} {model}, a sandbox per role, plain lines', () => {
  const a = generic.fromEntry('mycli', { argv: 'mycli run --dir {cwd} --mode {sandbox} -o {out} {model}', sandboxMap: { reviewer: 'ro' } });
  assert.equal(a.id, 'mycli');
  assert.deepEqual(a.bins, ['mycli']);
  assert.deepEqual(a.sandboxes, { reviewer: 'ro' }, 'roles are the keys of the sandbox map');
  assert.deepEqual(a.argv({ role: 'reviewer', sandbox: 'ro', cwd: '/w', outFile: '/o', model: null }), ['mycli', 'run', '--dir', '/w', '--mode', 'ro', '-o', '/o']);
  assert.deepEqual(a.argv({ role: 'reviewer', sandbox: 'ro', cwd: '/w', outFile: '/o', model: 'm1' }), ['mycli', 'run', '--dir', '/w', '--mode', 'ro', '-o', '/o', 'm1']);
  assert.deepEqual(a.parse('  some output  '), { lastLine: 'some output' });
  assert.deepEqual(a.parse('   '), {});
  assert.equal(a.auth({ env: {} }), 'ok', 'a declared CLI is trusted as logged in');
  assert.deepEqual(generic.parseSandboxMap('reviewer=read-only,implementer=workspace-write'), { reviewer: 'read-only', implementer: 'workspace-write' });
  for (const bad of ['reviewer', 'boss=x', 'reviewer=a,reviewer=b', 'reviewer=has space']) assert.throws(() => generic.parseSandboxMap(bad), (err) => err.exit === 'USAGE', bad);
  for (const bad of ['', '   ', 'tool {unknown}', 'tool --x{cwd}']) assert.throws(() => generic.parseTemplate(bad), (err) => err.exit === 'USAGE', bad);
});

test('detection: PATH, --version and the auth probe, 2 s each; cached 1 h in plugin data; --refresh probes again', async (t) => {
  const s = scratch(t);
  fakeProgram(s, 'codex', "const a = process.argv.slice(2).join(' ');\nif (a === '--version') console.log('codex-cli 9.9.9');\nelse if (a === 'login status') console.log('Logged in using ChatGPT');\nelse process.exit(64);");
  fakeProgram(s, 'gemini', 'setTimeout(() => {}, 10000);'); // never answers --version
  const started = Date.now();
  const first = providers.detectProviders({ names, env: s.env });
  assert.ok(Date.now() - started < 6000, 'a probe that hangs ends at its 2 s limit');
  const row = (r, id) => r.rows.find((x) => x.id === id);
  assert.deepEqual({ ...row(first, 'codex'), path: null }, { id: 'codex', kind: 'builtin', found: true, path: null, version: '9.9.9', auth: 'ok', roles: ['reviewer', 'implementer'], sandboxes: ['read-only', 'workspace-write'], error: null });
  assert.equal(row(first, 'gemini').found, true);
  assert.equal(row(first, 'gemini').version, null);
  assert.match(row(first, 'gemini').error, /--version/);
  assert.equal(first.cached, false);
  assert.deepEqual(calls(s, 'codex'), ['--version', 'login status']);
  const again = providers.detectProviders({ names, env: s.env });
  assert.equal(again.cached, true, 'within 1 h the cache answers');
  assert.deepEqual(again.rows, first.rows);
  assert.equal(calls(s, 'codex').length, 2, 'no probe ran');
  const cache = JSON.parse(readFileSync(join(s.env.CLAUDE_PLUGIN_DATA, 'providers.json'), 'utf8'));
  assert.equal(cache.schema, 2); // schema 2: a generic entry may name its env (T-MG-86 B-6)
  const old = { ...cache, detected: { ...cache.detected, at: new Date(Date.now() - 61 * 60e3).toISOString() } };
  writeFileSync(join(s.env.CLAUDE_PLUGIN_DATA, 'providers.json'), JSON.stringify(old));
  assert.equal(providers.detectProviders({ names, env: s.env }).cached, false, 'an hour later it probes again');
  assert.equal(calls(s, 'codex').length, 4);
  const r = await cli(['providers', '--refresh'], { env: s.env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls(s, 'codex').length, 6, '--refresh probes again');
  assert.equal(r.e.data.rows.find((x) => x.id === 'codex').auth, 'ok');
  // Not logged in: found, auth missing; not on PATH: not found.
  fakeProgram(s, 'codex', "const a = process.argv.slice(2).join(' ');\nif (a === '--version') console.log('codex-cli 9.9.9');\nelse { console.log('Not logged in'); process.exit(1); }");
  rmSync(join(s.bin, 'gemini'));
  const now = providers.detectProviders({ names, env: s.env, refresh: true });
  assert.equal(row(now, 'codex').auth, 'missing');
  assert.equal(row(now, 'gemini').found, false);
  // doctor reads it without writing: no write when asked not to.
  const before = readFileSync(join(s.env.CLAUDE_PLUGIN_DATA, 'providers.json'), 'utf8');
  providers.detectProviders({ names, env: s.env, refresh: true, write: false });
  assert.equal(readFileSync(join(s.env.CLAUDE_PLUGIN_DATA, 'providers.json'), 'utf8'), before);
});

test('selection: role preferences filtered by detection and auth, the first wins; an explicit provider must be usable', () => {
  const rows = [
    { id: 'alpha', found: true, auth: 'missing', roles: ['reviewer', 'implementer'] },
    { id: 'beta', found: true, auth: 'ok', roles: ['reviewer'] },
    { id: 'gamma', found: true, auth: 'ok', roles: ['reviewer', 'implementer'] },
    { id: 'delta', found: false, auth: 'unknown', roles: ['reviewer', 'implementer'] },
    { id: 'eps', found: true, auth: 'unknown', roles: ['reviewer'] },
  ];
  const pick = (o) => providers.chooseProvider({ rows, ...o });
  assert.equal(pick({ role: 'reviewer' }).id, 'beta', 'default preference: registry order');
  assert.equal(pick({ role: 'implementer' }).id, 'gamma', 'a provider without the role is skipped');
  assert.equal(pick({ role: 'reviewer', preferences: { reviewer: ['gamma', 'beta'] } }).id, 'gamma');
  assert.equal(pick({ role: 'reviewer', preferences: { reviewer: ['alpha', 'delta'] } }).id, 'beta', 'unusable preferences fall through to the others');
  assert.equal(pick({ role: 'reviewer', explicit: 'eps' }).id, 'eps', 'an explicit provider with an unknown auth may run');
  for (const [o, code] of [[{ role: 'reviewer', explicit: 'alpha' }, 'provider-not-logged-in'], [{ role: 'reviewer', explicit: 'delta' }, 'provider-missing'],
    [{ role: 'implementer', explicit: 'beta' }, 'provider-role'], [{ role: 'reviewer', explicit: 'zeta' }, 'provider-unknown']]) {
    assert.throws(() => pick(o), (err) => err.code === code && (code === 'provider-unknown' || code === 'provider-role' ? err.exit === 'USAGE' : err.exit === 'ENV'), code);
  }
  assert.throws(() => providers.chooseProvider({ rows: rows.slice(0, 1), role: 'reviewer' }), (err) => err.code === 'no-provider' && err.exit === 'ENV');
});

test('the dispatch code never names a provider: the selection holds no adapter ID', () => {
  const ids = providers.BUILTINS.map((a) => a.id);
  const dir = join(pluginDir, 'lib', 'providers');
  const dispatch = ['select.mjs'];
  for (const f of dispatch) {
    assert.ok(existsSync(join(dir, f)), `lib/providers/${f} exists`);
    const text = readFileSync(join(dir, f), 'utf8');
    for (const id of ids) assert.doesNotMatch(text, new RegExp(`\\b${id}\\b`, 'i'), `lib/providers/${f} names ${id}`);
  }
});

test('providers add declares a generic adapter in plugin data; providers lists it; bad declarations are usage errors', async (t) => {
  const s = scratch(t);
  const add = (args) => cli(['providers', 'add', ...args, '--yes'], { env: s.env });
  const ok = await add(['mycli', '--argv', 'node tool.js {cwd} {sandbox} {out}', '--sandbox-map', 'reviewer=ro,implementer=rw']);
  assert.equal(ok.code, 0, JSON.stringify(ok.e));
  const doc = JSON.parse(readFileSync(join(s.env.CLAUDE_PLUGIN_DATA, 'providers.json'), 'utf8'));
  assert.deepEqual(Object.keys(doc.generic), ['mycli']);
  assert.equal(doc.generic.mycli.argv, 'node tool.js {cwd} {sandbox} {out}');
  assert.deepEqual(doc.generic.mycli.sandboxMap, { reviewer: 'ro', implementer: 'rw' });
  const list = await cli(['providers'], { env: s.env });
  assert.equal(list.code, 0);
  const mine = list.e.data.rows.find((x) => x.id === 'mycli');
  assert.deepEqual([mine.kind, mine.found, mine.auth, mine.roles], ['generic', true, 'ok', ['reviewer', 'implementer']]);
  for (const [args, code] of [
    [['Bad-Id', '--argv', 'node x {cwd}', '--sandbox-map', 'reviewer=ro'], 'invalid-value'],
    [[providers.BUILTINS[0].id, '--argv', 'node x {cwd}', '--sandbox-map', 'reviewer=ro'], 'provider-builtin'],
    [['other', '--argv', 'node x --yolo', '--sandbox-map', 'reviewer=ro'], 'unsafe-mode'],
    [['other', '--sandbox-map', 'reviewer=ro'], 'missing-flag'],
  ]) {
    const r = await add(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${JSON.stringify(r.e)}`);
    assert.equal(r.e.errors[0].code, code);
  }
});
