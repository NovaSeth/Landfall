// Differential test of `secrets` against the 1.x scanner (spec §8.2: the successor of check-secrets.sh). The v1.5.1
// check-secrets.sh is read from git history (`git show v1.5.1:…`, so the clone needs that tag: CI checks out with
// fetch-depth 0) into a scratch directory and run on the same repositories as `secrets`. The corpora are every
// repository and scan of the v1.5.1 tests/secrets.test.mjs (its pre-push cases as the ranges the hook scans), and
// further cases for each built-in pattern with near misses, CRLF and multibyte text, merges, renames, binary, lock,
// ignored and deleted files, project patterns, an unborn branch and scans that cannot run.
// Verdicts: clean (exit 0), findings (1), invalid (1.x 2; now 8, or 2 for a usage error). For findings the reported
// locations must match too: path:line, commit:path:line in a range, the key files when 1.x reports them (it then
// stops before the line hits). Every difference must be on the allowlist below with its reason, and every allowlist
// entry must still occur, so the list stays exact.
// Every synthetic value is assembled at run time; its source line carries the SYNTH marker (SEC-11).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateProcessEnv } from './helpers/isolated-env.mjs';

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
const { main } = await import(pathToFileURL(join(pluginDir, 'lib', 'cli', 'main.mjs')).href);

const OLD_REF = 'v1.5.1:kit/.workflow/bin/check-secrets.sh';
const OLD_PATTERNS = '.workflow/secrets-patterns.txt'; // where 1.x reads project patterns

// Differences between the two scanners on these corpora, each with its reason: `${case} | ${scan}`.
const ALLOWED = new Map([
  ['path-quoting | --staged', 'a path with a tab is C-quoted in diff headers; 1.x printed it with the quotes stripped and the escape kept (a\\tb.ts), the successor unquotes it to the real name, as git grep printed it in the tree mode'],
  ['path-quoting | --range HEAD~1..HEAD', 'the same unquoting of a quoted diff path in a range'],
]);

// Synthetic values (SYNTH): alphanumeric runs of a given length, and the token shapes of the built-in patterns.
const run = (n, alphabet = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z') => Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join(''); // SYNTH
const UP = 'AB3DE5GH7JK9MN1PQ2RS4TU6VW8XY0Z'; // SYNTH
const ghToken = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'; // SYNTH
const val = 'Zx81' + 'Qw7Er6Ty5Ui4Op3'; // SYNTH
const pw = 'correct' + '-horse!battery@staple'; // SYNTH
const E = 'é'; // a two-byte character in UTF-8

let OLD; // the 1.x script in a scratch directory
test.before(() => {
  const r = spawnSync('git', ['-C', root, 'show', OLD_REF], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, `cannot read ${OLD_REF}: ${r.stderr.trim()} (fetch the release tags: git fetch --tags)`);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'secrets-1x-')));
  OLD = join(dir, 'check-secrets.sh');
  writeFileSync(OLD, r.stdout);
});
test.after(() => { if (OLD) rmSync(dirname(OLD), { recursive: true, force: true }); });

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
  const d = scratch(t, 'secrets-diff-');
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

const verdict = (code) => (code === 0 ? 'clean' : code === 1 ? 'findings' : 'invalid');
function oldScan(cwd, args) {
  const r = spawnSync('bash', [OLD, ...args], { cwd, encoding: 'utf8', env: process.env, timeout: 60000 });
  const lines = [...new Set(r.stdout.split('\n').filter(Boolean))].sort();
  const keys = lines.filter((l) => !/:\d+$/.test(l));
  return { verdict: r.status === 2 ? 'invalid' : verdict(r.status), keys, hits: keys.length ? null : lines, raw: `exit ${r.status}\n${r.stdout}${r.stderr}` };
}
async function newScan(cwd, args) {
  const mode = args[0] === '--range' ? ['--range', args.slice(1).join(' ')] : args;
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {}, stdinIsTTY: false, env: process.env, cwd, stdin: null };
  const code = await main(['secrets', ...mode, '--json'], { io });
  const env = JSON.parse(out.join(''));
  const findings = env.data.findings ?? [];
  const keys = findings.filter((f) => f.type === 'key-file').map((f) => f.where).sort();
  const hits = findings.filter((f) => f.type !== 'key-file').map((f) => f.where).sort();
  return { verdict: verdict(code), code, keys, hits, raw: `exit ${code}\n${out.join('')}` };
}

