// `secrets` (spec §8.2, §11, SD-29; SEC-5, SEC-6, SEC-11): the successor of the 1.x check-secrets.sh (patterns) and
// check-key-leak.sh (built files). The 1.x cases of tests/secrets.test.mjs (v1.5.1) are ported here in English and
// run against the command: working tree and index, --staged, --range, the project patterns, the synthetic marker.
// The generated pre-push hook and CI step are tested in tests/secrets-hooks.test.mjs, the verdicts against the 1.x
// script in tests/secrets-differential.test.mjs.
// Exit codes: 0 clean · 1 findings · 2 usage · 8 the scan could not run (1.x: 2), never 0 on an error. A finding names
// path:line (with --range commit:path:line), the pattern and a masked value; never the value.
// Every synthetic value is assembled at run time; its source line carries the SYNTH marker (SEC-11).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

// git (here and in the code under test) runs with a throwaway HOME and global config (S1).
isolateProcessEnv();
// The same git, found in its own exec path first: on macOS /usr/bin/git is an xcrun shim that adds a lookup to each of
// the many git calls here (and can fail under load); elsewhere this is the binary PATH already finds.
const GIT_DIR = spawnSync('git', ['--exec-path'], { encoding: 'utf8', env: process.env }).stdout.trim();
if (GIT_DIR && existsSync(join(GIT_DIR, 'git'))) process.env.PATH = `${GIT_DIR}${delimiter}${process.env.PATH}`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');

// Synthetic values, assembled at run time so no line of this file holds one.
const ghToken = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'; // SYNTH
const val = 'Zx81' + 'Qw7Er6Ty5Ui4Op3'; // SYNTH

const scratch = (t, prefix) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const git = (d, ...a) => {
  const r = spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function repo(t) {
  const d = scratch(t, 'secrets-');
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'commit.gpgsign', 'false');
  return d;
}
const put = (d, file, content) => {
  mkdirSync(dirname(join(d, file)), { recursive: true });
  writeFileSync(join(d, file), content);
};
const commit = (d, file, content) => {
  if (content === null) rmSync(join(d, file)); else put(d, file, content);
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', `change ${file}`);
};

// The command through the real command table, once as text and once with --json (the same exit both times).
async function scan(cwd, ...args) {
  const run = async (json) => {
    const out = [];
    const err = [];
    const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env: process.env, cwd, stdin: null };
    const code = await main(['secrets', ...args, ...(json ? ['--json'] : [])], { io });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  const text = await run(false);
  const json = await run(true);
  assert.equal(json.code, text.code, `the same exit with --json\n${text.stdout}${text.stderr}${json.stdout}`);
  const env = JSON.parse(json.stdout);
  return { status: text.code, stdout: text.stdout, stderr: text.stderr, env, all: `${text.stdout}${text.stderr}${json.stdout}` };
}
const where = (r) => r.env.data.findings.map((f) => f.where).sort();
const show = (r) => `exit ${r.status}\n${r.all}`;
const noLeak = (r, ...values) => {
  for (const v of values) assert.ok(!r.all.includes(v), `a secret value in the output: ${v.slice(0, 4)}…`);
};

test('a clean repository exits 0; a planted key exits 1 with path:line, the pattern and a masked value, never the value', async (t) => {
  const d = repo(t);
  commit(d, 'src/a.ts', 'export const x = 1;\n');
  let r = await scan(d);
  assert.equal(r.status, 0, show(r));
  assert.deepEqual([r.env.ok, r.env.data.mode, r.env.data.findings], [true, 'tree', []]);
  assert.match(r.stdout, /clean/);

  commit(d, 'src/b.ts', `const t = "${ghToken}";\n`);
  r = await scan(d);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual([r.env.exit, r.env.errors[0].code], ['FAIL', 'secrets-found']);
  assert.deepEqual(r.env.data.findings.map((f) => [f.where, f.path, f.line, f.type]), [['src/b.ts:1', 'src/b.ts', 1, 'github-token']]);
  const { masked } = r.env.data.findings[0];
  assert.ok(masked.startsWith(ghToken.slice(0, 4)) && masked.includes('*') && masked.includes(String(ghToken.length)), masked);
  assert.match(r.stdout, /^src\/b\.ts:1: github-token \S/m);
  noLeak(r, ghToken, ghToken.slice(4, 14), ghToken.slice(-10));
});

test('the scan never reports clean when it cannot run: outside git, a bad pattern file, a git error → 8', async (t) => {
  let r = await scan(scratch(t, 'secrets-outside-'));
  assert.equal(r.status, 8, show(r));
  assert.deepEqual([r.env.exit, r.env.errors[0].code], ['ENV', 'not-a-repo']);

  const d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  const rel = `${names.stateDir}/secrets-patterns.txt`;
  const file = join(d, rel);
  // Every mode reads the pattern file; --staged reads no working-tree file, so only the pattern file can fail it.
  const both = async (why, expected) => {
    for (const args of [[], ['--staged']]) {
      r = await scan(d, ...args);
      assert.equal(r.status, expected, `${why} (${args.join(' ') || 'tree'}): ${show(r)}`);
    }
    return r;
  };
  put(d, rel, '# project tokens\nzz_[A-Za-z0-9]{20,}  # our own prefix\n');
  await both('a readable pattern file', 0);
  if (process.getuid?.() !== 0) { // root reads a file without permissions; the directory case below covers it
    chmodSync(file, 0);
    try { r = await both('an unreadable pattern file', 8); } finally { chmodSync(file, 0o644); }
    assert.match(r.env.errors[0].message, /secrets-patterns\.txt/);
  }
  rmSync(file);
  mkdirSync(file);
  await both('a directory in place of the pattern file', 8);
  rmSync(file, { recursive: true });
  symlinkSync(join(d, 'a.ts'), file);
  await both('a symbolic link', 8);
  rmSync(file);
  for (const bad of ['zz_[A-Z\n', '([a-z]+_)+key\n', 'ok_[a-z]{4}\n[[:nope:]]\n']) {
    put(d, rel, bad);
    r = await both(JSON.stringify(bad), 8);
    assert.match(r.env.errors[0].message, /secrets-patterns\.txt:\d+/, 'the error names the line');
  }
  rmSync(file);
  for (const args of [['--range', 'no-such-revision'], ['--range', 'HEAD~5..HEAD'], ['--artifact', 'no-such-dir']]) {
    r = await scan(d, ...args);
    assert.equal(r.status, 8, `${args.join(' ')}: ${show(r)}`);
    assert.equal(r.env.exit, 'ENV');
  }
});

