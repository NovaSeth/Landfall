// State-file protection for Edit|Write (spec §7.13, FLW-7, PRI-8): the PreToolUse Edit|Write hook denies a direct edit
// of a command-owned state file of an active repository — tasks/<id>/task.json, tasks/<id>/verify.json,
// baseline/tests.json, local/loop.json — and a change of the frontmatter `status` of a decision record (its body stays
// editable), with the command to use instead. It finds the state through lib/state (also a linked state directory) and
// through links on the way to the file. Other files, an inactive repository and malformed input are not denied, and the
// decision context of the same hook still works. One list of owned files serves this hook and the Bash guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { MALFORMED, hook, launch, lib, loopDoc, names, repo, task, writeLoop } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const state = await lib('state/index.mjs');
const { OWNED, ownedFile } = await lib('guard/protect.mjs');
const RECORD = (status, body = 'A reason.') => `---\nschema: 1\nid: D-AB-1\ntitle: Plain SQL\nstatus: ${status}\nkind: general\ndate: 2026-10-15\nauthor: AB\n---\n\n## Why\n\n${body}\n`;
const edit = (f, file, tool_input, tool_name = 'Edit', cwd = f.dir) => hook('decisions-context',
  { session_id: 's', hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path: file, ...tool_input }, cwd }, { env: f.env });

function fixture(t) {
  const f = repo(t);
  task(f.store, 1);
  const s = (rel) => join(f.stateDir, rel);
  mkdirSync(s('tasks/T-AB-1'), { recursive: true });
  writeFileSync(s('tasks/T-AB-1/verify.json'), '{}\n');
  mkdirSync(s('baseline'), { recursive: true }); writeFileSync(s('baseline/tests.json'), '{}\n');
  writeLoop(f.stateDir, loopDoc(null));
  mkdirSync(s('decisions'), { recursive: true }); writeFileSync(s('decisions/D-AB-1.md'), RECORD('active'));
  return { ...f, s };
}

test('owned state files: one list for the Bash guard and the edit hook', () => {
  for (const [rel, rule] of [['tasks/T-AB-1/task.json', 'FLW-7'], ['tasks/T-AB-1/verify.json', 'FLW-7'], ['baseline/tests.json', 'FLW-7'], ['local/loop.json', 'FLW-7'],
    ['decisions/D-AB-1.md', 'PRI-8'], ['state.json', 'FLW-7'], ['team/AB.json', 'FLW-7'], ['guard-extra.txt', 'SEC-4']]) {
    assert.equal(ownedFile(rel)?.rule, rule, rel);
  }
  assert.equal(ownedFile('guard-extra.txt').edit, true, 'the project rules stay editable with the Edit tool');
  for (const rel of ['tasks/T-AB-1/brief.md', 'tasks/T-AB-1/report.md', 'profile.json', 'local/session/s.json', 'tasks/T-AB-1/task.json.bak']) {
    assert.equal(ownedFile(rel), null, rel);
  }
  assert.ok(OWNED.length >= 5);
});

test('edit hook: a direct Edit or Write of an owned state file is denied with the command to use (FLW-7)', (t) => {
  const f = fixture(t);
  const cases = [['tasks/T-AB-1/task.json', `${names.bin} task set T-AB-1`], ['tasks/T-AB-1/verify.json', `${names.bin} verify T-AB-1`],
    ['baseline/tests.json', `${names.bin} baseline pin`], ['local/loop.json', `${names.bin} loop`], ['tasks/T-AB-7/task.json', `${names.bin} task set T-AB-7`]];
  for (const [rel, use] of cases) {
    for (const [tool, input] of [['Edit', { old_string: '{', new_string: '{ ' }], ['Write', { content: '{}\n' }]]) {
      const v = edit(f, f.s(rel), input, tool);
      assert.equal(v.decision, 'deny', `${tool} ${rel}`); assert.equal(v.event, 'PreToolUse');
      assert.match(v.reason, /^FLW-7: blocked a direct edit of /, rel); assert.ok(v.reason.includes(use), `${rel}: ${v.reason}`);
      assert.ok(v.reason.length <= 300 && /Instead/.test(v.reason), v.reason);
    }
  }
  // a relative path against cwd, a path through a link, and the session working in a subdirectory
  assert.equal(edit(f, join(names.stateDir, 'tasks/T-AB-1/task.json'), { content: '{}' }, 'Write').decision, 'deny', 'relative to cwd');
  const via = join(f.dir, 'via'); symlinkSync(join(f.stateDir, 'tasks'), via);
  assert.equal(edit(f, join(via, 'T-AB-1/task.json'), { content: '{}' }, 'Write').decision, 'deny', 'through a directory link');
  const leaf = join(f.dir, 'leaf.json'); symlinkSync(f.s('tasks/T-AB-1/task.json'), leaf);
  assert.equal(edit(f, leaf, { content: '{}' }, 'Write').decision, 'deny', 'a link to the file itself');
});

