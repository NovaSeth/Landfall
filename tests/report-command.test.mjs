// `report <id> --from <file> [--round <k>] [--force]`: stores the task report with its RED/GREEN frontmatter checked,
// appends fix rounds, and records the implementer event. Commands run through the real command table in a throwaway
// repository and HOME. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

const identity = (name, email) => `[user]\n\tname = ${name}\n\temail = ${email}\n`;
const ME = 'TU';
const ID = `T-${ME}-1`;

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

async function cli(args, { cwd, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, out: json ? JSON.parse(stdout) : stdout, stderr: err.join('') };
}
const show = (r) => JSON.stringify(r.out ?? r);

async function active(t) {
  const iso = isolatedEnv({ gitConfig: identity('Test User', 'test@example.com'), prefix: 'report-command-' });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  const r = { base: iso.base, dir, cwd: dir, env: iso.env, store: join(dir, names.stateDir) };
  const init = await cli(['init', '--yes'], r);
  assert.equal(init.code, 0, show(init));
  r.run = (args) => cli([...args, '--yes'], r);
  r.task = (id) => JSON.parse(readFileSync(join(r.store, 'tasks', id, 'task.json'), 'utf8'));
  r.reportFile = (id = ID) => join(r.store, 'tasks', id, 'report.md');
  r.report = (id = ID) => (existsSync(r.reportFile(id)) ? readFileSync(r.reportFile(id), 'utf8') : null);
  r.write = (name, text) => {
    const file = join(iso.base, name);
    writeFileSync(file, text);
    return file;
  };
  const made = await r.run(['task', 'new', 'Report test']);
  assert.equal(made.out.data.id, ID, show(made));
  return r;
}
const lastEvent = (doc) => doc.events[doc.events.length - 1];

const FRONT = '---\nred: {"command": "npm test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "npm test", "exit": 0, "excerpt": "all passing"}\n---\n';
const GOOD = `${FRONT}# Report\n\nStatus: DONE\n`;

test('report: round 0 with evidence and a Status line stores the file byte for byte and records the implementer event', async (t) => {
  const r = await active(t);
  const from = r.write('in.md', GOOD);
  const res = await r.run(['report', ID, '--from', from]);
  assert.equal(res.code, 0, show(res));
  assert.equal(r.report(), GOOD);
  assert.equal(res.out.data.file, r.reportFile());
  assert.equal(res.out.data.status, 'done');
  const doc = r.task(ID);
  assert.equal(doc.status, 'implemented');
  assert.deepEqual(lastEvent(doc).data, { report: 'done' });
  assert.equal(lastEvent(doc).event, 'implementer');
});

test('report: no evidence or no Status line is exit 1 and nothing is written', async (t) => {
  const r = await active(t);
  let res = await r.run(['report', ID, '--from', r.write('a.md', '# Report\n\nStatus: DONE\n')]);
  assert.deepEqual([res.code, res.out.errors[0].code], [1, 'report-no-evidence'], show(res));
  assert.equal(r.report(), null);
  res = await r.run(['report', ID, '--from', r.write('b.md', `${FRONT}# Report\n`)]);
  assert.deepEqual([res.code, res.out.errors[0].code], [1, 'report-no-status'], show(res));
  assert.equal(r.report(), null);
  assert.equal(r.task(ID).status, 'new');
});

test('report: a second round-0 call keeps the report, --force replaces it', async (t) => {
  const r = await active(t);
  assert.equal((await r.run(['report', ID, '--from', r.write('a.md', GOOD)])).code, 0);
  const other = `${FRONT}# Other\n\nStatus: BLOCKED\n`;
  const res = await r.run(['report', ID, '--from', r.write('b.md', other)]);
  assert.deepEqual([res.code, res.out.errors[0].code], [1, 'report-exists'], show(res));
  assert.equal(r.report(), GOOD);
  const forced = await r.run(['report', ID, '--from', r.write('b.md', other), '--force']);
  assert.equal(forced.code, 0, show(forced));
  assert.equal(r.report(), other);
  assert.deepEqual(lastEvent(r.task(ID)).data, { report: 'blocked' });
});

test('report: --round appends a section, keeps earlier bytes, drops the frontmatter and refuses a repeated round', async (t) => {
  const r = await active(t);
  assert.equal((await r.run(['report', ID, '--from', r.write('a.md', GOOD)])).code, 0);
  const body = `${FRONT.replace('1 failing', 'DROPPED')}Fixed the thing.\n\nStatus: DONE_WITH_CONCERNS\n`;
  const res = await r.run(['report', ID, '--from', r.write('r1.md', body), '--round', '1']);
  assert.equal(res.code, 0, show(res));
  const text = r.report();
  assert.ok(text.startsWith(`${GOOD}\n## Fix round 1\n\n`), text);
  assert.ok(text.endsWith('Fixed the thing.\n\nStatus: DONE_WITH_CONCERNS\n'), text);
  assert.ok(!text.includes('DROPPED'));
  const doc = r.task(ID);
  assert.deepEqual([doc.status, doc.round, lastEvent(doc).data], ['implemented', 1, { report: 'done-with-concerns', round: 1 }]);
  const again = await r.run(['report', ID, '--from', r.write('r1b.md', 'x\n\nStatus: DONE\n'), '--round', '1']);
  assert.deepEqual([again.code, again.out.errors[0].code], [1, 'round-exists'], show(again));
  assert.equal(r.report(), text);
});

test('report: --round before any report is exit 1; bad flag values are exit 2', async (t) => {
  const r = await active(t);
  const from = r.write('r.md', 'Body\n\nStatus: DONE\n');
  let res = await r.run(['report', ID, '--from', from, '--round', '1']);
  assert.deepEqual([res.code, res.out.errors[0].code], [1, 'report-missing'], show(res));
  assert.equal(r.report(), null);
  for (const [args, code] of [
    [['--round', '0'], 'invalid-value'],
    [['--round', 'x'], 'invalid-value'],
    [['--force', '--round', '1'], 'invalid-combination'],
  ]) {
    res = await r.run(['report', ID, '--from', from, ...args]);
    assert.deepEqual([res.code, res.out.errors[0].code], [2, code], show(res));
  }
  res = await r.run(['report', ID]);
  assert.deepEqual([res.code, res.out.errors[0].code], [2, 'missing-flag'], show(res));
  res = await r.run(['report', ID, '--from', join(r.base, 'nope.md')]);
  assert.deepEqual([res.code, res.out.errors[0].code], [2, 'report-unreadable'], show(res));
});

test('report: a cancelled task is exit 1, a missing --yes is exit 7, and --help lists the command', async (t) => {
  const r = await active(t);
  const from = r.write('a.md', GOOD);
  const cancelled = await r.run(['task', 'set', ID, 'cancelled', '--reason', 'out of scope']);
  assert.equal(cancelled.code, 0, show(cancelled));
  let res = await r.run(['report', ID, '--from', from]);
  assert.deepEqual([res.code, res.out.errors[0].code], [1, 'task-closed'], show(res));
  assert.equal(r.report(), null);
  const fresh = await active(t);
  res = await cli(['report', ID, '--from', fresh.write('a.md', GOOD)], fresh);
  assert.deepEqual([res.code, res.out.errors[0].code], [7, 'consent-required'], show(res));
  const help = await cli(['--help'], { ...fresh, json: false });
  assert.match(help.out, /^\s*report\b/m);
});