test('1.x: output is path:line only — no quoted value, Bearer token or table row', async (t) => {
  const d = repo(t);
  const quoted = 'abcdefghijk' + 'lmnopqrstuv'; // SYNTH
  commit(d, 'a.env.ts', `API_KEY="${quoted}"\n`);
  commit(d, 'http.ts', `fetch(u, { headers: { Authorization: 'Bearer ${ghToken}' } });\n`);
  commit(d, 'docs/keys.md', `| key | value |\n|---|---|\n| key | ${ghToken} |\n`);
  const r = await scan(d);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), ['a.env.ts:1', 'docs/keys.md:3', 'http.ts:1']);
  noLeak(r, quoted, ghToken, ghToken.slice(4, 14), '| key |');
});

test('1.x: .env files in subdirectories are found, *.example is not', async (t) => {
  const d = repo(t);
  commit(d, 'apps/web/.env.example', 'API_URL=\n');
  let r = await scan(d);
  assert.equal(r.status, 0, show(r));
  commit(d, 'apps/web/.env', 'PORT=3000\n');
  r = await scan(d);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(r.env.data.findings.map((f) => [f.where, f.type]), [['apps/web/.env', 'key-file']]);
  commit(d, 'apps/web/.env', null);
  commit(d, 'services/api/.env.production', 'PORT=3000\n');
  r = await scan(d);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), ['services/api/.env.production']);
  for (const [file, found] of [['certs/server.pem', true], ['keys/release.p12', true], ['a/b/c.key', true], ['android/app.keystore', true], ['ios/x.jks', true], ['win/x.pfx', true],
    ['.env.local', true], ['.env.sample', false], ['config/.env.template', false], ['docs/env.md', false], ['src/keys.ts', false]]) {
    const e = repo(t);
    commit(e, file, 'x\n');
    r = await scan(e);
    assert.equal(r.status, found ? 1 : 0, `${file}: ${show(r)}`);
  }
});

test('1.x: patterns — apiKey in YAML and camelCase, JSON, DB_PASSWORD with a colon; no false positives', async (t) => {
  const cases = [
    ['config.yml', `apiKey: "${val}"\n`],
    ['config.json', `{"apiKey": "${val}"}\n`],
    ['compose.yml', `  DB_PASSWORD: "${val}"\n`],
    ['client.ts', `const clientSecret = '${val}';\n`],
  ];
  for (const [file, content] of cases) {
    const d = repo(t);
    commit(d, file, content);
    const r = await scan(d);
    assert.equal(r.status, 1, `${file}: ${content}`);
    assert.deepEqual(where(r), [`${file}:1`]);
    noLeak(r, val);
  }
  const d = repo(t);
  commit(d, 'ok.ts', [
    'const cfg = { apiKey: process.env.X, password: "" };',
    'apiKey: process.env.API_KEY',
    'password: ""',
    'DB_PASSWORD: ${DB_PASSWORD}',
    'const tokenizer = "bert-base-uncased-model";',
    'Authorization: Bearer <token>',
  ].join('\n') + '\n');
  const r = await scan(d);
  assert.equal(r.status, 0, show(r));
});

test('1.x: the SYNTH marker in a path does not exempt a line; in the line it does (SEC-11); a key elsewhere is found', async (t) => {
  const d = repo(t);
  commit(d, 'tests/SYNTH-fixtures/a.ts', `const t = "${ghToken}";\n`);
  let r = await scan(d);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), ['tests/SYNTH-fixtures/a.ts:1']);
  commit(d, 'tests/SYNTH-fixtures/a.ts', `const t = "${ghToken}"; // SYNTH\n`);
  commit(d, 'tests/b.test.ts', `const t = "${ghToken}"; // check-secrets: synthetic\n`);
  r = await scan(d);
  assert.equal(r.status, 0, show(r));
  commit(d, 'src/c.ts', `const t = "${ghToken}";\n`);
  r = await scan(d);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), ['src/c.ts:1'], 'only the line without the marker');
});

test('1.x: the default mode scans the index and the working tree (a secret staged and fixed only on disk is found)', async (t) => {
  const d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  put(d, 'a.ts', `const t = "${ghToken}";\n`);
  git(d, 'add', 'a.ts');
  put(d, 'a.ts', 'ok\n');
  let r = await scan(d);
  assert.equal(r.status, 1, `the index goes into the commit: ${show(r)}`);
  assert.deepEqual(where(r), ['a.ts:1']);
  git(d, 'add', 'a.ts');
  put(d, 'new.ts', `const t = "${ghToken}";\n`);
  r = await scan(d);
  assert.equal(r.status, 1, 'an untracked file that is not ignored reaches the repository with git add -A');
  assert.deepEqual(where(r), ['new.ts:1']);
  writeFileSync(join(d, '.gitignore'), 'new.ts\n');
  r = await scan(d);
  assert.equal(r.status, 0, show(r));
  rmSync(join(d, '.gitignore'));
  rmSync(join(d, 'new.ts'));
  commit(d, 'gone.ts', `const t = "${ghToken}";\n`);
  rmSync(join(d, 'gone.ts'));
  r = await scan(d);
  assert.equal(r.status, 1, `a file deleted on disk is still in the index: ${show(r)}`);
  assert.deepEqual(where(r), ['gone.ts:1']);
});

test('1.x: --staged scans only lines added in the index; --range a secret added and removed in the range; a bad revision is 8', async (t) => {
  const d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  put(d, 'a.ts', `ok\nconst t = "${ghToken}";\n`);
  git(d, 'add', 'a.ts');
  let r = await scan(d, '--staged');
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), ['a.ts:2']);
  noLeak(r, ghToken);
  git(d, 'commit', '-qm', 'secret');
  const added = git(d, 'rev-parse', 'HEAD').slice(0, 12);
  commit(d, 'a.ts', 'ok\n');
  assert.equal((await scan(d)).status, 0, 'the tree is clean');
  assert.equal((await scan(d, '--staged')).status, 0);
  r = await scan(d, '--range', 'HEAD~2..HEAD');
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), [`${added}:a.ts:2`]);
  assert.equal(r.env.data.findings[0].commit, added);
  assert.equal((await scan(d, '--range', 'HEAD~1..HEAD')).status, 0);
  assert.equal((await scan(d, '--range', 'no-such-revision')).status, 8, 'a git error is not clean');
});

