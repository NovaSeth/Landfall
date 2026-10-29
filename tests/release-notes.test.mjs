// Release notes follow the version: the version in package.json (the one source of the plugin version, gen-names)
// has its own CHANGELOG section, and docs/known-limitations.md names it in its title, so a version is never tagged
// without its notes and limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const { version } = JSON.parse(read('package.json'));

test('the package version has its CHANGELOG section, below at most an Unreleased one', () => {
  const sections = [...read('CHANGELOG.md').matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  const released = sections[0] === 'Unreleased' ? sections.slice(1) : sections;
  assert.equal(released[0], version, `the first released section of CHANGELOG.md is ${version}; sections: ${sections.slice(0, 3).join(', ')}`);
  assert.equal(sections.filter((s) => s === 'Unreleased').length <= 1 && !released.includes('Unreleased'), true, 'Unreleased only on top');
});

test('docs/known-limitations.md names the package version in its title', () => {
  assert.equal(read('docs/known-limitations.md').split('\n')[0], `# Known limitations (${version})`);
});

test('the README heading shows the package version, and its What\'s new names it', () => {
  const readme = read('README.md');
  const heading = readme.split('\n').find((l) => /^# /.test(l));
  assert.equal(heading.replace(/^# \S+ /, ''), `(${version})`, `the first heading shows ${version} in parentheses, level with the title: ${heading}`);
  assert.ok(readme.includes(`## What's new in ${version}`), `a What's new section for ${version}`);
});

// The README tells what the plugin does today: security review by the OWASP lists (2.4.0) and evidence-gated learning
// (2.4.1, 2.5.0) are in What it does, and the comparison has a row for each.
test('the README describes the security review and the evidence-gated learning, and compares them', () => {
  const readme = read('README.md');
  const does = readme.slice(readme.indexOf('## What it does'), readme.indexOf('## What\'s new'));
  for (const list of ['OWASP Top 10:2025', 'OWASP Top 10 for LLM Applications', 'OWASP Top 10 for Agentic Applications']) assert.ok(does.includes(list), `What it does names ${list}`);
  assert.match(does, /findings/);
  assert.match(does, /lessons/);
  const table = readme.slice(readme.indexOf('## How it compares'), readme.indexOf('## Measured'));
  for (const row of ['Security review by the OWASP lists', 'Review by another model provider', 'Secrets scan', 'Open review findings kept', 'Lessons admitted on evidence', 'Example project with its process state']) {
    assert.ok(table.split('\n').some((l) => l.startsWith(`| ${row}`)), `the comparison has the row "${row}"`);
  }
  assert.doesNotMatch(table, /will run under the pre-registered rules/, 'the benchmark is postponed (D-MG-26)');
});
