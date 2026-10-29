// The Bash guard against the 2.4.0 audit (T-MG-70): a linear prescan (A-1), a globbed or substituted git subcommand
// (A-2), an empty substitution inside a state path (A-3), assignments after their use (SF-AB-2), an unreadable
// guard-extra.txt next to the state (SF-AB-3) and a linear glob matcher (SF-AB-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv({ identity: false });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = readdirSync(join(root, 'plugins')).map((d) => join(root, 'plugins', d)).find((d) => existsSync(join(d, 'lib', 'name.json')));
const names = JSON.parse(readFileSync(join(plugin, 'lib', 'name.json'), 'utf8'));
const LAUNCHER = join(plugin, 'bin', names.bin);
const lib = (rel) => import(pathToFileURL(join(plugin, 'lib', rel)).href);
const { evaluate } = await lib('guard/index.mjs');
const { prescan, stripParams } = await lib('guard/tokens.mjs');
const { expandLiterals } = await lib('guard/tokenizer.mjs');
const { globRe, globReaches } = await lib('guard/protect.mjs');

const S = names.stateDir;
function repoWithState() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'g-audit-')));
  spawnSync('git', ['init', '-q', '-b', 'feat', repo]);
  spawnSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const dir = join(repo, S);
  mkdirSync(join(dir, 'tasks', 'T-1'), { recursive: true });
  return { repo, dir };
}
const { repo, dir } = repoWithState();
const opts = { cwd: repo, state: { dir, repo }, readProjectMode: () => 'solo', readGuardExtra: () => null };
const verdict = (cmd, o = opts) => evaluate(cmd, o);
const denied = (cmd, o) => verdict(cmd, o).deny ?? null;
const timed = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };

// ---------- A-1 ----------
const TAIL = '; git push --force origin main';
const LONG = `echo ${'rm '.repeat(Math.floor((65536 - 5 - TAIL.length) / 3))}${TAIL}`;