test('1.x: project patterns from <state dir>/secrets-patterns.txt apply to every mode', async (t) => {
  const d = repo(t);
  commit(d, `${names.stateDir}/secrets-patterns.txt`, 'zz_[A-Za-z0-9]{20,}\n');
  const own = 'zz_' + 'A1b2C3d4E5f6G7h8I9j0K1'; // SYNTH
  put(d, 'src.txt', `x = ${own}\n`);
  git(d, 'add', '-A');
  let r = await scan(d, '--staged');
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(r.env.data.findings.map((f) => [f.where, f.type]), [['src.txt:1', 'project:1']]);
  git(d, 'commit', '-qm', 'token');
  assert.equal((await scan(d, '--range', 'HEAD~1..HEAD')).status, 1);
  r = await scan(d);
  assert.equal(r.status, 1, show(r));
  noLeak(r, own);
});

test('1.x: patterns — quoted passwords with special characters, unquoted YAML, a token in a lockfile; placeholders and addresses are clean', async (t) => {
  const pw = 'correct' + '-horse!battery@staple'; // SYNTH
  for (const [file, content] of [
    ['config/a.yml', `db:\n  password: "${pw}"\n`],
    ['config/b.yml', `service:\n  api_key: ${val}abcd\n`],
    ['config/c.yml', `db:\n  password: "correct.${pw}"\n`],
    ['config/d.yml', `service:\n  api_key: ${val}abcd # production\n`],
    ['config/e.yml', `db:\n  password: "correct:${pw}"\n`],
    ['package-lock.json', `{"resolved": "https://registry.example.com/x.tgz", "auth": "${ghToken}"}\n`],
  ]) {
    const d = repo(t);
    commit(d, file, content);
    const r = await scan(d);
    assert.equal(r.status, 1, `${file}: ${show(r)}`);
    noLeak(r, pw, val, ghToken);
  }
  const d = repo(t);
  commit(d, 'config/ok.yml', [
    'password: "${DB_PASSWORD}"', 'api_key: "<your-api-key>"', 'secret: "****************"',
    'token: "https://auth.example.com/oauth/token"', "token: 'user:alice/co-a'", 'password: "https://user@host.example.com/x"', 'apiKey: process.env.API_KEY', 'password: ""', 'token_url: https://example.com/a/b/c',
  ].join('\n') + '\n');
  const r = await scan(d);
  assert.equal(r.status, 0, show(r));
});

test('--range and --staged scan exactly their changes: nothing before the range, nothing unstaged, nothing untracked', async (t) => {
  const d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  const c1 = git(d, 'rev-parse', 'HEAD');
  commit(d, 'old.ts', `const t = "${ghToken}";\n`);
  const c2 = git(d, 'rev-parse', 'HEAD');
  commit(d, 'b.ts', 'clean\n');
  commit(d, 'c.ts', 'clean too\n');
  put(d, 'untracked.ts', `const t = "${ghToken}";\n`);

  let r = await scan(d, '--range', `${c2}..HEAD`);
  assert.equal(r.status, 0, `the key is in the commit before the range: ${show(r)}`);
  r = await scan(d, '--range', `${c1}..HEAD`);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), [`${c2.slice(0, 12)}:old.ts:1`], 'the range, not the working tree');
  r = await scan(d, '--range', `${c2} --not ${c1}`);
  assert.deepEqual(where(r), [`${c2.slice(0, 12)}:old.ts:1`], 'revisions with --not, as git log takes them');

  r = await scan(d, '--staged');
  assert.equal(r.status, 0, `nothing staged: ${show(r)}`);
  put(d, 'staged.ts', `one\nconst t = "${ghToken}";\n`);
  git(d, 'add', 'staged.ts');
  put(d, 'staged.ts', `one\nconst t = "${ghToken}";\nconst u = "${ghToken}";\n`);
  put(d, 'b.ts', `clean\nconst t = "${ghToken}";\n`);
  r = await scan(d, '--staged');
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), ['staged.ts:2'], 'only the staged line');

  r = await scan(d);
  assert.deepEqual(where(r), ['b.ts:2', 'old.ts:1', 'staged.ts:2', 'staged.ts:3', 'untracked.ts:1'], 'the default mode sees all of them');
});

test('--range takes revisions only: an option other than --not, --all, --branches, --remotes, --tags is refused (2) before git runs', async (t) => {
  const d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  const out = join(d, 'written-by-git.txt');
  for (const bad of [`--output=${out}`, `HEAD --output=${out}`, '-p', '--remotes=origin', '', '  ']) {
    const r = await scan(d, '--range', bad);
    assert.equal(r.status, 2, `${JSON.stringify(bad)}: ${show(r)}`);
    assert.equal(r.env.exit, 'USAGE');
  }
  assert.ok(!existsSync(out), 'git never received the option');
  for (const ok of ['HEAD', 'HEAD --not --remotes', 'HEAD --not --branches --tags', '--all']) {
    const r = await scan(d, '--range', ok);
    assert.equal(r.status, 0, `${ok}: ${show(r)}`);
    assert.equal(r.env.data.range, ok);
  }
});

