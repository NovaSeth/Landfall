// Bash guard precision and recall (M3.3): a corpus of known-bad commands (must be denied) and known-good read-only commands
// (must be allowed), in tests/hooks-guard-corpus.json. Entry: [command, 'allow'|'deny', note, knownGap?]. <STATE> and <REPO>
// stand for the fixture state directory and repository. 'deny' on a read-only command marked by design (variables, an
// arbitrary interpreter) is not a gap. A knownGap entry is a read-only command the guard blocks today: the test fails when it
// is allowed, so that a fix removes the mark. Commands are data and are never run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv({ identity: false });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { runHook } = await lib('hooks/registry.mjs');
const state = await lib('state/index.mjs');

// An active repository on a task branch with a task, a report and a decision in its state directory, src/ and docs/.
function repo() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'guard-corpus-')));
  const git = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('switch', '-q', '-c', 'task/T-AB-1-x');
  const store = state.open(join(d, names.stateDir), { names });
  const at = '2026-10-22T10:00:00.000Z';
  store.write('state', null, { codename: names.codename, createdWith: '2.1.0', activatedAt: at });
  state.registerHandle(store, { name: 'Dev AB', email: 'ab@example.com', handle: 'AB' });
  store.write('task', 'T-AB-1', { id: 'T-AB-1', kind: 'task', title: 'x', lane: null, owner: 'AB', class: null, classHistory: [], status: 'new', round: 0, events: [{ at, by: 'AB', event: 'created', data: {} }], base: null, branch: null });
  for (const [rel, text] of [[`${names.stateDir}/tasks/T-AB-1/report.md`, '---\n---\nStatus: DONE\n'], [`${names.stateDir}/tasks/T-AB-1/brief.md`, '# brief\n'], [`${names.stateDir}/decisions/D-AB-1.md`, '---\nid: D-AB-1\nstatus: active\n---\n\nbody\n'],
    ['src/a.js', 'x\n'], ['docs/a.md', '# a\n'], ['state.json', '{}\n']]) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'tracked');
  return d;
}
const DIR = repo();
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));
const STATE = join(DIR, names.stateDir);

function judge(command) {
  const input = JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: DIR });
  const r = runHook('guard-bash', input, { deadline: Infinity, env: { ...process.env, CLAUDE_PROJECT_DIR: DIR }, readProjectMode: () => 'solo', shadowLog: () => {} });
  if (r.code === 2) return { deny: true, reason: r.stderr.trim() };
  if (!r.stdout) return { deny: false, reason: '' };
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  return { deny: o.permissionDecision === 'deny', reason: o.permissionDecisionReason ?? '' };
}
const fill = (c) => c.split('<STATE>').join(STATE).split('<REPO>').join(DIR);
const corpus = JSON.parse(readFileSync(join(root, 'tests', 'hooks-guard-corpus.json'), 'utf8'));

test('guard corpus: known-bad commands are denied, known-good read-only commands are allowed, known gaps are still blocked', (t) => {
  const rows = corpus.map(([cmd, expect, note, knownGap]) => ({ cmd, expect, note, knownGap: knownGap === true, v: judge(fill(cmd)) }));
  const bad = rows.filter((r) => r.expect === 'deny' && !r.note.includes('by design'));
  const good = rows.filter((r) => r.expect === 'allow');
  const byDesign = rows.filter((r) => r.expect === 'deny' && r.note.includes('by design'));
  const badBlocked = bad.filter((r) => r.v.deny).length;
  const goodDenied = good.filter((r) => r.v.deny).length;
  const missed = bad.filter((r) => r.knownGap && !r.v.deny);
  const gaps = good.filter((r) => r.knownGap);
  t.diagnostic(`recall=${badBlocked}/${bad.length} missed=${missed.length} falseBlocks=${goodDenied}/${good.length} knownGap=${gaps.length}`);
  for (const r of [...missed, ...gaps]) t.diagnostic(`knownGap: ${r.cmd}\n    ${r.v.reason || 'allowed'}`);
  assert.ok(bad.length >= 30, `at least 30 known-bad cases (${bad.length})`);
  assert.ok(good.length >= 10, `at least 10 known-good cases (${good.length})`);
  const msg = (r) => `${r.note}: ${r.cmd}\n    ${r.v.deny ? r.v.reason : 'allowed'}`;
  assert.deepEqual(bad.filter((r) => !r.v.deny && !r.knownGap).map(msg), [], 'known-bad commands allowed (a miss not marked knownGap)');
  assert.deepEqual(bad.filter((r) => r.v.deny && r.knownGap).map(msg), [], 'a knownGap known-bad command is now blocked: remove its mark');
  assert.deepEqual(byDesign.filter((r) => !r.v.deny).map(msg), [], 'deny-by-design commands allowed');
  assert.deepEqual(good.filter((r) => r.v.deny && !r.knownGap).map(msg), [], 'known-good read-only commands denied (false blocks, not marked knownGap)');
  assert.deepEqual(gaps.filter((r) => !r.v.deny).map(msg), [], 'a knownGap known-good command is now allowed: remove its mark');
});
