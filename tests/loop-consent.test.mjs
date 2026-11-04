// Loop restart consent from a session (T-MG-149, SD-17, GC4, GC8, SEC-14): the UserPromptSubmit hook `prompt-consent`
// records a one-time consent when the human's own prompt has `<bin> loop start [--caps k=v,…]` as its first line;
// `loop start` without a terminal consumes it once (same repository, not expired, caps within the consented ones) to
// start a loop after an ended one or with a raised cap. Without a consent nothing changes (tests/loop.test.mjs).
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

isolateProcessEnv();

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
const { HOOKS, runHook } = await lib('hooks/registry.mjs');
const BIN = names.bin;
const LAUNCHER = join(pluginDir, 'bin', BIN);
const MIN = 60000;

const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
async function cli(args, { cwd, env, tty = false }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: tty, env, cwd, stdin: null };
  const code = await main([...args, '--json'], { io });
  return { code, out: JSON.parse(out.join('')), stderr: err.join('') };
}
const show = (r) => JSON.stringify(r.out ?? r);

async function repo(t, prefix = 'consent-') {
  const iso = isolatedEnv({ gitConfig: identity, prefix });
  t.after(iso.cleanup);
  const dir = join(iso.base, 'repo');
  mkdirSync(dir);
  git(dir, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, iso.env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  for (const k of [`${names.envPrefix}BILLING`, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete iso.env[k];
  const r = { cwd: dir, env: iso.env, base: iso.base, store: join(dir, names.stateDir) };
  r.projects = join(iso.env.CLAUDE_CONFIG_DIR, 'projects');
  r.sessions = join(r.projects, realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(r.sessions, { recursive: true });
  r.run = (args, opts = {}) => cli([...args, '--yes'], { ...r, ...opts });
  r.loopFile = join(r.store, 'local', 'loop.json');
  r.consentFile = join(r.store, 'local', 'loop-consent.json');
  r.consent = () => (existsSync(r.consentFile) ? JSON.parse(readFileSync(r.consentFile, 'utf8')) : null);
  // the session's own transcript, where Claude Code writes it: <config>/projects/<slug of the repository>/<session>.jsonl
  r.transcript = join(r.sessions, 'sess-1.jsonl');
  // as Claude Code: the hook runs on the submitted prompt, and the prompt is in the session transcript as a user message
  r.say = (line) => appendFileSync(r.transcript, `${JSON.stringify(line)}\n`);
  r.userLine = (content, ms = Date.now()) => ({ type: 'user', sessionId: 'sess-1', timestamp: new Date(ms).toISOString(), message: { role: 'user', content } });
  r.prompt = (prompt, extra = {}, { noTranscript = false, ...opts } = {}) => {
    const out = runHook('prompt-consent', JSON.stringify({ session_id: 'sess-1', transcript_path: r.transcript, cwd: dir, hook_event_name: 'UserPromptSubmit', prompt, ...extra }), { env: iso.env, ...opts });
    if (!noTranscript) r.say(r.userLine(prompt, opts.now));
    return out;
  };
  assert.equal((await r.run(['init'])).code, 0);
  return r;
}

// A repository whose loop ended (loop stop): a new start is the user's decision.
async function ended(t, prefix) {
  const p = await repo(t, prefix);
  assert.equal((await p.run(['loop', 'start'])).code, 0);
  assert.equal((await p.run(['loop', 'stop'])).out.data.stopped, true);
  const r = await p.run(['loop', 'start']);
  assert.equal(r.code, 7, `refused without a consent: ${show(r)}`);
  assert.equal(r.out.errors[0].code, 'user-decision');
  return p;
}

const contextOf = (r) => JSON.parse(r.stdout).hookSpecificOutput;

test('registry: prompt-consent runs on UserPromptSubmit and fails open', () => {
  const h = HOOKS.find((x) => x.name === 'prompt-consent');
  assert.ok(h, 'registered');
  assert.equal(h.event, 'UserPromptSubmit');
  assert.equal(h.onError, 'allow');
  const config = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(config.hooks.UserPromptSubmit?.some((e) => e.hooks.some((x) => x.args.at(-1) === 'prompt-consent')), 'hooks.json carries it');
});

test('acceptance 1: the human prompt records a consent; loop start without a terminal uses it once, then is refused again', async (t) => {
  const p = await ended(t, 'consent-a1-');
  const before = Date.now();
  const h = p.prompt(`  ${BIN} loop start  \nplease go on with the plan`);
  assert.equal(h.code ?? 0, 0, 'the prompt is allowed');
  const ctx = contextOf(h);
  assert.equal(ctx.hookEventName, 'UserPromptSubmit');
  assert.match(ctx.additionalContext, /consent .*recorded/i);
  assert.match(ctx.additionalContext, /default caps/);
  assert.ok(!ctx.additionalContext.includes('\n'), 'one line');
  const c = p.consent();
  assert.equal(c.repo, realpathSync(p.cwd));
  assert.equal(c.session, 'sess-1');
  assert.deepEqual(c.caps, {});
  assert.equal(c.usedAt, null);
  assert.ok(Date.parse(c.at) >= before - 1000 && Date.parse(c.at) <= Date.now());
  assert.equal(Date.parse(c.expiresAt) - Date.parse(c.at), 10 * MIN);
  let r = await p.run(['loop', 'start']);
  assert.equal(r.code, 0, `the consent starts the loop: ${show(r)}`);
  assert.equal(r.out.data.replaced.exit, 'DONE');
  assert.equal(r.out.data.consented, true, 'the start says it used the consent');
  assert.ok(p.consent().usedAt, 'consumed');
  assert.equal((await p.run(['loop', 'stop'])).out.data.stopped, true);
  r = await p.run(['loop', 'start']);
  assert.equal(r.code, 7, `a used consent is no consent: ${show(r)}`);
  assert.equal(r.out.errors[0].code, 'user-decision');
});

test('acceptance 1: a consent with caps allows exactly that raise; the loop counts the raised cap', async (t) => {
  const p = await ended(t, 'consent-a1c-');
  const ctx = contextOf(p.prompt(`${BIN} loop start --caps ticks=500,usd=40`));
  assert.match(ctx.additionalContext, /ticks=500/);
  assert.deepEqual(p.consent().caps, { ticks: 500, costMicroUsd: 40000000 });
  const r = await p.run(['loop', 'start', '--caps', 'ticks=500,usd=40']);
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.loop.caps.ticks, 500);
  const doc = JSON.parse(readFileSync(p.loopFile, 'utf8'));
  assert.deepEqual(doc.extensions.map((e) => e.caps), [{ ticks: 500, costMicroUsd: 40000000 }], 'the raise is recorded as the user\'s start');
});

test('acceptance 1: a raised cap on a fresh repository (no loop yet) also takes the consent', async (t) => {
  const p = await repo(t, 'consent-fresh-');
  let r = await p.run(['loop', 'start', '--caps', 'ticks=300']);
  assert.equal(r.code, 7, show(r));
  p.prompt(`${BIN} loop start --caps ticks=300`);
  r = await p.run(['loop', 'start', '--caps', 'ticks=300']);
  assert.equal(r.code, 0, show(r));
  assert.ok(p.consent().usedAt);
});

test('acceptance 2: an expired consent, one for another repository, or a cap above the consented one is refused with user-decision (exit 7) and stays unused', async (t) => {
  const p = await ended(t, 'consent-a2-');
  const refused = async (args, why) => {
    const r = await p.run(['loop', 'start', ...args]);
    assert.equal(r.code, 7, `${why}: ${show(r)}`);
    assert.equal(r.out.errors[0].code, 'user-decision', why);
    return r;
  };
  // expired: recorded 11 minutes ago
  p.prompt(`${BIN} loop start`, {}, { now: Date.now() - 11 * MIN });
  assert.ok(p.consent(), 'recorded');
  await refused([], 'expired');
  assert.equal(p.consent().usedAt, null, 'an expired consent is not consumed');
  // another repository: the consent of q never starts p's loop
  const q = await repo(t, 'consent-a2q-');
  q.prompt(`${BIN} loop start`);
  assert.ok(q.consent());
  await refused([], 'another repository');
  // a cap above the consented one
  p.prompt(`${BIN} loop start --caps ticks=300`);
  await refused(['--caps', 'ticks=500'], 'ticks 500 over the consented 300');
  await refused(['--caps', 'wallMin=600'], 'a raise the consent does not name');
  assert.equal(p.consent().usedAt, null, 'refusals leave the consent unused');
  // a consent that tightens a cap does not allow the default
  p.prompt(`${BIN} loop start --caps ticks=50`);
  await refused([], 'the default 200 ticks over the consented 50');
  // a record with a validity longer than the hook's 10 min (not written by the hook) is no consent
  const { CONSENT } = await lib('hooks/prompt-consent.mjs');
  const state = await lib('state/index.mjs');
  const store = state.open(p.store, { names, kinds: { ...state.KINDS, [CONSENT.name]: CONSENT } });
  const now = Date.now();
  store.write(CONSENT.name, null, { at: new Date(now - MIN).toISOString(), expiresAt: new Date(now + 24 * 60 * MIN).toISOString(), repo: realpathSync(p.cwd), session: 'sess-1', transcript: p.transcript, caps: {}, usedAt: null });
  await refused([], 'a validity over 10 minutes');
  p.prompt(`${BIN} loop start`);
  const r = await p.run(['loop', 'start'], { tty: false });
  assert.equal(r.code, 0, `the valid consent still works: ${show(r)}`);
  assert.equal(r.out.data.loop.caps.ticks, 200);
});

test('acceptance 3: the phrase anywhere but the whole first line, other forms and malformed input record nothing and allow', async (t) => {
  const p = await ended(t, 'consent-a3-');
  const nothing = [
    `please run ${BIN} loop start`,
    `"${BIN} loop start"`,
    `\`${BIN} loop start\``,
    `> ${BIN} loop start`,
    `! ${BIN} loop start`,
    `hello\n${BIN} loop start`,
    `\n${BIN} loop start`,
    `${BIN} loop start --yes`,
    `${BIN} loop start --caps speed=3`,
    `${BIN} loop start --caps`,
    `${BIN} loop startx`,
    `${BIN} loop start; rm -rf /`,
    `${BIN} loop stop`,
  ];
  for (const prompt of nothing) {
    const r = p.prompt(prompt);
    assert.equal(r.code ?? 0, 0, prompt);
    assert.equal(r.stdout, '', `no context for ${JSON.stringify(prompt)}`);
    assert.equal(p.consent(), null, `nothing recorded for ${JSON.stringify(prompt)}`);
  }
  // each malformed event differs from a valid one (ok, recorded at the end) in one field
  const ok = { prompt: `${BIN} loop start`, cwd: p.cwd, session_id: 's', hook_event_name: 'UserPromptSubmit', transcript_path: p.transcript };
  const without = (k) => { const o = { ...ok }; delete o[k]; return JSON.stringify(o); };
  const malformed = ['', 'not json', '[]', '42', JSON.stringify({ ...ok, prompt: 5 }), JSON.stringify({ ...ok, cwd: 'relative/dir' }),
    without('session_id'), JSON.stringify({ ...ok, session_id: '../x' }), JSON.stringify({ ...ok, hook_event_name: 'PreToolUse' }),
    // fix round 1: the event name is required, exactly (a hand-made event without it is no UserPromptSubmit)
    without('hook_event_name'), JSON.stringify({ ...ok, hook_event_name: 'userpromptsubmit' }),
    // fix round 2: the transcript path is required (an absolute .jsonl path): the start checks the prompt there
    without('transcript_path'), JSON.stringify({ ...ok, transcript_path: 't.jsonl' }), JSON.stringify({ ...ok, transcript_path: join(p.base, 't.txt') }),
    JSON.stringify({ ...ok, cwd: join(p.base, 'nowhere') })];
  for (const text of malformed) {
    const r = runHook('prompt-consent', text, { env: p.env });
    assert.equal(r.code ?? 0, 0, text);
    assert.equal(p.consent(), null, `nothing recorded for ${text}`);
  }
  // a repository that is not active: nothing recorded
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'consent-inactive-' });
  t.after(iso.cleanup);
  const bare = join(iso.base, 'repo');
  mkdirSync(bare);
  git(bare, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  runHook('prompt-consent', JSON.stringify({ ...ok, cwd: bare }), { env: iso.env });
  assert.ok(!existsSync(join(bare, names.stateDir)), 'an inactive repository gets no state');
  assert.equal((await p.run(['loop', 'start'])).code, 7, 'still refused');
  runHook('prompt-consent', JSON.stringify(ok), { env: p.env });
  assert.ok(p.consent(), 'the valid event the malformed ones differ from records');
});

test('fix round 2 (review r1 F2): a consent never grants the terminal-only billing override: subscription from the environment is ignored', async (t) => {
  const BILL = `${names.envPrefix}BILLING`;
  const p = await ended(t, 'consent-bill-');
  p.prompt(`${BIN} loop start`);
  const r = await p.run(['loop', 'start'], { env: { ...p.env, [BILL]: 'subscription' } });
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.consented, true);
  assert.notEqual(r.out.data.billing.mode, 'subscription', `the usd cap stays on: ${JSON.stringify(r.out.data.billing)}`);
  // the same override from a terminal counts (the case discriminates)
  assert.equal((await p.run(['loop', 'stop'])).code, 0);
  const tty = await p.run(['loop', 'start'], { tty: true, env: { ...p.env, [BILL]: 'subscription' } });
  assert.equal(tty.out.data.billing.mode, 'subscription', show(tty));
});

test('fix round 2: the consent is bound to the human channel: the session transcript must hold the prompt as a user message in the window', async (t) => {
  const p = await ended(t, 'consent-tx-');
  const refused = async (why) => {
    const r = await p.run(['loop', 'start']);
    assert.equal(r.code, 7, `${why}: ${show(r)}`);
    assert.equal(r.out.errors[0].code, 'user-decision', why);
    assert.equal(p.consent().usedAt, null, `${why}: the consent stays unused`);
    return r;
  };
  // no transcript file: fail closed, with the terminal named
  p.prompt(`${BIN} loop start`, {}, { noTranscript: true });
  const r = await refused('no transcript');
  assert.match(r.out.errors[0].message, /transcript/);
  assert.match(r.out.errors[0].hint, /terminal/);
  // the command only as an assistant message, a tool result, a meta line or a quote inside a user message
  p.say({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `${BIN} loop start` }] } });
  p.say(p.userLine([{ type: 'tool_result', tool_use_id: 'x', content: `${BIN} loop start` }]));
  p.say({ ...p.userLine(`${BIN} loop start`), isMeta: true });
  p.say(p.userLine(`please run\n${BIN} loop start`));
  await refused('not a user prompt');
  // a user prompt for other caps, and one from before the window
  p.say(p.userLine(`${BIN} loop start --caps ticks=300`));
  p.say(p.userLine(`${BIN} loop start`, Date.now() - 20 * MIN));
  await refused('other caps or too old');
  // the prompt followed by more than the 256 KB tail that is read
  p.say(p.userLine(`${BIN} loop start`));
  for (let i = 0; i < 300; i++) p.say(p.userLine(`filler ${i} ${'x'.repeat(1024)}`));
  await refused('outside the tail');
  // the prompt as text blocks in the tail: accepted
  p.say(p.userLine([{ type: 'text', text: `${BIN} loop start\nand keep going` }]));
  const ok = await p.run(['loop', 'start']);
  assert.equal(ok.code, 0, show(ok));
  assert.ok(p.consent().usedAt);
});

