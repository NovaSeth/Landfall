// `migrate [--dry-run]` (spec §5.4, SD-10, REV-57, GC9): the forward migration chain on every state document of the
// repository (every committed JSON kind of every unit). --dry-run lists the steps and writes nothing; a second run
// writes nothing (idempotent); a newer schema refuses (exit 7) before any byte.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
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
function snapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (lstatSync(p).isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

// An active repository whose state.json was written by 2.0.0-beta.1 (store schema 1, flags in state.json).
async function oldRepository(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'migrate-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const p = { repo: realpathSync(repo), cwd: repo, env, state: join(realpathSync(repo), names.stateDir) };
  const init = await cli(['init', '--yes'], p);
  assert.equal(init.code, 0, show(init));
  const doc = JSON.parse(readFileSync(join(p.state, 'state.json'), 'utf8'));
  writeFileSync(join(p.state, 'state.json'), `${JSON.stringify({ ...doc, schema: 1, createdWith: '2.0.0-beta.1', flags: { engine: 'off', lanes: 'on' } }, null, 2)}\n`);
  return p;
}

test('migrate --dry-run lists the steps and writes nothing; migrate applies them; a second run writes nothing (acceptance 5)', async (t) => {
  const p = await oldRepository(t);
  const before = snapshot(p.state);
  const dry = await cli(['migrate', '--dry-run'], p);
  assert.equal(dry.code, 0, show(dry));
  assert.deepEqual(dry.out.data.steps.map((s) => [s.rel, s.kind, s.from, s.to, s.ids]), [
    ['config.json', 'config', null, 1, ['001-state-flags-to-config']],
    ['state.json', 'state', 1, 2, ['001-state-flags-to-config']],
  ]);
  assert.equal(dry.out.data.dryRun, true);
  const text = await cli(['migrate', '--dry-run'], { ...p, json: false });
  assert.match(text.out, /^ {2}state\.json: state schema 1 → 2 \(001-state-flags-to-config\)$/m);
  assert.match(text.out, /^ {2}config\.json: config new → 1 \(001-state-flags-to-config\)$/m);
  assert.deepEqual(snapshot(p.state), before, 'the dry run wrote nothing');
  // The flags are read as before meanwhile: the engine is off.
  assert.equal((await cli(['tier'], p)).code, 7);

  const noConsent = await cli(['migrate'], p);
  assert.equal(noConsent.code, 7, show(noConsent));
  assert.deepEqual(snapshot(p.state), before);
  const r = await cli(['migrate', '--yes'], p);
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.steps.length, 2);
  assert.match(r.out.data.backup, /^local\/backup\//);
  assert.equal(JSON.parse(readFileSync(join(p.state, 'state.json'), 'utf8')).schema, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(p.state, 'config.json'), 'utf8')).flags, { engine: 'off', lanes: 'on' });
  assert.equal((await cli(['tier'], p)).code, 7, 'nothing lost: the engine is still off');

  const after = snapshot(p.state);
  const again = await cli(['migrate', '--yes'], p);
  assert.equal(again.code, 0, show(again));
  assert.deepEqual(again.out.data.steps, []);
  assert.deepEqual(snapshot(p.state), after, 'a second run writes nothing');
  assert.deepEqual((await cli(['migrate', '--dry-run'], p)).out.data.steps, []);
});

test('migrate refuses a newer schema before any byte (exit 7); covers every committed JSON kind; an inactive repository has nothing', async (t) => {
  const p = await oldRepository(t);
  writeFileSync(join(p.state, 'profile.json'), JSON.stringify({ schema: 99, facts: {} }));
  const before = snapshot(p.state);
  for (const args of [['migrate', '--dry-run'], ['migrate', '--yes']]) {
    const r = await cli(args, p);
    assert.equal(r.code, 7, `${args.join(' ')}\n${show(r)}`);
    assert.equal(r.out.errors[0].code, 'schema-newer');
  }
  assert.deepEqual(snapshot(p.state), before);
  const { MIGRATE_KINDS } = await lib('cli/migrate.mjs');
  const kinds = Object.values(MIGRATE_KINDS).map((k) => k.name).sort();
  for (const name of ['baseline', 'config', 'generated', 'profile', 'receipt', 'review', 'state', 'task', 'team', 'tombstone', 'verify']) assert.ok(kinds.includes(name), name);
  // Outside an active repository there is no state to migrate.
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'migrate-none-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  git(repo, iso.env, ['init', '-q']);
  const none = await cli(['migrate', '--yes'], { cwd: repo, env: { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') } });
  assert.equal(none.code, 0, show(none));
  assert.deepEqual(none.out.data.steps, []);
  assert.equal(existsSync(join(repo, names.stateDir)), false);
});
