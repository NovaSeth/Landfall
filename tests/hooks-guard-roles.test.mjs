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
