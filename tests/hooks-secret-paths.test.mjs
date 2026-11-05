// Secret-path protection (SEC-13, spec 2026-11-05 D3, A8, A9, D-MG-81): a subagent (agent_type set) reads no Claude Code transcript
// and no file of the plugin data, through Read, Grep, Glob or Bash; the state's local/ holds no secret and is not a root. The main session is unchanged.
// Commands and paths are data: nothing here runs them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirName = readdirSync(join(root, 'plugins')).find((d) => existsSync(join(root, 'plugins', d, 'lib', 'name.json')));
const pluginDir = join(root, 'plugins', dirName);
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const { runHook } = await import(pathToFileURL(join(pluginDir, 'lib', 'hooks', 'registry.mjs')).href);
const { guardBash } = await import(pathToFileURL(join(pluginDir, 'lib', 'hooks', 'guard-bash.mjs')).href);

const home = realpathSync(mkdtempSync(join(tmpdir(), 'sp-home-')));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sp-repo-')));
const git = (...a) => assert.equal(spawnSync('git', a, { cwd: repo }).status, 0);
git('init', '-q', '-b', 'main');
const state = join(repo, names.stateDir);
mkdirSync(join(state, 'local', 'session'), { recursive: true });
writeFileSync(join(state, 'state.json'), '{}');
writeFileSync(join(state, 'local', 'token.json'), '{}');
const projects = join(home, '.claude', 'projects');
const transcript = join(projects, '-p', 's1.jsonl');
mkdirSync(dirname(transcript), { recursive: true });
writeFileSync(transcript, '{"lf1_":1}\n');
symlinkSync(join(state, 'local', 'token.json'), join(repo, 'link-token'));
symlinkSync(projects, join(repo, 'link-projects'));
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' };
delete env.CLAUDE_CONFIG_DIR;
const SUB = `${names.plugin}:implementer`;

const base = (tool, tool_input, sub = true, extra = {}) => ({ tool_name: tool, cwd: repo, transcript_path: transcript, ...(sub ? { agent_type: SUB } : {}), tool_input, ...extra });
const denied = (r) => /"permissionDecision":"deny"/.test(r.stdout ?? '');
const read = (input) => runHook('guard-read', typeof input === 'string' ? input : JSON.stringify(input), { env });
const bash = (command, sub = true) => guardBash(base('Bash', { command }, sub), { state: null, autoAllow: 'off', shadowLog() {}, env });
const REASON = "SEC-13: blocked: a subagent does not read Claude Code transcripts or the plugin's data files. Instead work from your brief and the repository.";

test('Read, Grep and Glob on a protected root are denied for a subagent with the exact reason', () => {
  const r = read(base('Read', { file_path: transcript }));
  assert.ok(denied(r), r.stdout);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, REASON);
  for (const [tool, input] of [
    ['Grep', { pattern: 'a', path: projects }],
    ['Glob', { pattern: '**/*.jsonl', path: projects }],
    ['Glob', { pattern: `${projects}/**/*.jsonl` }],
    ['Read', { file_path: join(repo, 'link-projects', '-p', 's1.jsonl') }],
    ['Read', { file_path: relative(repo, transcript) }],
    ['Read', { file_path: '~/.claude/projects/-p/s1.jsonl' }],
    ['Read', { file_path: '$HOME/.claude/projects/-p/s1.jsonl' }],
    ['Read', { file_path: '${HOME}/.claude/projects/-p/s1.jsonl' }],
    ['Grep', { pattern: 'lf1_', path: home }],
    ['Grep', { pattern: 'lf1_', path: '/' }],
    ['Glob', { pattern: '*', path: '~' }],
  ]) assert.ok(denied(read(base(tool, input))), `${tool} ${JSON.stringify(input)}`);
});

test('the transcripts directory comes from transcript_path, else CLAUDE_CONFIG_DIR, else the home', () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'sp-cfg-')));
  mkdirSync(join(other, 'projects', 'p'), { recursive: true });
  const f = join(other, 'projects', 'p', 'a.jsonl');
  const noPath = { tool_name: 'Read', cwd: repo, agent_type: SUB, tool_input: { file_path: f } };
  assert.ok(denied(runHook('guard-read', JSON.stringify(noPath), { env: { ...env, CLAUDE_CONFIG_DIR: other } })));
  assert.ok(!denied(runHook('guard-read', JSON.stringify(noPath), { env })));
  assert.ok(denied(runHook('guard-read', JSON.stringify({ ...noPath, tool_input: { file_path: transcript } }), { env })));
  assert.ok(denied(read(base('Read', { file_path: f }, true, { transcript_path: join(other, 'projects', 'p', 'b.jsonl') }))));
});