// Runs one scan with both scanners; a difference is recorded (and checked against the allowlist at the end).
function differ(t, name) {
  const seen = [];
  t.after(() => {
    for (const d of seen) assert.ok(ALLOWED.has(d.key), `${d.key}: the scanners differ and the difference is not allowlisted\n1.x: ${d.old.raw}\nnow: ${d.now.raw}`);
  });
  const check = async (cwd, args = []) => {
    const old = oldScan(cwd, args);
    const now = await newScan(cwd, args);
    const key = `${name} | ${args.join(' ') || '(tree)'}`;
    const same = old.verdict === now.verdict && (old.verdict !== 'findings' || (old.hits === null ? old.keys.join('\n') === now.keys.join('\n') : old.hits.join('\n') === now.hits.join('\n')));
    if (!same) seen.push({ key, old, now });
    if (now.verdict === 'invalid') assert.ok(now.code === 8 || now.code === 2, `${key}: invalid is 8 (or 2 for usage), never 0\n${now.raw}`);
    return { old, now };
  };
  check.seen = seen;
  return check;
}
const allowedSeen = new Set();
const record = (check) => { for (const d of check.seen) allowedSeen.add(d.key); };

test('1.x corpus: path:line output, env files, the patterns of the 1.x tests and the SYNTH marker', async (t) => {
  const check = differ(t, 'v1.5.1 tests');
  let d = repo(t);
  commit(d, 'a.env.ts', `API_KEY="${'abcdefghijk' + 'lmnopqrstuv'}"\n`); // SYNTH
  commit(d, 'http.ts', `fetch(u, { headers: { Authorization: 'Bearer ${ghToken}' } });\n`);
  commit(d, 'docs/keys.md', `| key | value |\n|---|---|\n| key | ${ghToken} |\n`);
  await check(d);

  d = repo(t);
  commit(d, 'apps/web/.env.example', 'API_URL=\n');
  await check(d);
  commit(d, 'apps/web/.env', 'PORT=3000\n');
  await check(d);
  commit(d, 'apps/web/.env', null);
  commit(d, 'services/api/.env.production', 'PORT=3000\n');
  await check(d);

  for (const [file, content] of [['config.yml', `apiKey: "${val}"\n`], ['config.json', `{"apiKey": "${val}"}\n`], ['compose.yml', `  DB_PASSWORD: "${val}"\n`], ['client.ts', `const clientSecret = '${val}';\n`],
    ['config/a.yml', `db:\n  password: "${pw}"\n`], ['config/b.yml', `service:\n  api_key: ${val}abcd\n`], ['config/c.yml', `db:\n  password: "correct.${pw}"\n`],
    ['config/d.yml', `service:\n  api_key: ${val}abcd # production\n`], ['config/e.yml', `db:\n  password: "correct:${pw}"\n`],
    ['package-lock.json', `{"resolved": "https://registry.example.com/x.tgz", "auth": "${ghToken}"}\n`]]) {
    d = repo(t);
    commit(d, file, content);
    const { now } = await check(d);
    assert.equal(now.verdict, 'findings', file);
  }
  d = repo(t);
  commit(d, 'ok.ts', ['const cfg = { apiKey: process.env.X, password: "" };', 'apiKey: process.env.API_KEY', 'password: ""', 'DB_PASSWORD: ${DB_PASSWORD}',
    'const tokenizer = "bert-base-uncased-model";', 'Authorization: Bearer <token>'].join('\n') + '\n');
  commit(d, 'config/ok.yml', ['password: "${DB_PASSWORD}"', 'api_key: "<your-api-key>"', 'secret: "****************"', 'token: "https://auth.example.com/oauth/token"',
    "token: 'user:alice/co-a'", 'password: "https://user@host.example.com/x"', 'apiKey: process.env.API_KEY', 'password: ""', 'token_url: https://example.com/a/b/c'].join('\n') + '\n');
  assert.equal((await check(d)).now.verdict, 'clean');

  d = repo(t);
  commit(d, 'tests/SYNTH-fixtures/a.ts', `const t = "${ghToken}";\n`);
  await check(d);
  commit(d, 'tests/SYNTH-fixtures/a.ts', `const t = "${ghToken}"; // SYNTH\n`);
  commit(d, 'tests/b.ts', `const t = "${ghToken}"; // check-secrets: synthetic\n`);
  await check(d);
  record(check);
});

