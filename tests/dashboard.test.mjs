// The dashboard mod (retro 2026-10 P1-9): the plugin's hooks manifest names the hooks module, the module and its state
// contract exist and plugin.json points at the contract and declares the dashboard option. Where Claude Code is on PATH
// the engine itself validates the module (`claude plugin validate`) and runs the mod's own tests (`claude plugin test`);
// elsewhere those two checks are skipped and say so. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (the Claude Code CLI among them) gets a throwaway HOME and environment (S1).
isolateProcessEnv();
const ISO = isolatedEnv({ prefix: 'dashboard-' });
const claudeRun = (args, timeout) => spawnSync('claude', args, { encoding: 'utf8', timeout, env: ISO.env });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));

const claude = (() => {
  const r = claudeRun(['--version'], 20000);
  return r.status === 0 && /^\d+\.\d+\.\d+/.test(r.stdout.trim()) ? r.stdout.trim() : null;
})();

test('hooks.json names the dashboard module next to the command hooks; the module, its test and its state contract exist', () => {
  assert.deepEqual(hooks.modules, ['./dashboard.tsx'], 'the one hooks module');
  assert.ok(Object.keys(hooks.hooks).length >= 5, 'the command hooks stay');
  const module = readFileSync(join(pluginDir, 'hooks', 'dashboard.tsx'), 'utf8');
  assert.match(module, /export const register: Register = /);
  assert.match(module, /\$\.ui\.open\(\{ id: PANE, title: 'Landfall' \}\)/, 'opens the Landfall pane');
  assert.match(module, /'status', '--json'|\['status'\]/, 'reads the plugin status');
  assert.match(module, /\$\.agent\.list\(\)/, 'reads the engine agent list');
  assert.match(module, /\$\.ui\.status\(/, 'sets the status line');
  assert.ok(existsSync(join(pluginDir, 'hooks', 'dashboard.test.tsx')));
  assert.equal(manifest.types, './types/index.d.ts');
  const contract = readFileSync(join(pluginDir, manifest.types), 'utf8');
  assert.match(contract, new RegExp(`${names.plugin}: \\{ snapshot: Snapshot \\| null; agents: AgentRecord\\[\\] \\}`));
  assert.deepEqual(manifest.userConfig.dashboard.options, ['auto', 'command', 'off']);
  assert.equal(manifest.userConfig.dashboard.default, 'auto');
});

test('the engine validates the module and runs the dashboard tests (skipped without Claude Code on PATH)', { skip: claude ? false : 'claude is not on PATH' }, () => {
  const v = claudeRun(['plugin', 'validate', pluginDir], 120000);
  assert.equal(v.status, 0, `claude plugin validate (${claude}):\n${v.stdout}\n${v.stderr}`);
  assert.match(v.stdout, /dashboard\.tsx hooks: session\.start/, 'the module is scanned');
  const t = claudeRun(['plugin', 'test', pluginDir], 300000);
  assert.equal(t.status, 0, `claude plugin test (${claude}):\n${t.stdout}\n${t.stderr}`);
  assert.match(t.stdout, /\n\s*0 fail\b/, t.stdout);
  assert.doesNotMatch(t.stdout, /\(fail\)/, t.stdout);
});