test('ordinary reads pass for a subagent, and everything passes for the main session', () => {
  writeFileSync(join(repo, 'a.txt'), 'x');
  for (const [tool, input] of [['Read', { file_path: join(repo, 'a.txt') }], ['Read', { file_path: 'a.txt' }], ['Grep', { pattern: 'x' }],
    ['Grep', { pattern: 'x', path: repo }], ['Glob', { pattern: '*.txt' }], ['Glob', { pattern: join(repo, '*.txt') }]]) {
    assert.ok(!denied(read(base(tool, input))), `${tool} ${JSON.stringify(input)}`);
  }
  for (const [tool, input] of [['Read', { file_path: transcript }], ['Grep', { pattern: 'a', path: home }], ['Read', { file_path: join(repo, 'link-token') }]]) {
    assert.ok(!denied(read(base(tool, input, false))), `main ${tool}`);
  }
});

test('malformed input is allowed; a relative target with a relative cwd, and an unresolvable path inside a root, are denied', () => {
  for (const text of ['', 'not json', '[]', '{"agent_type":5}', JSON.stringify({ agent_type: SUB }), JSON.stringify(base('Read', { file_path: 5 })), JSON.stringify(base('Read', {}))]) {
    assert.ok(!denied(read(text)), text);
  }
  assert.ok(denied(read({ ...base('Read', { file_path: 'x.txt' }), cwd: 'relative/dir' })));
  symlinkSync(join(projects, 'loop'), join(projects, 'loop')); // a link loop inside a root
  assert.ok(denied(read(base('Read', { file_path: join(projects, 'loop', 'x') }))));
});

test('the Bash read corpus is denied for a subagent and allowed for the main session', () => {
  const corpus = [
    `cat ${transcript}`, 'cat ~/.claude/projects/-p/s1.jsonl', 'cat $HOME/.claude/projects/-p/s1.jsonl', 'cat ${HOME}/.claude/projects/x',
    `cat ${home}/.claude/projects/-p/s1.jsonl`, 'grep -r lf1_ ~', 'grep -rn foo $HOME', 'echo lf1_abc',
    'find / -name "*.jsonl"', `find ${home} -type f`, 'rg secret ~', 'ls -R ~/.claude', `tar cf - ${home}`,
    'cat "$(echo ~/.claude/projects/x)"', 'cat ~/.cl*/projects/-p/s1.jsonl', 'cat ~/.claude/pro{jects,x}/-p/s1.jsonl',
  ];
  for (const c of corpus) {
    const r = bash(c);
    assert.ok(denied(r), `subagent: ${c}`);
    assert.match(r.stdout, /SEC-13: blocked: a subagent does not read Claude Code transcripts/, c);
    assert.ok(!/SEC-13: blocked: a subagent does not read/.test(bash(c, false).stdout), `main: ${c}`);
  }
  const eval_ = bash('eval "$X" ~/.claude');
  assert.ok(denied(eval_), 'unreducible and names .claude');
});

test('daily subagent commands still pass', () => {
  for (const c of ['ls', 'ls *', 'grep -rn foo src', 'grep -rn foo .', 'find . -name "*.mjs"', 'cat a.txt', 'git status', 'rg x', 'ls -R src']) {
    assert.ok(!/SEC-13: blocked: a subagent does not read/.test(bash(c).stdout), c);
  }
});

// Fix round 1 (security review r1 F1-F3, Codex review r2 F1-F6). The state lives in the repository here (the hard case).
const sd = (...p) => join(state, 'local', ...p);
const RE = /SEC-13: blocked: a subagent does not read/;
const cmdDenied = (c, sub = true) => RE.test(bash(c, sub).stdout);

test("the state's local directory is not a root: root recursive readers and the review diff pass (D-MG-81)", () => {
  for (const [tool, input] of [['Grep', { pattern: '.', path: sd() }], ['Glob', { pattern: sd('*') }], ['Read', { file_path: sd('review', 'T-AA-1-r1.diff') }],
    ['Read', { file_path: sd('verify', 'T-AA-1.log') }], ['Read', { file_path: sd('token.json') }], ['Grep', { pattern: '.', path: repo }]]) {
    assert.ok(!denied(read(base(tool, input))), `${tool} ${JSON.stringify(input)}`);
  }
  for (const c of ['grep -r tok .', 'find . -type f -exec cat {} +', 'tar cf - .', `cp -r . ${tmpdir()}/scratch`, `cat ${names.stateDir}/local/token.json`]) assert.ok(!cmdDenied(c), c);
  for (const [tool, input] of [['Grep', { pattern: '.', path: home }], ['Read', { file_path: transcript }]]) assert.ok(denied(read(base(tool, input))), tool);
});

test('r1 F2 / r2 F2, F4: every word of a subagent command is resolved (globs, cd chain, links, shell bodies, redirections)', () => {
  const tp = `${home}/.claude/projects/-p`;
  for (const c of [`cat ${tp}/s1.j*`, `cat ${tp}/s?.jsonl`, `cd ${tp} && cat s1.jsonl`, 'cat link-projects/-p/s1.jsonl', `cat ${tp}/./s1.jsonl`,
    `head -c 5 ${tp}/s1.jsonl`, `cat < ${tp}/s1.jsonl`, `cd ${home}/.claude && cat projects/-p/s1.jsonl`, `sed -n 1p ${tp}/s1.jsonl`,
    `bash -c "grep -r . ${home}"`, `cd ${home}; grep -r . .`, `bash -c 'cat ${tp}/s1.jsonl'`, `grep -r . ${tp}`, `cat ${home}/.claude/p*/-p/s1.jsonl`]) {
    assert.ok(cmdDenied(c), `subagent: ${c}`);
    assert.ok(!cmdDenied(c, false), `main: ${c}`);
  }
  for (const c of ['cat README.md', 'ls tests', 'git status', `cd ${names.stateDir} && cat state.json`, `cat ${names.stateDir}/local/token.json`, 'bash -c "ls src"']) assert.ok(!cmdDenied(c), c);
});

