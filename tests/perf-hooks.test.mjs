// Hook latency (SC13, GC8): every registered hook, run through the launcher as Claude Code runs it, in a fixture
// repository of 10,000 committed files: p95 ≤ 300 ms and max < 1 s of CPU time of the hook process (GC8: "< 1 s of CPU").
// CPU time, not wall clock: the hook process reports its own process.cpuUsage() on fd 3 from a preload, so a loaded machine
// (other agents, a full gate) does not change the result. The wall clock keeps one job, a hang guard (WALL_CEILING_MS).
// Commands are data// Commands are data: the guard gets them as JSON and never runs them.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fd3CpuMs, fd3Preload } from './helpers/cpu-time.mjs';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// No test here touches the real HOME: git and the launcher run with a throwaway HOME and an empty global git config
// (tests/helpers/isolated-env.mjs).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function locate() {
  const plugins = join(root, 'plugins');
  const hits = existsSync(plugins) ? readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json'))) : [];
  assert.equal(hits.length, 1, `expected exactly one plugins/*/lib/name.json, found ${hits.length}`);
  return { pluginDir: join(plugins, hits[0]), names: JSON.parse(readFileSync(join(plugins, hits[0], 'lib', 'name.json'), 'utf8')) };
}
const { pluginDir, names } = locate();
const LAUNCHER = join(pluginDir, 'bin', names.bin);
// Shared CI runners are slower and noisier than a developer machine: CI sets PERF_P95_MS (the 1 s max holds everywhere).
const P95_MS = Number(process.env.PERF_P95_MS) || 300;
const MAX_MS = 1000;
const WALL_CEILING_MS = 5000; // a hang guard only: a hook that takes this long in wall time is stuck, not slow

// What the budget judges: CPU p95 and max per hook, and the wall-clock hang guard. samples: { hook: [{ cpuMs, wallMs }] }.
// Returns the list of breaches (empty: within budget).
function judgeBudget(samples, { p95Ms = P95_MS, maxMs = MAX_MS, wallCeilingMs = WALL_CEILING_MS } = {}) {
  const out = [];
  for (const [n, xs] of Object.entries(samples)) {
    const cpu = xs.map((x) => x.cpuMs);
    if (cpu.some((c) => !Number.isFinite(c))) out.push(`${n}: CPU time not reported by the hook process`);
    else {
      if (p95(cpu) > p95Ms) out.push(`${n}: CPU p95 ${p95(cpu).toFixed(0)} ms > ${p95Ms} ms`);
      if (Math.max(...cpu) >= maxMs) out.push(`${n}: CPU max ${Math.max(...cpu).toFixed(0)} ms ≥ ${maxMs} ms`);
    }
    const wall = Math.max(...xs.map((x) => x.wallMs));
    if (wall >= wallCeilingMs) out.push(`${n}: wall ${wall.toFixed(0)} ms ≥ ${wallCeilingMs} ms (hang guard)`);
  }
  return out;
}

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-10k-'));
  for (let d = 0; d < files / 100; d++) {
    const sub = join(dir, 'src', `m${d}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < 100; f++) writeFileSync(join(sub, `f${f}.ts`), `export const v${f} = ${d};\n`);
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  const git = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); };
  git(['init', '-q', '-b', 'feat/perf']); git(['add', '-A']); git(['commit', '-q', '-m', 'fixture']);
  return dir;
}
// The repository made active (state through lib/state: 30 tasks, a running loop), so every hook does its full work.
async function activate(dir) {
  const state = await import(pathToFileURL(join(pluginDir, 'lib', 'state', 'index.mjs')).href);
  const store = state.open(join(dir, names.stateDir), { names });
  const at = '2026-10-15T10:00:00.000Z';
  store.write('state', null, { codename: names.codename, createdWith: JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).version, activatedAt: at });
  state.registerHandle(store, { name: 'Perf User', email: 'perf@example.com', handle: 'PU' });
  for (let n = 1; n <= 30; n++) {
    store.write('task', `T-PU-${n}`, { id: `T-PU-${n}`, kind: 'task', title: `Task ${n}`, lane: null, owner: 'PU', class: 'standard', classHistory: [], status: 'dispatched',
      round: 0, events: [{ at, by: 'PU', event: 'created', data: {} }], base: null, branch: null });
  }
  mkdirSync(join(dir, names.stateDir, 'local'), { recursive: true });
  writeFileSync(join(dir, names.stateDir, 'local', 'loop.json'), JSON.stringify({ schema: 1, id: 'L-1', startedAt: at, exit: null, ticks: 2 }));
}
// A valid event for each hook, so the measured run reaches the hook's substantive path (review r1b).
const TICK = `Run \`${names.bin} tick\` and do the listed steps.`;
function eventFor(h, dir, command) {
  const base = { session_id: 's', cwd: dir, hook_event_name: h.event };
  switch (h.name) {
    case 'guard-bash': return { ...base, tool_name: 'Bash', tool_input: { command } };
    case 'guard-wakeup': return { ...base, tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, prompt: TICK } };
    case 'decisions-context': return { ...base, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'm0', 'f0.ts'), old_string: 'v0', new_string: 'w0' } };
    case 'session-start': return { ...base, source: 'startup' };
    case 'subagent-start': return { ...base, agent_id: 'a1', agent_type: `${names.plugin}:implementer` };
    case 'stop-guard': return { ...base, stop_hook_active: false, session_crons: [{ id: 'c1', schedule: '*/20 * * * *', recurring: true, prompt: TICK }] };
    default: return { ...base, tool_name: 'Agent', tool_input: { subagent_type: `${names.plugin}:implementer`, prompt: 'x' } };
  }
}

