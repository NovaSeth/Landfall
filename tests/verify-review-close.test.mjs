// A review-close decision (kind review-close, with task and remaining) closes the review step once the latest review
// round has reached the loop's rounds cap (default 2) and the decision lists every blocking finding ID of that round.
// It never touches the report evidence or the gates; another task's, a superseded or a retired decision has no effect.
// This file holds no plugin name or path: names come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const verify = await lib('verify/index.mjs');
const decisions = await lib('decisions/index.mjs');
const { COMMANDS } = await lib('cli/commands.mjs');

const TASK = 'T-AB-1';
const finding = (id, severity) => ({ id, severity, path: 'a.mjs', line: 1, rule: 'COD-1', text: 'fix it' });
const needsFixes = (findings) => ({ schema: 1, verdict: 'needs-fixes', reviewer: { kind: 'claude', id: 'claude:reviewer' }, findings });

// A state directory with review rounds (a minimal store over it: list/read of the review kind, readText) and
// decision record files written in the record format.
function fixture(t, rounds, records = [], loop = null) {
  const dir = mkdtempSync(join(tmpdir(), 'review-close-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'decisions'));
  for (const doc of records) writeFileSync(join(dir, 'decisions', `${doc.id}.md`), decisions.formatRecord(doc, '## What\n\nx\n\n## Why\n\ny\n'));
  if (loop) { mkdirSync(join(dir, 'local')); writeFileSync(join(dir, 'local', 'loop.json'), JSON.stringify(loop)); }
  const reviews = new Map(rounds.map((doc, i) => [verify.reviewKey(TASK, i + 1), doc]));
  return {
    dir,
    list: (kind) => (kind === 'review' ? [...reviews.keys()] : []),
    read: (kind, key) => (kind === 'review' ? reviews.get(key) ?? null : null),
    readText: (rel) => { try { return readFileSync(join(dir, rel), 'utf8'); } catch { return null; } },
  };
}

const close = (over = {}) => ({
  schema: 1, id: 'D-AB-1', title: 'close the review', status: 'active', kind: 'review-close', date: '2026-10-19', author: 'AB',
  supersedes: [], supersededBy: null, scope: [], allowsTestRemoval: [], task: TASK, remaining: ['F1', 'F2'], ...over,
});
const ROUND2 = [needsFixes([finding('F1', 'blocking')]), needsFixes([finding('F1', 'blocking'), finding('F2', 'blocking'), finding('F3', 'minor')])];

test('review-close: round 2 needs-fixes with every blocking ID listed is approved; one ID missing stays missing', (t) => {
  assert.equal(verify.reviewState(fixture(t, ROUND2), TASK, ['review']), 'missing', 'no decision: the latest round needs fixes');
  assert.equal(verify.reviewState(fixture(t, ROUND2, [close()]), TASK, ['review']), 'approved');
  assert.equal(verify.reviewState(fixture(t, ROUND2, [close({ remaining: ['F1'] })]), TASK, ['review']), 'missing', 'F2 is not listed');
  assert.equal(verify.reviewState(fixture(t, ROUND2, [close({ remaining: ['F1', 'F3'] })]), TASK, ['review']), 'missing', 'a minor ID does not stand for F2');
});

test('review-close: before the rounds cap it has no effect; a loop with a lower cap closes earlier', (t) => {
  const round1 = [ROUND2[1]];
  assert.equal(verify.reviewState(fixture(t, round1, [close()]), TASK, ['review']), 'missing', 'round 1 < the default cap 2');
  const loop = { caps: { wallMin: 480, ticks: 200, costMicroUsd: 25000000, rounds: 1 } };
  assert.equal(verify.reviewState(fixture(t, round1, [close()], loop), TASK, ['review']), 'approved', 'the loop caps rounds at 1');
  const loop3 = { caps: { ...loop.caps, rounds: 3 } };
  assert.equal(verify.reviewState(fixture(t, ROUND2, [close()], loop3), TASK, ['review']), 'missing', 'round 2 < the loop cap 3');
});

test('review-close: another task, a superseded or a retired decision, or another kind has no effect', (t) => {
  for (const [why, over] of [
    ['another task', { task: 'T-AB-2' }],
    ['superseded', { status: 'superseded', supersededBy: 'D-AB-2' }],
    ['retired', { status: 'retired' }],
    ['kind general', { kind: 'general' }],
  ]) {
    const extra = over.supersededBy ? [close({ id: 'D-AB-2', kind: 'general', task: undefined, remaining: undefined, supersedes: ['D-AB-1'] })] : [];
    assert.equal(verify.reviewState(fixture(t, ROUND2, [close(over), ...extra]), TASK, ['review']), 'missing', why);
  }
});

test('review-close: the record keeps task and remaining; the kind needs a task; decide takes --task and --remaining', () => {
  const doc = close({ remaining: ['F1', 'needs, quotes'] });
  const { doc: back, errors } = decisions.parseRecord(decisions.formatRecord(doc, ''), 'D-AB-1.md');
  assert.deepEqual(errors, []);
  assert.deepEqual([back.task, back.remaining], [TASK, ['F1', 'needs, quotes']]);
  assert.deepEqual(decisions.recordErrors(back, 'D-AB-1.md'), []);
  assert.ok(decisions.DECISION_KINDS.includes('review-close'));
  const { task, ...noTask } = close();
  assert.ok(task);
  assert.match(decisions.recordErrors(noTask, 'D-AB-1.md').join('\n'), /review-close needs task/);
  const flags = COMMANDS.find((c) => c.name === 'decide').flags.map((f) => f.flag);
  assert.ok(flags.includes('--task') && flags.includes('--remaining'), flags.join(' '));
});