test('r2 F3: a nested subagent transcript still protects the whole transcripts directory', () => {
  const nested = join(projects, '-p', 's1', 'subagents', 'agent-abc.jsonl');
  assert.ok(denied(read(base('Read', { file_path: transcript }, true, { transcript_path: nested }))));
  assert.ok(denied(read(base('Read', { file_path: join(projects, '-q', 'z.jsonl') }, true, { transcript_path: nested }))));
});

// F3 (r1): the eight tests of the deleted tests/hooks-guard-roles.test.mjs (D-MG-78) and what covers them now:
//  'a subagent cannot dispatch' · 'review record needs the reviewer or security-reviewer agent' · 'the reviewer keeps the plain
//  record' → tests/role-tokens-forge.test.mjs (the CLI refuses a forged role; the tokens test records and dispatches);
//  'the main session is unchanged' · 'without agent_type every form is allowed' → the main-session cases of this file;
//  'malformed input allows' → the malformed-input test above; 'quoting, wrappers and unresolvable lines' → the forge corpus
//  (every spelling) and `eval "$X" ~/.claude` in the Bash corpus above; 'the role gate stays fast' → tests/perf-hooks.test.mjs.

// Fix round 2 (security review r3 F1; the cheap fail-closed text rules).
const sn = names.stateDir;
const allDenied = (cmds) => { for (const c of cmds) { assert.ok(cmdDenied(c), `subagent: ${c}`); assert.ok(!cmdDenied(c, false), `main: ${c}`); } };

test('r3 F1: the state directory is no root and no ancestor of one; the repository root stays allowed (D-MG-81)', () => {
  for (const c of [`grep -rn tok ${sn}`, `rg . ${sn}`, `ls -R ${sn}`, `find ${sn} -type f`, 'grep -r . .', 'grep -rn foo src']) assert.ok(!cmdDenied(c), c);
  assert.ok(!denied(read(base('Grep', { pattern: '.', path: sn }))));
  assert.ok(!denied(read(base('Grep', { pattern: '.' }))));
});

test('round 2: a word naming the transcripts is denied in any spelling', () => {
  allDenied([`ls --path=${projects}/-p`, `ls -d@${projects}`, `cat @${projects}/x`, `ls -f${projects}/x`,
    `X=${projects}; ls $X`, 'cat ~/.claude//projects/x', `cat ${projects}//-p/s1.jsonl`, `cat ${home}/.claude/./projects/z`]);
  assert.ok(!cmdDenied(`cat ${sn}/state.json`));
});

test('round 2: cd and pushd skip options; an unknown directory fails closed; wrappers do not hide cd or a shell body', () => {
  const ch = `${home}/.claude`;
  allDenied([`cd -- ${ch} && cat projects/-p/s1.jsonl`, `cd -P ${ch} && cat projects/-p/s1.jsonl`, `pushd ${ch} >/dev/null && cat projects/-p/s1.jsonl`,
    `builtin cd ${ch} && cat projects/-p/s1.jsonl`, `command cd ${ch} && cat projects/-p/s1.jsonl`,
    'cd && cat x.txt', 'cd - && cat x.txt', 'cd "$X"; cat x.txt', 'cd $(pwd)/.. && cat x.txt']);
  for (const w of ['env', 'nice -n 5', 'nohup', 'timeout 5', 'command', 'builtin', 'exec', 'stdbuf -o0', 'xargs', 'sudo', 'env A=1']) {
    allDenied([`${w} bash -c 'cat ${ch}/p*/-p/s1.jsonl'`, `${w} sh -c 'cat pro*/-p/s1.jsonl' ; ${w} cd ${ch} && ${w} cat pro*/-p/s1.jsonl`]);
  }
  assert.ok(!cmdDenied('cd src && cat a.txt') && !cmdDenied('cd - && ls') && !cmdDenied('env FOO=1 ls src'));
});

test('round 2: an inline interpreter body naming .claude is denied', () => {
  allDenied(['python -c "print(open(\'.claude/x\').read())"', 'perl -e \'open F,"~/.claude/x"\'', 'ruby -e \'File.read(".claude/x")\'',
    'node -e "require(\'fs\').readFileSync(process.env.HOME+\'/.claude/x\')"']);
  assert.ok(!cmdDenied('python3 -c "print(1)"') && !cmdDenied('node -e "console.log(2)"') && !cmdDenied(`python -c "import os;os.listdir('${sn}/local')"`));
});
