// Wakeup guard (spec §7.7, §7.13, §8.3, SD-18, GC4, FLW-5): PreToolUse ScheduleWakeup|CronCreate → `guard-wakeup`.
// The contract table of the 1.5.2 schedule guard in the v2 grammar, with ruling R73: in an inactive repository (or
// outside one) every wakeup passes. In an active one the loop prompts are the fixed prompt (normalized for case,
// quotes, whitespace, a trailing period and Unicode compatibility forms, optionally with `--plan docs/plans/<file>.md`
// under the repository root), `/<plugin>:<command>` and the Claude Code loop sentinels; one classifier (isLoopPrompt)
// recognizes them by prefix, so a padded or clipped copy still counts. While no plugin loop runs, a user's own prompt
// passes; while one runs, only exact loop prompts pass; after a terminal exit (DONE, STALLED, BUDGET) no loop prompt
// passes; a loop state or repository state that cannot be read (or a git that does not answer in time) denies every
// wakeup (every loop ends). `stop: true` always passes; malformed input is allowed. Prompts are data only.
// U1 (spec §6.2): whether Claude Code runs PreToolUse hooks for these tools is recorded in the I3.2 report; the
// stop guard (tests/hooks-stop-guard.test.mjs) is the fallback either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';
import { AT, FAKE_GIT_MODES, MALFORMED, VERSION, fakeGit, hook, launch, lib, loopDoc, names, repo, writeLoop } from './helpers/hook-fixture.mjs';

isolateProcessEnv();

const { FIXED_PROMPT, LOOP_SENTINELS, isFixedPrompt, isLoopPrompt } = await lib('hooks/guard-wakeup.mjs');
const state = await lib('state/index.mjs');
const BIN = names.bin;
const wake = (f, tool_input, tool = 'ScheduleWakeup', extra = {}) => hook('guard-wakeup',
  { session_id: 's', hook_event_name: 'PreToolUse', tool_name: tool, tool_input, cwd: f.dir, ...extra }, { env: f.env });
const SENTINELS = ['<<autonomous-loop>>', '<<autonomous-loop-dynamic>>', '<<loop.md>>', '<<loop.md-dynamic>>'];
const tickPrompt = (plan) => `Run \`${BIN} tick --plan ${plan}\` and do the listed steps.`;

