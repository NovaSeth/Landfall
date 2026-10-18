// `<bin> brief <id> [--role implementer|reviewer] [--write [--force]]` (spec §8.2, §5.1, ORC-4): the task brief rendered
// from plugins/<plugin>/templates/task/brief.md and the state: title, ID, kind, class and its reason from the route
// record, base and branch, the profile gates, the rule IDs of the role and the class (lib/method BRIEF_RULES) and the
// env of a lease the scheduler holds for the task. It prints by default; --write stores tasks/<id>/brief.md through
// lib/state. A rendered brief ends with a marker holding its hash: an unedited one is replaced, one written or edited
// by hand only with --force. Unknown task → exit 1 (§8.1); --write without consent and no terminal → 7.
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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
const method = await lib('method/index.mjs');
const profile = await lib('profile/index.mjs');
const sched = await lib('sched/index.mjs');
const index = JSON.parse(readFileSync(join(pluginDir, 'method', 'index.json'), 'utf8'));
const TEMPLATE = readFileSync(join(pluginDir, 'templates', 'task', 'brief.md'), 'utf8');
const BIN = names.bin;
const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const GATES = [{ name: 'test', cmd: 'node --test --test-concurrency=2', timeoutS: 600, kind: 'test' }, { name: 'lint', cmd: 'npx eslint .', timeoutS: 120, kind: 'lint' }];
const CALM = Object.freeze({ cores: 10, load1: 1, loadMeasurable: true, totalBytes: 32 * 2 ** 30, availBytes: 20 * 2 ** 30, memMethod: 'vm_stat' });

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
async function cli(args, { cwd, env, json = false, tty = false }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, out: json ? JSON.parse(stdout) : stdout, stderr: err.join('') };
}
const show = (r) => `exit ${r.code}\n${typeof r.out === 'string' ? r.out : JSON.stringify(r.out)}\n${r.stderr}`;

// An active repository with a standard task T-TU-1 (routed), an unrouted T-TU-2 and the profile gates.
async function project(t) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'brief-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  const env = { ...iso.env, CLAUDE_PLUGIN_DATA: join(iso.base, 'data') };
  git(repo, env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const p = { base: iso.base, repo: realpathSync(repo), cwd: repo, env, store: join(realpathSync(repo), names.stateDir) };
  p.run = async (args) => {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 0, `${args.join(' ')}\n${show(r)}`);
    return r;
  };
  for (const args of [['init'], ['task', 'new', 'Parser'], ['task', 'new', 'Not routed yet'], ['route', 'T-TU-1', '--paths', 'src/a.js,src/b.js,src/c.js', '--loc', '120']]) await p.run(args);
  profile.openStore(p.store, names).write('profile', null, { ...profile.emptyProfile(), gates: GATES });
  p.file = join(p.store, 'tasks', 'T-TU-1', 'brief.md');
  return p;
}

const rulesFor = (cls, role) => [...new Set([...method.BRIEF_RULES.role[role], ...method.BRIEF_RULES.class[cls]])];

test('BRIEF_RULES: every role and class lists live rules of the method; briefRules is the role\'s then the class\'s, once each', () => {
  assert.deepEqual(Object.keys(method.BRIEF_RULES.role).sort(), ['implementer', 'reviewer']);
  assert.deepEqual(Object.keys(method.BRIEF_RULES.class).sort(), ['critical', 'standard', 'trivial']);
  for (const list of [...Object.values(method.BRIEF_RULES.role), ...Object.values(method.BRIEF_RULES.class)]) {
    assert.ok(list.length > 0);
    for (const id of list) assert.ok(index.rules[id] && !index.rules[id].retired, `${id} is a live rule`);
  }
  for (const role of ['implementer', 'reviewer']) for (const cls of ['trivial', 'standard', 'critical']) assert.deepEqual(method.briefRules({ cls, role }), rulesFor(cls, role));
  assert.ok(method.briefRules({ cls: 'critical', role: 'implementer' }).length > method.briefRules({ cls: 'trivial', role: 'implementer' }).length, 'depth follows the class');
  assert.throws(() => method.briefRules({ cls: 'huge', role: 'implementer' }), TypeError);
});

