// Capability flags (spec §14, SD-38, §8.2 `flags show|set <cap> off|shadow|on`): the rollout capabilities with their
// defaults, the repository's config.json and the machine overrides in plugin data. `flags set` needs consent and records
// each flip as a decision. A capability that is off is the rollback: its commands return REFUSED naming the flag (once,
// in the CLI dispatcher: a row's `capability`) and its hooks pass through (once, in the hook registry: a hook's
// `capability`). In shadow the engine logs a proposed tier change to local/shadow.jsonl through store.append.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
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
const { COMMANDS } = await lib('cli/commands.mjs');
const { HOOKS, runHook } = await lib('hooks/registry.mjs');
const { ROLLOUT } = await lib('config/index.mjs');
const BIN = names.bin;
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
async function cli(args, { cwd, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, out: json ? JSON.parse(stdout) : stdout, stderr: err.join('') };
}
const show = (r) => `exit ${r.code}\n${typeof r.out === 'string' ? r.out : JSON.stringify(r.out)}\n${r.stderr}`;

// An active repository whose signals call for tier L1 (5,000 source lines), under a throwaway HOME and plugin data.
async function repository(t, { active = true } = {}) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'flags-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(join(repo, 'src', 'a'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a', 'big.js'), Array.from({ length: 5000 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['add', '-A']);
  git(repo, env, ['commit', '-q', '-m', 'start']);
  const p = { base: iso.base, data: env.CLAUDE_PLUGIN_DATA, repo: realpathSync(repo), cwd: repo, env, state: join(realpathSync(repo), names.stateDir) };
  p.ok = async (args) => {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 0, `${args.join(' ')}\n${show(r)}`);
    return r;
  };
  if (active) await p.ok(['init']);
  return p;
}
const config = (p) => (existsSync(join(p.state, 'config.json')) ? JSON.parse(readFileSync(join(p.state, 'config.json'), 'utf8')) : null);
const decisions = (p) => (existsSync(join(p.state, 'decisions')) ? readdirSync(join(p.state, 'decisions')).sort() : []);
const shadowLines = (p) => {
  const f = join(p.state, 'local', 'shadow.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const bash = (p, command) => runHook('guard-bash', JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: p.repo }),
  { deadline: Infinity, env: { ...p.env, CLAUDE_PROJECT_DIR: p.repo }, shadowLog: () => {} });
// A new session each time: the hook shows a decision once per file and session.
let sessions = 0;
const edit = (p, file) => runHook('decisions-context', JSON.stringify({ session_id: `e${++sessions}`, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file }, cwd: p.repo }),
  { deadline: Infinity, env: { ...p.env, CLAUDE_PROJECT_DIR: p.repo } });

test('flags show: every rollout capability with its spec §14 default, then the team flags; repository and machine sources', async (t) => {
  const p = await repository(t);
  const r = await cli(['flags', 'show'], p);
  assert.equal(r.code, 0, show(r));
  const want = { 'guard-bash': 'on', 'auto-allow': 'shadow', engine: 'shadow', admission: 'shadow', 'edit-retrieval': 'on', headroom: 'shadow', 'executor-ui': 'off' };
  assert.deepEqual(Object.fromEntries(ROLLOUT.map((c) => [c.name, c.default])), want, 'the defaults of spec §14');
  for (const [name, mode] of Object.entries(want)) assert.deepEqual([r.out.data.flags[name].mode, r.out.data.flags[name].source], [mode, 'default'], name);
  assert.equal(r.out.data.flags.lanes.mode, null, 'a team flag nobody set: the tier offers it');
  const text = await cli(['flags', 'show'], { ...p, json: false });
  assert.match(text.out, /^ {2}engine +shadow +default /m);
  assert.match(text.out, /^ {2}lanes +unset /m);
  // The machine override wins over the repository for a rollout capability; a team flag there is ignored, and said so.
  mkdirSync(p.data, { recursive: true });
  writeFileSync(join(p.data, 'config.json'), JSON.stringify({ schema: 1, flags: { engine: 'on', lanes: 'on' } }));
  const m = await cli(['flags', 'show'], p);
  assert.deepEqual([m.out.data.flags.engine.mode, m.out.data.flags.engine.source], ['on', 'machine']);
  assert.equal(m.out.data.flags.lanes.mode, null);
  assert.deepEqual(m.out.data.ignored, ['lanes']);
  // An inactive repository shows the defaults and writes nothing; flags set is refused there.
  const q = await repository(t, { active: false });
  assert.equal((await cli(['flags', 'show'], q)).out.data.flags.engine.mode, 'shadow');
  const refused = await cli(['flags', 'set', 'engine', 'off', '--yes'], q);
  assert.equal(refused.code, 7, show(refused));
  assert.equal(existsSync(q.state), false, 'nothing written in an inactive repository');
});

