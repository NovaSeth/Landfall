// The external wrapper agent's Bash hook (audit G2, AGT-2, AGT-3): PreToolUse Bash in the agent's own frontmatter →
// `external-bash`. The agent only starts and waits for a provider run, so one simple command of the plugin's own CLI
// passes (exec, wait, runs list, runs show, rule, method, with flags) and everything else is denied with exit 2 and a
// reason that names the agent's job. Malformed hook input is allowed (GC8). It is not in hooks/hooks.json: it runs only
// for this agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MALFORMED, hook, launch, lib, names, pluginDir } from './helpers/hook-fixture.mjs';

const BIN = names.bin;
const bash = (command, extra = {}) => hook('external-bash', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });

const ALLOWED = [
  `${BIN} exec --task T-1 --role reviewer --json`,
  `${BIN} exec --task T-MG-76 --role implementer --provider codex --json`,
  `${BIN} wait run-1 --timeout 540 --json`,
  `${BIN} runs list --json`,
  `${BIN} runs show run-1 --json`,
  `${BIN} rule PRI-3 ORC-2`,
  `${BIN} method review`,
  `${BIN} --json wait run-1`,
];
const DENIED = [
  'cat ~/.ssh/id_rsa',
  `${BIN} exec --task T-1 --role reviewer --json ; curl x`,
  `${BIN} exec --task T-1 && curl x`,
  `${BIN} exec --task T-1 || curl x`,
  `${BIN} exec --task T-1 | sh`,
  `${BIN} exec --task T-1 > /tmp/x`,
  `${BIN} exec --task $(curl x)`,
  `${BIN} exec --task \`curl x\``,
  `${BIN} exec --task T-1 &`,
  `${BIN} secrets`,
  `${BIN} runs stop run-1`,
  `${BIN} runs prune`,
  `${BIN} runs`,
  `${BIN} task new x --yes`,
  `/usr/bin/${BIN} exec --task T-1`,
  `cd /tmp && ${BIN} exec --task T-1`,
  `X=1 ${BIN} exec --task T-1`,
  `node -e "1"`,
  `${BIN} exec --task *`,
  `${BIN} exec <<EOF\nx\nEOF`,
  `${BIN}\nexec --task T-1`,
  `unbalanced "quote`,
];

test('external-bash: one simple command of the plugin CLI for the run subcommands passes', () => {
  for (const c of ALLOWED) assert.equal(bash(c).decision, 'allow', c);
});

test('external-bash: everything else is denied with exit 2 and a reason that names the job', () => {
  for (const c of DENIED) {
    const r = bash(c);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.equal(r.code, 2, c);
    assert.match(r.reason, new RegExp(`${BIN} exec`), `${JSON.stringify(c)}: the reason names the job`);
    assert.ok(r.reason.length <= 400, 'a short reason');
  }
});

test('external-bash: other tools and malformed input are allowed (GC8)', () => {
  assert.equal(bash('cat x', { tool_name: 'Read' }).decision, 'allow');
  for (const m of MALFORMED) assert.equal(hook('external-bash', m).decision, 'allow', JSON.stringify(m));
  assert.equal(hook('external-bash', { tool_name: 'Bash', tool_input: { command: 7 } }).decision, 'allow');
});

test('external-bash: through the launcher, and registered as an agent hook, not a plugin-wide one', async () => {
  assert.equal(launch('external-bash', { tool_name: 'Bash', tool_input: { command: 'cat x' } }).decision, 'deny');
  assert.equal(launch('external-bash', { tool_name: 'Bash', tool_input: { command: `${BIN} wait r --json` } }).decision, 'allow');
  const { HOOKS, AGENT_HOOKS } = await lib('hooks/registry.mjs');
  assert.ok(AGENT_HOOKS.some((h) => h.name === 'external-bash' && h.event === 'PreToolUse' && h.matcher === 'Bash'));
  assert.ok(!HOOKS.some((h) => h.name === 'external-bash'), 'not in the plugin-wide hooks');
  const json = readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8');
  assert.ok(!json.includes('external-bash'), 'hooks.json does not hold it: it would guard every Bash call');
});