test('edit hook: a decision record body stays editable; its status changes only through the commands (PRI-8)', (t) => {
  const f = fixture(t);
  const file = f.s('decisions/D-AB-1.md');
  assert.equal(edit(f, file, { old_string: 'A reason.', new_string: 'A better reason.' }).decision, 'allow', 'body edit');
  assert.equal(edit(f, file, { content: RECORD('active', 'Rewritten.') }, 'Write').decision, 'allow', 'whole-file write, same status');
  for (const [input, tool] of [[{ old_string: 'status: active', new_string: 'status: retired' }, 'Edit'], [{ content: RECORD('superseded') }, 'Write'],
    [{ old_string: 'status: active\n', new_string: '' }, 'Edit'], [{ old_string: 'status: active', new_string: 'status: "retired"' }, 'Edit'],
    [{ old_string: 'e', new_string: 'E', replace_all: true }, 'Edit'], [{ content: 'no frontmatter' }, 'Write']]) {
    const v = edit(f, file, input, tool);
    assert.equal(v.decision, 'deny', JSON.stringify(input)); assert.match(v.reason, /^PRI-8: blocked changing the status of D-AB-1/);
    assert.ok(v.reason.includes(`${names.bin} decisions supersede D-AB-1`) && v.reason.includes(`${names.bin} decisions retire D-AB-1`), v.reason);
    assert.ok(v.reason.length <= 300, v.reason);
  }
  // an Edit whose old_string is not in the file fails in Claude Code anyway: nothing to protect
  assert.equal(edit(f, file, { old_string: 'not there', new_string: 'status: retired' }).decision, 'allow');
  // a new record by hand: created by `decide`
  const created = edit(f, f.s('decisions/D-AB-2.md'), { content: RECORD('active').replace('D-AB-1', 'D-AB-2') }, 'Write');
  assert.equal(created.decision, 'deny'); assert.ok(created.reason.includes(`${names.bin} decide`), created.reason);
});

test('edit hook: other files, an inactive repository, a linked state directory and malformed input', (t) => {
  const f = fixture(t);
  for (const rel of ['tasks/T-AB-1/report.md', 'tasks/T-AB-1/brief.md', 'guard-extra.txt']) {
    assert.equal(edit(f, f.s(rel), { content: 'x' }, 'Write').decision, 'allow', rel);
  }
  assert.equal(edit(f, join(f.dir, 'src', 'a.js'), { content: 'x' }, 'Write').decision, 'allow');
  const inactive = repo(t, { active: false });
  mkdirSync(join(inactive.stateDir, 'tasks', 'T-AB-1'), { recursive: true });
  assert.equal(edit(inactive, join(inactive.stateDir, 'tasks/T-AB-1/task.json'), { content: '{}' }, 'Write').decision, 'allow', 'no state.json: not active');
  for (const text of MALFORMED) assert.equal(hook('decisions-context', text, { env: f.env }).decision, 'allow', text);
  assert.equal(edit(f, 'relative/x.json', { content: 'x' }, 'Write', 'not/absolute').decision, 'allow', 'a relative path without cwd is not guessed');
  // a linked (external) state directory: found through lib/state from the session's cwd
  const linked = repo(t, { active: false });
  const external = join(mkdtempSync(join(tmpdir(), 'external-')), 'state');
  state.updateProject({ repo: linked.dir, dataDir: state.machineDataDir(names, linked.env), names, patch: { stateDir: external } });
  const store = state.open(external, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: '2026-10-15T10:00:00.000Z' });
  task(store, 3);
  const v = edit(linked, join(external, 'tasks/T-AB-3/task.json'), { content: '{}' }, 'Write');
  assert.equal(v.decision, 'deny', 'linked state'); assert.match(v.reason, /^FLW-7: /);
});

