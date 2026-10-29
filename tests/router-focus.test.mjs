// reviewFocus (SEC-13): which review gets the security reviewer and which OWASP checklists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = join(root, 'plugins');
const pluginDir = join(plugins, readdirSync(plugins).find((d) => existsSync(join(plugins, d, 'lib', 'name.json'))));
const { reviewFocus, SECURITY_PATHS, AI_PATHS, CHECKLISTS } = await import(pathToFileURL(join(pluginDir, 'lib', 'router', 'focus.mjs')).href);

test('reviewFocus: security paths, AI paths, flags and the llm fact', () => {
  const a = reviewFocus({ files: ['src/auth/login.ts'] });
  assert.equal(a.focus, 'security');
  assert.deepEqual(a.checklists, ['web']);
  assert.deepEqual(a.triggers, ['src/auth/login.ts (**/auth/**)']);
  assert.deepEqual(reviewFocus({ files: ['prompts/system.md'] }).checklists, ['web', 'ai']);
  assert.deepEqual(reviewFocus({ files: ['package.json'], llm: true }).checklists, ['web', 'ai']);
  assert.equal(reviewFocus({ files: ['package.json'] }).focus, 'security');
  assert.equal(reviewFocus({ files: ['apps/web/package.json'] }).focus, 'security');
  assert.deepEqual(reviewFocus({ files: ['README.md'] }), { focus: 'general', checklists: [], triggers: [] });
  assert.deepEqual(reviewFocus({ files: ['README.md'], llm: true }).checklists, []);
  const s = reviewFocus({ files: ['README.md'], security: true });
  assert.deepEqual([s.focus, s.checklists, s.triggers], ['security', ['web'], ['--security']]);
  const f = reviewFocus({ files: ['README.md'], routeFlags: ['security'] });
  assert.deepEqual([f.focus, f.triggers], ['security', ['route flag security']]);
});

test('reviewFocus: at most 10 file triggers then a count; the lists are frozen', () => {
  const files = Array.from({ length: 13 }, (_, i) => `src/auth/f${i}.ts`);
  const r = reviewFocus({ files });
  assert.equal(r.triggers.length, 11);
  assert.equal(r.triggers[10], '… and 3 more files');
  assert.ok(Object.isFrozen(SECURITY_PATHS) && Object.isFrozen(AI_PATHS) && Object.isFrozen(CHECKLISTS));
  assert.equal(CHECKLISTS.ai.length, 20);
});
