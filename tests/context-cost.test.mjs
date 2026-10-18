// Always-on context cost (SC3, GC7): `claude plugin details <plugin>` "Always-on" ≤ 1,000 tok and the
// SessionStart injection ≤ 2,000 chars in the worst-case fixture state; together ≤ 1,500 tok (4 chars ≈ 1 tok).
// `details` must list exactly the shipped skills and agents, each within its per-component budget.
// `details` labels hooks "harness-only", so the SessionStart output is measured separately by running every
// SessionStart hook of the registry through the launcher. The plugin is installed into a throwaway HOME and
// CLAUDE_CONFIG_DIR (never the real ~/.claude). This file holds no plugin name: it comes from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

// No child of this file sees the real HOME or the calling session (tests/helpers/isolated-env.mjs).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, ...opts });
const out = (r) => `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

function locate() {
  const plugins = join(root, 'plugins');
  const hits = existsSync(plugins) ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json'))) : [];
  assert.equal(hits.length, 1, `expected exactly one plugins/*/lib/name.json, found ${hits.length}`);
  const dir = join(plugins, hits[0]);
  return { dir, names: readJson(join(dir, 'lib', 'name.json')) };
}
const { dir: pluginDir, names } = locate();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);

const LIMITS = { alwaysOnTokens: 1000, sessionStartChars: 2000, totalTokens: 1500 };
// Per-component always-on budget (spec §7.15): a model-invoked skill ≤ 60 tok, an agent ≤ 70 tok; a user-only skill
// (disable-model-invocation) still counts its description, which is a short slash-menu label: ≤ 20 tok ("< 20").
const COMPONENT_LIMITS = { skill: 60, userSkill: 20, agent: 70 };
const CHARS_PER_TOKEN = 4;
// SC3 as a function, so the over-budget cases are tested too (REV-45).
function overBudget({ alwaysOnTokens, sessionStartChars }) {
  const problems = [];
  if (!Number.isFinite(alwaysOnTokens)) problems.push('always-on cost not measured');
  if (!Number.isFinite(sessionStartChars)) problems.push('SessionStart output not measured');
  if (problems.length) return problems;
  if (alwaysOnTokens > LIMITS.alwaysOnTokens) problems.push(`always-on ${alwaysOnTokens} tok > ${LIMITS.alwaysOnTokens}`);
  if (sessionStartChars > LIMITS.sessionStartChars) problems.push(`SessionStart ${sessionStartChars} chars > ${LIMITS.sessionStartChars}`);
  const total = alwaysOnTokens + Math.ceil(sessionStartChars / CHARS_PER_TOKEN);
  if (total > LIMITS.totalTokens) problems.push(`total ${total} tok > ${LIMITS.totalTokens}`);
  return problems;
}

// Context a SessionStart hook injects: hookSpecificOutput.additionalContext of a JSON answer, else plain stdout.
function injectedChars(stdout) {
  if (stdout.trim() === '') return 0;
  try {
    const answer = JSON.parse(stdout);
    const ctx = answer?.hookSpecificOutput?.additionalContext;
    return typeof ctx === 'string' ? ctx.length : 0;
  } catch {
    return stdout.length;
  }
}

// `claude plugin details` inventory and per-component table: skill and agent names, and the rounded cost of each
// component ("< 20" is read as its bound 20, "~1.2k" as 1200). Null when the inventory lines are missing.
const tokens = (v) => { const m = /^(?:<|~)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k?)$/.exec(v.trim()); return m ? Math.round(Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1)) : NaN; };
function parseComponents(text) {
  const list = (kind) => {
    const m = new RegExp(`^\\s*${kind} \\((\\d+)\\)(.*)$`, 'm').exec(text);
    return m ? m[2].split(',').map((x) => x.trim()).filter(Boolean) : null;
  };
  const skills = list('Skills');
  const agents = list('Agents');
  if (!skills || !agents) return null;
  const cost = {};
  const lines = text.split('\n');
  const head = lines.findIndex((l) => /^\s*component\s+always-on\s+on-invoke\s*$/.test(l));
  for (const line of head < 0 ? [] : lines.slice(head + 1)) {
    if (!line.trim()) break;
    const m = /^\s+(\S+)\s+(<\s*\d+|~?\s*\d[\d,.]*k?)\s+(<\s*\d+|~?\s*\d[\d,.]*k?)\s*$/.exec(line);
    if (m) cost[m[1]] = { alwaysOn: tokens(m[2]), onInvoke: tokens(m[3]) };
  }
  return { skills, agents, cost };
}

// `claude plugin details` output of Claude Code 2.1.300 for a plugin with four hook events (recorded).
const RECORDED_DETAILS = `x 1.5.2
  Description: Process for building software with a team of AI coding agents: specs, plans, briefs, reviews and outcome gates.
  Source: x@x-plugins

Component inventory
  Skills (0)
  Agents (0)
  Hooks (4)  SessionStart, PreToolUse, SubagentStart, Stop  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~0 tok   added to every session
`;

test('SC3 budget: limits hold at the boundary and fail one step over it', () => {
  assert.deepEqual(overBudget({ alwaysOnTokens: 1000, sessionStartChars: 0 }), []);
  assert.deepEqual(overBudget({ alwaysOnTokens: 1000, sessionStartChars: 2000 }), []);
  assert.deepEqual(overBudget({ alwaysOnTokens: 1001, sessionStartChars: 0 }), ['always-on 1001 tok > 1000']);
  assert.deepEqual(overBudget({ alwaysOnTokens: 0, sessionStartChars: 2001 }), ['SessionStart 2001 chars > 2000']);
  assert.deepEqual(overBudget({ alwaysOnTokens: 1000, sessionStartChars: 2004 }), ['SessionStart 2004 chars > 2000', 'total 1501 tok > 1500']);
  assert.deepEqual(overBudget({ alwaysOnTokens: NaN, sessionStartChars: 0 }), ['always-on cost not measured']);
  assert.equal(injectedChars(''), 0);
  assert.equal(injectedChars(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'abc' } })), 3);
  assert.equal(injectedChars('plain text\n'), 11);
});

// The same for a plugin with skills and an agent (recorded from a fixture plugin).
const RECORDED_COMPONENTS = `x 0.0.1
  Description: d
  Source: x@x-plugins

Component inventory
  Skills (2)  status, work
  Agents (1)  implementer
  Hooks (0)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~76 tok   added to every session

Per-component (rounded)
  component    always-on  on-invoke
  status            < 20       < 20
  work               ~30        ~20
  implementer        ~30       < 20

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
`;

test('the details parser reads the recorded Claude Code 2.1.300 output', async () => {
  const { parseDetails } = await lib('cli/doctor.mjs');
  assert.deepEqual(parseDetails(RECORDED_DETAILS), { hookEvents: ['SessionStart', 'PreToolUse', 'SubagentStart', 'Stop'], alwaysOnTokens: 0 });
  assert.deepEqual(parseComponents(RECORDED_DETAILS), { skills: [], agents: [], cost: {} });
  assert.deepEqual(parseComponents(RECORDED_COMPONENTS), { skills: ['status', 'work'], agents: ['implementer'],
    cost: { status: { alwaysOn: 20, onInvoke: 20 }, work: { alwaysOn: 30, onInvoke: 20 }, implementer: { alwaysOn: 30, onInvoke: 20 } } });
  assert.equal(parseDetails(RECORDED_COMPONENTS).alwaysOnTokens, 76);
  assert.equal(parseComponents('no inventory'), null);
  assert.deepEqual([tokens('~1.2k'), tokens('< 20'), tokens('~30'), tokens('7')], [1200, 20, 30, 7]);
});

// Shipped components: skills/<name>/SKILL.md (user-only when disable-model-invocation is true) and agents/<name>.md.
function shippedComponents() {
  const skillsDir = join(pluginDir, 'skills');
  const agentsDir = join(pluginDir, 'agents');
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, 'SKILL.md'))).sort() : [];
  const userOnly = skills.filter((d) => /^disable-model-invocation: true$/m.test(readFileSync(join(skillsDir, d, 'SKILL.md'), 'utf8').split('\n---\n')[0]));
  const agents = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
  return { skills, userOnly, agents };
}

// Child environment from the helper: a throwaway HOME of this test (config, XDG dirs, git config inside it) and no
// variable of the calling session; Claude Code without auto-update or nonessential traffic.
function claudeEnv(t) {
  const iso = isolatedEnv({ gitConfig: '[init]\n\tdefaultBranch = main\n' });
  t.after(iso.cleanup);
  return { home: iso.home, env: { ...iso.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } };
}

test('SC3: installed plugin always-on cost and SessionStart injection stay within budget', { timeout: 300000 }, async (t) => {
  const { home, env } = claudeEnv(t);
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cost-project-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  if (run('claude', ['--version'], { env }).status !== 0) {
    if (process.env[`${names.envPrefix}REQUIRE_TOOLS`]) assert.fail(`claude not on PATH (${names.envPrefix}REQUIRE_TOOLS)`);
    t.skip('claude not on PATH');
    return;
  }
  const inProject = { cwd: project, env };
  const install = run('claude', ['plugin', 'install', names.plugin, '--marketplace', root, '--json'], inProject);
  assert.equal(install.status, 0, out(install));
  const details = run('claude', ['plugin', 'details', `${names.plugin}@${names.marketplace}`], inProject);
  assert.equal(details.status, 0, out(details));
  const { parseDetails } = await lib('cli/doctor.mjs');
  const parsed = parseDetails(details.stdout);
  assert.ok(parsed, `unrecognised \`claude plugin details\` output:\n${details.stdout}`);

  // Worst-case fixture state, every SessionStart source: an active repository (state written through lib/state) with
  // 150 active tasks whose titles have the maximum length, and a loop document that cannot be read.
  for (const args of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'base']]) assert.equal(run('git', args, inProject).status, 0);
  const state = await lib('state/index.mjs');
  const store = state.open(join(project, names.stateDir), { names });
  const at = '2026-10-15T10:00:00.000Z';
  store.write('state', null, { codename: names.codename, createdWith: readJson(join(pluginDir, '.claude-plugin', 'plugin.json')).version, activatedAt: at });
  state.registerHandle(store, { name: 'Test User', email: 'test@example.com', handle: 'AB' });
  for (let n = 1; n <= 150; n++) {
    store.write('task', `T-AB-${n}`, { id: `T-AB-${n}`, kind: 'task', title: `${'W'.repeat(100)} ${String(n).padStart(19, '0')}`, lane: null, owner: 'AB',
      class: 'critical', classHistory: [], status: 'fix-round', round: 999, events: [{ at, by: 'AB', event: 'created', data: {} }], base: null, branch: null });
  }
  mkdirSync(join(project, names.stateDir, 'local'), { recursive: true });
  writeFileSync(join(project, names.stateDir, 'local', 'loop.json'), '{"exit":');
  const { HOOKS } = await lib('hooks/registry.mjs');
  const sessionHooks = HOOKS.filter((h) => h.event === 'SessionStart');
  assert.ok(sessionHooks.length > 0, 'a SessionStart hook is registered');
  let sessionStartChars = 0;
  for (const h of sessionHooks) {
    for (const source of h.matcher.split('|')) {
      const input = JSON.stringify({ session_id: 'cost', cwd: project, hook_event_name: 'SessionStart', source, model: 'claude-opus', transcript_path: join(home, 't.jsonl') });
      const r = run(process.execPath, [join(pluginDir, 'bin', names.bin), 'hook', h.name], { ...inProject, input, stdio: ['pipe', 'pipe', 'pipe'] });
      assert.equal(r.status, 0, `${h.name} (${source})\n${out(r)}`);
      sessionStartChars = Math.max(sessionStartChars, injectedChars(r.stdout));
    }
  }
  t.diagnostic(`always-on ${parsed.alwaysOnTokens} tok; SessionStart ${sessionStartChars} chars`);
  assert.ok(sessionStartChars > 1000, `the worst-case fixture is measured, not an empty answer (${sessionStartChars} chars)`);
  assert.deepEqual(overBudget({ alwaysOnTokens: parsed.alwaysOnTokens, sessionStartChars }), []);

  // Not vacuous: the measured plugin ships its skills and agents, and `details` counts exactly those.
  const shipped = shippedComponents();
  assert.ok(shipped.skills.length > 0 && shipped.agents.length > 0, 'the plugin ships skills and agents');
  const components = parseComponents(details.stdout);
  assert.ok(components, `no component inventory in \`claude plugin details\`:\n${details.stdout}`);
  assert.deepEqual([...components.skills].sort(), shipped.skills, 'details lists the shipped skills');
  assert.deepEqual([...components.agents].sort(), shipped.agents, 'details lists the shipped agents');
  const over = [];
  for (const [name, limit] of [...shipped.skills.map((n) => [n, shipped.userOnly.includes(n) ? COMPONENT_LIMITS.userSkill : COMPONENT_LIMITS.skill]), ...shipped.agents.map((n) => [n, COMPONENT_LIMITS.agent])]) {
    const c = components.cost[name];
    if (!c || !Number.isFinite(c.alwaysOn)) over.push(`${name}: no per-component cost`);
    else if (c.alwaysOn > limit) over.push(`${name}: ${c.alwaysOn} tok > ${limit}`);
    else t.diagnostic(`${name}: always-on ${c.alwaysOn} tok (limit ${limit}), on-invoke ${c.onInvoke} tok`);
  }
  assert.deepEqual(over, []);
});