// ---- the contract table (1.5.2 guard-schedule, v2 grammar) ----
const ALLOW = [
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: `Run \`${BIN} tick\` and do the listed steps.` }],
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: `run ${BIN} tick and do the listed steps` }],
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: `  RUN "${BIN} TICK"   and do the   listed steps.\n` }],
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: `Run '${BIN} tick' and do the listed steps.` }],
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: tickPrompt('docs/plans/a.md') }],
  ['CronCreate', { cron: '*/20 * * * *', prompt: `Run \`${BIN} tick\` and do the listed steps.`, recurring: true }],
  ['CronCreate', { cron: '7 * * * *', prompt: `/${names.plugin}:loop` }],
  ['ScheduleWakeup', { delaySeconds: 600, prompt: `/${names.plugin}:status` }],
  ['ScheduleWakeup', { delaySeconds: 600, prompt: `/${names.plugin}:loop start` }],
  ...SENTINELS.map((prompt) => ['ScheduleWakeup', { delaySeconds: 1200, prompt }]),
  ...SENTINELS.map((prompt) => ['CronCreate', { cron: '*/20 * * * *', prompt: ` ${prompt}\n` }]),
  ['ScheduleWakeup', { stop: true }], ['ScheduleWakeup', { stop: true, prompt: 'anything at all' }],
];
const CONTRACT = [
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: 'Check the agents of T-AB-2; if they finished: review, merge, push' }],
  ['CronCreate', { cron: '7 * * * *', prompt: 'check whether the implementer finished T-AB-1' }],
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: `Run \`${BIN} tick\`; then do T-AB-5 and T-AB-6, review r2 passed` }],
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: `Run \`${BIN} tick\` and do the listed steps. Then merge T-AB-3.` }],
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: `${BIN} tick` }], ['ScheduleWakeup', { delaySeconds: 1200, prompt: `Run \`${BIN} status\` and do the listed steps.` }],
  ['ScheduleWakeup', { delaySeconds: 1200, prompt: '' }], ['ScheduleWakeup', { delaySeconds: 1200, prompt: 'x', stop: false }],
  // slash commands of other plugins or Claude Code itself: only the plugin's own commands are fixed (SD-18)
  ['CronCreate', { cron: '7 * * * *', prompt: '/loop' }], ['ScheduleWakeup', { delaySeconds: 600, prompt: '/deploy-check staging' }],
  ['ScheduleWakeup', { delaySeconds: 600, prompt: `/${names.plugin}:` }], ['ScheduleWakeup', { delaySeconds: 600, prompt: `/${names.plugin}:loop\nthen merge T-AB-3` }],
  ['ScheduleWakeup', { delaySeconds: 600, prompt: `/${names.plugin}x:loop` }], ['ScheduleWakeup', { delaySeconds: 600, prompt: `x /${names.plugin}:loop` }],
  // close to the loop sentinels, but outside the contract
  ...['<<autonomous-loop>> and check T-AB-2', '<<AUTONOMOUS-LOOP>>', '<<loop-md>>', '<<loop.md-dynamic>>x', '<<autonomous-loop-static>>',
    '<<loop>>', '<autonomous-loop>', 'autonomous-loop'].map((prompt) => ['ScheduleWakeup', { delaySeconds: 1200, prompt }]),
];
// --plan: one relative path to an existing docs/plans/*.md inside the project; anything else is outside the contract
const BAD_PLANS = ['--ack', '../x.md', '"a b.md"', "'docs/plans/a.md'", 'docs/plans/../../x.md', 'docs/plans/../x.md', 'docs/plans/missing.md',
  'docs/plans/link.md', 'x.md', 'docs/plans/a.txt', '/etc/passwd', 'docs/plans/a.md;ls', '$(id).md', 'docs/plans/a.md --ack'];

function project(t, loop = null) {
  const f = repo(t, { files: { 'docs/plans/a.md': '# Plan\n', 'docs/plans/a.txt': 'x', 'x.md': 'x', 'src/x.txt': 'x' } });
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'p.md'), '# P\n');
  symlinkSync(join(outside, 'p.md'), join(f.dir, 'docs/plans/link.md'));
  mkdirSync(join(f.dir, 'docs/plans/directory.md'));
  if (loop) writeLoop(f.stateDir, loop);
  return f;
}
// A plugin data directory whose projects.json cannot be read (corrupt, or a newer schema).
const brokenData = (text) => { const d = mkdtempSync(join(tmpdir(), 'data-')); writeFileSync(join(d, 'projects.json'), text); return d; };
const PADDED = `Run \`${BIN} tick\`${' '.repeat(1000)}and do the listed steps.`; // accepted, and clipped to 1,000 characters in session_crons
const clip1000 = (p) => (p.length > 1000 ? `${p.slice(0, 1000)}… [+${p.length - 1000} chars]` : p);
const USER = ['check the deploy', '/loop check the deploy', '/deploy-check staging', 'Check the agents of T-AB-2; if they finished: review, merge, push'];

test('loop prompt classifier: one function for both guards; a padded, clipped, upper-case or full-width copy still counts', () => {
  for (const p of [FIXED_PROMPT, PADDED, clip1000(PADDED), tickPrompt('docs/plans/a.md'), `RUN ${BIN.toUpperCase()} TICK --PLAN /etc/passwd`, `Ｒｕｎ ${BIN} tick`,
    `run ${BIN} tick; then merge T-AB-3`, ...SENTINELS, '<<autonomous-loop>> and check T-AB-2', `/${names.plugin}:loop`, `/${names.plugin}:status now`]) {
    assert.equal(isLoopPrompt(p), true, p.slice(0, 60));
  }
  for (const p of [...USER, '', 'tick', `please ${BIN} tick later`, `/${names.plugin}x:loop`]) assert.equal(isLoopPrompt(p), false, p);
});