test('one mode at a time: --range, --staged and --artifact exclude each other (2)', async (t) => {
  const d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  for (const args of [['--staged', '--range', 'HEAD'], ['--staged', '--artifact', 'a.ts'], ['--range', 'HEAD', '--artifact', 'a.ts']]) {
    const r = await scan(d, ...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${show(r)}`);
  }
});

test('--artifact: a key in a built file is found (ignored, minified, nested); the marker exempts nothing there; key files too', async (t) => {
  const d = repo(t);
  commit(d, '.gitignore', 'dist/\n');
  put(d, 'dist/app.min.js', `!function(){var a="x";var k="${ghToken}";console.log(a,k)}();\n`);
  put(d, 'dist/assets/site.css', 'body{margin:0}\n');
  let r = await scan(d);
  assert.equal(r.status, 0, `the working tree mode skips ignored files: ${show(r)}`);
  r = await scan(d, '--artifact', 'dist');
  assert.equal(r.status, 1, show(r));
  assert.deepEqual([r.env.data.mode, where(r)], ['artifact', ['dist/app.min.js:1']]);
  assert.equal(r.env.data.scanned.files, 2);
  noLeak(r, ghToken, ghToken.slice(4, 14));
  r = await scan(d, '--artifact', 'dist/app.min.js');
  assert.deepEqual([r.status, where(r)], [1, ['dist/app.min.js:1']], 'a single file');
  mkdirSync(join(d, 'sub'));
  r = await scan(join(d, 'sub'), '--artifact', '../dist');
  assert.deepEqual([r.status, where(r)], [1, ['../dist/app.min.js:1']], 'relative to the current directory');

  put(d, 'dist/app.min.js', 'console.log(1)\n');
  r = await scan(d, '--artifact', 'dist');
  assert.equal(r.status, 0, `a clean build: ${show(r)}`);
  put(d, 'dist/fixture.js', `var k="${ghToken}"; // SYNTH\n`);
  r = await scan(d, '--artifact', 'dist');
  assert.deepEqual([r.status, where(r)], [1, ['dist/fixture.js:1']], 'a built file is no test file: the marker does not exempt');
  rmSync(join(d, 'dist/fixture.js'));
  put(d, 'dist/deep/er/.env', 'PORT=1\n');
  r = await scan(d, '--artifact', 'dist');
  assert.deepEqual([r.status, r.env.data.findings.map((f) => [f.where, f.type])], [1, [['dist/deep/er/.env', 'key-file']]]);
});

test('a range whose diff exceeds the 16 MB git output buffer is scanned in full (the first push of a large history)', async (t) => {
  const d = repo(t);
  commit(d, 'big.txt', `${'x'.repeat(99)}\n`.repeat(180000));
  commit(d, 'late.ts', `const t = "${ghToken}";\n`);
  const r = await scan(d, '--range', 'HEAD');
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), [`${git(d, 'rev-parse', 'HEAD').slice(0, 12)}:late.ts:1`]);
  assert.ok(r.env.data.scanned.lines > 180000, `every added line was read: ${r.env.data.scanned.lines}`);
});

// One pattern source (GC6): lib/secrets/patterns.mjs is the only plugin file that defines a secret pattern. The checker
// looks for the shapes a secret regular expression takes (a token prefix followed by regex syntax, a private key
// header, a Bearer class, case classes of key names, alternations of key names or key file extensions, the marker
// alternation); it must find each planted shape and the real pattern module (REV-45: a checker that finds nothing
// proves nothing).
const SHAPES = [
  /(?:\bgh[pousr]?_?|github_pat_|\bsk-(?:ant-)?|AKIA|AIza|\bxox[a-z]?-?|\beyJ)(?:\[|\\[dwsS.]|\((?!\))|\{\d)/,
  /BEGIN[ ([].{0,24}PRIVATE KEY/,
  /\[Bb\]earer|[Bb]earer(?:\\s|\[)/,
  /\[(?:Aa|Pp|Ss|Tt|Kk)\]\[(?:Pp|Aa|Ee|Oo|Ee)\]/,
  /\((?:\?:)?(?:API_KEY|SECRET|TOKEN|PASSWORD|api_key|apikey|access_token|password|secret|token)\|/,
  /\b(?:pem|p12|pfx|jks|keystore|key)\|(?:pem|p12|pfx|jks|keystore|key)\b/,
  /SYNTH\|/,
];
const PATTERN_MODULE = 'lib/secrets/patterns.mjs';
function secretRegexFiles(pluginRoot) {
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  return walk(pluginRoot)
    .filter((f) => { const text = readFileSync(f, 'latin1'); return SHAPES.some((re) => re.test(text)); })
    .map((f) => relative(pluginRoot, f).split(sep).join('/'))
    .sort();
}

test('one pattern source: no plugin file but lib/secrets/patterns.mjs defines a secret pattern', (t) => {
  assert.deepEqual(secretRegexFiles(pluginDir), [PATTERN_MODULE]);
  const planted = [
    "const re = /gh[pousr]_[A-Za-z0-9]{36}/;\n", "const re = /ghp_[A-Za-z0-9]{36}/;\n", "new RegExp('AKIA[0-9A-Z]{16}');\n",
    "const k = /sk-[A-Za-z0-9]{32}/;\n", "const s = /xox[bp]-[0-9a-z-]+/;\n", "const g = /AIza\\S{35}/;\n", "const j = /eyJ[\\w-]+\\.eyJ/;\n",
    'const p = /-----BEGIN (RSA )?PRIVATE KEY-----/;\n', 'const b = /[Bb]earer\\s+\\S+/;\n', 'const b = /Bearer\\s+\\S+/;\n',
    "const n = /[Aa][Pp][Ii]_?[Kk][Ee][Yy]/;\n", "const n = /(API_KEY|SECRET)=\\S+/;\n", "const n = /(?:password|token)\\s*=/i;\n",
    'const f = /\\.(pem|p12|key)$/;\n', "const m = /SYNTH|synthetic/;\n", "x=$(grep -E 'github_pat_[A-Za-z0-9_]{40,}' f)\n",
  ];
  for (const content of planted) {
    const dir = scratch(t, 'secrets-plant-');
    mkdirSync(join(dir, 'lib', 'other'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'other', 'a.mjs'), content);
    assert.deepEqual(secretRegexFiles(dir), ['lib/other/a.mjs'], content);
  }
});

// Fix round 1 (review r1, F1–F5).
const utf16 = (text, be = false) => { const le = Buffer.from(`﻿${text}`, 'utf16le'); return be ? Buffer.from(le).swap16() : le; };

test('F1: a BOM-marked UTF-16 text file (LE, BE) is decoded in every mode, not skipped as binary; other binaries stay skipped', async (t) => {
  const d = repo(t);
  commit(d, 'README.md', 'x\n');
  const body = `a=1\r\nTOKEN="${ghToken}"\r\n`;
  put(d, 'win/le.txt', utf16(body));
  put(d, 'win/be.txt', utf16(body, true));
  put(d, 'bin.dat', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`\n${ghToken}\n`)]));
  let r = await scan(d);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), ['win/be.txt:2', 'win/le.txt:2'], 'line numbers of the decoded text; the other binary is skipped');
  noLeak(r, ghToken, ghToken.slice(4, 14));
  git(d, 'add', '-A');
  r = await scan(d, '--staged');
  assert.deepEqual([r.status, where(r)], [1, ['win/be.txt:2', 'win/le.txt:2']], `staged: ${show(r)}`);
  git(d, 'commit', '-qm', 'utf-16');
  let sha = git(d, 'rev-parse', 'HEAD').slice(0, 12);
  r = await scan(d, '--range', 'HEAD~1..HEAD');
  assert.deepEqual([r.status, where(r)], [1, [`${sha}:win/be.txt:2`, `${sha}:win/le.txt:2`]], `range: ${show(r)}`);

  const quoted = 'abcdefghijk' + 'lmnopqrstuv'; // SYNTH
  put(d, 'win/le.txt', utf16(`${body}more=1\r\nAPI_KEY="${quoted}"\r\n`));
  git(d, 'add', '-A');
  r = await scan(d, '--staged');
  assert.deepEqual([r.status, where(r)], [1, ['win/le.txt:4']], `only the line the change adds: ${show(r)}`);
  git(d, 'commit', '-qm', 'more');
  sha = git(d, 'rev-parse', 'HEAD').slice(0, 12);
  r = await scan(d, '--range', 'HEAD~1..HEAD');
  assert.deepEqual([r.status, where(r)], [1, [`${sha}:win/le.txt:4`]], show(r));
  noLeak(r, quoted);

  put(d, 'win/x.txt', utf16(`k="${ghToken}"\r\n`));
  git(d, 'add', '-A');
  put(d, 'win/x.txt', utf16('ok\r\n'));
  r = await scan(d);
  assert.deepEqual(where(r), ['win/be.txt:2', 'win/le.txt:2', 'win/le.txt:4', 'win/x.txt:1'], `a UTF-16 key staged and fixed only on disk: ${show(r)}`);
  r = await scan(d, '--artifact', 'win');
  assert.deepEqual(where(r), ['win/be.txt:2', 'win/le.txt:2', 'win/le.txt:4'], `artifact: ${show(r)}`);
});

test('F2: the marker is a separate word: SYNTHESIS_API_KEY or SYNTHETIC lines are findings; SYNTH, SYNTH-x and the long form exempt', async (t) => {
  const d = repo(t);
  commit(d, 'config.sh', `SYNTHESIS_API_KEY="${val}abcd"\nconst SYNTHETIC = "${ghToken}";\nx="${ghToken}" # SYNTHS\n`);
  let r = await scan(d);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), ['config.sh:1', 'config.sh:2', 'config.sh:3']);
  noLeak(r, val, ghToken);
  commit(d, 'config.sh', `SYNTHESIS_API_KEY="${val}abcd" # SYNTH\nconst t = "${ghToken}"; // SYNTH-fixture\nconst u = "${ghToken}"; /* check-secrets: synthetic */\n`);
  r = await scan(d);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(where(r), ['config.sh:1', 'config.sh:2', 'config.sh:3']);
  commit(d, 'tests/config.sh', readFileSync(join(d, 'config.sh')));
  rmSync(join(d, 'config.sh'));
  git(d, 'add', '-A');
  r = await scan(d);
  assert.equal(r.status, 0, show(r));
  assert.equal(r.env.data.exempted, 3);
});