test('flags set: consent, a known capability and a mode it has; each flip writes a decision, the same value writes nothing', async (t) => {
  const p = await repository(t);
  const noConsent = await cli(['flags', 'set', 'engine', 'off'], p);
  assert.equal(noConsent.code, 7, show(noConsent));
  assert.equal(noConsent.out.errors[0].code, 'consent-required');
  for (const [args, code] of [[['flags', 'set', 'warp-drive', 'on'], 'unknown-capability'], [['flags', 'set', 'engine', 'maybe'], 'invalid-mode'],
    [['flags', 'set', 'guard-bash', 'shadow'], 'invalid-mode'], [['flags', 'set', 'lanes', 'shadow'], 'invalid-mode']]) {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 2, `${args.join(' ')}\n${show(r)}`);
    assert.equal(r.out.errors[0].code, code, args.join(' '));
  }
  assert.equal(config(p), null, 'refusals wrote nothing');
  assert.deepEqual(decisions(p), []);
  const r = await p.ok(['flags', 'set', 'engine', 'off', '--reason', 'tier flaps on this repository']);
  assert.deepEqual(config(p).flags, { engine: 'off' });
  assert.deepEqual(decisions(p), ['D-TU-1.md']);
  const record = readFileSync(join(p.state, 'decisions', 'D-TU-1.md'), 'utf8');
  assert.match(record, /^title: "Capability engine: shadow \(default\) → off"$/m);
  assert.match(record, /tier flaps on this repository/);
  assert.equal(r.out.data.decision, 'D-TU-1');
  const again = await p.ok(['flags', 'set', 'engine', 'off']);
  assert.equal(again.out.data.decision, null, 'unchanged: no decision');
  assert.deepEqual(decisions(p), ['D-TU-1.md']);
  await p.ok(['flags', 'set', 'lanes', 'on']);
  assert.deepEqual(config(p).flags, { engine: 'off', lanes: 'on' });
  assert.deepEqual(decisions(p), ['D-TU-1.md', 'D-TU-2.md']);
  const shown = await cli(['flags', 'show'], p);
  assert.deepEqual([shown.out.data.flags.engine.mode, shown.out.data.flags.engine.source], ['off', 'repo']);
});

test('engine off: tier returns REFUSED naming the flag (the dispatcher, before consent); shadow logs the proposed change through store.append (acceptance 1)', async (t) => {
  const p = await repository(t);
  await p.ok(['flags', 'set', 'engine', 'off']);
  const tier = await cli(['tier'], p);
  assert.equal(tier.code, 7, show(tier));
  assert.equal(tier.out.errors[0].code, 'capability-off');
  assert.match(tier.out.errors[0].message, /\bengine\b.*flags\.engine/);
  assert.match(tier.out.errors[0].hint, new RegExp(`${BIN} flags set engine`));
  assert.deepEqual(shadowLines(p), [], 'off: nothing evaluated, nothing logged');
  // The status view says so in a line instead of refusing.
  const status = await cli(['status'], p);
  assert.equal(status.code, 0, show(status));
  assert.equal(status.out.data.tier, null);
  // A machine override can turn it off on this machine only, whatever the repository says.
  await p.ok(['flags', 'set', 'engine', 'shadow']);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(join(p.data, 'config.json'), JSON.stringify({ schema: 1, flags: { engine: 'off' } }));
  assert.equal((await cli(['tier'], p)).code, 7, 'machine override off');
  writeFileSync(join(p.data, 'config.json'), JSON.stringify({ schema: 1 }));
  const shadow = await p.ok(['tier']);
  assert.deepEqual([shadow.out.data.mode, shadow.out.data.change, shadow.out.data.written], ['shadow', { from: 'L0', to: 'L1' }, 'shadow']);
  const log = shadowLines(p);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].capability, log[0].event, log[0].status, log[0].from, log[0].to], ['engine', 'tier', 'proposed', 'L0', 'L1']);
  // The refusal is the dispatcher's, for any row: a fixture command of a capability that is off never loads.
  await p.ok(['flags', 'set', 'headroom', 'off']);
  let loaded = 0;
  const fixture = [{ name: 'probe', summary: 'x', details: [], args: [], flags: [], exits: ['OK', 'REFUSED'], capability: 'headroom', load: async () => { loaded++; return () => ({ text: 'ran\n' }); } }];
  const out = [];
  const code = await main(['probe', '--json'], { commands: fixture, io: { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env: p.env, cwd: p.cwd, stdin: null } });
  assert.deepEqual([code, JSON.parse(out.join('')).errors[0].code, loaded], [7, 'capability-off', 0]);
  // Every row that names a capability names a rollout capability and lists REFUSED.
  const gated = COMMANDS.filter((row) => row.capability);
  assert.ok(gated.some((row) => row.name === 'tier' && row.capability === 'engine'));
  for (const row of gated) {
    assert.ok(ROLLOUT.some((c) => c.name === row.capability), row.name);
    assert.ok(row.exits.includes('REFUSED'), `${row.name} lists REFUSED`);
  }
});

