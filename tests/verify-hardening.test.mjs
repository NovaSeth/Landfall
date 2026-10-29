// Hardening of verify (T-MG-75, audit D2, D7, D8).
//   D2  gate output is redacted with the built-in patterns and the project's secrets-patterns.txt before it reaches
//       --json output, the log, the gate cache or the pinned baseline (baseline pin included).
//   D7  a gate-cache entry carries an HMAC made with a machine key: a hand-written entry is no entry; verify of a
//       critical task never reuses an entry; task merge reuses an authenticated one.
//   D8  review record --from and report --from read through the safe reader (a FIFO is refused, not waited for).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isolatedEnv } from './helpers/isolated-env.mjs';
import { lib, names } from './helpers/hook-fixture.mjs';
import { trustWith } from './helpers/trust.mjs';

const profile = await lib('profile/index.mjs');
const state = await lib('state/index.mjs'); // trustWith (T-MG-83)
const { main } = await lib('cli/main.mjs');

const IDENTITY = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "1 passing"}\n---\n\n# Report\n';
// split so that this file holds no secret of its own
const BUILT_IN = `AK${'IA'}ABCDEFGHIJKLMNOP`;
const PROJECT = `ZZPRJ-${'4815162'}3`;
const CALC_SECRET = `import { test } from 'node:test';\ntest('adds ${BUILT_IN} ${PROJECT}', () => {});\n`;

function git(cwd, env, args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const show = (r) => JSON.stringify(r.out ?? r).slice(0, 1500);

async function cli(args, { cwd, env }) {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main([...args, '--json'], { io });
  const text = out.join('');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { code, out: parsed, raw: text };
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

const CALC = "import { test } from 'node:test';\ntest('adds', () => {});\n";

async function fresh(t, { gateCmd, calc = CALC } = {}) {
  const iso = isolatedEnv({ gitConfig: IDENTITY, prefix: 'verify-hard-' });
  t.after(iso.cleanup);
  const env = iso.env;
  const repo = join(iso.base, 'main');
  const wt = join(iso.base, 'wt');
  const counter = join(iso.base, 'counter');
  mkdirSync(repo);
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  put(join(repo, 'README.md'), '# x\n');
  put(join(repo, 'calc.test.mjs'), calc);
  git(repo, env, ['add', '-A']);
  git(repo, env, ['commit', '-q', '-m', 'base']);
  const stateDir = join(iso.base, 'control', 'state');
  const p = { env, repo, wt, stateDir, counter, base: iso.base };
  p.run = (args, where = 'main') => cli(args, { cwd: where === 'wt' ? wt : repo, env });
  assert.equal((await p.run(['init', '--yes', '--state-dir', stateDir])).code, 0);
  p.gate = (cmd) => {
    profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd, timeoutS: 120, kind: 'test' }] });
    trustWith(state, stateDir, names, env);
  };
  p.gate(gateCmd ?? `echo run >> ${counter} && node --test`);
  p.head = git(repo, env, ['rev-parse', 'HEAD']).trim();
  git(repo, env, ['worktree', 'add', '-q', wt, '-b', 'feature']);
  p.task = async (where = 'main') => {
    const id = (await p.run(['task', 'new', 'Hard', '--yes'], where)).out.data.id;
    assert.equal((await p.run(['task', 'set', id, 'dispatched', '--executor', 'claude', '--base', p.head, '--yes'], where)).code, 0);
    assert.equal((await p.run(['route', id, '--paths', 'README.md', '--loc', '1', '--yes'], where)).code, 0);
    put(join(stateDir, 'tasks', id, 'report.md'), REPORT);
    return id;
  };
  p.commit = (where, rel, text) => {
    const dir = where === 'wt' ? wt : repo;
    put(join(dir, rel), text);
    git(dir, env, ['add', rel]);
    git(dir, env, ['commit', '-q', '-m', `change ${rel}`]);
  };
  p.runs = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
  p.cacheFiles = () => (existsSync(join(stateDir, 'local', 'gate-cache')) ? readdirSync(join(stateDir, 'local', 'gate-cache')).map((f) => join(stateDir, 'local', 'gate-cache', f)) : []);
  return p;
}

