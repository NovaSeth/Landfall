// `config show|set <key> <value> [--decision <D>]` (spec §8.2, §5.1 config.json, GC3): a threshold override
// (thresholds.<unit>.<path>, a number of the router's or the engine's threshold data) is written only with an active
// decision, which config.json keeps next to it and `config show` prints; without one: exit 1, nothing written.
// Executor role preferences need no decision. Flags have their own command (flags set).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
async function cli(args, { cwd, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  return { code, out: json ? JSON.parse(out.join('')) : out.join(''), stderr: err.join('') };
}
const show = (r) => `exit ${r.code}\n${typeof r.out === 'string' ? r.out : JSON.stringify(r.out)}\n${r.stderr}`;

async function repository(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'config-cmd-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const p = { base: iso.base, repo: realpathSync(repo), cwd: repo, env, state: join(realpathSync(repo), names.stateDir) };
  p.ok = async (args) => {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 0, `${args.join(' ')}\n${show(r)}`);
    return r;
  };
  await p.ok(['init']);
  return p;
}
const configText = (p) => (existsSync(join(p.state, 'config.json')) ? readFileSync(join(p.state, 'config.json'), 'utf8') : null);
const decide = async (p, extra = []) => (await p.ok(['decide', '--title', 'Small changes up to 50 lines', '--why', 'Our modules are long.', '--cost', 'Some standard tasks run as trivial.', ...extra])).out.data.id;

test('config set of a threshold without an active decision: exit 1 and nothing written; with one: written, and config show prints the decision (acceptance 2)', async (t) => {
  const p = await repository(t);
  const key = 'thresholds.router.trivial.maxLoc';
  const missing = await cli(['config', 'set', key, '50', '--yes'], p);
  assert.equal(missing.code, 1, show(missing));
  assert.equal(missing.out.errors[0].code, 'decision-required');
  const unknown = await cli(['config', 'set', key, '50', '--decision', 'D-TU-9', '--yes'], p);
  assert.equal(unknown.code, 1, show(unknown));
  assert.equal(unknown.out.errors[0].code, 'unknown-decision');
  const old = await decide(p);
  await p.ok(['decisions', 'retire', old, '--reason', 'replaced']);
  const retired = await cli(['config', 'set', key, '50', '--decision', old, '--yes'], p);
  assert.equal(retired.code, 1, show(retired));
  assert.equal(retired.out.errors[0].code, 'decision-not-active');
  assert.equal(configText(p), null, 'nothing written by a refusal');

  const id = await decide(p);
  const r = await p.ok(['config', 'set', key, '50', '--decision', id]);
  assert.deepEqual(r.out.data.threshold, { key: 'router.trivial.maxLoc', value: 50, default: 30, decision: id, at: r.out.data.threshold.at });
  const doc = JSON.parse(configText(p));
  assert.deepEqual([doc.thresholds['router.trivial.maxLoc'].value, doc.thresholds['router.trivial.maxLoc'].decision], [50, id]);
  const shown = await cli(['config', 'show'], { ...p, json: false });
  assert.equal(shown.code, 0, show(shown));
  assert.match(shown.out, new RegExp(`^ {2}router\\.trivial\\.maxLoc = 50 \\(default 30\\) · ${id}`, 'm'));
  const j = await cli(['config', 'show'], p);
  assert.deepEqual([j.out.data.thresholds['router.trivial.maxLoc'].value, j.out.data.thresholds['router.trivial.maxLoc'].decision], [50, id]);
  // Back to the default: the override is removed, again with a decision.
  const back = await cli(['config', 'set', key, 'default', '--yes'], p);
  assert.equal(back.code, 1, show(back));
  await p.ok(['config', 'set', key, 'default', '--decision', id]);
  assert.deepEqual(JSON.parse(configText(p)).thresholds ?? {}, {});
});

test('config set: a key must name a number of the threshold data, the value an integer; flags have their own command', async (t) => {
  const p = await repository(t);
  const id = await decide(p);
  for (const [args, code] of [
    [['config', 'set', 'thresholds.router.trivial.nope', '5', '--decision', id], 'unknown-key'],
    [['config', 'set', 'thresholds.router.flags.0', '5', '--decision', id], 'unknown-key'],
    [['config', 'set', 'thresholds.router.schema', '5', '--decision', id], 'unknown-key'],
    [['config', 'set', 'thresholds.engine.changeEveryDays', 'seven', '--decision', id], 'invalid-value'],
    [['config', 'set', 'thresholds.engine.changeEveryDays', '1.5', '--decision', id], 'invalid-value'],
    [['config', 'set', 'flags.engine', 'off'], 'use-flags-set'],
    [['config', 'set', 'colour', 'blue'], 'unknown-key'],
    [['config', 'set', 'executors.reviewer', 'codex', '--decision', id], 'unexpected-decision'],
    [['config', 'set', 'executors.reviewer', 'Codex!'], 'invalid-value'],
  ]) {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 2, `${args.join(' ')}\n${show(r)}`);
    assert.equal(r.out.errors[0].code, code, args.join(' '));
  }
  assert.equal(configText(p), null);
  await p.ok(['config', 'set', 'thresholds.engine.tierSignals.loc.levels.0.up', '6000', '--decision', id]);
  assert.equal(JSON.parse(configText(p)).thresholds['engine.tierSignals.loc.levels.0.up'].value, 6000);
});

test('config set executors: role preferences in order, no decision; the machine config overrides them; config show lists both', async (t) => {
  const p = await repository(t);
  await p.ok(['config', 'set', 'executors.reviewer', 'codex,claude']);
  assert.deepEqual(JSON.parse(configText(p)).executors, { reviewer: ['codex', 'claude'] });
  let j = await cli(['config', 'show'], p);
  assert.deepEqual(j.out.data.executors, { reviewer: { providers: ['codex', 'claude'], source: 'repo' }, implementer: { providers: [], source: 'default' } });
  mkdirSync(join(p.base, 'data'), { recursive: true });
  writeFileSync(join(p.base, 'data', 'config.json'), JSON.stringify({ schema: 1, executors: { reviewer: ['gemini'] } }));
  j = await cli(['config', 'show'], p);
  assert.deepEqual(j.out.data.executors.reviewer, { providers: ['gemini'], source: 'machine' });
  await p.ok(['config', 'set', 'executors.reviewer', 'default']);
  assert.deepEqual(JSON.parse(configText(p)).executors ?? {}, {});
  const noConsent = await cli(['config', 'set', 'executors.implementer', 'claude'], p);
  assert.equal(noConsent.code, 7, show(noConsent));
});
