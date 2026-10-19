// `profile gates apply --decision <D>` and `profile gates set <name> <cmd> [--kind <k>] [--timeout <s>] --decision <D>`
// (spec §7.3, §7.6, GC3): after activation a gate change is a decision, because a weaker gate weakens the oracle. Without
// an active gate-change decision both exit 1 and write nothing; with one, apply replaces the gates with the observed
// candidates and set adds or replaces one gate by name; verify runs the gates that are in the profile then.
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
const { main } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'main.mjs')).href);
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
async function cli(args, { cwd, env }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, out: JSON.parse(out.join('')), stderr: err.join('') };
}
const show = (r) => `exit ${r.code}\n${JSON.stringify(r.out)}\n${r.stderr}`;

async function repository(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'gates-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e 0' } }));
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['add', '-A']);
  git(repo, env, ['commit', '-q', '-m', 'start']);
  const p = { repo: realpathSync(repo), cwd: repo, env, state: join(realpathSync(repo), names.stateDir) };
  p.ok = async (args) => {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 0, `${args.join(' ')}\n${show(r)}`);
    return r;
  };
  await p.ok(['init']);
  return p;
}
const profileText = (p) => (existsSync(join(p.state, 'profile.json')) ? readFileSync(join(p.state, 'profile.json'), 'utf8') : null);
const gates = (p) => JSON.parse(profileText(p)).gates.map((g) => [g.name, g.cmd, g.kind, g.timeoutS]);
const decide = async (p, kind) => (await p.ok(['decide', '--kind', kind, '--title', `A ${kind} decision`, '--why', 'The real gate runs more than the detected one.', '--cost', 'A slower gate.'])).out.data.id;

test('profile gates apply and set without an active gate-change decision exit 1 and write nothing (acceptance 3)', async (t) => {
  const p = await repository(t);
  const before = profileText(p);
  const general = await decide(p, 'general');
  for (const args of [
    ['profile', 'gates', 'apply'],
    ['profile', 'gates', 'apply', '--decision', 'D-TU-9'],
    ['profile', 'gates', 'apply', '--decision', general],
    ['profile', 'gates', 'set', 'unit', 'node -e 0'],
    ['profile', 'gates', 'set', 'unit', 'node -e 0', '--decision', general],
  ]) {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 1, `${args.join(' ')}\n${show(r)}`);
    assert.ok(['decision-required', 'unknown-decision', 'decision-kind'].includes(r.out.errors[0].code), r.out.errors[0].code);
  }
  assert.equal(profileText(p), before, 'nothing written');
  const bad = await cli(['profile', 'gates', 'set', 'Unit Tests', 'node -e 0', '--decision', general, '--yes'], p);
  assert.equal(bad.code, 2, show(bad));
  const noConsent = await cli(['profile', 'gates', 'apply', '--decision', general], p);
  assert.equal(noConsent.code, 7, show(noConsent));
});

test('with an active gate-change decision: apply takes the observed candidates, set adds or replaces one gate, verify runs them (acceptance 3)', async (t) => {
  const p = await repository(t);
  const id = await decide(p, 'gate-change');
  const applied = await p.ok(['profile', 'gates', 'apply', '--decision', id]);
  assert.deepEqual(applied.out.data.gates.map((g) => [g.name, g.cmd, g.kind]), [['test', 'npm run test', 'test']]);
  assert.deepEqual(gates(p).map(([n, c]) => [n, c]), [['test', 'npm run test']]);
  // Replace the detected gate by name (kind and time limit kept unless given), then add one.
  await p.ok(['profile', 'gates', 'set', 'test', 'node -e "process.exit(0)"', '--decision', id]);
  await p.ok(['profile', 'gates', 'set', 'smoke', 'node -e "process.exit(3)"', '--kind', 'e2e', '--timeout', '30', '--decision', id]);
  assert.deepEqual(gates(p), [['test', 'node -e "process.exit(0)"', 'test', gates(p)[0][3]], ['smoke', 'node -e "process.exit(3)"', 'e2e', 30]]);
  for (const [args, code] of [[['--kind', 'magic'], 'invalid-value'], [['--timeout', '0'], 'invalid-value'], [['--timeout', '9999'], 'invalid-value']]) {
    const r = await cli(['profile', 'gates', 'set', 'smoke', 'node -e 0', ...args, '--decision', id, '--yes'], p);
    assert.equal(r.code, 2, `${args.join(' ')}\n${show(r)}`);
    assert.equal(r.out.errors[0].code, code);
  }
  // verify runs exactly the profile's gates now.
  await p.ok(['task', 'new', 'A task']);
  await p.ok(['route', 'T-TU-1', '--paths', 'a.js', '--loc', '3']);
  const v = await cli(['verify', 'T-TU-1', '--ci', '--yes'], p);
  assert.deepEqual(v.out.data.gates.map((g) => [g.name, g.exit]), [['test', 0], ['smoke', 3]], show(v));
});