test('edit hook: the decision context still comes for ordinary files; the launcher denies a state file', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'a.sql'), '-- D-AB-1\nselect 1;\n');
  // the record in the fixture is valid: its summary reaches the edit of a file that cites it
  const v = edit(f, join(f.dir, 'a.sql'), { old_string: 'select 1', new_string: 'select 2' });
  assert.equal(v.decision, 'allow'); assert.match(v.context ?? '', /D-AB-1/);
  const r = launch('decisions-context', { tool_name: 'Write', tool_input: { file_path: f.s('baseline/tests.json'), content: '{}' }, cwd: f.dir }, { env: f.env, cwd: f.dir });
  assert.equal(r.status, 0); assert.equal(r.decision, 'deny'); assert.match(r.reason, /^FLW-7: /);
  assert.equal(readFileSync(f.s('baseline/tests.json'), 'utf8'), '{}\n', 'the hook writes nothing');
});

// ---- fix round 1 (review-r1a F4, M1, M2, M3; findings-r1 C3, C4) ----
test('edit hook: state.json and the team files are owned (FLW-7); a MultiEdit is read like an Edit', (t) => {
  const f = fixture(t);
  for (const rel of ['state.json', 'team/AB.json', 'team/CD.json']) {
    const v = edit(f, f.s(rel), { content: '{}' }, 'Write');
    assert.equal(v.decision, 'deny', rel); assert.match(v.reason, /^FLW-7: blocked a direct edit/);
  }
  const multi = (file, edits) => hook('decisions-context', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'MultiEdit', tool_input: { file_path: file, edits }, cwd: f.dir }, { env: f.env });
  assert.equal(multi(f.s('tasks/T-AB-1/task.json'), [{ old_string: '{', new_string: '{ ' }]).decision, 'deny');
  assert.equal(multi(f.s('decisions/D-AB-1.md'), [{ old_string: 'A reason.', new_string: 'B.' }]).decision, 'allow', 'body only');
  const v = multi(f.s('decisions/D-AB-1.md'), [{ old_string: 'A reason.', new_string: 'B.' }, { old_string: 'status: active', new_string: 'status: retired' }]);
  assert.equal(v.decision, 'deny'); assert.match(v.reason, /^PRI-8: /);
});

test('edit hook: a second status line in a decision record is a status change (PRI-8)', (t) => {
  const f = fixture(t);
  const file = f.s('decisions/D-AB-1.md');
  const v = edit(f, file, { old_string: 'status: active\n', new_string: 'status: active\nstatus: retired\n' });
  assert.equal(v.decision, 'deny', 'duplicate status key'); assert.match(v.reason, /^PRI-8: /);
  assert.equal(edit(f, file, { content: RECORD('active').replace('author: AB\n', 'author: AB\nstatus: retired\n') }, 'Write').decision, 'deny');
});

// A-I1 (findings-r2, part A): a state that cannot be resolved and has no directory (git missing, a spent budget) still
// denies an edit of any file under a path segment named like the state directory, not only of the owned file names.
test('A-I1: unknown state without a directory (git missing, spent budget): an edit of any file in the state directory is denied', (t) => {
  const f = fixture(t);
  const write = (file, env, deadline = Infinity) => hook('decisions-context',
    { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: f.dir }, { env, deadline });
  const nogit = { ...f.env, PATH: mkdtempSync(join(tmpdir(), 'nogit-')) };
  for (const [name, env, deadline] of [['git missing', nogit, Infinity], ['spent budget', f.env, performance.now() - 1]]) {
    for (const rel of ['local/other.txt', 'tasks/T-AB-1/brief.md', 'profile.json']) {
      const v = write(f.s(rel), env, deadline);
      assert.equal(v.decision, 'deny', `${name} ${rel}`); assert.match(v.reason, /cannot be resolved/, v.reason);
    }
    assert.equal(write(join(f.dir, 'src', 'a.js'), env, deadline).decision, 'allow', `${name}: a source file`);
  }
});