test('a capability that is off: its hooks pass through (guard-bash, edit-retrieval, set off on this machine), the state-file protection stays', async (t) => {
  const p = await repository(t);
  assert.equal(JSON.parse(bash(p, 'git stash').stdout).hookSpecificOutput.permissionDecision, 'deny', 'on: the guard blocks');
  await p.ok(['decide', '--title', 'Keep big.js flat', '--why', 'Readers grep it.', '--cost', 'Slower edits.', '--scope', 'src/**']);
  const file = join(p.repo, 'src', 'a', 'big.js');
  assert.match(edit(p, file).stdout, /additionalContext/, 'on: the decision is shown before the edit');
  await p.ok(['flags', 'set', 'guard-bash', 'off', '--local']);
  assert.deepEqual(bash(p, 'git stash'), { stdout: '' }, 'off: the guard hook passes every command');
  await p.ok(['flags', 'set', 'edit-retrieval', 'off', '--local']);
  assert.equal(edit(p, file).stdout, '', 'off: no decision context');
  const owned = JSON.parse(edit(p, join(p.state, 'state.json')).stdout).hookSpecificOutput;
  assert.equal(owned.permissionDecision, 'deny', 'the state-file protection is not part of edit-retrieval');
  // Registry rows: each capability is a rollout capability; the hooks that carry one.
  const byName = Object.fromEntries(HOOKS.map((h) => [h.name, h.capability ?? null]));
  assert.equal(byName['guard-bash'], 'guard-bash');
  assert.equal(byName['decisions-context'], 'edit-retrieval');
  for (const h of HOOKS.filter((x) => x.capability)) assert.ok(ROLLOUT.some((c) => c.name === h.capability), h.name);
  // A config that cannot be read keeps the default: the guard stays on (a broken file never turns a guard off).
  await p.ok(['flags', 'set', 'guard-bash', 'on', '--local']);
  await p.ok(['flags', 'set', 'engine', 'on']);
  writeFileSync(join(p.state, 'config.json'), '{ not json');
  assert.equal(JSON.parse(bash(p, 'git stash').stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('auto-allow follows its flag: on allows an own read command, off logs nothing; the user option still turns it off', async (t) => {
  const p = await repository(t);
  const own = `${BIN} status`;
  const log = [];
  const hook = (env = {}) => runHook('guard-bash', JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: own }, cwd: p.repo }),
    { deadline: Infinity, env: { ...p.env, CLAUDE_PROJECT_DIR: p.repo, ...env }, shadowLog: (e) => log.push(e) });
  assert.equal(hook().stdout, '', 'shadow (default): no decision');
  assert.equal(log.length, 1, 'shadow: logged');
  await p.ok(['flags', 'set', 'auto-allow', 'on', '--local']);
  assert.equal(JSON.parse(hook().stdout).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(hook({ CLAUDE_PLUGIN_OPTION_AUTO_ALLOW_OWN_COMMANDS: 'false' }).stdout, '', 'the user option off wins');
  await p.ok(['flags', 'set', 'auto-allow', 'off', '--local']);
  assert.equal(hook().stdout, '');
  assert.equal(log.length, 1, 'off: nothing logged');
});

test('a committed config.json never lowers a protective capability; this machine\'s override does; flags show reports both values (acceptance 8)', async (t) => {
  const p = await repository(t);
  // What a clone of someone else's repository can carry: protective capabilities lowered, the engine off.
  writeFileSync(join(p.state, 'config.json'), JSON.stringify({ schema: 1, flags: { 'guard-bash': 'off', 'auto-allow': 'on', 'edit-retrieval': 'off', engine: 'off' } }));
  assert.equal(JSON.parse(bash(p, 'git stash').stdout).hookSpecificOutput.permissionDecision, 'deny', 'the guard still blocks');
  const log = [];
  const own = runHook('guard-bash', JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `${BIN} status` }, cwd: p.repo }),
    { deadline: Infinity, env: { ...p.env, CLAUDE_PROJECT_DIR: p.repo }, shadowLog: (e) => log.push(e) });
  assert.equal(own.stdout, '', 'auto-allow stays at its default (shadow): no allow without a prompt');
  assert.equal(log.length, 1);
  await p.ok(['decide', '--title', 'Keep big.js flat', '--why', 'Readers grep it.', '--cost', 'Slower edits.', '--scope', 'src/**']);
  assert.match(edit(p, join(p.repo, 'src', 'a', 'big.js')).stdout, /additionalContext/, 'decisions are still shown');
  assert.equal((await cli(['tier'], p)).code, 7, 'an ordinary capability follows the repository');
  let s = await cli(['flags', 'show'], p);
  assert.deepEqual(s.out.data.flags['guard-bash'], { ...s.out.data.flags['guard-bash'], mode: 'on', source: 'default', repo: 'off' });
  assert.deepEqual(s.out.data.lowered.map((l) => [l.name, l.mode]), [['guard-bash', 'off'], ['auto-allow', 'on'], ['edit-retrieval', 'off']]);
  const text = await cli(['flags', 'show'], { ...p, json: false });
  assert.match(text.out, /guard-bash: the repository's off is ignored: a committed file never lowers a protective capability/);
  // flags set refuses to write such a value into the repository; raising is fine.
  const lower = await cli(['flags', 'set', 'guard-bash', 'off', '--yes'], p);
  assert.equal(lower.code, 2, show(lower));
  assert.equal(lower.out.errors[0].code, 'protective-flag');
  assert.match(lower.out.errors[0].hint, /--local/);
  await p.ok(['flags', 'set', 'auto-allow', 'off']);
  // The user's own machine override lowers it, with consent; flags show reports both values.
  const noConsent = await cli(['flags', 'set', 'guard-bash', 'off', '--local'], p);
  assert.equal(noConsent.code, 7, show(noConsent));
  const local = await p.ok(['flags', 'set', 'guard-bash', 'off', '--local']);
  assert.deepEqual([local.out.data.local, local.out.data.decision], [true, null]);
  assert.deepEqual(JSON.parse(readFileSync(join(p.data, 'config.json'), 'utf8')).flags, { 'guard-bash': 'off' });
  assert.deepEqual(bash(p, 'git stash'), { stdout: '' }, 'off on this machine: the guard passes');
  s = await cli(['flags', 'show'], p);
  assert.deepEqual([s.out.data.flags['guard-bash'].mode, s.out.data.flags['guard-bash'].source, s.out.data.flags['guard-bash'].repo, s.out.data.flags['guard-bash'].machine], ['off', 'machine', 'off', 'off']);
  // In a session the repository's config.json changes only through the commands (FLW-7), like state.json.
  const owned = JSON.parse(edit(p, join(p.state, 'config.json')).stdout).hookSpecificOutput;
  assert.equal(owned.permissionDecision, 'deny');
  assert.match(owned.permissionDecisionReason, new RegExp(`^FLW-7: .*${BIN} flags set`));
  const team = await cli(['flags', 'set', 'lanes', 'on', '--local', '--yes'], p);
  assert.equal(team.code, 2, show(team));
  assert.equal(team.out.errors[0].code, 'team-flag');
});