const leaks = (p, extra = '') => {
  const found = [];
  for (const file of walk(p.stateDir)) {
    if (file.endsWith('/profile.json')) continue; // the gate command itself holds them
    const text = readFileSync(file, 'utf8');
    for (const secret of [BUILT_IN, PROJECT]) if (text.includes(secret)) found.push(`${file.slice(p.stateDir.length)}: ${secret.slice(0, 5)}`);
  }
  if (extra.includes(BUILT_IN)) found.push('output: built-in');
  if (extra.includes(PROJECT)) found.push('output: project');
  return found;
};

// the gate command holds the secrets in pieces, so only its output has them whole
const SECRET_GATE = `printf 'token %s%s\\n' ${BUILT_IN.slice(0, 6)} ${BUILT_IN.slice(6)}; printf '%s%s\\n' ${PROJECT.slice(0, 6)} ${PROJECT.slice(6)}; node --test`;

test('D2: baseline pin redacts built-in and project secrets from its output and the baseline it writes', async (t) => {
  const p = await fresh(t, { gateCmd: SECRET_GATE, calc: CALC_SECRET });
  put(join(p.stateDir, 'secrets-patterns.txt'), 'ZZPRJ-[0-9]{8}\n');
  const d = await p.run(['decide', '--kind', 'gate-change', '--title', 'pin', '--why', 'repair', '--cost', 'none', '--yes']);
  assert.equal(d.code, 0, show(d));
  const pin = await p.run(['baseline', 'pin', '--decision', d.out.data.id, '--yes']);
  assert.equal(pin.code, 0, show(pin));
  assert.ok(pin.out.data.output.length > 0, 'the pin reports the gate output');
  assert.deepEqual(leaks(p, pin.raw), [], 'no secret in the output or in the state');
});

test('D2: verify redacts the project secret in its log, output and gate cache', async (t) => {
  const p = await fresh(t, { gateCmd: SECRET_GATE });
  put(join(p.stateDir, 'secrets-patterns.txt'), 'ZZPRJ-[0-9]{8}\n');
  const id = await p.task();
  p.commit('main', 'README.md', '# y\n');
  const v = await p.run(['verify', id, '--yes']);
  assert.ok(v.out, show(v));
  assert.ok(existsSync(join(p.stateDir, 'local', 'verify', `${id}.log`)), 'the log exists');
  assert.deepEqual(leaks(p, v.raw), []);
});

// A repository whose task passed verify once (the entry is stored).
async function primed(t) {
  const p = await fresh(t);
  const id = await p.task();
  p.commit('main', 'README.md', '# y\n');
  assert.equal((await p.run(['verify', id, '--yes'])).code, 0);
  assert.equal(p.cacheFiles().length, 1, 'an entry is stored');
  return { p, id };
}

test('D7: a hand-written entry without a valid MAC is not reused, one with the machine key MAC is', async (t) => {
  const { p, id } = await primed(t);
  const [file] = p.cacheFiles();
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  assert.match(String(entry.mac), /^[0-9a-f]{64}$/, 'the entry carries a MAC');
  for (const forged of [{ ...entry, mac: undefined }, { ...entry, mac: 'a'.repeat(64) }, { ...entry, runs: entry.runs.map((r) => ({ ...r, tail: ['forged'] })) }]) {
    writeFileSync(file, JSON.stringify(forged, null, 2));
    const n = p.runs();
    const v = await p.run(['verify', id, '--yes']);
    assert.equal(v.code, 0, show(v));
    assert.ok(p.runs() > n, 'the gate ran');
    assert.equal(v.out.data.reusedFrom ?? null, null);
  }
  const n = p.runs();
  const again = await p.run(['verify', id, '--yes']);
  assert.equal(p.runs(), n, 'the entry verify rewrote is reused');
  assert.ok(again.out.data.reusedFrom, show(again));
});

test('D7: the machine key is a 32-byte file with mode 0600 in the plugin data', async (t) => {
  const { p } = await primed(t);
  const keys = walk(join(p.base, 'home')).filter((f) => f.includes('/plugins/data/')).filter((f) => statSync(f).size === 32);
  assert.equal(keys.length, 1, `one 32-byte key file under CLAUDE_PLUGIN_DATA: ${keys}`);
  assert.equal(statSync(keys[0]).mode & 0o777, 0o600);
});