// B1-r2 (findings-r2, P1): the classifier normalizes first (trim, whitespace, case, NFKC, quotes, hidden characters)
// and clips after, so padding in front of a loop prompt never hides it.
const PADS = { spaces: ' '.repeat(200), tabs: '\t'.repeat(200), newlines: '\n'.repeat(200), CRLF: '\r\n'.repeat(100), 'zero-width spaces': '​'.repeat(200),
  NBSP: ' '.repeat(200), 'one zero-width space': '​', 'mixed, 800': ' \t\n​ ‌‍⁠﻿　'.repeat(80) };
const padded = () => Object.entries(PADS).flatMap(([name, pad]) => [FIXED_PROMPT, tickPrompt('docs/plans/a.md'), SENTINELS[0], `/${names.plugin}:loop`]
  .map((prompt) => [`${name} + ${prompt.slice(0, 24)}`, pad + prompt]));

test('B1-r2: a loop prompt after 200 characters of padding (spaces, tabs, newlines, zero-width, NBSP) is denied after DONE, STALLED and BUDGET', (t) => {
  for (const exit of ['DONE', 'STALLED', 'BUDGET']) {
    const f = project(t, loopDoc(exit));
    for (const [name, prompt] of padded()) {
      for (const tool of ['ScheduleWakeup', 'CronCreate']) {
        const v = wake(f, { delaySeconds: 60, cron: '*/5 * * * *', prompt }, tool);
        assert.equal(v.decision, 'deny', `${exit} ${tool} ${name}`); assert.match(v.reason, new RegExp(`loop ended \\(${exit}\\)`), v.reason);
      }
      assert.equal(isLoopPrompt(prompt), true, `classifier: ${name}`);
    }
  }
});

test('B1-r2 property: for every padding p of at most 800 characters, isFixedPrompt(p + FIXED) implies isLoopPrompt(p + FIXED)', () => {
  const ALPHABET = [' ', '\t', '\n', '\r', ' ', '​', '‌', '‍', '⁠', '﻿', '　', ' ', ' ', ' ', '"', "'", '`', 'x', '.'];
  let a = 20261016; // mulberry32
  const rnd = (n) => { a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n); };
  let fixed = 0;
  for (let n = 0; n <= 800; n++) {
    const pads = [ALPHABET[n % ALPHABET.length].repeat(n), Array.from({ length: n }, () => ALPHABET[rnd(ALPHABET.length - 2)]).join(''),
      Array.from({ length: n }, () => ALPHABET[rnd(ALPHABET.length)]).join('')];
    for (const p of pads) {
      for (const prompt of [FIXED_PROMPT, tickPrompt('docs/plans/a.md'), `run ${BIN} tick and do the listed steps`]) {
        if (!isFixedPrompt(p + prompt)) continue;
        fixed++;
        assert.equal(isLoopPrompt(p + prompt), true, `padding of ${n}: ${JSON.stringify(p.slice(0, 12))}…`);
      }
    }
  }
  assert.ok(fixed >= 3000, `the implication is not vacuous: ${fixed} fixed prompts`);
});

test('wakeup contract in a running loop: the exact loop prompts pass; every other prompt is denied with FLW-5 and the allowed list', (t) => {
  const f = project(t, loopDoc(null));
  for (const [tool, input] of [...ALLOW, ['ScheduleWakeup', { delaySeconds: 60, prompt: PADDED }]]) {
    const v = wake(f, input, tool);
    assert.equal(v.decision, 'allow', `${tool} ${JSON.stringify(input).slice(0, 120)}: ${v.reason}`);
    assert.equal(v.stdout, '', 'an allow prints nothing');
  }
  assert.equal(FIXED_PROMPT, `Run \`${BIN} tick\` and do the listed steps.`, 'the fixed prompt of spec §7.7');
  assert.deepEqual([...LOOP_SENTINELS].sort(), [...SENTINELS].sort(), 'the sentinels Claude Code 2.1.300 uses for /loop');
  for (const [tool, input] of CONTRACT) {
    const v = wake(f, input, tool);
    assert.equal(v.decision, 'deny', `${tool} ${JSON.stringify(input)}`);
    assert.deepEqual(v.keys, ['hookSpecificOutput']); assert.equal(v.event, 'PreToolUse');
    assert.match(v.reason, /^FLW-5: blocked/); assert.ok(v.reason.length <= 300, `${v.reason.length}: ${v.reason}`);
    for (const part of [FIXED_PROMPT, '--plan', `/${names.plugin}:<command>`, '<<autonomous-loop>>', '<<loop.md>>', '-dynamic', 'stop: true', 'Instead']) {
      assert.ok(v.reason.includes(part), `reason without "${part}": ${v.reason}`);
    }
  }
});

