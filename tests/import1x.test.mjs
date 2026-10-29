// 1.x import, slice 1 (T-MG-18): `import-1x --dry-run` reads a 1.x ledger and prints the mapping; nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugins', readdirSync(join(root, 'plugins')).find((d) => existsSync(join(root, 'plugins', d, 'lib/name.json'))));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');
const { openMethod, lookupRules } = await lib('method/index.mjs');

const LEDGER = `# Ledger: synthetic
Format: **Ruling R<n>: what — why — cost.**

## Rules
- Ruling R1 (2026-01-02 03:04 AB): Use ZAS-4 as the base — dlaczego: prostota — cost: low.
**Ruling R2: Ship the importer — because users ask — cost: a day.**
**Ruling R3: Zmieniamy podejście — bo tak wyszło — koszt: niski.**
- Ruling R4 (2026-01-03 AB): Reverse R2 — new facts — cost: none (korekta R2 pkt 1).
- Ruling R-CD-2 (2026-01-04 CD): Second author — why — cost: low (correction R1).
- Ruling R5 broken line without separators
## Progress
Task T1: dispatched (BASE abc123) — implementer by AB @ 2026-01-02 03:04
Task T1: implementer DONE (abc)
Task T1: complete (commits a..b, review clean)
Task T2: dispatched (BASE abc123) — implementer
Task T3: dispatched (BASE abc123) — implementer
Task T3: blocked (waits for keys) by AB @ 2026-01-02 03:04
Task T4: dispatched (BASE abc123) — implementer
Task T4: cancelled (nie potrzeba) by AB @ 2026-01-02 03:04
Task : dispatched
Shared-fix backlog S1: shared parser cleanup (see PRC-14 and KOD-3)
- S2 (2026-01-05 AB): another shared task
SEC-1: leaked token in a log
- SEC-2 (2026-01-06 AB): weak default
Just a prose line that is ignored, Polish: to jest zwykły tekst.
`;
const CONFIG = { kit: 'X', level: 'full', team: 'solo', stack: 'inny', discovery: true };

function fixture(t, { ledger = LEDGER, workflow = true } = {}) {
  const iso = isolatedEnv({ gitConfig: '[user]\n name = A B\n email = ab@example.com\n', prefix: 'import1x-' });
  t.after(iso.cleanup);
  const from = join(iso.base, 'old');
  mkdirSync(from);
  if (workflow) {
    mkdirSync(join(from, '.workflow'));
    writeFileSync(join(from, '.workflow/progress.md'), ledger);
    writeFileSync(join(from, '.workflow/config.json'), JSON.stringify(CONFIG));
  }
  const cli = async (args) => {
    const io = { cwd: iso.base, env: iso.env, stdinIsTTY: false, stdin: null, stdout: '', stderr: '' };
    io.out = (s) => { io.stdout += s; };
    io.err = (s) => { io.stderr += s; };
    const code = await main(args, { io });
    return { code, stdout: io.stdout, stderr: io.stderr };
  };
  return { from, base: iso.base, cli };
}

test('the dry run maps rulings, a correction, tasks, shared tasks, findings and config; bad lines are reported', async (t) => {
  const { from, cli } = fixture(t);
  const r = await cli(['import-1x', '--from', from, '--dry-run', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const { data } = JSON.parse(r.stdout);
  const d = Object.fromEntries(data.decisions.map((x) => [x.legacy, x]));
  assert.equal(d.R1.id, 'D-AB-1');
  assert.deepEqual([d.R2.what, d.R2.why, d.R2.cost], ['Ship the importer', 'because users ask', 'a day.']);
  assert.match(d.R1.what, /PRI-3/, 'the citation is translated');
  assert.deepEqual(d.R1.citations, [{ from: 'ZAS-4', to: 'PRI-3' }]);
  assert.match(d.R3.what, /podejście/, 'Polish prose is kept as data');
  assert.deepEqual(d.R4.supersedes, ['D-AB-2']);
  assert.equal(d['R-CD-2'].id, 'D-CD-2');
  assert.deepEqual(d['R-CD-2'].supersedes, ['D-AB-1']);
  const tasks = Object.fromEntries(data.tasks.map((x) => [x.id, x]));
  assert.deepEqual(['T1', 'T2', 'T3', 'T4'].map((id) => tasks[id].status), ['done', 'in_progress', 'blocked', 'cancelled']);
  assert.deepEqual(data.shared.map((x) => [x.legacy, x.labels]), [['S1', ['shared']], ['S2', ['shared']]]);
  assert.deepEqual(data.shared[0].citations.map((c) => c.from), ['PRC-14', 'KOD-3']);
  assert.equal(data.shared[0].citations[0].to, null);
  assert.match(data.shared[0].citations[0].note, /superseded/);
  assert.deepEqual(data.notes.map((x) => x.id), ['SF-1', 'SF-2']);
  assert.deepEqual(data.profile.find((f) => f.key === 'level'), { key: 'level', value: 'full', source: 'import' });
  assert.deepEqual(data.skipped.map((s) => s.text), ['- Ruling R5 broken line without separators', 'Task : dispatched']);
});

test('every target of lib/import1x/legacy.json is a current rule or null with a note', async () => {
  const table = JSON.parse(readFileSync(join(pluginDir, 'lib/import1x/legacy.json'), 'utf8'));
  const ids = Object.entries(table.rules);
  assert.ok(ids.length > 600);
  const method = openMethod();
  for (const [from, v] of ids) {
    if (v.to === null) { assert.ok(v.note, from); continue; }
    assert.equal(lookupRules(method, [v.to]).unknown.length, 0, `${from} -> ${v.to}`);
  }
  assert.equal(table.rules['ZAS-4'].to, 'PRI-3');
});

test('without --dry-run it refuses with exit 7 and writes nothing', async (t) => {
  const { from, base, cli } = fixture(t);
  const before = JSON.stringify(readdirSync(base).sort());
  const r = await cli(['import-1x', '--from', from]);
  assert.equal(r.code, 7);
  assert.match(r.stdout + r.stderr, /apply comes in the next release step/);
  assert.equal(JSON.stringify(readdirSync(base).sort()), before);
  assert.deepEqual(readdirSync(from).sort(), ['.workflow']);
});

test('a missing .workflow exits ENV with a hint', async (t) => {
  const { from, cli } = fixture(t, { workflow: false });
  const r = await cli(['import-1x', '--from', from, '--dry-run']);
  assert.equal(r.code, 8);
  assert.match(r.stdout + r.stderr, /\.workflow/);
});