test('1.x corpus: the index and the working tree, --staged, --range, project patterns', async (t) => {
  const check = differ(t, 'v1.5.1 modes');
  let d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  put(d, 'a.ts', `const t = "${ghToken}";\n`);
  git(d, 'add', 'a.ts');
  put(d, 'a.ts', 'ok\n');
  await check(d);
  git(d, 'add', 'a.ts');
  put(d, 'new.ts', `const t = "${ghToken}";\n`);
  await check(d);
  writeFileSync(join(d, '.gitignore'), 'new.ts\n');
  await check(d);

  d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  put(d, 'a.ts', `ok\nconst t = "${ghToken}";\n`);
  git(d, 'add', 'a.ts');
  await check(d, ['--staged']);
  git(d, 'commit', '-qm', 'secret');
  commit(d, 'a.ts', 'ok\n');
  await check(d);
  await check(d, ['--staged']);
  await check(d, ['--range', 'HEAD~2..HEAD']);
  await check(d, ['--range', 'HEAD~1..HEAD']);
  await check(d, ['--range', 'no-such-revision']);

  d = repo(t);
  const line = 'zz_[A-Za-z0-9]{20,}\n';
  put(d, `${names.stateDir}/secrets-patterns.txt`, line);
  commit(d, OLD_PATTERNS, line);
  put(d, 'src.txt', `x = ${'zz_' + 'A1b2C3d4E5f6G7h8I9j0K1'}\n`); // SYNTH
  git(d, 'add', '-A');
  await check(d, ['--staged']);
  git(d, 'commit', '-qm', 'token');
  await check(d, ['--range', 'HEAD~1..HEAD']);
  await check(d);
  record(check);
});

test('1.x corpus: the ranges the pre-push hook scans (a secret added and removed, fixed only on disk, a new branch)', async (t) => {
  const check = differ(t, 'v1.5.1 pre-push');
  const remote = scratch(t, 'secrets-diff-remote-');
  git(remote, 'init', '-q', '--bare');
  const d = repo(t);
  git(d, 'remote', 'add', 'origin', remote);
  commit(d, 'src/a.ts', 'export const x = 1;\n');
  git(d, 'push', '-q', 'origin', 'main');
  const pushed = () => git(d, 'rev-parse', 'origin/main');
  commit(d, 'src/b.ts', `const t = "${ghToken}";\n`);
  commit(d, 'src/b.ts', null);
  await check(d, ['--range', `${pushed()}..HEAD`]);
  git(d, 'reset', '-q', '--hard', 'origin/main');
  commit(d, 'src/c.ts', 'export const y = 2;\n');
  await check(d, ['--range', `${pushed()}..HEAD`]);
  commit(d, 'src/b.ts', `const t = "${ghToken}";\n`);
  put(d, 'src/b.ts', 'ok\n');
  await check(d, ['--range', `${pushed()}..HEAD`]);
  git(d, 'checkout', '-q', '--', 'src/b.ts');
  git(d, 'reset', '-q', '--hard', 'origin/main');
  git(d, 'checkout', '-qb', 'feat');
  commit(d, 'apps/web/.env', 'PORT=1\n');
  await check(d, ['--range', git(d, 'rev-parse', 'HEAD'), '--not', '--remotes']);
  git(d, 'reset', '-q', '--hard', 'main');
  commit(d, 'src/d.ts', 'export const z = 3;\n');
  await check(d, ['--range', git(d, 'rev-parse', 'HEAD'), '--not', '--remotes']);
  record(check);
});

