// The profile scan observes `llm` from the dependency manifests at the repository root (T-MG-59 slice B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { observeFiles, SCANNER, SCANNED_KEYS } = await import(pathToFileURL(join(here, '..', 'plugins', 'landfall', 'lib', 'profile', 'observe.mjs')).href);

function scan(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'profile-llm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), typeof text === 'string' ? text : JSON.stringify(text));
  return observeFiles(dir, Object.keys(files)).facts.llm;
}
const pkg = (deps, key = 'dependencies') => ({ name: 'x', [key]: deps });

test('llm: package.json dependencies by exact name and by prefix', (t) => {
  assert.deepEqual(scan(t, { 'package.json': pkg({ '@anthropic-ai/sdk': '^0.30.0' }) }), { value: true, evidence: 'package.json: @anthropic-ai/sdk', confidence: 0.9 });
  assert.equal(scan(t, { 'package.json': pkg({ '@ai-sdk/openai': '1' }) }).evidence, 'package.json: @ai-sdk/openai');
  assert.equal(scan(t, { 'package.json': pkg({ '@langchain/core': '1' }, 'peerDependencies') }).evidence, 'package.json: @langchain/core');
  assert.equal(scan(t, { 'package.json': pkg({ ai: '1' }, 'optionalDependencies') }).value, true);
});

test('llm: devDependencies, empty repositories and broken manifests observe nothing', (t) => {
  assert.equal(scan(t, { 'package.json': pkg({ openai: '1' }, 'devDependencies') }), undefined);
  assert.equal(scan(t, {}), undefined);
  assert.equal(scan(t, { 'package.json': '{ not json' }), undefined);
  assert.equal(scan(t, { 'package.json': pkg({ aiohttp: '1', 'ai-utils': '1' }) }), undefined);
});

test('llm: requirements, pyproject and go.mod', (t) => {
  assert.equal(scan(t, { 'requirements.txt': 'anthropic>=0.30\n' }).evidence, 'requirements.txt: anthropic');
  assert.equal(scan(t, { 'requirements.txt': 'Anthropic==1\n' }).value, true);
  assert.equal(scan(t, { 'requirements-dev.txt': '-r base.txt\nllama_index\n' }).evidence, 'requirements-dev.txt: llama-index');
  assert.equal(scan(t, { 'pyproject.toml': '[project]\nname = "app"\ndependencies = ["openai>=1.0"]\n' }).evidence, 'pyproject.toml: openai');
  assert.equal(scan(t, { 'pyproject.toml': '[tool.poetry.dependencies]\nlangchain = "^0.2"\n' }).evidence, 'pyproject.toml: langchain');
  assert.equal(scan(t, { 'go.mod': 'module x\n\nrequire github.com/openai/openai-go v1.0.0\n' }).evidence, 'go.mod: github.com/openai/openai-go');
  assert.equal(scan(t, { 'go.mod': 'module x\n\nrequire (\n\tgithub.com/a/b v1\n\tgithub.com/tmc/langchaingo v0.1.0\n)\n' }).value, true);
  assert.equal(scan(t, { 'requirements.txt': '# anthropic\n--index-url https://x\nanthropic-tools-helper==1\n' }), undefined);
  assert.equal(scan(t, { 'pyproject.toml': '[project]\nname = "anthropic"\n' }) !== undefined, true, 'a name = key counts per the brief');
  assert.equal(scan(t, { 'pyproject.toml': '[project]\ndescription = "openai wrapper"\n' }), undefined);
  assert.equal(scan(t, { 'pyproject.toml': 'x = ["openai wrapper"]\n' }), undefined);
  assert.equal(scan(t, { 'pyproject.toml': 'x = ["anthropic[bedrock]; python_version>\'3.9\'"]\n' }).evidence, 'pyproject.toml: anthropic');
  assert.equal(scan(t, { 'pyproject.toml': 'x = ["openai"]\n' }).evidence, 'pyproject.toml: openai');
});

test('llm: the scanner version and the scanned keys', () => {
  assert.equal(SCANNER, 3);
  assert.ok(SCANNED_KEYS.includes('llm'));
});
