// Secret-path protection (SEC-13, spec 2026-11-05 D3, A8, A9): a subagent (agent_type set) reads no Claude Code transcript and
// no token or session file of the plugin's state, through Read, Grep, Glob or Bash. The main session is unchanged.
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
const REASON = "SEC-13: blocked: a subagent does not read Claude Code transcripts or the plugin's token and session files. Instead work from your brief and the repository.";

test('Read, Grep and Glob on a protected root are denied for a subagent with the exact reason', () => {
  const r = read(base('Read', { file_path: transcript }));
  assert.ok(denied(r), r.stdout);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, REASON);
  for (const [tool, input] of [
    ['Read', { file_path: join(state, 'local', 'token.json') }],
    ['Read', { file_path: join(state, 'local', 'session', 'x.json') }],
    ['Grep', { pattern: 'a', path: projects }],
    ['Grep', { pattern: 'a', path: join(state, 'local', 'session') }],
    ['Glob', { pattern: '**/*.jsonl', path: projects }],
    ['Glob', { pattern: `${projects}/**/*.jsonl` }],
    ['Read', { file_path: join(repo, 'link-token') }],
    ['Read', { file_path: join(repo, 'link-projects', '-p', 's1.jsonl') }],
    ['Read', { file_path: 'link-token' }],
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
  mkdirSync(join(state, 'local', 'session'), { recursive: true });
  symlinkSync(join(state, 'local', 'session', 'loop'), join(state, 'local', 'session', 'loop')); // a link loop
  assert.ok(denied(read(base('Read', { file_path: join(state, 'local', 'session', 'loop', 'x') }))));
});

test('the Bash read corpus is denied for a subagent and allowed for the main session', () => {
  const corpus = [
    `cat ${transcript}`, 'cat ~/.claude/projects/-p/s1.jsonl', 'cat $HOME/.claude/projects/-p/s1.jsonl', 'cat ${HOME}/.claude/projects/x',
    `cat ${home}/.claude/projects/-p/s1.jsonl`, 'grep -r lf1_ ~', 'grep -rn foo $HOME', 'echo lf1_abc', `cat ${join(state, 'local', 'token.json')}`,
    `cat ${names.stateDir}/local/token.json`, 'find / -name "*.jsonl"', `find ${home} -type f`, 'rg secret ~', 'ls -R ~/.claude', `tar cf - ${home}`,
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
