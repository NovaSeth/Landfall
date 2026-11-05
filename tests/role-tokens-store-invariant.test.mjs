// Role tokens are never stored or logged (tokens.mjs, SEC-13, D-MG-81): after the mint and block flows, no file under the
// state's local/ or the plugin data holds a minted token or the token prefix; the guard's block log redacts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirName = readdirSync(join(root, 'plugins')).find((d) => existsSync(join(root, 'plugins', d, 'lib', 'name.json')));
const pluginDir = join(root, 'plugins', dirName);
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const load = (p) => import(pathToFileURL(join(pluginDir, 'lib', p)).href);
const { guardBash } = await load('hooks/guard-bash.mjs');
const { runHook } = await load('hooks/registry.mjs');
const { sessionStart } = await load('hooks/session-start.mjs');
const { subagentStart } = await load('hooks/subagent-start.mjs');
const { identify } = await load('sched/machine.mjs');

const PFX = ['lf', '1_'].join('');
const TOK = new RegExp(`${PFX}[A-Za-z0-9_-]{43}`);
const home = realpathSync(mkdtempSync(join(tmpdir(), 'rti-home-')));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rti-repo-')));
const pd = join(home, 'pd');
mkdirSync(pd);
const env = { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_DATA: pd, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const run = (cmd, args) => spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8' });
const denied = (r) => /"permissionDecision":"deny"/.test(r.stdout ?? '');
const files = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)])) : []);

run('git', ['init', '-q', '-b', 'main']);
run('git', ['config', 'user.email', 't@example.com']);
run('git', ['config', 'user.name', 'T']);
writeFileSync(join(repo, 'a.txt'), 'x\n');
run('git', ['add', '.']);
run('git', ['commit', '-qm', 'init']);
const ini = run(join(pluginDir, 'bin', 'landfall'), ['init', '--yes']);
assert.equal(ini.status, 0, ini.stdout + ini.stderr);
const host = { pid: process.pid, start: identify([process.pid]).get(process.pid).start };
const ctx = JSON.parse(sessionStart({ cwd: repo, session_id: 's1' }, { env, host }).stdout || '{}').hookSpecificOutput?.additionalContext ?? '';
const orch = TOK.exec(ctx)?.[0];
const rev = TOK.exec(subagentStart({ cwd: repo, session_id: 's1', agent_id: 'a1', agent_type: `${names.plugin}:reviewer` }, { env, host }).stdout)?.[0];

test('no role token lands under the state local directory or the plugin data', () => {
  assert.ok(orch && rev, 'both tokens minted');
  const sub = guardBash({ tool_name: 'Bash', cwd: repo, agent_type: `${names.plugin}:reviewer`, session_id: 's1', tool_input: { command: `printf %s ${rev} | landfall review record T-PA-1 --from r.md --token -` } }, { env, autoAllow: 'off' });
  assert.ok(denied(sub), 'the reviewer command is blocked');
  guardBash({ tool_name: 'Bash', cwd: repo, session_id: 's1', tool_input: { command: `printf %s ${orch} | rm -rf /` } }, { env, autoAllow: 'off' });
  for (const f of [...files(join(repo, names.stateDir, 'local')), ...files(pd)]) {
    const t = readFileSync(f, 'utf8');
    assert.ok(!t.includes(PFX) && !t.includes(orch) && !t.includes(rev), `${f} holds a token`);
  }
});

test("the guard's block log redacts the token prefix", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rti-log-')));
  const t = `${PFX}${'A'.repeat(43)}`;
  guardBash({ tool_name: 'Bash', cwd: repo, agent_type: `${names.plugin}:implementer`, tool_input: { command: `echo ${t} ${t}` } }, { env: { ...env, CLAUDE_PLUGIN_DATA: dir }, autoAllow: 'off' });
  const line = readFileSync(join(dir, 'shadow.jsonl'), 'utf8');
  assert.ok(line.includes(`${PFX}<redacted>`), line);
  assert.ok(!line.includes(`${PFX}A`), line);
});

test('a subagent does not read the plugin data directory; the main session does', () => {
  const f = join(pd, 'shadow.jsonl');
  writeFileSync(f, '{}\n');
  const sub = (tool, tool_input) => ({ tool_name: tool, cwd: repo, agent_type: `${names.plugin}:implementer`, tool_input });
  for (const i of [sub('Read', { file_path: f }), sub('Grep', { pattern: 'x', path: pd }), sub('Glob', { pattern: '*', path: pd })]) {
    assert.ok(denied(runHook('guard-read', JSON.stringify(i), { env })), JSON.stringify(i));
  }
  assert.ok(denied(guardBash(sub('Bash', { command: `cat ${f}` }), { env, autoAllow: 'off', shadowLog() {} })));
  const { agent_type: _a, ...main } = sub('Read', { file_path: f });
  assert.ok(!denied(runHook('guard-read', JSON.stringify(main), { env })));
  assert.ok(!denied(guardBash({ ...main, tool_name: 'Bash', tool_input: { command: `cat ${f}` } }, { env, autoAllow: 'off', shadowLog() {} })));
});