test('T-MG-154: the transcript the consent names must be the session\'s own (<config>/projects/<slug>/<session>.jsonl by real path); any other is refused (exit 7) and the consent stays unused', async (t) => {
  const p = await ended(t, 'consent-path-');
  const line = (file) => appendFileSync(file, `${JSON.stringify(p.userLine(`${BIN} loop start`))}\n`);
  const refusedWith = async (transcript, why) => {
    p.prompt(`${BIN} loop start`, { transcript_path: transcript }, { noTranscript: true });
    assert.equal(p.consent().transcript, transcript, `${why}: recorded as given`);
    line(transcript); // the prompt is there, so only the path decides
    const r = await p.run(['loop', 'start']);
    assert.equal(r.code, 7, `${why}: ${show(r)}`);
    assert.equal(r.out.errors[0].code, 'user-decision', why);
    assert.match(r.out.errors[0].message, /transcript/, why);
    assert.equal(p.consent().usedAt, null, `${why}: the consent stays unused`);
  };
  // outside the projects directory
  await refusedWith(join(p.base, 'elsewhere.jsonl'), 'outside the projects directory');
  // inside the projects directory, but another session's file, or the session's name under another project
  await refusedWith(join(p.sessions, 'sess-2.jsonl'), 'another session');
  const other = join(p.projects, '-somewhere-else'); mkdirSync(other);
  await refusedWith(join(other, 'sess-1.jsonl'), 'another project');
  // the derived name, a link to a file outside the projects directory
  const outside = join(p.base, 'linked.jsonl'); line(outside);
  symlinkSync(outside, p.transcript);
  await refusedWith(p.transcript, 'a link out of the projects directory');
  rmSync(p.transcript);
  // the session's own transcript: accepted (the cases above differ from it only in the path)
  p.prompt(`${BIN} loop start`);
  const ok = await p.run(['loop', 'start']);
  assert.equal(ok.code, 0, show(ok));
  assert.ok(p.consent().usedAt);
});