test('F3: --range lists key and env files a merge adds in its resolution (added against every parent)', async (t) => {
  const d = repo(t);
  commit(d, 'a.ts', 'base\n');
  const base = git(d, 'rev-parse', 'HEAD');
  git(d, 'checkout', '-qb', 'side');
  commit(d, 'side.ts', 'side\n');
  git(d, 'checkout', '-q', 'main');
  commit(d, 'main.ts', 'main\n');
  git(d, 'merge', '-q', '--no-commit', 'side');
  put(d, '.env', 'PORT=1\n');
  put(d, 'android/release.keystore', 'x\n');
  put(d, 'win/m.txt', utf16(`TOKEN="${ghToken}"\r\n`));
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'merge with files added in the resolution');
  const merge = git(d, 'rev-parse', 'HEAD').slice(0, 12);
  const r = await scan(d, '--range', `${base}..HEAD`);
  assert.equal(r.status, 1, show(r));
  assert.deepEqual(r.env.data.findings.map((f) => [f.where, f.type]).sort(), [[`${merge}:.env`, 'key-file'], [`${merge}:android/release.keystore`, 'key-file'], [`${merge}:win/m.txt:1`, 'github-token']]);
  // A key file a branch adds is reported at its own commit, not again at the merge that brings it.
  const e = repo(t);
  commit(e, 'a.ts', 'base\n');
  const b2 = git(e, 'rev-parse', 'HEAD');
  git(e, 'checkout', '-qb', 'side');
  commit(e, 'side.pem', 'x\n');
  const sidePem = git(e, 'rev-parse', 'HEAD').slice(0, 12);
  git(e, 'checkout', '-q', 'main');
  commit(e, 'main.ts', 'main\n');
  git(e, 'merge', '-q', '--no-edit', 'side');
  const s = await scan(e, '--range', `${b2}..HEAD`);
  assert.deepEqual(where(s), [`${sidePem}:side.pem`], show(s));
});

test('F4: a project pattern that does not compile is reported by file, line and reason, never by its text', async (t) => {
  const d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  const literal = 'live_' + 'Q9w8E7r6T5y4'; // SYNTH
  for (const tail of ['[A-Z', '(?<', '+++', '[[:nope:]]', '[[.a.]]', '(']) {
    put(d, `${names.stateDir}/secrets-patterns.txt`, `# ours\n${literal}${tail}\n`);
    const r = await scan(d, '--staged');
    assert.equal(r.status, 8, `${tail}: ${show(r)}`);
    assert.match(r.env.errors[0].message, /secrets-patterns\.txt:2: /, 'file and line');
    assert.ok(!r.all.includes(literal.slice(5)) && !r.all.includes(tail.length > 2 ? tail : '\u0000'), `${tail}: the pattern text is not printed\n${r.all}`);
  }
});