// The preload reports the hook process's own CPU time (user + system) on fd 3 when it exits.
const PROBE = fd3Preload('perf-cpu-');
const runOnce = (name, input, cwd) => new Promise((done) => {
  const started = performance.now();
  const p = spawn(process.execPath, ['--require', PROBE, LAUNCHER, 'hook', name], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let stdout = ''; let cpu = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stdio[3].on('data', (d) => { cpu += d; });
  p.on('close', (status) => {
    let cpuMs = NaN;
    cpuMs = fd3CpuMs(cpu); // NaN is judged as "not reported"
    done({ status, stdout, cpuMs, wallMs: performance.now() - started });
  });
  p.stdin.on('error', () => {}); p.stdin.end(input);
});
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

// The judge itself, driven with fakes: a machine that is slow in wall time but not in CPU passes, a hook that burns CPU or hangs fails.
test('the budget judges CPU time: slow wall time alone passes, CPU over the limit or a hang fails', () => {
  // the judge itself, with an explicit limit: CI sets PERF_P95_MS for the measured run, never for this check
  const limit = { p95Ms: 300 };
  const fine = { cpuMs: 90, wallMs: 100 };
  assert.deepEqual(judgeBudget({ h: Array.from({ length: 20 }, () => fine) }, limit), []);
  assert.deepEqual(judgeBudget({ h: Array.from({ length: 20 }, () => ({ cpuMs: 90, wallMs: 4000 })) }, limit), [], 'a loaded machine: wall time 40x, same CPU');
  assert.match(judgeBudget({ h: Array.from({ length: 20 }, () => ({ cpuMs: 400, wallMs: 450 })) }, limit)[0], /CPU p95 400 ms > 300 ms/);
  assert.match(judgeBudget({ h: [...Array.from({ length: 19 }, () => fine), { cpuMs: 1200, wallMs: 1300 }] }, limit).join('\n'), /CPU max 1200 ms/);
  assert.match(judgeBudget({ h: [fine, { cpuMs: 10, wallMs: 6000 }] }, limit)[0], /hang guard/);
  assert.match(judgeBudget({ h: [{ cpuMs: NaN, wallMs: 10 }] }, limit)[0], /not reported/);
});

test('hook latency on a 10,000-file repository: p95 ≤ 300 ms, max < 1 s of CPU per hook (wall clock only as a 5 s hang guard)', async (t) => {
  const dir = fixture(10000);
  await activate(dir);
  const tracked = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').length;
  assert.ok(tracked >= 10000, `tracked files: ${tracked}`);
  const { HOOKS } = await import(pathToFileURL(join(pluginDir, 'lib', 'hooks', 'registry.mjs')).href);
  const event = (h, command) => JSON.stringify(eventFor(h, dir, command));
  // guard-bash: daily commands, among them the ones that read the branch (push without a refspec) and package.json
  const COMMANDS = ['git status', 'git push', 'git push -f', 'git commit -m "fix: stash note"', 'npm test', 'npm run lint | tail -1',
    'git push origin feat/perf', 'ls -la src', `${names.bin} status`, 'git stash'];
  const samples = {};
  for (const h of HOOKS) {
    samples[h.name] = [];
    const inputs = h.name === 'guard-bash' ? COMMANDS.flatMap((c) => [c, c, c]) : Array.from({ length: 10 }, () => 'git status');
    await runOnce(h.name, event(h, 'ls'), dir); // warm the file cache
    for (const c of inputs) {
      const r = await runOnce(h.name, event(h, c), dir);
      assert.equal(r.status, 0, `${h.name} <- ${c}`);
      // the measured guard is the real one: it decides, it does not just exit
      if (h.name === 'guard-bash') assert.equal(r.stdout.includes('"deny"'), c === 'git stash', `${h.name} <- ${c}: ${r.stdout}`);
      if (['session-start', 'subagent-start'].includes(h.name)) assert.match(r.stdout, /additionalContext/, `${h.name}: the context was built`);
      samples[h.name].push({ cpuMs: r.cpuMs, wallMs: r.wallMs });
    }
  }
  const lines = Object.entries(samples).map(([n, xs]) => `${n}: CPU p95 ${p95(xs.map((x) => x.cpuMs)).toFixed(0)} ms, max ${Math.max(...xs.map((x) => x.cpuMs)).toFixed(0)} ms; wall max ${Math.max(...xs.map((x) => x.wallMs)).toFixed(0)} ms; n=${xs.length}`);
  for (const l of lines) t.diagnostic(l);
  assert.deepEqual(judgeBudget(samples), []);
});
