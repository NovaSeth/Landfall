// The external wrapper agent's Bash policy (audit G2, AGT-2, AGT-3). Plugin subagents ignore frontmatter hooks, so the
// plugin-level Bash guard (hook guard-bash) applies it to a call whose agent_type is `external` or `<plugin>:external`: one
// simple command of the plugin's own CLI (exec, wait, runs list, runs show, rule, method, with flags) passes to the
// guard as before; anything else is denied with exit 2 and a reason that names the agent's job. Other agents and calls
// without agent_type are not affected. Malformed hook input is allowed (GC8).
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { MALFORMED, hook, launch, names } from './helpers/hook-fixture.mjs';

const BIN = names.bin;
const AGENT = `${names.plugin}:external`;
const bash = (command, extra = { agent_type: AGENT }) => hook('guard-bash', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: tmpdir(), ...extra });

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

test('external agent: a bare agent_type external is held to the same policy', () => {
  assert.equal(bash(`${BIN} wait run-1 --json`, { agent_type: 'external' }).decision, 'allow');
  assert.equal(bash('cat ~/.ssh/id_rsa', { agent_type: 'external' }).decision, 'deny');
});

test('other agents and calls without agent_type are not held to it', () => {
  assert.equal(bash('cat README.md', {}).decision, 'allow');
  assert.equal(bash('cat README.md', { agent_type: `${names.plugin}:implementer` }).decision, 'allow');
  assert.equal(bash('cat README.md', { agent_type: 7 }).decision, 'allow');
  assert.equal(bash('cat README.md', { agent_type: `other:external` }).decision, 'allow');
});

test('malformed input is allowed (GC8)', () => {
  for (const m of MALFORMED) assert.equal(hook('guard-bash', m).decision, 'allow', JSON.stringify(m));
  assert.equal(bash(7).decision, 'allow');
});

test('through the launcher with stdin JSON', () => {
  const input = (command, agent_type) => ({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: tmpdir(), ...(agent_type ? { agent_type } : {}) });
  assert.equal(launch('guard-bash', input(`${BIN} exec --task T-1 --role reviewer --json`, AGENT)).decision, 'allow');
  assert.equal(launch('guard-bash', input('cat ~/.ssh/id_rsa', AGENT)).decision, 'deny');
  assert.equal(launch('guard-bash', input(`${BIN} secrets`, AGENT)).decision, 'deny');
  assert.equal(launch('guard-bash', input('cat README.md')).decision, 'allow');
  assert.equal(launch('external-bash', { tool_name: 'Bash', tool_input: { command: 'cat x' } }).decision, 'allow', 'no separate hook command any more');
});

test('F1: a quoted command substitution with a heredoc, or $?, is not a literal word and is denied', () => {
  const sub = `${BIN} rule "$(cat <<'EOF'\nPRI-3\nEOF\n)"`;
  for (const c of [sub, `${BIN} rule $?`, `${BIN} rule "$?"`, `${BIN} method "$(id)"`]) {
    const r = bash(c);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.equal(r.code, 2, c);
  }
  const input = (command) => ({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: tmpdir(), agent_type: AGENT });
  assert.equal(launch('guard-bash', input(sub)).decision, 'deny', 'through the launcher');
  assert.equal(bash(`${BIN} rule "PRI-3" 'ORC-2'`).decision, 'allow', 'quoted literal words stay allowed');
});