test('T-MG-154 fix round 1: a session started in a repository subdirectory restarts the loop: the slug comes from the session cwd the consent records; a cwd outside the repository, or none, is refused', async (t) => {
  const p = await ended(t, 'consent-sub-');
  const sub = join(p.cwd, 'src', 'app'); mkdirSync(sub, { recursive: true });
  const sessions = join(p.projects, realpathSync(sub).replace(/[^A-Za-z0-9]/g, '-')); mkdirSync(sessions);
  const transcript = join(sessions, 'sess-1.jsonl');
  const say = () => appendFileSync(transcript, `${JSON.stringify(p.userLine(`${BIN} loop start`))}\n`);
  const { CONSENT } = await lib('hooks/prompt-consent.mjs');
  const state = await lib('state/index.mjs');
  const store = state.open(p.store, { names, kinds: { ...state.KINDS, [CONSENT.name]: CONSENT } });
  const forge = (fields) => { const now = Date.now(); const doc = { at: new Date(now).toISOString(), expiresAt: new Date(now + 5 * MIN).toISOString(), repo: realpathSync(p.cwd), session: 'sess-1', transcript, caps: {}, usedAt: null, ...fields }; for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k]; store.write(CONSENT.name, null, doc); };
  const refused = async (why) => {
    const r = await p.run(['loop', 'start']);
    assert.equal(r.code, 7, `${why}: ${show(r)}`);
    assert.equal(r.out.errors[0].code, 'user-decision', why);
    assert.equal(p.consent().usedAt, null, `${why}: the consent stays unused`);
  };
  say();
  // the hook's record from the subdirectory session: accepted
  const h = runHook('prompt-consent', JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: sub, hook_event_name: 'UserPromptSubmit', prompt: `${BIN} loop start` }), { env: p.env });
  assert.equal(h.code ?? 0, 0);
  const r = await p.run(['loop', 'start']);
  assert.equal(r.code, 0, `restarted from the subdirectory session's consent: ${show(r)}`);
  assert.equal(p.consent().cwd, realpathSync(sub), 'the session cwd is recorded as its real path');
  assert.ok(p.consent().usedAt);
  assert.equal((await p.run(['loop', 'stop'])).out.data.stopped, true);
  // a record (not the hook's) naming a cwd outside the repository whose slug directory holds the transcript
  const away = join(p.base, 'away'); mkdirSync(away);
  const awaySessions = join(p.projects, realpathSync(away).replace(/[^A-Za-z0-9]/g, '-')); mkdirSync(awaySessions);
  appendFileSync(join(awaySessions, 'sess-1.jsonl'), `${JSON.stringify(p.userLine(`${BIN} loop start`))}\n`);
  forge({ cwd: away, transcript: join(awaySessions, 'sess-1.jsonl') });
  await refused('a cwd outside the repository');
  // a record without a cwd (written before fix round 1): fail closed
  forge({ cwd: undefined });
  await refused('no cwd');
  // the subdirectory's slug, but the record names the repository root as the cwd
  forge({ cwd: realpathSync(p.cwd) });
  await refused('the transcript is not under the slug of the recorded cwd');
});