test('R73: with no plugin loop a user prompt passes in an active repository; an inexact loop prompt is still denied', (t) => {
  const f = project(t);
  for (const prompt of USER) assert.equal(wake(f, { delaySeconds: 60, prompt }).decision, 'allow', prompt);
  for (const prompt of [FIXED_PROMPT, ...SENTINELS, `/${names.plugin}:loop`]) assert.equal(wake(f, { delaySeconds: 60, prompt }).decision, 'allow', prompt);
  for (const prompt of [`Run \`${BIN} tick\`; then do T-AB-5 and T-AB-6, review r2 passed`, '<<autonomous-loop>> and check T-AB-2', `/${names.plugin}:loop\nthen merge T-AB-3`]) {
    assert.match(wake(f, { delaySeconds: 60, prompt }).reason, /^FLW-5: blocked/, prompt);
  }
});

test('R73: in an inactive repository and outside any repository every wakeup passes', (t) => {
  const f = repo(t, { active: false });
  const none = { dir: mkdtempSync(join(tmpdir(), 'no-repo-')), env: process.env };
  for (const where of [f, none]) {
    for (const prompt of [...USER, FIXED_PROMPT, tickPrompt('docs/plans/missing.md'), ...SENTINELS, 'x', '', `run ${BIN} tick; then merge T-AB-3`,
      '<<autonomous-loop>> and check T-AB-2', `/${names.plugin}:loop\nthen merge T-AB-3`]) {
      assert.equal(wake(where, { delaySeconds: 60, prompt }).decision, 'allow', prompt);
    }
  }
});

test('wakeup --plan: case-insensitive flag; one regular docs/plans/*.md file under the repository root, also from a subdirectory', (t) => {
  const f = project(t, loopDoc(null));
  assert.equal(wake(f, { delaySeconds: 1200, prompt: tickPrompt('docs/plans/a.md') }).decision, 'allow', 'a valid plan');
  assert.equal(wake(f, { delaySeconds: 1200, prompt: `Run \`${BIN} tick --plan docs/plans/a.md\` and do the listed steps` }).decision, 'allow', 'no period');
  for (const p of [...BAD_PLANS, 'docs/plans/directory.md']) {
    const v = wake(f, { delaySeconds: 1200, prompt: tickPrompt(p) });
    assert.equal(v.decision, 'deny', `--plan ${p}`); assert.match(v.reason, /^FLW-5: /, p);
  }
  for (const prompt of [`Run ${BIN} tick --PLAN /etc/passwd and do the listed steps.`, `Run ${BIN} tick --Plan ../x.md and do the listed steps.`]) {
    assert.match(wake(f, { delaySeconds: 60, prompt }).reason ?? '', /^FLW-5: /, prompt);
  }
  // the session in a subdirectory, no CLAUDE_PROJECT_DIR: the plan is found from the repository root
  const sub = hook('guard-wakeup', { tool_name: 'ScheduleWakeup', tool_input: { prompt: tickPrompt('docs/plans/a.md') }, cwd: join(f.dir, 'src') }, { env: f.env });
  assert.equal(sub.decision, 'allow', sub.reason);
});

