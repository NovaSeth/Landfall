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