test('F5: a UTF-8 BOM in secrets-patterns.txt is stripped; another encoding of the file is refused (8)', async (t) => {
  const d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  const own = 'zz_' + 'A1b2C3d4E5f6G7h8I9j0K1'; // SYNTH
  put(d, 'src.txt', `x = ${own}\n`);
  git(d, 'add', 'src.txt');
  const rel = `${names.stateDir}/secrets-patterns.txt`;
  put(d, rel, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('zz_[A-Za-z0-9]{20,}\n')]));
  let r = await scan(d, '--staged');
  assert.deepEqual([r.status, r.env.data.findings.map((f) => [f.where, f.type])], [1, [['src.txt:1', 'project:1']]], `the first pattern works: ${show(r)}`);
  for (const [why, bytes] of [['UTF-16', utf16('zz_[A-Za-z0-9]{20,}\n')], ['a NUL', Buffer.from('zz_[A-Z]{4}\0\n')], ['not UTF-8', Buffer.from([0x7a, 0x7a, 0x5f, 0xb3, 0x0a])]]) {
    put(d, rel, bytes);
    r = await scan(d, '--staged');
    assert.equal(r.status, 8, `${why}: ${show(r)}`);
    assert.match(r.env.errors[0].message, /secrets-patterns\.txt.*UTF-8/);
  }
});

// Fix round 2 (review r2).
test('F1 (r2, orchestrator decision): a blob over the read cap is not read and listed as not scanned, never silently; at the cap it is read', async (t) => {
  const { scanSecrets } = await lib('secrets/index.mjs');
  const { secrets } = await lib('secrets/command.mjs');
  const d = repo(t);
  commit(d, 'README.md', 'x\n');
  const content = utf16(`TOKEN="${ghToken}"\r\n`);
  put(d, 'win/big.txt', content);
  git(d, 'add', '-A');
  const scanWith = (mode, blobMax, revs = []) => scanSecrets({ cwd: d, env: process.env, names, mode, revs, blobMax });
  let r = scanWith('staged', content.length);
  assert.deepEqual([r.findings.map((f) => f.where), r.skipped], [['win/big.txt:1'], []], 'at the cap: read and found');
  r = scanWith('staged', content.length - 1);
  assert.deepEqual([r.findings, r.skipped], [[], [{ path: 'win/big.txt', commit: null, size: content.length, reason: `over ${content.length - 1} bytes` }]], 'one byte over: listed');
  // The command prints the list, with exit 0 when nothing else was found, and keeps it in data.skipped.
  const io = { cwd: d, env: process.env };
  let out = secrets({ flags: { staged: true }, names, io, blobMax: content.length - 1 });
  assert.equal(out.code ?? 0, 0);
  assert.match(out.text, new RegExp(`^not scanned \\(over ${content.length - 1} bytes\\): win/big\\.txt$`, 'm'));
  assert.deepEqual(out.data.skipped.map((x) => x.path), ['win/big.txt']);
  put(d, 'b.ts', `const t = "${ghToken}";\n`);
  git(d, 'add', 'b.ts');
  out = secrets({ flags: { staged: true }, names, io, blobMax: content.length - 1 });
  assert.equal(out.code, 1, 'findings elsewhere still exit 1');
  assert.match(out.text, /^not scanned \(over \d+ bytes\): win\/big\.txt$/m, 'the list is printed with findings too');
  assert.deepEqual((await scan(d, '--staged')).env.data.skipped, [], 'the default cap (16 MiB) reads it');
  git(d, 'commit', '-qm', 'big');
  const sha = git(d, 'rev-parse', 'HEAD').slice(0, 12);
  assert.deepEqual(scanWith('range', content.length, ['HEAD~1..HEAD']).findings.map((f) => f.where).sort(), [`${sha}:b.ts:1`, `${sha}:win/big.txt:1`]);
  r = scanWith('range', content.length - 1, ['HEAD~1..HEAD']);
  assert.deepEqual([r.findings.map((f) => f.where), r.skipped.map((x) => [x.commit, x.path])], [[`${sha}:b.ts:1`], [[sha, 'win/big.txt']]]);
  const { MAX_OUTPUT } = await lib('git/index.mjs');
  assert.equal(MAX_OUTPUT, 16 * 1024 * 1024, 'the default cap is the one the text names');
});

test('F6: a file re-saved from UTF-16 to UTF-8 while a secret is added: its new lines are scanned in --staged and --range', async (t) => {
  const d = repo(t);
  commit(d, 'win/notes.txt', utf16('a=1\r\nb=2\r\n'));
  put(d, 'win/notes.txt', Buffer.from(`a=1\r\nb=2\r\nTOKEN="${ghToken}"\r\n`));
  git(d, 'add', '-A');
  let r = await scan(d, '--staged');
  assert.deepEqual([r.status, where(r)], [1, ['win/notes.txt:3']], `the lines the UTF-16 version held are not new: ${show(r)}`);
  git(d, 'commit', '-qm', 'utf-8 now');
  const sha = git(d, 'rev-parse', 'HEAD').slice(0, 12);
  r = await scan(d, '--range', 'HEAD~1..HEAD');
  assert.deepEqual([r.status, where(r)], [1, [`${sha}:win/notes.txt:3`]], show(r));
  noLeak(r, ghToken);
});

// Audit regressions (T-MG-72). Values are synthetic and assembled only in this test fixture.
const secretPatterns = await lib('secrets/patterns.mjs');
const { redact: redactGate } = await lib('verify/redact.mjs');
for (const operation of ['matchLine', 'redact']) {
  for (const shape of ['uppercase', 'assignments']) {
    test(`D1: ${operation} handles 1 MiB of ${shape} within 2000 ms`, () => {
      const module = pathToFileURL(join(pluginDir, 'lib', operation === 'redact' ? 'verify/redact.mjs' : 'secrets/patterns.mjs')).href;
      const script = `import { ${operation} as run } from ${JSON.stringify(module)};
        const unit = ${JSON.stringify(shape === 'uppercase' ? 'TOKEN' : 'api_key="aaaaa')};
        const text = unit.repeat(Math.ceil(1048576 / unit.length)).slice(0, 1048576);
        run(text);`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 2000, encoding: 'utf8' });
      assert.equal(r.error?.code ?? r.status, 0, `${operation}/${shape}: ${r.error?.code ?? r.stderr}`);
    });
  }
}