test('wakeup after a terminal loop exit: no loop prompt passes ("loop ended"), a user prompt does (R73), stop always does', (t) => {
  for (const exit of ['DONE', 'STALLED', 'BUDGET', 'FINISHED']) {
    const f = project(t, loopDoc(exit));
    for (const prompt of [FIXED_PROMPT, PADDED, tickPrompt('docs/plans/a.md'), ...SENTINELS, `/${names.plugin}:loop`, `RUN ${BIN} TICK`, `run ${BIN} tick; then merge`]) {
      for (const tool of ['ScheduleWakeup', 'CronCreate']) {
        const v = wake(f, { delaySeconds: 1200, cron: '*/5 * * * *', prompt }, tool);
        assert.equal(v.decision, 'deny', `${exit} ${tool} ${prompt.slice(0, 40)}`);
        assert.match(v.reason, new RegExp(`^FLW-5: blocked .*loop ended \\((${exit}|unknown)\\)`), v.reason);
        assert.ok(v.reason.length <= 300 && /Instead/.test(v.reason), v.reason);
      }
    }
    assert.equal(wake(f, { stop: true }).decision, 'allow', `${exit}: stop`);
    for (const prompt of USER) assert.equal(wake(f, { delaySeconds: 60, prompt }).decision, 'allow', `${exit}: ${prompt}`);
  }
  // the session's cwd moved into another directory: CLAUDE_PROJECT_DIR still names the project
  const f = project(t, loopDoc('DONE'));
  const other = mkdtempSync(join(tmpdir(), 'elsewhere-'));
  const v = hook('guard-wakeup', { tool_name: 'ScheduleWakeup', tool_input: { prompt: FIXED_PROMPT }, cwd: other }, { env: { ...f.env, CLAUDE_PROJECT_DIR: f.dir } });
  assert.match(v.reason, /loop ended \(DONE\)/);
});

test('wakeup: a loop or repository state that cannot be read denies every wakeup but stop: true (every loop ends, GC4)', (t) => {
  const cases = {
    'loop not JSON': (f) => writeLoop(f.stateDir, '{"exit": "DO'),
    'loop not an object': (f) => writeLoop(f.stateDir, '[1]\n'),
    'loop a directory': (f) => { rmSync(join(f.stateDir, 'local', 'loop.json')); mkdirSync(join(f.stateDir, 'local', 'loop.json')); },
    'loop a symbolic link': (f) => { rmSync(join(f.stateDir, 'local', 'loop.json')); const o = join(f.base, 'loop.json'); writeFileSync(o, JSON.stringify(loopDoc(null))); symlinkSync(o, join(f.stateDir, 'local', 'loop.json')); },
    'corrupt projects.json': (f) => { f.env = { ...f.env, CLAUDE_PLUGIN_DATA: brokenData('{') }; },
    'newer projects.json': (f) => { f.env = { ...f.env, CLAUDE_PLUGIN_DATA: brokenData('{"schema":999,"projects":{}}') }; },
    'git missing': (f) => { f.env = { ...f.env, PATH: mkdtempSync(join(tmpdir(), 'nogit-')) }; },
  };
  for (const [name, plant] of Object.entries(cases)) {
    const f = project(t, loopDoc('DONE'));
    plant(f);
    for (const prompt of [FIXED_PROMPT, SENTINELS[1], ...USER]) {
      const v = wake(f, { delaySeconds: 1200, prompt });
      assert.equal(v.decision, 'deny', `${name}: ${prompt}`); assert.match(v.reason, /^FLW-5: blocked .*state cannot be read/, `${name}: ${v.reason}`);
      assert.ok(v.reason.length <= 300, v.reason);
    }
    assert.equal(wake(f, { stop: true }).decision, 'allow', `${name}: stop`);
  }
});

// B2-r2 (findings-r2, P1): only git's own "not a git repository" with no .git entry above is "no repository"; any other
// git failure leaves the state unknown, and with an active-looking marker (the state directory in cwd or above, in
// CLAUDE_PROJECT_DIR, or a projects.json entry) the wakeup is denied. Without any marker the plugin stays out (R73).
const linkedProject = (t, exit) => {
  const f = repo(t, { active: false });
  const ext = join(f.base, 'control', 'state');
  const st = state.open(ext, { names });
  st.write('state', null, { codename: names.codename, createdWith: VERSION, activatedAt: AT });
  state.updateProject({ repo: f.dir, dataDir: f.env.CLAUDE_PLUGIN_DATA, names, patch: { stateDir: ext } });
  writeLoop(ext, loopDoc(exit));
  return f;
};
const wakeIn = (cwd, env, prompt, tool = 'ScheduleWakeup') => hook('guard-wakeup',
  { tool_name: tool, tool_input: { delaySeconds: 60, cron: '*/5 * * * *', prompt }, cwd }, { env });