test('SEC-14: the model cannot write the consent through Bash (the guard blocks the state directory)', async (t) => {
  const p = await repo(t, 'consent-sec-');
  const cmd = `echo '{"schema":1}' > ${join(names.stateDir, 'local', 'loop-consent.json')}`;
  const r = runHook('guard-bash', JSON.stringify({ session_id: 's', cwd: p.cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } }), { env: { ...p.env, CLAUDE_PROJECT_DIR: p.cwd } });
  assert.ok(r.code === 2 || /"permissionDecision":"deny"/.test(r.stdout), `blocked: ${JSON.stringify(r)}`);
  assert.equal(p.consent(), null);
});

test('race: two loop starts on one consent: exactly one starts a loop', async (t) => {
  const p = await ended(t, 'consent-race-');
  p.prompt(`${BIN} loop start`);
  const start = () => new Promise((done) => {
    const c = spawn(process.execPath, [LAUNCHER, 'loop', 'start', '--yes', '--json'], { cwd: p.cwd, env: p.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => done({ code, out }));
  });
  const results = await Promise.all([start(), start()]);
  const codes = results.map((r) => r.code).sort();
  assert.equal(codes.filter((c) => c === 0).length, 1, `exactly one start: ${JSON.stringify(results)}`);
  assert.ok([1, 7].includes(codes[1]), `the other is refused: ${JSON.stringify(results)}`);
  assert.equal(JSON.parse(readFileSync(p.loopFile, 'utf8')).exit, null, 'one running loop');
});

test('acceptance 5: the hook takes < 50 ms of CPU for a 100 KB prompt', async (t) => {
  const p = await repo(t, 'consent-perf-');
  const body = 'x'.repeat(100 * 1024);
  const cases = { match: `${BIN} loop start\n${body}`, longFirstLine: `${BIN} loop start --caps ${body}`, other: body };
  p.prompt(cases.match); // warm the file cache and the git binary
  for (const [name, prompt] of Object.entries(cases)) {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const c0 = process.cpuUsage();
      p.prompt(prompt);
      const c = process.cpuUsage(c0);
      samples.push((c.user + c.system) / 1000);
    }
    samples.sort((a, b) => a - b);
    assert.ok(samples[1] < 50, `${name}: median ${samples[1].toFixed(1)} ms of CPU`);
  }
});