// One line per case: the positives and the near misses of every built-in pattern. The reported lines of both scanners
// are compared, so each line gets its own verdict; in a tree, staged and in a range.
const POSITIVE = [
  `a = "${'gh' + 'o_' + run(30)}"`, `a = ${'gh' + 'u_' + run(40)}`, `${'gh' + 's_' + run(36)}`, `${'gh' + 'r_' + run(31)}`, // SYNTH
  `t: ${'github' + '_pat_' + run(40, 'aB3_dE5')}`, // SYNTH
  `k=${'sk' + '-' + run(20)}`, `"${'sk' + '-' + run(48)}"`, `${'sk' + '-ant-' + run(24)}`, // SYNTH
  `id ${'AK' + 'IA' + run(16, UP)}`, `slack ${'xo' + 'xb-' + run(10)}`, `slack ${'xo' + 'xp-' + run(24, 'a1-B2')}`, `g ${'AI' + 'za' + run(35, 'aB3_-')}`, // SYNTH
  '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----', // SYNTH
  `Authorization: Bearer ${run(20, 'aB3.~+/-')}`, `auth: bearer\t${run(24)}`, `${'ey' + 'J' + run(10)}.${'ey' + 'J' + run(12)}.sig`, // SYNTH
  `api_key = "${run(12)}"`, `apiKey: '${run(16)}'`, `"client_secret": "${run(20)}"`, `PRIVATE_KEY := "${run(14)}"`, `token => "${run(13)}"`, `Api-Key="${run(15)}"`, // SYNTH
  `passwd: "ab:cd!${run(4)}"`, `password = "x!y:${run(5)}"`, `PASSWORD: "${run(6)}!:${run(3)}"`, // SYNTH
  `api_key: ${run(16, 'aB3_/+=-')}`, `secret_key: ${run(20)}   # rotated`, `privateKey:  ${run(18)}`, // SYNTH
  `GET /x?token=${run(8)}`, `u?a=1&api_key=${run(9)}`, `x?access_token=${run(12)}`, `x&apikey=${run(10)}`, // SYNTH
  `FOO_API_KEY=${run(12)}`, `MY_SECRET="${run(16)}"`, `export GH_TOKEN='${run(12, 'aB3/+=')}'`, `DB_PASSWORD_PROD=${run(13)}`, // SYNTH
  `password: "${E.repeat(6)}"`, `token: "${run(6)}${E.repeat(3)}"`, // SYNTH
];
const NEGATIVE = [
  `a = "${'gh' + 'o_' + run(29)}"`, `${'gh' + 'x_' + run(36)}`, `t: ${'github' + '_pat_' + run(39)}`, `k=${'sk' + '-' + run(19)}`, `task-${run(24)}`, `ask-${run(24)}`, // SYNTH
  `${'AK' + 'IA' + run(15, UP)}`, `${'AK' + 'IA' + run(16)}`, `${'xo' + 'xb-' + run(9)}`, `${'xo' + 'xz-' + run(12)}`, `${'AI' + 'za' + run(34)}`, // SYNTH
  '-----BEGIN PUBLIC KEY-----', '-----BEGIN CERTIFICATE-----', `Authorization: Bearer ${run(19)}`, 'Authorization: Bearer <token>', `${'ey' + 'J' + run(9)}.${'ey' + 'J' + run(12)}`, // SYNTH
  `api_key = "${run(11)}"`, 'api_key = "${API_KEY}"', `apiKey: "<${run(14)}>"`, 'password: "*************"', `token: "${run(8)}:${run(8)}"`, 'secret = "https://example.com/a:b"', // SYNTH
  `api_key: ${run(15)}`, `api_key: ${run(16)} trailing`, `api_key ${run(20)}`, `GET /x?token=${run(7)}`, `x?tokens=${run(12)}`, // SYNTH
  `FOO_API_KEY=${run(11)}`, `foo_api_key=${run(16)}`, `XAPI_KEYS ${run(16)}`, `password: "${E.repeat(5)}"`, // SYNTH
];

test('pattern corpus: every built-in pattern with near misses, in the tree, staged and in a range', async (t) => {
  const check = differ(t, 'patterns');
  const d = repo(t);
  commit(d, 'README.md', 'patterns\n');
  put(d, 'pos.txt', `${POSITIVE.join('\n')}\n`);
  put(d, 'neg.txt', `${NEGATIVE.join('\n')}\n`);
  let r = await check(d);
  assert.equal(r.now.hits.length, POSITIVE.length, `every positive line is a finding:\n${r.now.raw}`);
  assert.ok(r.now.hits.every((h) => h.startsWith('pos.txt:')), `no near miss is a finding:\n${r.now.raw}`);
  git(d, 'add', '-A');
  await check(d, ['--staged']);
  git(d, 'commit', '-qm', 'patterns');
  r = await check(d, ['--range', 'HEAD~1..HEAD']);
  assert.equal(r.now.hits.length, POSITIVE.length);
  record(check);
});

