// T-MG-176: print, compgen, vared and zparseopts set the variable they name, like read and printf -v: a line holding one
// is not read with the literal substituted (the text stays as written beside the substituted one). Commands are data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = join(root, 'plugins');
const dir = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'guard', 'tokenizer.mjs')))[0];
const { expandLiterals } = await import(pathToFileURL(join(plugins, dir, 'lib', 'guard', 'tokenizer.mjs')).href);

const KEPT = (cmd) => expandLiterals(cmd).includes(cmd);
test('T-MG-176: the four builtins are variable setters for literal substitution', () => {
  for (const b of ['print -r $n', 'vared $n', 'compgen -V $n -W x', 'zparseopts -a $n x', 'print -v$n x']) {
    const cmd = `n=t; for t in safe; do ${b}; cp /dev/null "$t"; done`;
    assert.ok(KEPT(cmd), `${b}: the original text is kept beside the expansion`);
    const flat = `dest=safe; ${b.replace('$n', 'dest')}; cp /dev/null "$dest"`;
    assert.ok(KEPT(flat), `${b}: a line with a setter is not substituted`);
  }
});
test('T-MG-176: glued option names count as bare use of the name', () => {
  for (const b of ['print -vdest x', 'compgen -Vdest -W x', 'printf -vdest x', 'read -rdest']) {
    const cmd = `dest=safe; ${b}; cp /dev/null "$dest"`;
    assert.ok(KEPT(cmd), b);
  }
});
test('B-MG-15: a flag cluster of a reader is no name glued to an option', () => {
  for (const cmd of ['F=.landfall; ls -lF "$F"', 'F=.landfall; grep -nF x "$F/state.json"']) assert.ok(!KEPT(cmd), cmd);
  // a program that may set the variable keeps the fail-closed reading
  assert.ok(KEPT('F=.landfall; foo -lF "$F"'));
});