test('D7: an entry written by verify is reused by task merge for the same tree', async (t) => {
  const p = await fresh(t);
  const id = await p.task('wt');
  p.commit('wt', 'README.md', '# y\n');
  const v = await p.run(['verify', id, '--yes'], 'wt');
  assert.equal(v.code, 0, show(v));
  assert.equal((await p.run(['task', 'done', id, '--yes'], 'wt')).code, 0);
  const n = p.runs();
  const m = await p.run(['task', 'merge', id, '--branch', 'feature', '--yes']);
  assert.equal(m.code, 0, show(m));
  assert.equal(p.runs(), n, 'the merge reused the stored runs');
});

test('D7: verify of a critical task runs the gates even with a valid entry', async (t) => {
  const { p, id } = await primed(t);
  assert.equal((await p.run(['route', id, '--paths', 'README.md', '--loc', '1', '--flags', 'security', '--yes'])).code, 0);
  const n = p.runs();
  const v = await p.run(['verify', id, '--yes']);
  assert.equal(v.out.data.class, 'critical', show(v));
  assert.ok(p.runs() > n, 'the gate ran again');
  assert.equal(v.out.data.reusedFrom ?? null, null);
});

test('D8: review record and report refuse a FIFO without waiting for it', { timeout: 30000 }, async (t) => {
  const p = await fresh(t);
  const id = await p.task();
  const fifo = join(p.base, 'pipe');
  if (spawnSync('mkfifo', [fifo]).status !== 0) return t.skip('no mkfifo on this platform');
  const r = await p.run(['review', 'record', id, '--from', fifo, '--yes']);
  assert.equal(r.code, 2, show(r));
  assert.equal(r.out.errors[0].code, 'review-unreadable');
  const rep = await p.run(['report', id, '--from', fifo, '--yes']);
  assert.equal(rep.code, 2, show(rep));
  assert.equal(rep.out.errors[0].code, 'report-unreadable');
});

// Fix round 1 (review r1, F1 F3 F4 F5).
const redactLib = await lib('verify/redact.mjs');
const secretsLib = await lib('secrets/index.mjs');

test('F1: a project pattern that matches its own mask ends (redaction never re-matches the replacement)', (t) => {
  const iso = isolatedEnv({ prefix: 'verify-hard-redact-' });
  t.after(iso.cleanup);
  const href = new URL(`file://${join(dirname(new URL(import.meta.url).pathname), '..', 'plugins', 'landfall', 'lib')}/`).href;
  const script = `const r = await import(${JSON.stringify(`${href}verify/redact.mjs`)}); const s = await import(${JSON.stringify(`${href}secrets/index.mjs`)});
const out = r.redact('a tok_1234567890123456 b', s.projectPatterns('tok_.*').patterns); process.stdout.write(out);`;
  const c = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 1500, env: iso.env });
  assert.equal(c.error?.code ?? null, null, 'redact ended within 1500 ms');
  assert.equal(c.status, 0, c.stderr);
  assert.ok(!c.stdout.includes('1234567890123456'), c.stdout);
  assert.match(c.stdout, /^a tok_\*{8} \(\d+ chars\)$/);
});

test('F1: overlapping and repeated matches are each masked once, on the original text', () => {
  const extra = secretsLib.projectPatterns('ZZPRJ-[0-9]{8}\n').patterns;
  const out = redactLib.redact(`x ${PROJECT} y ${PROJECT} ${BUILT_IN}`, extra);
  assert.ok(!out.includes('48151623') && !out.includes(BUILT_IN.slice(4)), out);
  assert.equal(out.match(/\*{8}/g).length, 3, out);
});

function patternDir(t, bytes) {
  const d = join(spawnSync('mktemp', ['-d']).stdout.toString().trim());
  t.after(() => spawnSync('rm', ['-rf', d]));
  if (bytes !== null) writeFileSync(join(d, 'secrets-patterns.txt'), bytes);
  return d;
}

test('F3: a UTF-8 project pattern redacts the UTF-8 secret it names', (t) => {
  const d = patternDir(t, Buffer.from('żeton-[0-9]{8}\n', 'utf8'));
  const extra = redactLib.projectRedactions({ dir: d });
  assert.equal(extra.length, 1);
  const out = redactLib.redact('key żeton-12345678 end é', extra);
  assert.ok(!out.includes('12345678'), out);
  assert.ok(out.endsWith(' end é'), `the rest of the line keeps its characters: ${out}`);
});