test('edge corpus: CRLF, other spaces, merges, renames, binary, lock, ignored and deleted files, odd paths, an unborn branch, failures', async (t) => {
  const check = differ(t, 'edges');
  let d = repo(t);
  commit(d, 'crlf.yml', `api_key: ${run(16)}\r\nsecret: ${run(20)} # note\r\nok: 1\r\n`);
  commit(d, 'spaces.txt', `Authorization: Bearer\v${run(20)}\npassword\f=\f"${run(12)}"\n`);
  await check(d);
  await check(d, ['--range', 'HEAD~2..HEAD']);

  d = repo(t);
  commit(d, 'a.ts', 'base\n');
  git(d, 'checkout', '-qb', 'side');
  commit(d, 'a.ts', 'side\n');
  git(d, 'checkout', '-q', 'main');
  commit(d, 'a.ts', 'main\n');
  spawnSync('git', ['-C', d, 'merge', '-q', 'side'], { env: process.env });
  put(d, 'a.ts', `const t = "${ghToken}";\n`);
  git(d, 'add', 'a.ts');
  git(d, 'commit', '-qm', 'merge with a key in the resolution');
  await check(d, ['--range', 'HEAD~1..HEAD']);
  await check(d, ['--range', 'side..HEAD']);
  git(d, 'checkout', '-qb', 'clean-merge', 'HEAD~1');
  git(d, 'checkout', '-qb', 'other', 'HEAD~1');
  commit(d, 'b.ts', 'other\n');
  git(d, 'checkout', '-q', 'clean-merge');
  git(d, 'merge', '-q', '--no-edit', 'other');
  await check(d, ['--range', 'HEAD~1..HEAD']);

  d = repo(t);
  commit(d, 'keep.ts', `const t = "${ghToken}";\n`);
  git(d, 'mv', 'keep.ts', 'moved.ts');
  git(d, 'commit', '-qm', 'rename');
  await check(d, ['--range', 'HEAD~1..HEAD']);
  git(d, 'mv', 'moved.ts', 'again.ts');
  put(d, 'again.ts', `const t = "${ghToken}";\nconst u = "${val}";\nexport const ${'apiKey'} = "${val}";\n`);
  git(d, 'add', '-A');
  await check(d, ['--staged']);
  git(d, 'commit', '-qm', 'rename and change');
  await check(d, ['--range', 'HEAD~1..HEAD']);
  commit(d, 'cert.pem', 'x\n');
  git(d, 'mv', 'cert.pem', 'renamed.pem');
  git(d, 'commit', '-qm', 'rename a key file');
  await check(d, ['--range', 'HEAD~1..HEAD']);
  await check(d, ['--range', 'HEAD~2..HEAD']);

  d = repo(t);
  commit(d, 'blob.bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`\n${ghToken}\n`)]));
  commit(d, 'bun.lockb', `${ghToken}\n`);
  commit(d, '.gitignore', 'secret.local\n');
  put(d, 'secret.local', `${ghToken}\n`);
  await check(d);
  await check(d, ['--range', 'HEAD~3..HEAD']);
  put(d, 'bun.lockb', `${ghToken}\nmore ${ghToken}\n`);
  git(d, 'add', '-A');
  await check(d, ['--staged']);

  d = repo(t);
  commit(d, 'gone.ts', `const t = "${ghToken}";\n`);
  rmSync(join(d, 'gone.ts'));
  await check(d);
  commit(d, 'deep/er/file.ts', 'x\n');
  put(d, 'deep/er/file.ts', `x\nconst t = "${ghToken}";\n`);
  git(d, 'add', '-A');
  put(d, 'deep/er/file.ts', 'x\n');
  await check(d);
  await check(d, ['--staged']);

  d = repo(t);
  commit(d, 'dir with space/café.ts', `const t = "${ghToken}";\n`);
  await check(d);
  await check(d, ['--range', 'HEAD~1..HEAD']);

  d = repo(t);
  put(d, 'a.ts', `const t = "${ghToken}";\n`);
  git(d, 'add', '-A');
  await check(d);
  await check(d, ['--staged']);
  await check(d, ['--range', 'HEAD']);

  d = repo(t);
  commit(d, OLD_PATTERNS, '  my_[a-z]{12,}   # our tokens\r\n# a comment\r\n\r\n');
  put(d, `${names.stateDir}/secrets-patterns.txt`, readFileSync(join(d, OLD_PATTERNS)));
  put(d, 'a.txt', `x ${'my_' + run(12, 'abcdefg')}\n`); // SYNTH
  await check(d);

  await check(scratch(t, 'secrets-diff-outside-'));
  d = repo(t);
  commit(d, 'a.ts', 'ok\n');
  await check(d, ['--range']);
  await check(d, ['--bogus']);
  record(check);
});

test('path corpus: a quoted diff path (the allowlisted difference)', async (t) => {
  const check = differ(t, 'path-quoting');
  const d = repo(t);
  commit(d, 'README.md', 'x\n');
  put(d, 'a\tb.ts', `const t = "${ghToken}";\n`);
  await check(d);
  git(d, 'add', '-A');
  await check(d, ['--staged']);
  git(d, 'commit', '-qm', 'tab');
  await check(d, ['--range', 'HEAD~1..HEAD']);
  record(check);
});

test('the allowlist is exact: every allowed difference still occurs', () => {
  assert.deepEqual([...allowedSeen].sort(), [...ALLOWED.keys()].sort());
});