test('D1: every window is bounded and overlapping; edge secrets are found and fully redacted', () => {
  const windows = [];
  const exec = RegExp.prototype.exec;
  try {
    RegExp.prototype.exec = function (s) {
      if (this.global) windows.push(s);
      return exec.call(this, s);
    };
    secretPatterns.matchLine('.'.repeat(14000));
  } finally { RegExp.prototype.exec = exec; }
  assert.ok(windows.length > 1);
  assert.ok(windows.every((s) => s.length <= 4096));
  assert.ok(secretPatterns.WINDOW_OVERLAP >= secretPatterns.MAX_PATTERN_SPAN);
  for (const offset of [4090, 4095, 6140, 8190]) {
    const line = '.'.repeat(offset) + ghToken + '.'.repeat(5000);
    assert.equal(secretPatterns.matchLine(line)?.id, 'github-token');
    assert.ok(!redactGate(line).includes(ghToken.slice(4)), 'the whole secret is redacted');
  }
});

const auditFormats = [
  ['PGP', 'private-key', '-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----BEGIN PGP PUBLIC KEY BLOCK-----'], // SYNTH
  ['npm', 'npm-token', 'npm_' + 'a1B2'.repeat(9), 'npm_<placeholder>'], // SYNTH
  ['npmrc', 'npm-token', '//registry.npmjs.org/:_authToken=' + 'a1B2'.repeat(9), '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'], // SYNTH
  ['AWS ini', 'aws-secret-key', 'aws_secret_access_key = ' + 'a1B/'.repeat(10), 'aws_secret_access_key = <placeholder>'], // SYNTH
  ['Stripe secret', 'stripe-key', 'sk_live_' + 'a1B2'.repeat(6), 'sk_live_<placeholder>'], // SYNTH
  ['Stripe restricted', 'stripe-key', 'rk_live_' + 'a1B2'.repeat(6), 'rk_live_<placeholder>'], // SYNTH
  ['GitLab', 'gitlab-token', 'glpat-' + 'a1_-'.repeat(5), 'glpat-<placeholder>'], // SYNTH
  ['URL password', 'url-password', 'postgres://user:' + 'a1B2'.repeat(4) + '@db.example.com/app', 'postgres://user:password@db.example.com/app'], // SYNTH
];
for (const [name, id, positive, negative] of auditFormats) {
  test(`D3: ${name} is detected and its placeholder is clean`, () => {
    assert.equal(secretPatterns.matchLine(positive)?.id, id);
    assert.equal(secretPatterns.matchLine(negative), null);
    assert.ok(!redactGate(positive).includes(positive), 'redaction uses the same patterns');
  });
}
test('D3: URL password placeholders and missing passwords are clean', () => {
  for (const password of ['password', 'pass', '***', '<secret>', '${SECRET}', 'ab', '']) {
    assert.equal(secretPatterns.matchLine(`postgres://user:${password}@host/db`), null);
  }
  assert.equal(secretPatterns.matchLine('postgres://user@host/db'), null);
});
for (const name of ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']) {
  test(`D3: ${name} is a key file; its template/public counterpart is clean`, () => {
    assert.equal(secretPatterns.isKeyFile(`config/${name}`), true);
    assert.equal(secretPatterns.isKeyFile(`config/${name}.example`), false);
    assert.equal(secretPatterns.isKeyFile(`config/${name}.pub`), false);
  });
}

test('AR-1: tree and artifact stream a 3 MiB file, finding a secret at byte 2.5 MiB', async (t) => {
  const d = repo(t);
  const at = 2.5 * 1024 * 1024;
  put(d, 'large.txt', '.'.repeat(at) + ghToken + '\n' + '.'.repeat(3 * 1024 * 1024 - at - ghToken.length - 1));
  put(d, 'small.txt', ghToken);
  for (const args of [[], ['--artifact', 'large.txt']]) {
    const r = await scan(d, ...args);
    assert.equal(r.status, 1, show(r));
    assert.deepEqual(r.env.data.skipped, []);
    assert.deepEqual(where(r), args.length ? ['large.txt:1'] : ['large.txt:1', 'small.txt:1']);
    assert.equal(r.env.data.scanned.files, args.length ? 1 : 2);
    noLeak(r, ghToken);
  }
});

test('D9: only test/fixture paths exempt marked lines, counted in tree, staged and range output', async (t) => {
  const d = repo(t);
  commit(d, 'README.md', 'clean\n');
  const fixtures = ['test/a.js', 'tests/fixtures/a.js', '__tests__/a.js', 'fixtures/a.js', 'testdata/a.js', 'spec/a.js', 'src/a.test.js', 'src/a.spec.ts'];
  const production = ['src/a.js', 'src/contest/a.js', 'specimen/a.js', 'src/a.tests.js'];
  for (const file of [...fixtures, ...production]) put(d, file, `${ghToken} // SYNTH\n`);
  git(d, 'add', '-A');
  for (const args of [[], ['--staged']]) {
    const r = await scan(d, ...args);
    assert.deepEqual(where(r), production.map((p) => `${p}:1`).sort());
    assert.equal(r.env.data.exempted, fixtures.length);
    assert.match(r.stdout, /8 synthetic lines exempted/);
  }
  git(d, 'commit', '-qm', 'marked values');
  const r = await scan(d, '--range', 'HEAD~1..HEAD');
  assert.equal(r.env.data.findings.length, production.length);
  assert.equal(r.env.data.exempted, fixtures.length);
  assert.match(r.stdout, /8 synthetic lines exempted/);
});

// T-MG-72 fix round 1: regressions for the orchestrator decision and review findings.
test('fix1 .npmrc: registry-only configuration is clean; credentials are content findings', async (t) => {
  const d = repo(t);
  assert.equal(secretPatterns.isKeyFile('.npmrc'), false);
  put(d, '.npmrc', 'registry=https://registry.npmjs.org/\n');
  assert.equal((await scan(d)).status, 0);
  for (const [name, value] of [['_authToken', 'npm_' + 'a1B2'.repeat(9)], ['_auth', 'a1B2'.repeat(9)], ['_password', 'a1B2'.repeat(9)]]) { // SYNTH
    put(d, '.npmrc', `//registry.npmjs.org/:${name}=${value}\n`);
    const r = await scan(d);
    assert.equal(r.status, 1, show(r));
    assert.deepEqual(r.env.data.findings.map((f) => [f.where, f.type]), [['.npmrc:1', 'npm-token']]);
    noLeak(r, value);
    for (const placeholder of ['${NPM_TOKEN}', '<placeholder>', '************']) {
      put(d, '.npmrc', `//registry.npmjs.org/:${name}=${placeholder}\n`);
      assert.equal((await scan(d)).status, 0);
    }
  }
});

