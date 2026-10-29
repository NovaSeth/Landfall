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
  assert.equal(scan(t, { 'pyproject.toml': '[tool.poetry.dependencies]\nanthropic = "1"\n' }).value, true, 'a name = key counts in a poetry dependency table');
  assert.equal(scan(t, { 'pyproject.toml': '[project]\nname = "anthropic"\n' }), undefined, 'the project name is no dependency');
  assert.equal(scan(t, { 'pyproject.toml': '[project]\ndescription = "openai wrapper"\n' }), undefined);
  assert.equal(scan(t, { 'pyproject.toml': '[project.optional-dependencies]\nx = ["openai wrapper"]\n' }), undefined);
  assert.equal(scan(t, { 'pyproject.toml': '[project.optional-dependencies]\nx = ["anthropic[bedrock]; python_version>\'3.9\'"]\n' }).evidence, 'pyproject.toml: anthropic');
  assert.equal(scan(t, { 'pyproject.toml': '[project.optional-dependencies]\nx = ["openai"]\n' }).evidence, 'pyproject.toml: openai');
});

test('llm: the scanner version and the scanned keys', () => {
  assert.equal(SCANNER, 3);
  assert.ok(SCANNED_KEYS.includes('llm'));
});

test('llm: pyproject.toml is read by section, comments and closed arrays only', (t) => {
  const py = (text) => scan(t, { 'pyproject.toml': text });
  assert.equal(py('[tool.poetry.dependencies]\n  openai = "^1.0"\n').evidence, 'pyproject.toml: openai');
  assert.equal(py('[project]\ndependencies = [\n  "anthropic>=0.30",\n]\n').evidence, 'pyproject.toml: anthropic');
  assert.equal(py('[project.optional-dependencies]\nai = ["langchain"]\n').evidence, 'pyproject.toml: langchain');
  assert.equal(py('[dependency-groups]\ndev = ["openai"]\n').evidence, 'pyproject.toml: openai');
  assert.equal(py('[tool.poetry.group.ai.dependencies]\nopenai = "1"\n').evidence, 'pyproject.toml: openai');
  assert.equal(py('[project]\ndependencies = ["openai>=1.0"] # c\n').evidence, 'pyproject.toml: openai');
  assert.equal(py('# dependencies = ["openai>=1.0"]'), undefined);
  assert.equal(py('[project]\ndependencies = ["openai>=1.0"'), undefined);
  assert.equal(py('[project]\nkeywords = ["mcp"]\n'), undefined);
  assert.equal(py('[tool.x]\nopenai = "1"\n'), undefined);
  assert.equal(py('[tool.poetry.dev-dependencies]\nopenai = "1"\n'), undefined);
  assert.equal(py('description = "openai wrapper"'), undefined);
});

test('llm: go.mod module paths match an entry exactly or continue with a slash', (t) => {
  assert.equal(scan(t, { 'go.mod': 'module x\n\nrequire github.com/openai/openai-go-evil v1.0.0\n' }), undefined);
  assert.equal(scan(t, { 'go.mod': 'module x\n\nrequire github.com/openai/openai-go/v2 v2.0.0\n' }).value, true);
});

test('llm: pyproject.toml keys and headers are decoded; a poetry key needs a value', (t) => {
  const py = (text) => scan(t, { 'pyproject.toml': text });
  assert.equal(py('[tool.poetry.dependencies]\nopenai =\n'), undefined, 'no value is no dependency');
  assert.equal(py('[tool.poetry.dependencies]\nopenai = {version = "^1"}\n').value, true);
  assert.equal(py('[project]\n"dependencies" = ["openai"]\n').evidence, 'pyproject.toml: openai');
  assert.equal(py('project.dependencies = ["anthropic"]\n').evidence, 'pyproject.toml: anthropic');
  assert.equal(py('[tool."poetry".dependencies]\nopenai = "^1"\n').evidence, 'pyproject.toml: openai');
  assert.equal(py('[project]\n"keywords" = ["mcp"]\n'), undefined);
});

test('F1-1: an unclosed dependency array is scanned once: the largest readable file (256 KB) of `dependencies = [` finishes fast with no llm fact', (t) => {
  const text = `[project]\n${'dependencies = [\n'.repeat(Math.floor(250_000 / 17))}`;
  const started = performance.now();
  const fact = scan(t, { 'pyproject.toml': text });
  const ms = performance.now() - started;
  assert.equal(fact, undefined);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
});

test('F1-1: an array that closes after the cap counts nothing; a later well-formed array still counts', (t) => {
  const far = `[project]\ndependencies = [\n${'\n'.repeat(2500)}"openai",\n]\n`;
  assert.equal(scan(t, { 'pyproject.toml': far }), undefined, 'closing beyond 2000 lines counts nothing');
  const near = `[project]\ndependencies = [\n${'\n'.repeat(1500)}"openai",\n]\n`;
  assert.equal(scan(t, { 'pyproject.toml': near }).evidence, 'pyproject.toml: openai');
  const after = '[project]\ndependencies = [\n"x"\n[tool.poetry.dependencies]\nopenai = "1"\n';
  assert.equal(scan(t, { 'pyproject.toml': after }).evidence, 'pyproject.toml: openai', 'the scan moves on after an unclosed array');
});

test('F1-2: the test gate reads a bounded prefix and matches linearly (240 KB body)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gateOf = (body) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: body } }));
    return observeFiles(dir, ['package.json']).gates.find((g) => g.name === 'test')?.cmd;
  };
  const started = performance.now();
  const cmd = gateOf(';node a '.repeat(30000));
  const ms = performance.now() - started;
  assert.equal(cmd, 'npm run test');
  assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
  const tap = 'NODE_OPTIONS="$NODE_OPTIONS --test-reporter=tap" npm run test';
  assert.equal(gateOf('node --test'), tap);
  assert.equal(gateOf('npx node --test tests/'), tap);
  assert.equal(gateOf('tsc && node --import x --test'), tap);
  assert.equal(gateOf('echo node; echo --test'), 'npm run test', 'node and --test in different commands do not count');
  assert.equal(gateOf('node --test --test-reporter=spec'), 'npm run test');
});

test('review r1 F4: the array cap counts the opening line: an array closing on line 2000 counts, on line 2001 does not', (t) => {
  const arr = (blank) => `[project]\ndependencies = [\n${'\n'.repeat(blank)}"openai" ]\n`;
  assert.equal(scan(t, { 'pyproject.toml': arr(1998) }).evidence, 'pyproject.toml: openai', '2000 lines');
  assert.equal(scan(t, { 'pyproject.toml': arr(1999) }), undefined, '2001 lines');
});

test('review r1 F2: a body over the inspection cap gets the unmodified run command, also when a chain crosses the boundary', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gateOf = (body) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: body } }));
    return observeFiles(dir, ['package.json']).gates.find((g) => g.name === 'test')?.cmd;
  };
  assert.equal(gateOf(`jest ${' '.repeat(4096)}&& node --test`), 'npm run test');
  assert.equal(gateOf(`vitest ${' '.repeat(4096)}; node --test`), 'npm run test');
  assert.equal(gateOf(`node ${' '.repeat(4096)} --test`), 'npm run test');
});