test('B2-r2: after DONE a git that fails (dubious ownership exit 128, permission, crash, a broken .git) denies the fixed wakeup in an active repository', (t) => {
  for (const mode of FAKE_GIT_MODES) {
    const f = project(t, loopDoc('DONE'));
    const env = { ...f.env, PATH: fakeGit(t, mode) };
    for (const tool of ['ScheduleWakeup', 'CronCreate']) {
      const v = wakeIn(f.dir, env, FIXED_PROMPT, tool);
      assert.equal(v.decision, 'deny', `${mode} ${tool}`); assert.match(v.reason, /^FLW-5: blocked .*state cannot be read/, `${mode}: ${v.reason}`);
    }
    assert.equal(wakeIn(join(f.dir, 'src'), env, FIXED_PROMPT).decision, 'deny', `${mode}: from a subdirectory`);
    // the marker only in CLAUDE_PROJECT_DIR: the session's cwd is a plain directory
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'elsewhere-')));
    assert.equal(wakeIn(other, { ...env, CLAUDE_PROJECT_DIR: f.dir }, FIXED_PROMPT).decision, 'deny', `${mode}: CLAUDE_PROJECT_DIR`);
    assert.equal(wake(f, { stop: true }).decision, 'allow', `${mode}: stop`);
  }
  // a linked state directory (projects.json entry, nothing in the repository): healthy git → loop ended; failing git → unknown
  const l = linkedProject(t, 'DONE');
  assert.match(wakeIn(l.dir, l.env, FIXED_PROMPT).reason, /loop ended \(DONE\)/);
  const v = wakeIn(l.dir, { ...l.env, PATH: fakeGit(t, 'dubious') }, FIXED_PROMPT);
  assert.equal(v.decision, 'deny', 'linked'); assert.match(v.reason, /state cannot be read/);
});

test('B2-r2: no marker, no false positive: a failing or missing git outside any repository or in a repository without the plugin allows every wakeup', (t) => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'no-repo-')));
  const bare = repo(t, { active: false });
  for (const mode of [...FAKE_GIT_MODES, 'missing']) {
    const path = mode === 'missing' ? realpathSync(mkdtempSync(join(tmpdir(), 'nogit-'))) : fakeGit(t, mode);
    for (const [where, cwd, env] of [['plain', plain, process.env], ['repository without the plugin', bare.dir, bare.env]]) {
      for (const prompt of [FIXED_PROMPT, USER[0], SENTINELS[0]]) {
        const v = wakeIn(cwd, { ...env, PATH: path }, prompt);
        assert.equal(v.decision, 'allow', `${mode} ${where} ${prompt}: ${v.reason}`);
      }
    }
  }
});

test('wakeup: malformed input or a prompt that is not a string is allowed without output (GC8); the launcher answers the same', (t) => {
  const f = project(t, loopDoc('DONE'));
  const inputs = [...MALFORMED, '{"tool_input":{"delaySeconds":60}}', '{"tool_input":{"prompt":42}}', '{"tool_input":{"prompt":["/loop"]}}',
    '{"tool_input":{"prompt":{"text":"x"}}}', '{"tool_input":{"prompt":null}}'];
  for (const text of inputs) {
    const v = hook('guard-wakeup', text, { env: f.env });
    assert.equal(v.decision, 'allow', text); assert.equal(v.stdout, '', text); assert.equal(v.stderr, '', text);
  }
  const deny = launch('guard-wakeup', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, prompt: FIXED_PROMPT }, cwd: f.dir }, { env: f.env, cwd: f.dir });
  assert.equal(deny.status, 0); assert.equal(deny.decision, 'deny'); assert.match(deny.reason, /loop ended \(DONE\)/);
  const allow = launch('guard-wakeup', { tool_name: 'ScheduleWakeup', tool_input: { stop: true }, cwd: f.dir }, { env: f.env, cwd: f.dir });
  assert.equal(allow.status, 0); assert.equal(allow.stdout, '');
});