test('fix1 AR-1: files over the hard cap make tree and artifact scans incomplete, exit 1', async (t) => {
  const { secrets } = await lib('secrets/command.mjs');
  const { FILE_MAX } = await lib('secrets/scan.mjs');
  const d = repo(t);
  put(d, 'large.txt', '.'.repeat(1025));
  for (const flags of [{}, { artifact: 'large.txt' }]) {
    const r = secrets({ flags, names, io: { cwd: d, env: process.env }, fileMax: 1024 });
    assert.equal(r.code, 1);
    assert.equal(r.data.incomplete, true);
    assert.ok(r.errors.some((e) => e.code === 'scan-incomplete'));
    assert.deepEqual(r.data.skipped.map((f) => f.path), ['large.txt']);
    assert.doesNotMatch(r.text, /secrets: clean/);
    assert.match(r.text, /large\.txt/);
    const atCap = secrets({ flags, names, io: { cwd: d, env: process.env }, fileMax: 1025 });
    assert.equal(atCap.code ?? 0, 0);
    assert.equal(atCap.data.incomplete, false);
  }
  assert.equal(FILE_MAX, 64 * 1024 * 1024);
});

test('fix1 AR-2: JWT headers of 1500 characters are detected and redacted across windows', () => {
  const token = 'eyJ' + 'a'.repeat(1497) + '.eyJ' + 'b'.repeat(20) + '.sig'; // SYNTH
  for (const offset of [0, 99, 2046, 3500, 4090]) {
    const text = '.'.repeat(offset) + token + ' '.repeat(3000);
    assert.equal(secretPatterns.matchLine(text)?.id, 'jwt');
    assert.ok(!redactGate(text).includes(token));
  }
});

for (const operation of ['matchLine', 'redact']) {
  for (const [shape, unit, suffix, limit] of [['JWT', 'eyJ', '', 500], ['URL scheme', 'a'.repeat(4000) + '://', '', 300]]) {
    test(`fix1 F1: ${operation} scans 1 MiB of ${shape} within ${limit} ms`, () => {
      const input = unit.repeat(Math.ceil(1048576 / unit.length)).slice(0, 1048576) + suffix;
      const run = operation === 'matchLine' ? secretPatterns.matchLine : redactGate;
      const start = performance.now();
      const result = run(input);
      const elapsed = performance.now() - start;
      assert.equal(result, operation === 'matchLine' ? null : input);
      assert.ok(elapsed < limit, `${operation}/${shape}: ${elapsed.toFixed(1)} ms (limit ${limit})`);
    });
  }
}

test('fix1 AR-3: anchored project patterns run once on the first 64 KiB of the whole line', () => {
  const { patterns, errors } = secretPatterns.projectPatterns('^TOPSECRET-[0-9]+$');
  assert.deepEqual(errors, []);
  const token = 'TOPSECRET-' + '1'.repeat(4990); // SYNTH
  assert.equal(secretPatterns.matchLine(token, patterns)?.id, 'project:1');
  assert.equal(secretPatterns.matchLine('.' + token, patterns), null);
  const inputs = [];
  const probe = [{ id: 'probe', re: { exec: (line) => { inputs.push(line); return null; } } }];
  secretPatterns.matchLine('.'.repeat(70000), probe);
  assert.deepEqual(inputs.map((line) => line.length), [65536]);
  const tail = secretPatterns.projectPatterns('TAILSECRET$').patterns;
  assert.equal(secretPatterns.matchLine('.'.repeat(65536) + 'TAILSECRET', tail), null);
});

test('fix1 F2: exported patterns have stable repeated test results and no global state', () => {
  const p = secretPatterns.PATTERNS[0];
  assert.deepEqual([p.re.test(ghToken), p.re.test(ghToken)], [true, true]);
  assert.ok(secretPatterns.PATTERNS.every(({ re }) => !re.global));
});

test('fix1 F3: artificial window starts cannot create an openai-key match', () => {
  for (const offset of [99, 2046]) {
    const text = '.'.repeat(offset) + 'task-' + 'abcdefghijklmnopqrstuvwxyz' + ' '.repeat(3000); // SYNTH
    assert.equal(secretPatterns.matchLine(text), null);
    assert.equal(redactGate(text), text);
  }
});

test('fix1 F3: artificial window ends cannot satisfy a YAML end anchor', () => {
  const assignment = 'api_key: ' + 'a'.repeat(20); // SYNTH
  const text = '.'.repeat(4096 - assignment.length) + assignment + ' trailing text';
  assert.equal(secretPatterns.matchLine(text), null);
  assert.equal(secretPatterns.matchLine('.'.repeat(4096) + assignment)?.id, 'assigned-secret');
});


test('fix1 stream boundaries: tokens, true line anchors, markers and project prefixes survive chunks', async (t) => {
  const d = repo(t);
  const chunk = 1024 * 1024;
  put(d, 'crossing.txt', '.'.repeat(chunk - 12) + ghToken + '\napi_key: ' + 'a'.repeat(20)); // SYNTH
  put(d, `${names.stateDir}/secrets-patterns.txt`, '^TOPSECRET-[0-9]{4990}$\n');
  put(d, 'project.txt', 'TOPSECRET-' + '1'.repeat(4990)); // SYNTH
  put(d, 'tests/fixture.txt', ghToken + ' '.repeat(chunk - ghToken.length - 3) + 'SYNTH\n');
  put(d, 'tests/near.txt', ghToken + ' '.repeat(chunk - ghToken.length - 5) + 'SYNTHESIS\n');
  put(d, 'edge.txt', '.'.repeat(chunk - 2) + 'task-' + 'abcdefghijklmnopqrstuvwxyz' + ' '.repeat(3000)); // SYNTH
  const r = await scan(d);
  assert.deepEqual(where(r), ['crossing.txt:1', 'crossing.txt:2', 'project.txt:1', 'tests/near.txt:1']);
  assert.equal(r.env.data.exempted, 1);
  noLeak(r, ghToken);
});


test('fix1 .npmrc: short non-placeholder auth and password values are findings', () => {
  for (const name of ['_authToken', '_auth', '_password']) {
    assert.equal(secretPatterns.matchLine(`//registry.npmjs.org/:${name}=a1B2`)?.id, 'npm-token'); // SYNTH
  }
});