test('F4: no pattern file is no project pattern; an unreadable or invalid one is refused', (t) => {
  assert.deepEqual(redactLib.projectRedactions({ dir: patternDir(t, null) }), []);
  const asDir = patternDir(t, null);
  mkdirSync(join(asDir, 'secrets-patterns.txt'));
  const invalid = patternDir(t, 'ok-[0-9]+\n(unclosed\n');
  for (const d of [asDir, invalid]) {
    assert.throws(() => redactLib.projectRedactions({ dir: d }), (err) => err.code === 'project-patterns-unreadable' && err.exit === 'FAIL'
      && err.message.includes('secrets-patterns.txt'), d);
  }
});

test('F4: verify and baseline pin refuse an invalid pattern file before any gate runs', async (t) => {
  const p = await fresh(t);
  const id = await p.task();
  p.commit('main', 'README.md', '# y\n');
  put(join(p.stateDir, 'secrets-patterns.txt'), '(unclosed\n');
  const v = await p.run(['verify', id, '--yes']);
  assert.equal(v.code, 1, show(v));
  assert.equal(v.out.errors[0].code, 'project-patterns-unreadable', show(v));
  const d = await p.run(['decide', '--kind', 'gate-change', '--title', 'pin', '--why', 'repair', '--cost', 'none', '--yes']);
  const pin = await p.run(['baseline', 'pin', '--decision', d.out.data.id, '--yes']);
  assert.equal(pin.code, 1, show(pin));
  assert.equal(pin.out.errors[0].code, 'project-patterns-unreadable', show(pin));
  assert.equal(p.runs(), 0, 'no gate ran');
});

test('F5: a change of the project pattern file reruns the gates instead of reusing the cache', async (t) => {
  const { p, id } = await primed(t);
  const n = p.runs();
  assert.ok((await p.run(['verify', id, '--yes'])).out.data.reusedFrom, 'the same patterns reuse the entry');
  assert.equal(p.runs(), n);
  put(join(p.stateDir, 'secrets-patterns.txt'), 'ZZPRJ-[0-9]{8}\n');
  const v = await p.run(['verify', id, '--yes']);
  assert.equal(v.code, 0, show(v));
  assert.ok(p.runs() > n, 'the gate ran again');
  assert.equal(v.out.data.reusedFrom ?? null, null);
});

// Fix round 2 (review r2, F6): a merged span is masked completely, no prefix of one pattern inside another's match.
test('F6: overlapping matches of two patterns are masked completely (no visible prefix)', () => {
  const extra = secretsLib.projectPatterns('4826\n[0-9]{16}').patterns;
  const out = redactLib.redact('4826123456789012', extra);
  assert.ok(!/[0-9]/.test(out.replace(/\(\d+ chars\)/g, '')), out);
  assert.match(out, /^\*{8,} \(16 chars\)$/);
});

test('F6: three overlapping patterns are masked completely over the union', () => {
  const extra = secretsLib.projectPatterns('48261\n1234567890\n6789012').patterns;
  const out = redactLib.redact('id 4826123456789012 end', extra);
  assert.ok(!/[0-9]/.test(out.replace(/\(\d+ chars\)/g, '')), out);
  assert.match(out, /^id \*{8,} \(16 chars\) end$/);
});

// T-MG-83 fix round 1 (review r1, F1 F2): redaction never prints more than the bounded scanner sees.
test('T-MG-83 F1: a value longer than the bounded probe is masked to its end, not only its first 1024 bytes', () => {
  const out = redactLib.redact(`pre password="${'A'.repeat(1100)}SYNTH_END" post`);
  assert.ok(!out.includes('SYNTH_END'), out.slice(-80));
  assert.ok(!out.includes('AAAA'), 'no part of the value shows');
  assert.ok(out.startsWith('pre '), out.slice(0, 40));
});

test('T-MG-83 F1: a line the scanner marks sensitive but no span covers is masked to its end', () => {
  // A JWT header longer than the regex bound: the scanner's separator-anchored probe finds it, the span regex does not.
  const line = `x eyJ${'A'.repeat(4085)}.eyJ${'B'.repeat(20)}SYNTHTAIL`;
  assert.ok(secretsLib.matchLine(line), 'the scanner marks the line');
  const out = redactLib.redact(line);
  assert.ok(!out.includes('SYNTHTAIL') && !out.includes('AAAA'), out.slice(-80));
});