// SC6 (hook part): random loop and repository states against random wakeups AND turn ends (session_crons as Claude Code
// sends them: prompts clipped at 1,000 characters). After a terminal exit, or with a state that cannot be read, no loop
// prompt is scheduled and a turn end with a pending loop prompt is blocked once; stop: true always passes.
test('SC6 hook part: 1,000 random (state, wakeup or turn end): 0 loop wakeups after a terminal exit; Stop blocks once on any pending loop prompt', (t) => {
  const f = project(t);
  const healthy = f.env; const broken = { ...f.env, CLAUDE_PLUGIN_DATA: brokenData('{') };
  let a = 20261015; // mulberry32
  const rnd = (n) => { a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n); };
  const STATES = ['absent', 'running', 'DONE', 'STALLED', 'BUDGET', 'unreadable', 'corrupt'];
  const LOOP = [FIXED_PROMPT, PADDED, tickPrompt('docs/plans/a.md'), ...SENTINELS, `/${names.plugin}:loop`];
  const seen = Object.fromEntries(STATES.map((s) => [s, 0])); const tools = { ScheduleWakeup: 0, CronCreate: 0, Stop: 0 };
  for (let k = 0; k < 1000; k++) {
    const s = STATES[rnd(STATES.length)]; seen[s]++;
    if (s === 'absent') rmSync(join(f.stateDir, 'local', 'loop.json'), { force: true });
    else if (s === 'running' || s === 'corrupt') writeLoop(f.stateDir, loopDoc(null));
    else if (s === 'unreadable') writeLoop(f.stateDir, rnd(2) ? '{' : '[]');
    else writeLoop(f.stateDir, loopDoc(s));
    f.env = s === 'corrupt' ? broken : healthy;
    const ended = !['absent', 'running'].includes(s);
    const pick = () => (rnd(3) ? LOOP[rnd(LOOP.length)] : USER[rnd(USER.length)]);
    const kind = ['ScheduleWakeup', 'CronCreate', 'Stop'][rnd(3)]; tools[kind]++;
    if (kind === 'Stop') {
      const crons = Array.from({ length: rnd(4) }, (_, j) => ({ id: `c${k}x${j}`, schedule: '* * * * *', recurring: rnd(2) === 1, prompt: clip1000(pick()) }));
      const active = rnd(4) === 0;
      const v = hook('stop-guard', { hook_event_name: 'Stop', cwd: f.dir, stop_hook_active: active, session_crons: crons }, { env: f.env });
      const pending = crons.some((c) => isLoopPrompt(c.prompt));
      if (ended && pending && !active) assert.equal(v.decision, 'block', `${s}: ${JSON.stringify(crons).slice(0, 200)}`);
      else assert.equal(v.decision, 'allow', `${s} stop_hook_active=${active}: ${JSON.stringify(crons).slice(0, 200)}`);
      if (v.reason) assert.ok(v.reason.length <= 300, v.reason);
      continue;
    }
    if (rnd(6) === 0) { assert.equal(wake(f, { stop: true }, kind).decision, 'allow', `stop in ${s}`); continue; }
    const prompt = pick();
    const v = wake(f, { delaySeconds: 60 + rnd(3000), cron: '*/5 * * * *', prompt }, kind);
    if (ended && isLoopPrompt(prompt)) assert.equal(v.decision, 'deny', `${s}: ${prompt.slice(0, 60)}`);
  }
  for (const [s, n] of Object.entries(seen)) assert.ok(n >= 80, `state ${s}: ${n} cases`);
  for (const [k, n] of Object.entries(tools)) assert.ok(n >= 250, `${k}: ${n} calls`);
});