test('brief renders the template from the state: title, kind, class and reason, gates, rule IDs; it prints and writes nothing', async (t) => {
  const p = await project(t);
  const r = await cli(['brief', 'T-TU-1'], p);
  assert.equal(r.code, 0, show(r));
  const text = r.out;
  assert.match(text, /^# Parser \(T-TU-1\)\n/);
  assert.match(text, new RegExp(`^Executor: ${names.plugin}:implementer \\(class: standard — 3 files > 2; 120 LOC > 30; kind: task\\)\\.$`, 'm'));
  const rules = rulesFor('standard', 'implementer');
  assert.ok(text.includes(`Rules: ${rules.join(' ')}; read them with \`${BIN} rule <ID…>\`.`), text);
  assert.ok(text.includes(`\`\`\`bash\n${GATES.map((g) => g.cmd).join('\n')}\n<secrets scan>; echo "exit $?"\n\`\`\``), 'the profile gates replace the gate placeholders');
  assert.ok(!text.includes('{{'), 'every name placeholder is filled');
  for (const ph of ['<Task title>', '<task ID>', '<trivial | standard | critical>', '<rule IDs>', '<typecheck>', '<lint>', '<tests with a worker limit>']) assert.ok(!text.includes(ph), `${ph} is filled`);
  assert.ok(text.includes('(branch <branch> from <base branch> at <base SHA>;'), 'no branch or base recorded yet: placeholders stay');
  assert.doesNotMatch(text, /^Lease env/m, 'no lease, no lease line');
  assert.match(text, new RegExp(`\\n<!-- rendered by \`${BIN} brief\`; sha256 [0-9a-f]{64}: an edit makes this brief hand-written -->\\n$`));
  // The rest of the template is kept as it is.
  const kept = TEMPLATE.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(text.split('\n').filter((l) => l.startsWith('## ')), kept);
  assert.equal(existsSync(p.file), false, 'printing writes nothing');

  const j = await cli(['brief', 'T-TU-1'], { ...p, json: true });
  assert.equal(j.code, 0, show(j));
  assert.deepEqual([j.out.command, j.out.data.task, j.out.data.role, j.out.data.class, j.out.data.kind, j.out.data.rules, j.out.data.lease, j.out.data.written],
    ['brief', 'T-TU-1', 'implementer', 'standard', 'task', rules, null, null]);
  assert.deepEqual(j.out.data.gates, GATES.map((g) => g.cmd));
  assert.equal(j.out.data.text, text);

  // The reviewer role: its agent and its rules; the base once the task is dispatched.
  const head = git(p.repo, p.env, ['rev-parse', 'HEAD']);
  await p.run(['task', 'set', 'T-TU-1', 'dispatched', '--executor', `${names.plugin}:implementer`, '--base', head]);
  const rev = await cli(['brief', 'T-TU-1', '--role', 'reviewer'], p);
  assert.equal(rev.code, 0, show(rev));
  assert.match(rev.out, new RegExp(`^Executor: ${names.plugin}:reviewer \\(class: standard`, 'm'));
  assert.ok(rev.out.includes(`Rules: ${rulesFor('standard', 'reviewer').join(' ')};`));
  assert.ok(rev.out.includes(`at ${head};`), 'the recorded base fills the base SHA');
  const bad = await cli(['brief', 'T-TU-1', '--role', 'designer'], { ...p, json: true });
  assert.deepEqual([bad.code, bad.out.errors[0].code], [2, 'invalid-value']);
});

test('brief: unknown task exit 1, unrouted task exit 1 with the route command, malformed ID 2, inactive repository 1, outside git 8', async (t) => {
  const p = await project(t);
  const unknown = await cli(['brief', 'T-TU-9'], { ...p, json: true });
  assert.deepEqual([unknown.code, unknown.out.exit, unknown.out.errors[0].code], [1, 'FAIL', 'task-unknown'], show(unknown));
  const unrouted = await cli(['brief', 'T-TU-2'], { ...p, json: true });
  assert.deepEqual([unrouted.code, unrouted.out.errors[0].code], [1, 'task-unrouted'], show(unrouted));
  assert.match(unrouted.out.errors[0].hint, new RegExp(`${BIN} route T-TU-2 --paths`));
  const malformed = await cli(['brief', 'task-1'], { ...p, json: true });
  assert.deepEqual([malformed.code, malformed.out.errors[0].code], [2, 'invalid-key'], show(malformed));

  const other = join(p.base, 'plain');
  mkdirSync(other);
  git(other, p.env, ['init', '-q']);
  const inactive = await cli(['brief', 'T-TU-1'], { ...p, cwd: other, json: true });
  assert.deepEqual([inactive.code, inactive.out.errors[0].code], [1, 'task-unknown'], show(inactive));
  assert.match(inactive.out.errors[0].message, /not active/);
  const outside = join(p.base, 'not-a-repo');
  mkdirSync(outside);
  const env8 = await cli(['brief', 'T-TU-1'], { ...p, cwd: outside, json: true });
  assert.equal(env8.code, 8, show(env8));
});

test('brief --write: consent, then tasks/<id>/brief.md; an unedited brief is replaced, a hand-edited one only with --force', async (t) => {
  const p = await project(t);
  const refused = await cli(['brief', 'T-TU-1', '--write'], { ...p, json: true });
  assert.deepEqual([refused.code, refused.out.errors[0].code], [7, 'consent-required'], show(refused));
  assert.equal(existsSync(p.file), false, 'nothing written without consent');
  const lone = await cli(['brief', 'T-TU-1', '--force', '--yes'], { ...p, json: true });
  assert.deepEqual([lone.code, lone.out.errors[0].code], [2, 'missing-flag'], '--force needs --write');

  const printed = (await cli(['brief', 'T-TU-1'], p)).out;
  const w = await cli(['brief', 'T-TU-1', '--write', '--yes'], { ...p, json: true });
  assert.equal(w.code, 0, show(w));
  assert.deepEqual([w.out.data.written, w.out.data.file], ['created', p.file]);
  assert.equal(readFileSync(p.file, 'utf8'), printed, 'the file holds the printed brief');
  const ino = statSync(p.file).ino;
  const same = await cli(['brief', 'T-TU-1', '--write', '--yes'], { ...p, json: true });
  assert.equal(same.out.data.written, 'unchanged');
  assert.equal(statSync(p.file).ino, ino, 'not rewritten');

  // The state changed and nobody edited the brief: it is rendered again.
  profile.openStore(p.store, names).write('profile', null, { ...profile.emptyProfile(), gates: GATES.slice(0, 1) });
  const again = await cli(['brief', 'T-TU-1', '--write', '--yes'], { ...p, json: true });
  assert.equal(again.code, 0, show(again));
  assert.equal(again.out.data.written, 'replaced');
  assert.ok(!readFileSync(p.file, 'utf8').includes(GATES[1].cmd));

  // Filled in by hand: kept, unless --force.
  const edited = readFileSync(p.file, 'utf8').replace('<absolute path>', '/work/wt/T-TU-1');
  writeFileSync(p.file, edited);
  const kept = await cli(['brief', 'T-TU-1', '--write', '--yes'], { ...p, json: true });
  assert.deepEqual([kept.code, kept.out.errors[0].code], [1, 'brief-hand-written'], show(kept));
  assert.match(kept.out.errors[0].hint, /--force/);
  assert.equal(readFileSync(p.file, 'utf8'), edited, 'the hand-edited brief is untouched');
  const forced = await cli(['brief', 'T-TU-1', '--write', '--force', '--yes'], { ...p, json: true });
  assert.equal(forced.code, 0, show(forced));
  assert.equal(forced.out.data.written, 'replaced');
  // A brief written by hand from the start (no marker) is kept the same way.
  writeFileSync(p.file, '# My own brief\n');
  assert.equal((await cli(['brief', 'T-TU-1', '--write', '--yes'], { ...p, json: true })).code, 1);
  assert.equal(readFileSync(p.file, 'utf8'), '# My own brief\n');

  // Only a registered developer writes: another git email has no handle here.
  git(p.repo, p.env, ['config', 'user.email', 'someone@example.com']);
  const stranger = await cli(['brief', 'T-TU-1', '--write', '--force', '--yes'], { ...p, json: true });
  assert.deepEqual([stranger.code, stranger.out.errors[0].code], [2, 'handle-unknown'], show(stranger));
  assert.equal(readFileSync(p.file, 'utf8'), '# My own brief\n');
});

test('brief: the env of a lease held for the task follows the worktree line', async (t) => {
  const p = await project(t);
  const got = sched.acquire('agent', { names, env: p.env, cwd: p.repo, task: 'T-TU-1', owner: { sessionId: 'session-1', key: 'toolu_1' }, readings: CALM });
  assert.equal(got.ok, true, JSON.stringify(got));
  const r = await cli(['brief', 'T-TU-1'], p);
  assert.equal(r.code, 0, show(r));
  const env = sched.leaseEnv(got.lease, names);
  const line = `Lease env (the scheduler's slot for this task): ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`;
  const lines = r.out.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Worktree: '));
  assert.equal(lines[at + 1], line, r.out);
  const j = await cli(['brief', 'T-TU-1'], { ...p, json: true });
  assert.deepEqual(j.out.data.lease, env);
  // Another task has no lease line.
  await p.run(['route', 'T-TU-2', '--paths', 'a.js', '--loc', '3']);
  assert.doesNotMatch((await cli(['brief', 'T-TU-2'], p)).out, /^Lease env/m);
});

test('renderBrief refuses a template that lost a placeholder it fills (the template and the renderer must agree)', async () => {
  const { renderBrief } = await lib('cli/brief.mjs');
  const task = { id: 'T-TU-1', kind: 'task', title: 'Parser', class: 'trivial', classHistory: [{ class: 'trivial', reason: 'trivial: small', at: '2026-10-18T00:00:00.000Z' }], base: null, branch: null };
  const args = { task, role: 'implementer', gates: [], lease: null, names };
  assert.match(renderBrief({ ...args, template: TEMPLATE }), /^# Parser \(T-TU-1\)/);
  for (const ph of ['<Task title>', '<rule IDs>', '<trivial | standard | critical>']) {
    assert.throws(() => renderBrief({ ...args, template: TEMPLATE.replace(ph, 'x') }), new RegExp(ph.replace(/[|()]/g, '\\$&')), ph);
  }
});
