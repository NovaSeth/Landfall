// Generic adapter contract (T-MG-86: B-4, SF-AB-5). A generic adapter's sandbox map is checked again on every load (a
// hand-edited providers.json gets no unchecked mode), {sandbox} is mandatory, a template that hard-codes a sandbox or
// write mode is refused, and a role whose mapping is missing or invalid cannot run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv } from './helpers/isolated-env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1);
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const generic = await lib('providers/generic.mjs');
const registry = await lib('providers/registry.mjs');

const OK = 'mycli run --dir {cwd} --mode {sandbox} -o {out}';

test('B-4: a hand-edited sandbox map loses every role whose mode is a bypass, invalid or (reviewer) a write mode', () => {
  const cases = [
    [{ reviewer: 'danger-full-access', implementer: 'workspace-write' }, { implementer: 'workspace-write' }],
    [{ reviewer: 'read-only', implementer: 'yolo' }, { reviewer: 'read-only' }],
    [{ reviewer: 'has space', implementer: 'rw' }, { implementer: 'rw' }],
    [{ reviewer: '-x', implementer: 'rw' }, { implementer: 'rw' }],
    [{ reviewer: 'workspace-write' }, {}],
    [{ reviewer: 'auto_edit' }, {}],
    [{ reviewer: 'read-only' }, { reviewer: 'read-only' }],
  ];
  for (const [map, roles] of cases) assert.deepEqual({ ...generic.fromEntry('mycli', { argv: OK, sandboxMap: map }).sandboxes }, roles, JSON.stringify(map));
});

test('SF-AB-5: {sandbox} is mandatory and a hard-coded sandbox or write mode is refused, on add and on load', () => {
  for (const bad of ['mycli run {cwd} {out}', 'codex exec -s workspace-write - {sandbox}', 'mycli --sandbox=read-only {sandbox}', 'mycli --mode auto_edit {sandbox}', 'mycli -s ro {sandbox}', 'mycli --sandbox read-only {sandbox}']) {
    assert.throws(() => generic.parseTemplate(bad), (err) => err.exit === 'USAGE', bad);
    assert.deepEqual({ ...generic.fromEntry('mycli', { argv: bad, sandboxMap: { reviewer: 'read-only', implementer: 'rw' } }).sandboxes }, {}, `${bad}: no role can run`);
  }
  for (const good of [OK, 'mycli --sandbox {sandbox}', 'node /opt/credit-tool.js {sandbox} {out}']) assert.doesNotThrow(() => generic.parseTemplate(good), good);
  assert.throws(() => generic.parseSandboxMap('reviewer=workspace-write'), (err) => err.code === 'unsafe-mode');
});

test('B-4: a hand-edited providers.json entry with a full-access reviewer cannot run the reviewer role', () => {
  const iso = isolatedEnv({ prefix: 'prov-hard-' });
  try {
    const data = join(iso.base, 'data');
    const env = { ...iso.env, CLAUDE_PLUGIN_DATA: data };
    registry.addProvider({ names, env, id: 'mycli', argv: OK, sandboxMap: 'reviewer=read-only,implementer=rw' });
    const file = join(data, 'providers.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.generic.mycli.sandboxMap.reviewer = 'danger-full-access';
    writeFileSync(file, JSON.stringify(doc));
    const a = registry.adapters({ names, env }).find((x) => x.id === 'mycli');
    assert.deepEqual({ ...a.sandboxes }, { implementer: 'rw' });
    doc.generic.mycli.argv = 'mycli run {cwd} {out}';
    doc.generic.mycli.sandboxMap.reviewer = 'read-only';
    writeFileSync(file, JSON.stringify(doc));
    assert.deepEqual({ ...registry.adapters({ names, env }).find((x) => x.id === 'mycli').sandboxes }, {}, 'no {sandbox}: no role');
  } finally {
    iso.cleanup();
  }
});

test('B-6: providers.json schema 2 adds the optional env; a schema 1 file still reads and a newer one is not used', () => {
  const iso = isolatedEnv({ prefix: 'prov-hard-' });
  try {
    const data = join(iso.base, 'data');
    const env = { ...iso.env, CLAUDE_PLUGIN_DATA: data };
    registry.addProvider({ names, env, id: 'mycli', argv: OK, sandboxMap: 'reviewer=read-only' });
    const file = join(data, 'providers.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(doc.schema, 2);
    writeFileSync(file, JSON.stringify({ ...doc, schema: 1 }));
    assert.deepEqual({ ...registry.adapters({ names, env }).find((x) => x.id === 'mycli').sandboxes }, { reviewer: 'read-only' }, 'a 2.4.1 file reads');
    writeFileSync(file, JSON.stringify({ ...doc, schema: 3 }));
    assert.equal(registry.adapters({ names, env }).find((x) => x.id === 'mycli'), undefined, 'a newer file is not interpreted');
    assert.throws(() => registry.addProvider({ names, env, id: 'other', argv: OK, sandboxMap: 'reviewer=read-only' }), (err) => err.code === 'schema-newer');
  } finally {
    iso.cleanup();
  }
});

test('B-4: a bad entry is listed with its note and no role; the other providers still load', () => {
  const iso = isolatedEnv({ prefix: 'prov-hard-' });
  try {
    const data = join(iso.base, 'data');
    const env = { ...iso.env, CLAUDE_PLUGIN_DATA: data };
    registry.addProvider({ names, env, id: 'good', argv: OK, sandboxMap: 'reviewer=read-only' });
    registry.addProvider({ names, env, id: 'bad', argv: OK, sandboxMap: 'reviewer=read-only' });
    const file = join(data, 'providers.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.generic.bad.argv = 'mycli --sandbox=read-only {sandbox}';
    writeFileSync(file, JSON.stringify(doc));
    const list = registry.adapters({ names, env });
    assert.deepEqual({ ...list.find((x) => x.id === 'good').sandboxes }, { reviewer: 'read-only' });
    assert.match(list.find((x) => x.id === 'bad').note, /no role can run/);
    const rows = registry.detectProviders({ names, env, write: false }).rows;
    const bad = rows.find((r) => r.id === 'bad');
    assert.deepEqual(bad.roles, []);
    assert.match(bad.error, /no role can run/);
  } finally {
    iso.cleanup();
  }
});