test('A-1: the real hook denies the 65534-character rm filler with a push in under 2000 ms', () => {
  assert.ok(LONG.length <= 65536 && LONG.length > 65000, String(LONG.length));
  const input = JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: LONG }, cwd: repo });
  const t = performance.now();
  const r = spawnSync(process.execPath, [LAUNCHER, 'hook', 'guard-bash'], { input, encoding: 'utf8', timeout: 5000, env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
  const ms = performance.now() - t;
  assert.equal(r.signal, null, `killed after ${Math.round(ms)} ms`);
  const deny = r.status === 2 || (r.stdout && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny');
  assert.ok(deny, `no deny: exit ${r.status} ${r.stdout} ${r.stderr}`);
  assert.ok(ms < 2000, `${Math.round(ms)} ms`);
});

// Adversarial 64 KiB inputs for every pattern the fix changed (prescan tokens, the gate line, the state git rewrite,
// assignments, the brace alternatives, the glob matcher).
const K = 65536;
const fill = (unit, head = '', tail = '') => head + unit.repeat(Math.floor((K - head.length - tail.length) / unit.length)) + tail;
const ADVERSARIAL = {
  'rm filler (RM_RECURSIVE)': fill('rm ', 'echo ', ' x!'),
  'rm flag (RM_RECURSIVE option)': fill('r', 'rm -', '!'),
  'find filler (FIND_DELETE)': fill('find ', 'echo ', ' x!'),
  'bin filler in a pipe (GATE_LINE)': fill(`${names.bin} `, 'echo a | ', ' x!'),
  'git options (GIT_REWRITE)': fill('-x /git ', 'git '),
  'assignment with spaces (ASSIGN)': fill(' ', 'A=', 'x'),
  'for with spaces (FOR)': fill(' ', 'for x in a; do ', 'x'),
  'brace commas (globReaches)': fill(',', 'cp x {', ''),
  'default operator run (variants)': fill('-', 'echo ${x:', ''),
  'include run (include.path)': fill('include.', 'echo ', ''),
  'many references (substitute)': fill('$a', 'a=1; echo ', ''),
};
for (const [name, text] of Object.entries(ADVERSARIAL)) {
  test(`linearity: ${name} on 64 KiB finishes in under 200 ms`, () => {
    let ms = timed(() => prescan(text, [S]));
    assert.ok(ms < 200, `prescan ${Math.round(ms)} ms`);
    ms = timed(() => expandLiterals(text));
    assert.ok(ms < 200, `expandLiterals ${Math.round(ms)} ms`);
    ms = timed(() => globReaches(text, S));
    assert.ok(ms < 200, `globReaches ${Math.round(ms)} ms`);
    ms = timed(() => { try { evaluate(text, { ...opts, deadline: performance.now() + 150 }); } catch { /* a verdict only */ } });
    assert.ok(ms < 400, `evaluate ${Math.round(ms)} ms`);
  });
}

// ---------- A-2 ----------
test('A-2: a glob or a substitution in the git subcommand is a guarded hit and is blocked', () => {
  for (const cmd of ['git pu?h --force origin main', 'git com?it -n -m x', 'git pu$(:)sh --force origin main', 'git st*']) {
    assert.ok(prescan(cmd).size > 0, `no hit: ${cmd}`);
    assert.ok(denied(cmd), `allowed: ${cmd}`);
  }
  assert.match(denied('git pu?h --force origin main'), /subcommand literally/);
  for (const cmd of ['git status', 'git log --oneline -3', `git -C ${repo} diff`]) assert.equal(denied(cmd), null, cmd);
});

// ---------- A-3 ----------
test('A-3: an empty substitution inside a state path is blocked like the plain path', () => {
  assert.match(denied(`cp /tmp/forged ${S}/tasks/T-1/verify.json`), /FLW-7/);
  const split = `cp /tmp/forged ${S.slice(0, 5)}$(:)${S.slice(5)}/tas$(:)ks/T-1/veri$(:)fy.json`;
  assert.ok(prescan(split, [S]).size > 0, 'no hit');
  assert.ok(denied(split), `allowed: ${split}`);
  assert.ok(denied(`echo '{}' > ${S.slice(0, 5)}$(:)${S.slice(5)}/tas$(:)ks/T-1/ta$(:)sk.json`));
  assert.ok(denied(`cp /tmp/f ${S.slice(0, 5)}\`:\`${S.slice(5)}/tasks/T-1/verify.json`));
});

// ---------- SF-AB-2 ----------
test('SF-AB-2: an assignment after its use is no literal value of the earlier reference', () => {
  assert.ok(denied('git push origin HEAD:"$DEST"; DEST=topic'), 'allowed');
  assert.match(denied('DEST=main; git push origin HEAD:"$DEST"'), /PRI-1/);
  assert.equal(expandLiterals('echo $A; A=x'), 'echo $A; A=x');
  assert.equal(expandLiterals('A=x; echo $A'), 'echo x');
});

// ---------- SF-AB-3 ----------
test('SF-AB-3: an unreadable guard-extra.txt keeps the state protection', () => {
  const broken = { ...opts, readGuardExtra: () => { const e = new Error('ELOOP'); e.code = 'ELOOP'; throw e; } };
  assert.ok(denied(`echo x > ${S}/config.json`, broken), 'allowed');
  assert.ok(denied(`cp /tmp/f ${S}/tasks/T-1/verify.json`, broken), 'allowed');
  assert.ok(denied('git push --force origin main', broken));
  assert.equal(denied('echo hi', broken), null);
});

// ---------- SF-AB-4 ----------
test('SF-AB-4: the glob matcher is linear and keeps the bash semantics', () => {
  const ms = timed(() => assert.equal(globRe(`${'*a'.repeat(20)}b`)('a'.repeat(80)), false));
  assert.ok(ms < 50, `${Math.round(ms)} ms`);
  const cases = [['*', 'abc', true], ['*', '.x', false], ['.*', '.x', true], ['a?c', 'abc', true], ['a?c', 'ac', false],
    ['[ab]x', 'bx', true], ['[!ab]x', 'bx', false], ['[!ab]x', 'cx', true], ['[a-c]*', 'cz', true], ['*.json', 'task.json', true],
    ['*.json', 'task.jso', false], ['t*k*.json', 'task.json', true], ['a*b*c', 'aXbYc', true], ['a*b*c', 'aXbY', false], ['[x', '[x', true],
    ['a.b', 'axb', false], ['*', '', true], ['**', 'x', true], ['?', '', false]];
  for (const [p, s, want] of cases) assert.equal(globRe(p)(s), want, `${p} ~ ${s}`);
  assert.equal(globRe('*', { dots: true })('.x'), true);
  assert.equal(globRe('*', { dots: true })('..'), false);
});

// ---------- fix round 1 (review r1) ----------
test('F1: a quoted or escaped parenthesis inside a substitution does not end it early', () => {
  const at = (body) => `cp /tmp/f ${S.slice(0, 5)}$(${body})${S.slice(5)}/tas$(:)ks/T-1/veri$(:)fy.json`;
  for (const body of [": '('", ': "("', ': \\(', ": '$('", ': "a)b"', ": `echo ')'`", ': $(: ")")']) {
    const cmd = at(body);
    assert.ok(prescan(cmd, [S]).size > 0, `no hit: ${cmd}`);
    assert.ok(denied(cmd), `allowed: ${cmd}`);
  }
  // a substitution only inside single quotes is text, not a substitution
  assert.equal(denied("echo '$(rm -rf /)'"), null);
});

test('F1: a substitution without a certain end is a guarded hit and is blocked', () => {
  for (const cmd of [`cp /tmp/f ${S.slice(0, 5)}$(: '(${S.slice(5)}/tasks/T-1/verify.json`, 'echo $(: "', 'echo `: x']) {
    assert.ok(prescan(cmd).size > 0, `no hit: ${cmd}`);
    assert.ok(denied(cmd), `allowed: ${cmd}`);
  }
  assert.ok(prescan('echo $(case x in a) echo y;; esac)').size > 0, 'case inside a substitution');
});

test('F2: repeated unclosed parameter syntax is linear and the real hook denies 21000 repeats in under 1000 ms', () => {
  const ms8 = timed(() => prescan(`echo '${'${['.repeat(16000)}'`));
  assert.ok(ms8 < 100, `prescan ${Math.round(ms8)} ms`);
  for (const unit of ['${[', '${#[', '${x:-', '${x[']) {
    const ms = timed(() => prescan(fill(unit, "echo '", "'")));
    assert.ok(ms < 200, `${unit}: ${Math.round(ms)} ms`);
  }
  const cmd = `echo '${'${['.repeat(21000)}'${TAIL}`;
  const input = JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd: repo });
  const t = performance.now();
  const r = spawnSync(process.execPath, [LAUNCHER, 'hook', 'guard-bash'], { input, encoding: 'utf8', timeout: 5000, env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
  const ms = performance.now() - t;
  const deny = r.status === 2 || (r.stdout && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny');
  assert.ok(deny, `no deny: exit ${r.status} ${r.stdout} ${r.stderr}`);
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
});

test('F2: the parameter scanner keeps the default-value semantics', () => {
  for (const [cmd, tok] of [['echo ${x:-push}', 'push'], ['echo ${x:=commit}', 'commit'], ['echo ${#[x}stash', 'stash'], ['echo ${a[1]:-push}', 'push']]) {
    assert.ok(prescan(cmd).has(tok), `${cmd}: ${[...prescan(cmd)]}`);
  }
  // the scanner gives what the former regex gave
  const OLD = /\$\{[#!]?\w*(?:\[[^\]]*\])?(?::?[-=+?#%/^,]+(?![-=+?#%/^,])([^}]*))?\}/g;
  for (const t of ['${x:-push}', '${#}', '${#x}', '${!x}', '${#-x}', '${#[x}', '${a[1]}', '${a[1]:-v}', '${a[}', '${x:}', '${x:-}', '${x', '${x:-a',
    '${x/a/b}', '${x^^}', '${x,,}', '${x%%.*}', '${x##*/}', '${x:?err}', '${x+alt}', '${#x[@]}', '${x:-${y}}', 'a${b}c${d:-e}f', '${[x]}', '${}',
    '$${x}', '${x:-a}b}', '${#[a]}', '${#[a]:-q}', '${!#}', '${##}', '${x[a]b}', '${${x}}']) {
    assert.equal(stripParams(t), t.replace(OLD, '$1'), t);
  }
});

test('F3: the glob matcher is bounded on the long-prefix family and fails closed past its caps', () => {
  const n = 8192;
  const match = globRe(`*${'a'.repeat(n)}b`);
  const ms = timed(() => assert.equal(match('a'.repeat(2 * n)), true)); // past the 4096 cap: a hit
  assert.ok(ms < 50, `${Math.round(ms)} ms`);
  const m2 = globRe(`*${'a'.repeat(200)}b`);
  const ms2 = timed(() => assert.equal(m2('a'.repeat(4000)), false));
  assert.ok(ms2 < 50, `${Math.round(ms2)} ms`);
  const m3 = globRe(`*${'a?'.repeat(100)}b`);
  const ms3 = timed(() => assert.equal(m3('a'.repeat(4096)), false));
  assert.ok(ms3 < 50, `${Math.round(ms3)} ms`);
  assert.equal(globRe(`${'x'.repeat(257)}*`)('y'), true, 'a glob longer than 256 characters is a hit');
  assert.equal(globRe('*.json')(`${'a'.repeat(4097)}.txt`), true, 'a name longer than 4096 characters is a hit');
  for (const [p, s, want] of [['a*a', 'a', false], ['a*a', 'aa', true], ['*ab*ab', 'abab', true], ['*ab*ab', 'aba', false],
    ['x*?y', 'xy', false], ['x*?y', 'xzy', true], ['*[ab]c*', 'zzbc', true], ['a*b?c*d', 'aXbYcZd', true], ['a*b?c*d', 'abcd', false]]) {
    assert.equal(globRe(p)(s), want, `${p} ~ ${s}`);
  }
});