test('T-MG-83 F2: a project pattern match after the first 4096 bytes of a line is masked', () => {
  const extra = secretsLib.projectPatterns('synth_custom_[A-Z]+').patterns;
  const out = redactLib.redact(`${'.'.repeat(4096)}synth_custom_PRIVATE`, extra);
  assert.ok(!out.includes('PRIVATE'), out.slice(-80));
});

test('T-MG-83 F2: a project pattern match straddling a window edge is masked, far into a long line', () => {
  const extra = secretsLib.projectPatterns('synth_custom_[A-Z]+').patterns;
  for (const at of [4090, 2048 * 5 - 7, 4096 * 7 - 10, 100000]) {
    const out = redactLib.redact(`${'.'.repeat(at)}synth_custom_PRIVATE ${'.'.repeat(5000)}`, extra);
    assert.ok(!out.includes('PRIVATE'), `at ${at}: ${out.slice(at - 20, at + 60)}`);
    // Intended change (fix round 3): a long line with a hit is one whole-line marker; no part of it is kept.
    assert.match(out, WHOLE_LINE, 'a long line with a hit is masked whole');
  }
});

test('T-MG-83 F2: a line longer than 1 MiB without a hit is kept as it is (no truncation)', () => {
  // Intended change (fix round 3): detection runs over the whole line; a long line with no hit is kept whole.
  const extra = secretsLib.projectPatterns('synth_custom_[A-Z]+').patterns;
  const line = `${'.'.repeat(1024 * 1024 + 10)}tail_visible`;
  assert.equal(redactLib.redact(line, extra), line);
});

// T-MG-83 fix round 3 (review r2 F1-F3, automated review AR-1 AR-2): a line longer than 4096 bytes with any hit is
// masked whole as one marker, so no window edge or cut shows a byte of the secret.
const WHOLE_LINE = /^\[redacted: \d+ chars, secret detected\]$/;
const noByteOf = (out, secret) => {
  for (let i = 0; i + 4 <= secret.length; i++) assert.ok(!out.includes(secret.slice(i, i + 4)), `"${secret.slice(i, i + 4)}" shows`);
};

test('T-MG-83 r2 F1: a JWT the span regex cannot see is masked even when another span matches the line', () => {
  const out = redactLib.redact(`safe x eyJ${'A'.repeat(4085)}.eyJ${'B'.repeat(20)}SYNTHTAIL`, secretsLib.projectPatterns('safe').patterns);
  assert.ok(!out.includes('SYNTHTAIL') && !out.includes('AAAA') && !out.includes('BBBB'), out.slice(-80));
  assert.match(out, WHOLE_LINE);
});

test('T-MG-83 r2 F2: a project match longer than a window is masked whole', () => {
  const out = redactLib.redact(`synth_custom_${'A'.repeat(5000)}SYNTH_END`, secretsLib.projectPatterns('synth_custom_[A-Z_]+').patterns);
  assert.ok(!out.includes('SYNTH_END') && !out.includes('AAAA'), out.slice(-80));
  assert.match(out, WHOLE_LINE);
});

test('T-MG-83 AR-1: a project match that runs past a window end shows no byte of it', () => {
  const extra = secretsLib.projectPatterns('synth_custom_[A-Z_]+').patterns;
  for (const at of [4090, 2048 * 3 - 5]) {
    const secret = `synth_custom_${'Q'.repeat(3000)}SYNTH_END`;
    const out = redactLib.redact(`${'.'.repeat(at)}${secret} after`, extra);
    noByteOf(out, secret);
    assert.match(out, WHOLE_LINE, `at ${at}`);
  }
});

test('T-MG-83 r2 F3 and AR-2: a key across the 1 MiB mark shows no byte of it', () => {
  for (const before of [1048566, 1024 * 1024 - 5, 1024 * 1024 + 3]) {
    const out = redactLib.redact(`${'.'.repeat(before)}AKIAABCDEFGHIJKLMNOP`); // SYNTH
    noByteOf(out, 'AKIAABCDEFGHIJKLMNOP'); // SYNTH
    assert.match(out, WHOLE_LINE, `at ${before}`);
  }
});

test('T-MG-83 r2: a long line masked whole leaves the other lines of the text as they are', () => {
  const out = redactLib.redact(`first\n${'.'.repeat(5000)}AKIAABCDEFGHIJKLMNOP\nlast`); // SYNTH
  const [a, b, c] = out.split('\n');
  assert.equal(a, 'first');
  assert.match(b, WHOLE_LINE);
  assert.equal(c, 'last');
});
