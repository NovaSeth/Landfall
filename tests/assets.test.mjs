// Logo assets (T-MG-82): docs/assets/*.svg are hand-written, self-contained SVG files without the
// codename, and the README header shows the light and dark logo. The codename is read from
// plugins/*/lib/name.json, as tests/name.test.mjs does; this file never spells it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'docs', 'assets');
const SVGS = [
  { file: 'logo.svg', viewBox: '0 0 512 512' },
  { file: 'logo-dark.svg', viewBox: '0 0 512 512' },
  { file: 'social-preview.svg', viewBox: '0 0 1280 640', width: '1280', height: '640' },
];
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

function codenames() {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'expected exactly one plugins/*/lib/name.json');
  const names = JSON.parse(readFileSync(join(plugins, hits[0], 'lib', 'name.json'), 'utf8'));
  return [...new Set([names.codename, names.displayName].filter(Boolean).map((n) => String(n).toLowerCase()))];
}

// A simple well-formedness check: comments removed, every tag balanced, no stray angle bracket.
function assertBalanced(src, file) {
  const body = src.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  for (const m of body.matchAll(TAG)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) assert.equal(stack.pop(), name, `${file}: </${name}> closes the wrong element`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], `${file}: unclosed elements`);
  assert.ok(!/[<>]/.test(body.replace(TAG, '')), `${file}: a stray < or > outside a tag`);
}

for (const spec of SVGS) {
  test(`docs/assets/${spec.file} is a clean, self-contained SVG of the specified size`, () => {
    const path = join(assets, spec.file);
    assert.ok(existsSync(path), `${spec.file} missing`);
    const src = readFileSync(path, 'utf8');
    assert.ok(src.trimStart().startsWith('<svg'), `${spec.file}: must start with <svg`);
    assertBalanced(src, spec.file);
    assert.ok(!/<script/i.test(src), `${spec.file}: holds a script`);
    assert.ok(!/href\s*=\s*["']\s*https?:/i.test(src), `${spec.file}: holds an external reference`);
    assert.ok(!/data:image\//i.test(src), `${spec.file}: embeds a raster`);
    assert.ok(!/\b(?:inkscape|sodipodi|sketch|figma|illustrator):/i.test(src), `${spec.file}: holds editor metadata`);
    const open = src.match(/<svg\b[^>]*>/)[0];
    assert.match(open, new RegExp(`viewBox="${spec.viewBox}"`), `${spec.file}: viewBox`);
    if (spec.width) {
      assert.match(open, new RegExp(`\\swidth="${spec.width}"`), `${spec.file}: width`);
      assert.match(open, new RegExp(`\\sheight="${spec.height}"`), `${spec.file}: height`);
    }
  });
}

test('no SVG asset holds the codename, as text or in its path', () => {
  const names = codenames();
  const files = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.svg')) : [];
  assert.ok(files.length >= SVGS.length, 'the SVG assets are missing');
  for (const f of files) {
    const text = readFileSync(join(assets, f), 'utf8').toLowerCase();
    for (const n of names) {
      assert.ok(!f.toLowerCase().includes(n), `${f}: the codename is in the file name`);
      assert.ok(!text.includes(n), `${f}: holds the codename`);
    }
  }
});

test('the README header shows the light and the dark logo before the first heading', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const head = readme.slice(0, Math.max(0, readme.search(/^#\s/m)));
  assert.ok(head.length > 0, 'the README must open with the logo block, before its heading');
  assert.match(head, /<picture>/);
  assert.match(head, /<source\s+media="\(prefers-color-scheme: dark\)"\s+srcset="docs\/assets\/logo-dark\.svg"/);
  assert.match(head, /<img\s+src="docs\/assets\/logo\.svg"/);
});
