// Hook test fixtures (I3.2): the plugin's lib loader, a repository whose state directory is written through lib/state
// (never by hand), the loop document the loop unit will write (spec §5.2; no writer exists before the loop task, so
// tests write it as a fixture), and one hook call in process (lib/hooks/registry.mjs) or through the launcher.
// The process environment is isolated when this module loads (tests/helpers/isolated-env.mjs): git, the launcher and
// the hooks see a throwaway HOME. This file holds no plugin name or path: both come from lib/name.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from '../helpers/isolated-env.mjs'; // the specifier the isolation scan recognizes

isolateProcessEnv();

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
export const names = readJson(join(pluginDir, 'lib', 'name.json'));
export const VERSION = readJson(join(pluginDir, '.claude-plugin', 'plugin.json')).version;
export const LAUNCHER = join(pluginDir, 'bin', names.bin);
export const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);

const state = await lib('state/index.mjs');
const { runHook } = await lib('hooks/registry.mjs');
export const AT = '2026-10-15T10:00:00.000Z';

export function git(cwd, args, env = process.env) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// A git repository with one commit (files: { relative path: text }, committed). active: a state directory written
// through lib/state with the given handles registered. Result { base, dir, stateDir, env, store }.
export function repo(t, { active = true, handles = ['AB'], files = { 'README.md': '# x\n' }, prefix = 'hooks-' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: join(base, 'data') };
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q'], env);
  git(dir, ['config', 'user.name', 'Test User'], env);
  git(dir, ['config', 'user.email', 'test@example.com'], env);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git(dir, ['add', '-A'], env);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base'], env);
  const stateDir = join(dir, names.stateDir);
  let store = null;
  if (active) {
    store = state.open(stateDir, { names });
    store.write('state', null, { codename: names.codename, createdWith: VERSION, activatedAt: AT });
    handles.forEach((h, k) => state.registerHandle(store, { name: `Dev ${h}`, email: `${h.toLowerCase()}${k}@example.com`, handle: h }));
  }
  return { base, dir, stateDir, env, store };
}

// A task document (spec §5.1) written through lib/state.
export function task(store, n, { status = 'dispatched', title = `Task ${n}`, round = 0, owner = 'AB', kind = 'task' } = {}) {
  const id = `T-${owner}-${n}`;
  store.write('task', id, { id, kind, title, lane: null, owner, class: 'standard', classHistory: [], status, round,
    events: [{ at: AT, by: owner, event: 'created', data: {} }], base: null, branch: null });
  return id;
}

// The loop document of spec §5.2 as the loop unit writes it (a fixture until that unit lands).
export function loopDoc(exit = null, extra = {}) {
  return { schema: 1, id: 'L-1', startedAt: AT, caps: { wallMin: 600, ticks: 200, usd: 20, rounds: 2 }, ticks: 3, fingerprint: 'f'.repeat(64),
    sameCount: 0, sameSince: AT, exit, exitAt: exit ? AT : null, extensions: [], ...extra };
}
export function writeLoop(stateDir, doc) {
  mkdirSync(join(stateDir, 'local'), { recursive: true });
  writeFileSync(join(stateDir, 'local', 'loop.json'), typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
}

// A directory holding a stand-in `git` (put it on PATH) that fails the way a real git does (findings-r2 B2): dubious
// ownership and an unreadable working directory (exit 128, git's own stderr, empty stdout), a crash (SIGSEGV), and git's
// "not a git repository" answer where a .git entry exists (a broken repository).
const FAKE_GIT = {
  dubious: `printf "fatal: detected dubious ownership in repository at '%s'\\nTo add an exception for this directory, call:\\n\\n\\tgit config --global --add safe.directory %s\\n" "$PWD" "$PWD" >&2\nexit 128`,
  denied: 'printf "fatal: Unable to read current working directory: Permission denied\\n" >&2\nexit 128',
  crash: 'kill -SEGV $$',
  'not-a-repo': 'printf "fatal: not a git repository (or any of the parent directories): .git\\n" >&2\nexit 128',
};
export const FAKE_GIT_MODES = Object.freeze(Object.keys(FAKE_GIT));
export function fakeGit(t, mode) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `fake-git-${mode}-`)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n${FAKE_GIT[mode]}\n`, { mode: 0o755 });
  return dir;
}

// One hook in process. Result { decision ('allow' | 'deny' | 'block'), reason, context, stdout, stderr, code }.
export function decode(r) {
  const stdout = r?.stdout ?? ''; const stderr = r?.stderr ?? ''; const code = r?.code ?? r?.status ?? 0;
  if (code === 2) return { decision: 'deny', reason: stderr.trim(), context: null, stdout, stderr, code };
  if (stdout.trim() === '') return { decision: 'allow', reason: '', context: null, stdout, stderr, code };
  const o = JSON.parse(stdout);
  if (o.decision === 'block') return { decision: 'block', reason: o.reason, context: null, stdout, stderr, code, keys: Object.keys(o) };
  const h = o.hookSpecificOutput ?? {};
  return { decision: h.permissionDecision ?? 'allow', reason: h.permissionDecisionReason ?? '', context: h.additionalContext ?? null, event: h.hookEventName,
    stdout, stderr, code, keys: Object.keys(o) };
}
export const hook = (name, input, opts = {}) => decode(runHook(name, typeof input === 'string' ? input : JSON.stringify(input), { deadline: Infinity, ...opts }));

// The launcher end to end (exec form, as hooks/hooks.json runs it).
export function launch(name, input, { env = process.env, cwd = tmpdir() } = {}) {
  const r = spawnSync(process.execPath, [LAUNCHER, 'hook', name], { input: typeof input === 'string' ? input : JSON.stringify(input), env, cwd, encoding: 'utf8', timeout: 30000 });
  return { ...decode({ stdout: r.stdout, stderr: r.stderr, status: r.status }), status: r.status };
}

// Malformed hook input (GC8: allowed, no output).
export const MALFORMED = ['', 'not json', '{"truncated":', '[]', 'null', '42', '"text"', '{}', '{"tool_input":null}', '{"tool_input":"x"}',
  '{"tool_input":[]}', '{"cwd":7}', '{"hook_event_name":5,"source":7}'];
