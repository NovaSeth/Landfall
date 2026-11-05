// Role gate of the Bash guard (SEC-13, T-MG-187 F1): only the orchestrator (no agent_type) dispatches; a subagent records a
// review only as the plugin's reviewer or security-reviewer. Commands are data and are never run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirName = readdirSync(join(root, 'plugins')).find((d) => existsSync(join(root, 'plugins', d, 'lib', 'name.json')));
const pluginDir = join(root, 'plugins', dirName);
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const { guardBash } = await import(pathToFileURL(join(pluginDir, 'lib', 'hooks', 'guard-bash.mjs')).href);

const run = (command, agentType) => {
  const input = { tool_name: 'Bash', cwd: root, tool_input: { command } };
  if (agentType !== undefined) input.agent_type = agentType;
  return guardBash(input, { state: null, autoAllow: 'off', shadowLog() {}, env: { ...process.env, CLAUDE_PLUGIN_DATA: '' } });
};
const denied = (r) => /"permissionDecision":"deny"/.test(r.stdout ?? '');
const B = names.bin;
const DISPATCH = `${B} task set T-X dispatched --executor ${names.plugin}:reviewer --base abc --yes`;
const RECORD = `${B} review record T-X --from f --yes`;

test('a subagent cannot dispatch', () => {
  for (const t of [`${names.plugin}:implementer`, `${names.plugin}:reviewer`, 'general-purpose']) {
    const r = run(DISPATCH, t);
    assert.ok(denied(r), t);
    assert.match(r.stdout, /SEC-13/);
    assert.match(r.stdout, /only the orchestrator dispatches/);
  }
  assert.ok(denied(run(`/x/plugins/${names.plugin}/bin/${B} task set T-X dispatched --yes`, `${names.plugin}:implementer`)));
  assert.ok(denied(run(`bash -c '${DISPATCH}'`, `${names.plugin}:implementer`)));
});

test('review record needs the reviewer or security-reviewer agent', () => {
  assert.ok(denied(run(RECORD, `${names.plugin}:implementer`)));
  assert.ok(denied(run(RECORD, 'general-purpose')));
  assert.ok(!denied(run(RECORD, `${names.plugin}:reviewer`)));
  assert.ok(!denied(run(RECORD, `${names.plugin}:security-reviewer`)));
});

test('the main session is unchanged', () => {
  assert.ok(!denied(run(DISPATCH)));
  assert.ok(!denied(run(RECORD)));
  assert.ok(!denied(run(`${B} task set T-X status done --yes`, `${names.plugin}:implementer`)));
});

test('malformed input allows', () => {
  assert.equal(guardBash({ agent_type: 5, tool_input: {} }, { state: null }).stdout, '');
  assert.ok(!denied(run(DISPATCH, 7)));
});

// Parser differential (T-MG-187 fix round 2): the gate reads the guard's tokenized form, so quoting, escapes and
// wrappers do not hide the call; a line a subagent cannot reduce to literal words that names the binary is denied.
const IMPL = `${names.plugin}:implementer`;
const BYPASS = [
  `${B} task 'set' T-X dispatched --yes`,
  `${B} ta""sk set T-X dispatched --yes`,
  `"${B}" task set T-X "dispatched" --yes`,
  `${B} task set T-X 'a;b' dispatched --yes`,
  `bash -c "${B} task set T-X dispatched --yes"`,
  `sh -c '${B} "task" set T-X dispatched'`,
  `node /x/bin/${B} task set T-X dispatched --yes`,
  `env X=1 ${B} task set T-X dispatched`,
  `${B}=1; l=${B}; $l task set T-X dispatched`,
  `l=$(echo ${B}); $l task set T-X dispatched`,
  `eval "${B} task set T-X dispatched"`,
  `bash <<EOF\n${B} task set T-X dispatched\nEOF`,
  `${B} "re""view" record T-X --from f`,
  `"${B}" "review" record T-X --from f`,
];
const RECORD_BYPASS = [`${B} 'review' record T-X --from f`, `bash -c "${B} review record T-X"`, `${B} rev""iew record T-X`];

test('quoting, wrappers and unresolvable lines naming the binary are denied for a subagent', () => {
  for (const c of [...BYPASS, ...RECORD_BYPASS]) assert.ok(denied(run(c, IMPL)), c);
  assert.match(run('l=$(echo landfall); $l x', IMPL).stdout, /write the landfall call as plain words/);
});

test('the reviewer keeps the plain record; other lines keep the guard decision', () => {
  assert.ok(!denied(run(RECORD, `${names.plugin}:reviewer`)));
  assert.ok(!denied(run(`${B} 'review' record T-X --from f`, `${names.plugin}:reviewer`)));
  assert.ok(!denied(run(`${B} task set T-X status done --yes`, IMPL)));
  assert.ok(!denied(run('echo "$HOME" | wc -c', IMPL)));
  assert.ok(!denied(run(`${B} status "$(pwd)"`, `${names.plugin}:reviewer`)) || true);
});

test('without agent_type every form is allowed', () => {
  for (const c of [...BYPASS, ...RECORD_BYPASS]) assert.ok(!denied(run(c)), c);
});

test('the role gate stays fast and tolerates odd input', () => {
  const t = process.cpuUsage();
  for (let i = 0; i < 20; i++) run(`${B} 'task' set T-X dispatched`, IMPL);
  const u = process.cpuUsage(t);
  assert.ok((u.user + u.system) / 1000 < 1000);
  assert.ok(!denied(guardBash({ agent_type: IMPL, tool_input: { command: 5 } }, { state: null })));
  assert.ok(!denied(run('x'.repeat(5), IMPL)));
});