test('edit hook: a repository state that cannot be resolved blocks an edit inside the state directory, not elsewhere (C3)', (t) => {
  const data = (text) => { const d = mkdtempSync(join(tmpdir(), 'data-')); writeFileSync(join(d, 'projects.json'), text); return d; };
  for (const [name, extra] of [['corrupt', { CLAUDE_PLUGIN_DATA: data('{ not json') }], ['newer', { CLAUDE_PLUGIN_DATA: data('{"schema":999,"projects":{}}') }],
    ['git missing', { PATH: mkdtempSync(join(tmpdir(), 'nogit-')) }]]) {
    const f = fixture(t);
    const g = { ...f, env: { ...f.env, ...extra } };
    for (const rel of ['tasks/T-AB-1/task.json', 'state.json', 'decisions/D-AB-1.md']) {
      const v = edit(g, f.s(rel), { content: 'x' }, 'Write');
      assert.equal(v.decision, 'deny', `${name} ${rel}`); assert.match(v.reason, /cannot be resolved/, v.reason);
      assert.ok(v.reason.length <= 300);
    }
    assert.equal(edit(g, join(f.dir, 'src', 'a.js'), { content: 'x' }, 'Write').decision, 'allow', `${name}: a source file`);
  }
});

test('owned state files: every committed lib/state kind is owned, and an Edit names its command (FLW-7)', async (t) => {
  const { KINDS } = await lib('state/kinds.mjs');
  const keys = { team: 'AB', task: 'T-AB-1', tombstone: 'D-AB-3', counter: 'T-AB' };
  const f = fixture(t);
  for (const kind of Object.values(KINDS)) {
    const rel = kind.path(kind.keyPattern ? keys[kind.name] : undefined);
    assert.ok(!kind.keyPattern || keys[kind.name], `${kind.name}: add a sample key to this test`);
    assert.equal(ownedFile(rel)?.rule, 'FLW-7', `${kind.name}: ${rel}`);
    const v = edit(f, f.s(rel), { old_string: '{', new_string: '{ ' });
    assert.equal(v.decision, 'deny', rel);
    assert.match(v.reason, /^FLW-7: blocked a direct edit of /, rel);
    assert.ok(v.reason.includes(`${names.bin} `), `${rel}: ${v.reason}`);
  }
});

test('owned state files: nothing the previous hand-written list protected is allowed now (T-MG-39)', (t) => {
  const f = fixture(t);
  const before = [['state.json', 'FLW-7'], ['config.json', 'FLW-7'], ['team/AB.json', 'FLW-7'], ['tasks/T-AB-1/task.json', 'FLW-7'], ['tasks/T-AB-1/verify.json', 'FLW-7'],
    ['baseline/tests.json', 'FLW-7'], ['local/loop.json', 'FLW-7'], ['decisions/D-AB-1.md', 'PRI-8'], ['tombstones/D-AB-3.json', 'FLW-7']];
  for (const [rel, rule] of before) assert.equal(ownedFile(rel)?.rule, rule, rel);
  for (const rel of before.filter(([r]) => r !== 'decisions/D-AB-1.md').map(([r]) => r)) {
    for (const [tool, input] of [['Edit', { old_string: '{', new_string: '{ ' }], ['Write', { content: '{}\n' }]]) assert.equal(edit(f, f.s(rel), input, tool).decision, 'deny', `${tool} ${rel}`);
  }
  // user-owned: the project rules stay editable with the Edit tool; unknown files stay allowed
  assert.equal(edit(f, f.s('guard-extra.txt'), { content: 'x\n' }, 'Write').decision, 'allow');
  assert.equal(ownedFile('secrets-patterns.txt'), null);
});
