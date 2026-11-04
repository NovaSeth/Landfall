// The merge record (T-MG-80): `task merge` writes a `merged` event and mergedAt on the task through lib/state, and
// `task merge --adopt <ids…>` records tasks merged by hand after one gate run on HEAD, only for branch tips that are
// ancestors of HEAD; a failing gate records nothing. This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

const ISO = isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const state = await lib('state/index.mjs');
const profile = await lib('profile/index.mjs');
const { saveReceipt, taskReceipt } = await lib('receipts/index.mjs');
const { main } = await lib('cli/main.mjs');
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const AT = '2026-10-15T05:42:00.000Z';
const TESTS = "import { test } from 'node:test';\ntest('adds', () => {});\n";
const REPORT = '---\nred: {"command": "node --test", "exit": 1, "excerpt": "1 failing"}\ngreen: {"command": "node --test", "exit": 0, "excerpt": "2 passing"}\n---\n\n# Report\n';

function repo(t, { gate = 'node --test', timeoutS = 120 } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'merge-record-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(dir);
  mkdirSync(home);
  const env = { ...ISO.env, HOME: home };
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write('calc.test.mjs', TESTS);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const stateDir = join(dir, names.stateDir);
  const store = state.open(stateDir, { names });
  store.write('state', null, { codename: names.codename, createdWith: '2.0.0', activatedAt: AT });
  writeFileSync(join(stateDir, '.gitignore'), 'local/\n');
  const handle = state.registerHandle(store, { name: 'Test User', email: 'test@example.com', at: AT }).handle;
  profile.openStore(stateDir, names).write('profile', null, { ...profile.emptyProfile(), gates: [{ name: 'test', cmd: gate, timeoutS, kind: 'test' }] });
  const task = (branch) => {
    const id = state.allocateId(store, {
      prefix: 'T', handle,
      build: (tid) => ({ id: tid, kind: 'task', title: 'a task', lane: null, owner: handle, class: 'trivial', classHistory: [], status: 'done', round: 0, events: [], base: head, branch }),
    });
    writeFileSync(join(stateDir, 'tasks', id, 'report.md'), REPORT);
    return id;
  };
  git('add', '-A');
  git('commit', '-q', '-m', 'state');
  // A branch with one new passing test file (or a failing one), from main.
  const branch = (name, file, body = "test('ok', () => {});") => {
    git('checkout', '-q', '-b', name, 'main');
    write(file, `import { test } from 'node:test';\n${body}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', name);
    git('checkout', '-q', 'main');
    return git('rev-parse', name);
  };
  return { dir, env, stateDir, store, handle, git, write, task, branch };
}

async function cli(args, { dir, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd: dir, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  return { code, env: json ? JSON.parse(out.join('')) : null, stderr: err.join('') };
}
const merges = (r, id) => r.store.read('task', id).events.filter((e) => e.event === 'merged');

for (const existing of [false, true]) {
  test(`task merge ${existing ? 'refreshes an existing' : 'creates a missing'} receipt through the merged event`, async (t) => {
    const r = repo(t, { timeoutS: 30 });
    r.branch('feat/receipt', 'receipt.test.mjs');
    const id = r.task('feat/receipt');
    const file = join(r.stateDir, 'receipts', `${id}.json`);
    if (existing) {
      const built = taskReceipt(id, { cwd: r.dir, env: r.env, names });
      saveReceipt({ ...built.receipt, startedAt: AT, endedAt: AT, wallMs: 0, tokens: { ...built.receipt.tokens, input: 100 } }, { where: built.where, names });
    }
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'task');
    const res = await cli(['task', 'merge', id, '--yes'], r);
    assert.equal(res.code, 0, JSON.stringify(res.env.errors));
    assert.ok(existsSync(file), 'merge saves receipts/<id>.json');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Date.parse(receipt.endedAt) >= Date.parse(merges(r, id)[0].at), 'receipt includes the merged event');
    assert.equal(res.env.data.receipt, file);
    assert.equal(res.env.data.receiptProblem, null);
    if (existing) assert.equal(receipt.tokens.input, 100, 'usage remains when transcripts are no longer available');
    if (receipt.startedAt) assert.equal(receipt.wallMs, Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt));
  });
}

for (const json of [true, false]) {
  test(`task merge keeps success and exposes receipt build failures (${json ? 'JSON' : 'text'})`, async (t) => {
    const r = repo(t, { timeoutS: 30 });
    r.branch('feat/receipt', 'receipt.test.mjs');
    const id = r.task('feat/receipt');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'task');
    // A directory lookup that reliably throws ELOOP, even when tests run as root.
    r.env.CLAUDE_PLUGIN_DATA = state.resolve({ cwd: r.dir, env: r.env, names }).dataDir;
    r.env.CLAUDE_CONFIG_DIR = join(r.env.HOME, 'unreadable-transcripts');
    mkdirSync(r.env.CLAUDE_CONFIG_DIR);
    symlinkSync('projects', join(r.env.CLAUDE_CONFIG_DIR, 'projects'));
    const res = await cli(['task', 'merge', id, '--yes'], { ...r, json });
    assert.equal(res.code, 0, JSON.stringify(res.env ?? res.stderr));
    assert.equal(merges(r, id).length, 1, 'receipt failure does not undo the merge');
    if (json) {
      assert.equal(res.env.data.receipt, null);
      assert.equal(res.env.data.receiptProblem?.code, 'receipt-not-saved');
      assert.match(res.env.data.receiptProblem.message, /ELOOP/);
    } else {
      const warnings = res.stderr.trim().split('\n');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^warning: .*receipt-not-saved/);
      assert.ok(warnings[0].includes(`${names.bin} receipt --task ${id}`));
    }
  });
}

test('batch merge saves a receipt for every merged task after recording its event', async (t) => {
  const r = repo(t, { timeoutS: 30 });
  const heads = ['a', 'b'].map((name) => r.branch(`feat/${name}`, `${name}.test.mjs`));
  const ids = ['a', 'b'].map((name, i) => {
    const id = r.task(`feat/${name}`);
    r.store.update('task', id, (task) => ({ ...task, events: [{ at: AT, by: r.handle, event: 'done', data: { head: heads[i] } }] }));
    return id;
  });
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'tasks');
  const res = await cli(['task', 'merge', ...ids, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  assert.equal(res.env.data.fallback, undefined, 'exercises batch integration');
  for (const id of ids) {
    const file = join(r.stateDir, 'receipts', `${id}.json`);
    assert.ok(existsSync(file), `${id} has a receipt`);
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Date.parse(receipt.endedAt) >= Date.parse(merges(r, id)[0].at));
    const result = res.env.data.tasks.find((task) => task.task === id);
    assert.equal(result.receipt, file);
    assert.equal(result.receiptProblem, null);
  }
});

for (const json of [true, false]) {
  test(`sequential batch fallback keeps success and exposes receipt build failures (${json ? 'JSON' : 'text'})`, async (t) => {
    const r = repo(t, { timeoutS: 30 });
    const heads = ['a', 'b'].map((name) => r.branch(`feat/${name}`, `${name}.test.mjs`));
    const ids = ['a', 'b'].map((name, i) => {
      const id = r.task(`feat/${name}`);
      r.store.update('task', id, (task) => ({ ...task, events: [{ at: AT, by: r.handle, event: 'done', data: { head: heads[i] } }] }));
      return id;
    });
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'tasks');
    // Dependencies without a lockfile force the real sequential fallback.
    mkdirSync(join(r.dir, 'node_modules'));
    r.env.CLAUDE_PLUGIN_DATA = state.resolve({ cwd: r.dir, env: r.env, names }).dataDir;
    r.env.CLAUDE_CONFIG_DIR = join(r.env.HOME, 'unreadable-transcripts');
    mkdirSync(r.env.CLAUDE_CONFIG_DIR);
    symlinkSync('projects', join(r.env.CLAUDE_CONFIG_DIR, 'projects'));
    const res = await cli(['task', 'merge', ...ids, '--yes'], { ...r, json });
    assert.equal(res.code, 0, JSON.stringify(res.env ?? res.stderr));
    for (const id of ids) assert.equal(merges(r, id).length, 1, 'receipt failure does not stop subsequent merges');
    if (json) {
      assert.equal(res.env.data.fallback.mode, 'sequential');
      assert.match(res.env.data.fallback.reason, /no lockfile/);
      assert.equal(res.env.data.tasks.length, ids.length);
      for (const id of ids) {
        const result = res.env.data.tasks.find((task) => task.task === id);
        assert.equal(result.outcome, 'merged');
        assert.equal(result.receiptProblem?.code, 'receipt-not-saved');
        assert.match(result.receiptProblem.message, /ELOOP/);
        assert.equal(result.receipt, null);
      }
    } else {
      assert.match(res.stderr, /falling back to sequential merges: .*no lockfile/);
      const warnings = res.stderr.trim().split('\n').filter((line) => line.startsWith('warning:'));
      assert.equal(warnings.length, ids.length, 'one receipt warning per merged task');
      for (const [i, id] of ids.entries()) {
        assert.match(warnings[i], /^warning: .*receipt-not-saved/);
        assert.ok(warnings[i].includes(`${names.bin} receipt --task ${id}`));
      }
    }
  });
}

test('a single task merge writes the merged event and mergedAt through lib/state', async (t) => {
  const r = repo(t);
  r.branch('feat/a', 'a.test.mjs');
  const id = r.task('feat/a');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  const res = await cli(['task', 'merge', id, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  const commit = r.git('rev-parse', 'HEAD');
  const events = merges(r, id);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0].data), ['commit', 'target', 'batch', 'adopted', 'verify']);
  assert.deepEqual([events[0].data.commit, events[0].data.target, events[0].data.batch, events[0].data.adopted], [commit, 'main', null, false]);
  assert.match(events[0].data.verify, /^[0-9a-f]{40,64}$/);
  const doc = r.store.read('task', id);
  assert.equal(doc.mergedAt, events[0].at);
  assert.equal(doc.schema, state.KINDS.task.version);
  assert.equal(r.git('status', '--porcelain', '--', '.', `:(exclude)${names.stateDir}`), '', 'the code is clean; only the record is an uncommitted state write');
  // The record does not block the next merge: a second task merges with the first one's record uncommitted.
  r.branch('feat/b', 'b.test.mjs');
  const id2 = r.task('feat/b');
  const res2 = await cli(['task', 'merge', id2, '--yes'], r);
  assert.equal(res2.code, 0, JSON.stringify(res2.env.errors));
  assert.equal(merges(r, id2).length, 1);
  assert.equal(merges(r, id).length, 1, 'the first record survives the second merge');
  const show = await cli(['task', 'show', id], r);
  assert.equal(show.env.data.task.mergedAt, doc.mergedAt);
});

test('task merge --adopt records only tasks whose branch tip is an ancestor of HEAD, after one gate run', async (t) => {
  const r = repo(t);
  r.branch('feat/a', 'a.test.mjs');
  r.branch('feat/b', 'b.test.mjs');
  const a = r.task('feat/a');
  const b = r.task('feat/b');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'tasks');
  r.git('merge', '-q', '--no-ff', '-m', 'by hand', 'feat/a');
  const head = r.git('rev-parse', 'HEAD');
  const res = await cli(['task', 'merge', '--adopt', a, b, '--yes'], r);
  assert.equal(res.code, 1, 'one task was not adopted');
  assert.equal(res.env.data.result, 'pass');
  assert.deepEqual(res.env.data.tasks.map((x) => [x.task, x.adopted, x.why]), [[a, true, null], [b, false, 'not-ancestor']]);
  assert.deepEqual(res.env.errors.map((e) => e.code), ['not-ancestor']);
  const ev = merges(r, a);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].data.commit, ev[0].data.target, ev[0].data.adopted, ev[0].data.batch], [head, 'main', true, null]);
  assert.equal(merges(r, b).length, 0, 'a task not merged into HEAD is not recorded');
  assert.equal(r.git('rev-parse', 'HEAD'), head, 'adopt moves nothing');
});

test('task merge --adopt with a failing gate records nothing', async (t) => {
  const r = repo(t);
  r.branch('feat/a', 'a.test.mjs', "test('breaks', () => { throw new Error('boom'); });");
  const a = r.task('feat/a');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  r.git('merge', '-q', '--no-ff', '-m', 'by hand', 'feat/a');
  const res = await cli(['task', 'merge', '--adopt', a, '--yes'], r);
  assert.equal(res.code, 1);
  assert.equal(res.env.data.result, 'fail');
  assert.equal(merges(r, a).length, 0);
  assert.equal(r.store.read('task', a).mergedAt, undefined);
});

test('task merge takes --branch only with one ID (several IDs are a batch)', async (t) => {
  const r = repo(t);
  const res = await cli(['task', 'merge', 'T-MG-1', 'T-MG-2', '--branch', 'feat/a', '--yes'], r);
  assert.equal(res.code, 2);
  assert.equal(res.env.errors[0].code, 'unexpected-flag');
});

test('fix round 1 (F2): task merge --adopt whose gate changes tracked code records nothing (merge-tree-changed)', async (t) => {
  const r = repo(t, { gate: "node --test; s=$?; case \"$PWD\" in */repo) echo '// changed' >> calc.test.mjs;; esac; exit $s" });
  r.branch('feat/a', 'a.test.mjs');
  const a = r.task('feat/a');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  r.git('merge', '-q', '--no-ff', '-m', 'by hand', 'feat/a');
  const res = await cli(['task', 'merge', '--adopt', a, '--yes'], r);
  assert.equal(res.code, 1, JSON.stringify(res.env.errors));
  assert.ok(res.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(res.env.errors));
  assert.equal(merges(r, a).length, 0, 'nothing is recorded');
  assert.equal(r.store.read('task', a).mergedAt, undefined);
});

test('fix round 1: --adopt and --ready together are a usage error', async (t) => {
  const r = repo(t);
  const res = await cli(['task', 'merge', '--adopt', '--ready', '--yes'], r);
  assert.equal(res.code, 2);
  assert.equal(res.env.errors[0].code, 'unexpected-flag');
});

// ---- fix round 2 (review r2 F1): a run whose tree did not hold leaves no gate-cache entry, so a retry runs the gates ----
const DIRTY_GATE = "node --test; s=$?; case \"$PWD\" in */repo) echo run >> ../runs.log; echo '// changed' >> calc.test.mjs;; esac; exit $s";
const cacheEntries = (r) => {
  const d = join(r.stateDir, 'local', 'gate-cache');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).length : 0;
};
const gateRuns = (r) => (existsSync(join(r.dir, '..', 'runs.log')) ? readFileSync(join(r.dir, '..', 'runs.log'), 'utf8').split('\n').filter(Boolean).length : 0);

test('fix round 2 (F1): --adopt rejected by merge-tree-changed stores no gate-cache entry; the retry runs the gates and records nothing', async (t) => {
  const r = repo(t, { gate: DIRTY_GATE });
  r.branch('feat/a', 'a.test.mjs');
  const a = r.task('feat/a');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  r.git('merge', '-q', '--no-ff', '-m', 'by hand', 'feat/a');
  const first = await cli(['task', 'merge', '--adopt', a, '--yes'], r);
  assert.ok(first.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(first.env.errors));
  assert.equal(cacheEntries(r), 0, 'a rejected run publishes no gate-cache entry');
  const before = gateRuns(r);
  r.git('checkout', '-q', '--', 'calc.test.mjs'); // the adoption's tree restored, as the reviewer's retry did
  const retry = await cli(['task', 'merge', '--adopt', a, '--yes'], r);
  assert.ok(gateRuns(r) > before, 'the retry ran the gates');
  assert.equal(retry.code, 1, JSON.stringify(retry.env.errors));
  assert.ok(retry.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(retry.env.errors));
  assert.equal(merges(r, a).length, 0, 'nothing is recorded');
});

test('fix round 2 (F1): a single merge rejected by merge-tree-changed stores no gate-cache entry; the retry runs the gates and merges nothing', async (t) => {
  const r = repo(t, { gate: DIRTY_GATE });
  r.branch('feat/a', 'a.test.mjs');
  const a = r.task('feat/a');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  const tip = r.git('rev-parse', 'HEAD');
  const first = await cli(['task', 'merge', a, '--yes'], r);
  assert.ok(first.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(first.env.errors));
  assert.equal(cacheEntries(r), 0, 'a rejected run publishes no gate-cache entry');
  const before = gateRuns(r);
  const retry = await cli(['task', 'merge', a, '--yes'], r);
  assert.ok(gateRuns(r) > before, 'the retry ran the gates');
  assert.ok(retry.env.errors.some((e) => e.code === 'merge-tree-changed'), JSON.stringify(retry.env.errors));
  assert.equal(r.git('rev-parse', 'HEAD'), tip, 'nothing merged');
  assert.equal(merges(r, a).length, 0);
});

test('fix round 2 (F1): a passing adoption still publishes its gate-cache entry', async (t) => {
  const r = repo(t);
  r.branch('feat/a', 'a.test.mjs');
  const a = r.task('feat/a');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  r.git('merge', '-q', '--no-ff', '-m', 'by hand', 'feat/a');
  const res = await cli(['task', 'merge', '--adopt', a, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  assert.equal(cacheEntries(r), 1);
});

test('task merge saves gates from the verify events of the task (T-MG-120)', async (t) => {
  const r = repo(t, { timeoutS: 30 });
  r.branch('feat/gates', 'gates.test.mjs');
  const id = r.task('feat/gates');
  r.store.update('task', id, (task) => ({ ...task, events: [{ at: AT, by: r.handle, event: 'verify', data: { result: 'fail' } }, { at: AT, by: r.handle, event: 'verify', data: { result: 'pass' } }] }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'task');
  const res = await cli(['task', 'merge', id, '--yes'], r);
  assert.equal(res.code, 0, JSON.stringify(res.env.errors));
  const receipt = JSON.parse(readFileSync(join(r.stateDir, 'receipts', `${id}.json`), 'utf8'));
  assert.deepEqual(receipt.gates, { attempts: 2, firstPass: false, gatesMs: null, heavyWaitMs: null, cache: null });
});
