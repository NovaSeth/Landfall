// One story across the method, the skills, the agents, the help and the docs: a step one text gives is the step
// the others and the CLI accept (merge through task merge, external runs that review only and pass --yes, current
// rule IDs, one severity scale, one known-limitations entry per topic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins', readdirSync(join(root, 'plugins')).find((d) => existsSync(join(root, 'plugins', d, 'lib', 'name.json'))));
const read = (...p) => readFileSync(join(...p), 'utf8');
const rule = (topic, id) => {
  const line = read(plugin, 'method', `${topic}.md`).split('\n').find((l) => l.startsWith(`**${id}.**`));
  assert.ok(line, `${id} in method/${topic}.md`);
  return line;
};
const bullets = (text) => text.split('\n').filter((l) => l.startsWith('- '));
const step = (text, n) => text.split('\n').find((l) => l.startsWith(`${n}. `)) ?? '';

test('merging is task merge everywhere: REV-11 and the tick name no squashed pull request or hand merge (ORC-25)', () => {
  const rev11 = rule('review', 'REV-11');
  assert.doesNotMatch(rev11, /squash|git merge --no-ff/, rev11);
  assert.match(rev11, /task merge/, rev11);
  assert.doesNotMatch(read(plugin, 'lib', 'loop', 'table.mjs'), /squashed pull request|locally without a remote/);
});

test('the external agent passes --yes, waits, and starts reviewer runs only; ORC-14, ORC-21 and the README agree', () => {
  const ext = read(plugin, 'agents', 'external.md');
  const exec = ext.split('\n').find((l) => l.includes(' exec --task '));
  assert.ok(exec && /--yes/.test(exec), exec);
  assert.match(ext, / wait <run>/);
  assert.doesNotMatch(ext, /implementer|an implementation/, 'exec --role implementer is refused in this release');
  assert.doesNotMatch(rule('orchestration', 'ORC-14'), /workspace-write for fixes/);
  assert.doesNotMatch(rule('orchestration', 'ORC-21'), /give it slices/);
  assert.doesNotMatch(read(root, 'README.md'), /implementer in its own worktree \(a Claude agent or an external CLI/);
});

test('the dispatch skill: verify failure goes back before any fix-round record, merge forms read as commands, the reviewer dispatch is recorded', () => {
  const d = read(plugin, 'skills', 'dispatch', 'SKILL.md');
  assert.doesNotMatch(step(d, 5), /Fail: `?task set <id> fix-round/, step(d, 5));
  assert.doesNotMatch(step(d, 8), /\| --ready/, step(d, 8));
  assert.match(step(d, 8), /task merge <ids…> --yes/);
  assert.match(step(d, 8), /task merge --ready --yes/);
  assert.match(step(d, 6), /record as in 3 \(`--executor <reviewer>`\)/, step(d, 6));
  assert.match(step(d, 7), /--remaining <open finding IDs>/, step(d, 7));
});

test('the review and work skills: the Rules line holds every rule the steps cite; init comes before the class branch', () => {
  const r = read(plugin, 'skills', 'review', 'SKILL.md');
  const rules = r.split('\n').find((l) => l.startsWith('Rules:'));
  for (const id of ['SEC-13', 'REV-22']) assert.ok(rules.includes(id), `${id} in ${rules}`);
  const w = step(read(plugin, 'skills', 'work', 'SKILL.md'), 3);
  assert.ok(w.indexOf('init --yes') >= 0 && w.indexOf('init --yes') < w.indexOf('Critical'), w);
});

test('no 1.x rule ID in the help, docs/cli.md or lib (REV-54, REV-57, REV-58 → COD-5, COD-8, COD-9)', () => {
  assert.doesNotMatch(read(plugin, 'lib', 'cli', 'help.mjs'), /REV-5[478]/);
  assert.doesNotMatch(read(root, 'docs', 'cli.md'), /REV-5[478]/);
  assert.match(read(root, 'docs', 'cli.md'), /exit 7 REFUSED \(COD-9\)/);
});

test('the method: one severity scale, real template paths, PRI-6 points to REV-20, ORC-1 lists the security reviewer, ORC-24 defers its reactions', () => {
  assert.match(rule('review', 'REV-1'), /templates\/task\/review\.md/);
  assert.match(rule('orchestration', 'ORC-4'), /templates\/task\/brief\.md/);
  assert.match(rule('review', 'REV-2'), /blocking/);
  assert.match(rule('principles', 'PRI-6'), /REV-20/);
  assert.match(rule('orchestration', 'ORC-1'), /security-reviewer/);
  const orc24 = rule('orchestration', 'ORC-24');
  for (const id of ['ORC-9', 'ORC-10', 'ORC-11']) assert.ok(orc24.includes(id), `${id} in ORC-24`);
  assert.doesNotMatch(orc24, /re-planned/);
});

test('known limitations: no stale task merge bullet, one bullet per topic, the local/ sentence reads; the merge help says state may be pending', () => {
  const k = read(root, 'docs', 'known-limitations.md');
  assert.doesNotMatch(k, /`task merge` still needs a clean tree/);
  assert.doesNotMatch(k, /instead of moving it and moved aside/);
  assert.equal(bullets(k).filter((l) => l.startsWith('- Secrets scan')).length, 1);
  assert.equal(bullets(k).filter((l) => l.startsWith('- Bash guard')).length, 1);
  assert.doesNotMatch(bullets(k).find((l) => l.startsWith('- Dashboard')) ?? '', /qa/);
  assert.match(k, /^- No `qa` pack or agent/m);
  assert.match(read(plugin, 'lib', 'cli', 'commands.mjs'), /The code tree must be clean \(state writes may be pending\)/);
});

test('getting started: findings close names the task that fixed them', () => {
  const g = read(root, 'docs', 'getting-started.md');
  assert.doesNotMatch(g, /`findings close` and `findings drop` end one without a task/);
  assert.match(g, /findings close <ids…> --task <id>/);
});
