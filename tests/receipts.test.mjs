// Receipts (spec §7.11, §5.1, §6.1 P3, SD-23, SC16 receipt part, ruling R70): tokens and estimated cost of a task from
// the Claude Code transcripts of the repository (main sessions and subagents) and its external run records; money in
// integer micro-dollars (costMicroUsd), durations in integer milliseconds; `receipt --task` saves receipts/<task>.json
// through lib/state in an active repository and writes nothing in an inactive one.
// Fixtures (tests/fixtures/receipts, synthetic, Claude Code 2.1.300 line shapes, no real content; {{bin}} and {{plugin}}
// are filled from lib/name.json when they are copied, so no file holds the codename, SD-30):
//   repo/<S1>.jsonl      main session: req_01 (task new, no ID) · req_02 (task set T-TU-1: the switch comes after it)
//                        · req_03 (T-TU-1, 3 lines, output 2 → 2 → 80, spawns toolu_A) · req_04 (T-TU-1, spawns toolu_B
//                        named codex-reviewer-T-TU-1) · req_05 (T-TU-1, runs `<bin> verify T-TU-2`) · req_06 (T-TU-2,
//                        `git log --grep T-TU-1` is no switch, spawns toolu_C) · msg_07 (T-TU-2, no requestId,
//                        `<bin> task list` is no switch) · a <synthetic> line (no API request)
//   repo/<S1>/subagents  a1 <plugin>:implementer "Implement T-TU-1 parser" (sonnet; runs `<bin> brief T-TU-2`, which moves
//                        nothing) · a3 nested in a1 "Search helpers" (haiku, prompt over 100k tokens) · a2 <plugin>:external
//                        "Review via codex" (haiku; the task ID is only in the Agent name) · a4 "Explore the repository
//                        layout" (haiku; no ID anywhere: unattributed although T-TU-2 was active)
//   repo/<S2>.jsonl      resumed session: copies of req_02 and req_03 (same requestIds), then req_08 (T-TU-1)
//   worktree/<S3>.jsonl  session in a linked worktree: req_10 (task set T-TU-2) · req_09 (T-TU-2)
//   runs/*.json          codex-T-TU-1-reviewer-1 (tokens, 50,000 µ$, elapsedMs 94,500 within a 95 s span) · codex-T-TU-1-reviewer-2 (tokens null, reason)
//                        · codex-T-TU-2-implementer-1 (tokens null, no reason)
// Hand-computed totals (prices of lib/receipts/prices.json, USD per million tokens; µ$ = 1e-6 USD):
//   Opus 5.5 (in 4, 5m write 5, 1h write 8, read 0.20, out 20), main writes are 1h:
//     req_03  4·4 +  80·20 + 1200·0.2 + 300·8 = 4256    req_04  3·4 + 60·20 + 1500·0.2 + 100·8 = 2312
//     req_05  2·4 +  40·20 + 1600·0.2 +  50·8 = 1528    req_08  7·4 + 70·20 + 2000·0.2         = 1828   → 9924 µ$
//   Sonnet 5.5 (in 2, 5m write 2.5, read 0.10, out 10):
//     req_s1  6·2 + 500·10 + 4000·2.5            = 15012   req_s2  4·2 + 700·10 + 4000·0.1 + 800·2.5 = 9408 → 24420 µ$
//   Haiku 5.5, prompt ≤ 100k (in 0.10, 5m write 0.125, read 0.01, out 0.50); > 100k (0.50, 0.625, 0.05, 2.50):
//     req_n1 (151,100-token prompt) 100·0.5 + 200·2.5 + 150000·0.05 + 1000·0.625 = 8675
//     req_w1  50·0.1 + 100·0.5 + 2000·0.125 = 305                                                       → 8980 µ$
//   T-TU-1: 9924 + 24420 + 8980 = 43324 µ$ of Claude + 50000 µ$ external = 93324 µ$ ($0.093324)
//     tokens: input 16+10+150+12000 = 12176 · output 250+1200+300+3000 = 4750
//             cache read 6300+4000+150000+8000 = 168300 · cache write 450+4800+3000 = 8250
//   T-TU-2: req_06 2·4 + 30·20 + 1700·0.2 + 40·8 = 1268 · msg_07 1·4 + 20·20 + 1800·0.2 = 764
//           · req_09 1·4 + 10·20 + 100·0.2 = 224 → 2256 µ$; tokens input 4 · output 60 · cache read 3600 · write 40
// This file holds no plugin name or path: both come from lib/name.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, isolateProcessEnv } from './helpers/isolated-env.mjs';

// Every child of this file (git run by the code under test too) gets a throwaway HOME and environment (S1).
isolateProcessEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(root, 'tests', 'fixtures', 'receipts');
const pluginDir = (() => {
  const plugins = join(root, 'plugins');
  const hits = readdirSync(plugins).filter((d) => existsSync(join(plugins, d, 'lib', 'name.json')));
  assert.equal(hits.length, 1, 'exactly one plugins/*/lib/name.json');
  return join(plugins, hits[0]);
})();
const names = JSON.parse(readFileSync(join(pluginDir, 'lib', 'name.json'), 'utf8'));
const lib = (rel) => import(pathToFileURL(join(pluginDir, 'lib', rel)).href);
const { main } = await lib('cli/main.mjs');

const S1 = '5e551011-0000-4000-8000-000000000001';
const T1 = { input: 12176, output: 4750, cacheRead: 168300, cacheWrite: 8250 };
const T1_COST = 93324; // micro-dollars
const T2 = { input: 4, output: 60, cacheRead: 3600, cacheWrite: 40 };
const T2_COST = 2256;

const identity = '[user]\n\tname = Test User\n\temail = test@example.com\n';
// The rule observed on disk (spec §6.1 P3): every character outside A-Z, a-z, 0-9 becomes '-'.
const slugOf = (path) => path.replace(/[^A-Za-z0-9]/g, '-');

const git = (cwd, env, args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

async function cli(args, { cwd, env, json = true }) {
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdinIsTTY: false, env, cwd, stdin: null };
  const code = await main(json ? [...args, '--json'] : args, { io });
  const stdout = out.join('');
  return { code, out: json ? JSON.parse(stdout) : stdout, stderr: err.join('') };
}
const show = (r) => JSON.stringify(r.out ?? r);

// Copies a fixture tree with {{bin}} and {{plugin}} filled in.
function place(from, to) {
  for (const f of readdirSync(from, { recursive: true })) {
    const src = join(from, f);
    if (statSync(src).isDirectory()) continue;
    mkdirSync(dirname(join(to, f)), { recursive: true });
    writeFileSync(join(to, f), readFileSync(src, 'utf8').replaceAll('{{bin}}', names.bin).replaceAll('{{plugin}}', names.plugin));
  }
}

// An active repository with tasks T-TU-1 and T-TU-2, a linked worktree, the fixture transcripts under the
// throwaway CLAUDE_CONFIG_DIR and the fixture run records.
async function project(t, { transcripts = true } = {}) {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'receipts-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  git(repo, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, iso.env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  const r = { repo, cwd: repo, env: iso.env, store: join(repo, names.stateDir) };
  for (const args of [['init'], ['task', 'new', 'Receipts parser'], ['task', 'new', 'Second task']]) {
    const res = await cli([...args, '--yes'], r);
    assert.equal(res.code, 0, show(res));
  }
  const wt = join(iso.base, 'repo-wt');
  git(repo, iso.env, ['worktree', 'add', '-q', '-b', 'wt', wt]);
  r.projects = join(iso.env.CLAUDE_CONFIG_DIR, 'projects');
  r.main = join(r.projects, slugOf(realpathSync(repo)));
  r.wt = join(r.projects, slugOf(realpathSync(wt)));
  if (transcripts) {
    place(join(FIXTURES, 'repo'), r.main);
    place(join(FIXTURES, 'worktree'), r.wt);
  }
  r.runs = join(r.store, 'local', 'runs');
  place(join(FIXTURES, 'runs'), r.runs);
  r.receipt = (args, opts = {}) => cli(['receipt', ...args, '--yes'], { ...r, ...opts });
  return r;
}

const agentRow = (receipt, agentType, model) => receipt.byAgent.find((a) => a.agentType === agentType && a.model === model);

test('receipt --task: tokens and cost equal the hand-computed totals (acceptance ±1%; sessions, subagents, external runs)', async (t) => {
  const p = await project(t);
  const r = await p.receipt(['--task', 'T-TU-1']);
  assert.equal(r.code, 0, show(r));
  const rc = r.out.data.receipt;
  assert.deepEqual(rc.tokens, T1, 'token counts are exact');
  assert.equal(rc.costMicroUsd, T1_COST, 'T-TU-1 cost in micro-dollars, exactly');
  assert.equal(rc.schema, 1);
  assert.equal(rc.task, 'T-TU-1');
  assert.equal(rc.rounds, 0);
  assert.equal(rc.class, null, 'the task was never routed');
  assert.equal(rc.startedAt, '2026-10-15T09:02:00.000Z');
  assert.equal(rc.endedAt, '2026-10-15T10:01:40.000Z', 'the last external run ends after the last request');
  assert.equal(rc.wallMs, 3580000);
  assert.equal(rc.partial, false);
  assert.equal(rc.priceTable, (await lib('receipts/index.mjs')).PRICES.date);
  assert.equal(rc.source, 'transcripts@2.1.300');
  // Per agent and model.
  const rows = [
    ['main', 'claude-opus-5-5', { input: 16, output: 250, cacheRead: 6300, cacheWrite: 450 }, 9924],
    ['implementer', 'claude-sonnet-5-5', { input: 10, output: 1200, cacheRead: 4000, cacheWrite: 4800 }, 24420],
    ['Explore', 'claude-haiku-5-5', { input: 100, output: 200, cacheRead: 150000, cacheWrite: 1000 }, 8675],
    ['external', 'claude-haiku-5-5', { input: 50, output: 100, cacheRead: 0, cacheWrite: 2000 }, 305],
  ].map(([type, ...rest]) => [['implementer', 'external'].includes(type) ? `${names.plugin}:${type}` : type, ...rest]);
  assert.equal(rc.byAgent.length, rows.length, show(rc.byAgent));
  for (const [agentType, model, tokens, cost] of rows) {
    const row = agentRow(rc, agentType, model);
    assert.ok(row, `byAgent ${agentType} ${model}`);
    assert.deepEqual(row.tokens, tokens, `${agentType} tokens`);
    assert.equal(row.costMicroUsd, cost, `${agentType} cost`);
  }
  // The wrapper agent of external runs is process overhead.
  assert.deepEqual(rc.processOverhead.wrapperTokens, { input: 50, output: 100, cacheRead: 0, cacheWrite: 2000 });
  // Sources not built yet are null, never invented.
  for (const k of ['tier', 'gates', 'defectsBeforeMerge']) assert.equal(rc[k], null, k);
  assert.equal(rc.processOverhead.hookInjectedChars, null);
});

test('attribution: requests between task switches go to the active task; subagents by description, Agent name or parent', async (t) => {
  const p = await project(t);
  const r = await p.receipt(['--task', 'T-TU-2']);
  assert.equal(r.code, 0, show(r));
  const rc = r.out.data.receipt;
  // req_06 and msg_07 (after `verify T-TU-2`, with commands that are no switch) and req_09 (a worktree session);
  // not the Explore subagent a4 spawned while T-TU-2 was active (no ID in its description or name), not a1's
  // `brief T-TU-2` (a subagent never switches the session's task).
  assert.deepEqual(rc.tokens, T2);
  assert.equal(rc.costMicroUsd, T2_COST, 'T-TU-2 cost');
  assert.deepEqual(rc.byAgent.map((a) => `${a.agentType} ${a.model}`), ['main claude-opus-5-5']);
  assert.equal(rc.processOverhead.wrapperTokens.input, 0);
  // Mutation evidence: the request that runs the switching command still belongs to the task before it.
  // req_05 ran `verify T-TU-2`: it is in T-TU-1's main row (16 input tokens = req_03 4 + req_04 3 + req_05 2 + req_08 7).
  const one = (await p.receipt(['--task', 'T-TU-1'])).out.data.receipt;
  assert.equal(agentRow(one, 'main', 'claude-opus-5-5').tokens.input, 16);
});

test('dedupe (P3): one request spans lines with growing output → counted once with its final usage', async (t) => {
  const { parseTranscript } = await lib('receipts/transcript.mjs');
  const iso = isolatedEnv({ prefix: 'receipts-parse-' });
  t.after(iso.cleanup);
  const file = join(iso.base, 's.jsonl');
  const line = (o, at, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: at, version: '2.1.300', ...extra,
    message: { id: extra.msg ?? 'msg_1', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 4, output_tokens: o, cache_read_input_tokens: 10, cache_creation_input_tokens: 6, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 } } } });
  writeFileSync(file, [
    line(2, '2026-10-15T09:00:00.000Z', { requestId: 'req_1' }),
    line(2, '2026-10-15T09:00:01.000Z', { requestId: 'req_1' }),
    line(80, '2026-10-15T09:00:02.000Z', { requestId: 'req_1' }),
    line(5, '2026-10-15T09:00:03.000Z', { msg: 'msg_2' }), // no requestId: merged by message.id
    line(9, '2026-10-15T09:00:04.000Z', { msg: 'msg_2' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'usage' } }),
    '{"type":"assistant","message":{"usage"', // an unfinished last line: a write in progress
  ].join('\n'));
  const parsed = parseTranscript(file, { bin: names.bin });
  assert.equal(parsed.malformed, 0, 'an unterminated last line is not malformed');
  assert.deepEqual(parsed.requests.map((q) => [q.key, q.tokens.output]), [['req_1', 80], ['msg_2', 9]]);
  assert.deepEqual(parsed.requests[0].tokens, { input: 4, output: 80, cacheRead: 10, cacheWrite5m: 2, cacheWrite1h: 4 });
  assert.equal(parsed.requests[0].at, '2026-10-15T09:00:00.000Z', 'a request starts at its first line');
  assert.deepEqual([...parsed.versions], ['2.1.300']);
  // Across files: the resumed session S2 repeats req_02 and req_03; the fixture totals above count them once
  // (with a per-file dedupe T-TU-1 would have 4 more input tokens).
  const p = await project(t);
  const r = await p.receipt(['--task', 'T-TU-1']);
  assert.equal(r.out.data.receipt.tokens.input, T1.input);
});

test('task switches: the first task ID after task, route, brief, verify or exec of the CLI; task new and others are none', async () => {
  const { switchesIn } = await lib('receipts/transcript.mjs');
  const bin = names.bin;
  for (const [command, ids] of [
    [`${bin} task set T-TU-1 dispatched --note "after T-TU-2"`, ['T-TU-1']],
    [`${bin} exec --task T-TU-3 --role reviewer --json`, ['T-TU-3']],
    [`cd /work && plugins/${names.plugin}/bin/${bin} verify T-TU-2`, ['T-TU-2']],
    [`${bin} route T-TU-1 --paths a.mjs; ${bin} brief T-TU-4`, ['T-TU-1', 'T-TU-4']],
    [`${bin} task new "Follow-up of T-TU-1"`, []],
    [`${bin} task list`, []],
    [`${bin} receipt --task T-TU-1`, []],
    ['git log --grep T-TU-1', []],
    [`my${bin} task set T-TU-1 dispatched`, []],
  ]) assert.deepEqual(switchesIn(command, bin), ids, command);
});

test('external runs (SC16): every run of the task appears, with provider tokens or null and a reason', async (t) => {
  const p = await project(t);
  const one = (await p.receipt(['--task', 'T-TU-1'])).out.data.receipt;
  const files = readdirSync(p.runs).filter((f) => f.includes('-T-TU-1-'));
  assert.equal(one.external.length, files.length, '100% of the task\'s runs');
  assert.deepEqual(one.external, [
    { provider: 'codex', runId: 'codex-T-TU-1-reviewer-1', model: 'gpt-5.5-codex', tokens: { input: 12000, output: 3000, cacheRead: 8000, cacheWrite: 0 }, tokensReason: null, costMicroUsd: 50000, wallMs: 94500, exit: 0 },
    { provider: 'codex', runId: 'codex-T-TU-1-reviewer-2', model: 'gpt-5.5-codex', tokens: null, tokensReason: 'usage event missing', costMicroUsd: null, wallMs: 40000, exit: 1 },
  ]);
  const two = (await p.receipt(['--task', 'T-TU-2'])).out.data.receipt;
  assert.deepEqual(two.external.map((e) => [e.runId, e.tokens, e.tokensReason]), [['codex-T-TU-2-implementer-1', null, 'not reported']],
    'a run whose record gives no reason is "not reported"');
});

test('receipt --run: one external run; totals() gives the loop the same numbers in process', async (t) => {
  const p = await project(t);
  const r = await p.receipt(['--run', 'codex-T-TU-1-reviewer-1']);
  assert.equal(r.code, 0, show(r));
  assert.deepEqual(r.out.data.run, { runId: 'codex-T-TU-1-reviewer-1', task: 'T-TU-1', provider: 'codex', model: 'gpt-5.5-codex', status: 'done',
    tokens: { input: 12000, output: 3000, cacheRead: 8000, cacheWrite: 0 }, tokensReason: null, costMicroUsd: 50000, wallMs: 94500, exit: 0 });
  const nul = await p.receipt(['--run', 'codex-T-TU-2-implementer-1']);
  assert.equal(nul.code, 0, show(nul));
  assert.deepEqual([nul.out.data.run.tokens, nul.out.data.run.tokensReason], [null, 'not reported']);

  const { totals } = await lib('receipts/index.mjs');
  const ctx = { cwd: p.repo, env: p.env, names };
  const task = totals({ task: 'T-TU-1' }, ctx);
  assert.deepEqual(task.tokens, T1);
  assert.equal(task.costMicroUsd, T1_COST);
  assert.equal(task.partial, false);
  const run = totals({ run: 'codex-T-TU-1-reviewer-2' }, ctx);
  assert.deepEqual([run.tokens, run.costMicroUsd, run.partial], [null, null, false]);
  assert.throws(() => totals({}, ctx), /task or a run/);
});

test('partial data: a malformed line or an unpriced model → exit 1 with the numbers found; an unfinished last line is not partial', async (t) => {
  const p = await project(t);
  // A write in progress (no line end) changes nothing.
  appendFileSync(join(p.main, `${S1}.jsonl`), '{"type":"assistant","message":{"usage":{"input_tokens":');
  const live = await p.receipt(['--task', 'T-TU-1']);
  assert.equal(live.code, 0, show(live));
  assert.equal(live.out.data.receipt.partial, false);
  // A broken complete line: numbers still computed, flagged partial, exit 1 (spec §8.1 partial data).
  appendFileSync(join(p.main, `${S1}.jsonl`), '\n');
  const bad = await p.receipt(['--task', 'T-TU-1']);
  assert.equal(bad.code, 1, show(bad));
  assert.equal(bad.out.ok, false);
  assert.equal(bad.out.data.receipt.partial, true);
  assert.deepEqual(bad.out.data.receipt.tokens, T1);
  assert.ok(bad.out.errors.some((e) => e.code === 'transcript-malformed'), show(bad));

  // An unpriced model in T-TU-2: its tokens count, its cost is unknown → partial for that task only.
  const q = await project(t);
  const dir = join(q.main, S1, 'subagents');
  writeFileSync(join(dir, 'agent-a5000000000000005.meta.json'), JSON.stringify({ agentType: `${names.plugin}:\u202eevil`, description: 'Check T-TU-2', toolUseId: 'toolu_E', spawnDepth: 1 }));
  writeFileSync(join(dir, 'agent-a5000000000000005.jsonl'), `${JSON.stringify({ type: 'assistant', requestId: 'req_u1', timestamp: '2026-10-15T09:20:00.000Z', version: '2.1.300',
    message: { id: 'msg_u1', model: 'claude-future-9', content: [], usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`);
  const two = await q.receipt(['--task', 'T-TU-2']);
  assert.equal(two.code, 1, show(two));
  assert.equal(two.out.data.receipt.partial, true);
  assert.equal(two.out.data.receipt.tokens.input, T2.input + 1000);
  assert.equal(two.out.data.receipt.costMicroUsd, T2_COST, 'the unpriced request adds no cost');
  assert.ok(two.out.errors.some((e) => e.code === 'model-unpriced' && /claude-future-9/.test(e.message)), show(two));
  assert.ok(agentRow(two.out.data.receipt, 'unknown', 'claude-future-9'), 'a label with hidden characters becomes "unknown"');
  const one = await q.receipt(['--task', 'T-TU-1']);
  assert.equal(one.code, 0, 'the other task is complete');
});

test('usage: exactly one of --task and --run; IDs are checked; an unknown task or run exits 2', async (t) => {
  const p = await project(t);
  for (const [args, code] of [
    [['--task', 'T-TU-1', '--run', 'codex-T-TU-1-reviewer-1'], 'conflicting-flags'],
    [['--task', 'nope'], 'invalid-value'],
    [['--run', '../escape'], 'invalid-value'],
    [['--task', 'T-TU-9'], 'task-unknown'],
    [['--run', 'codex-T-TU-1-reviewer-9'], 'run-unknown'],
  ]) {
    const r = await p.receipt(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${show(r)}`);
    assert.equal(r.out.errors[0].code, code, `${args.join(' ')}: ${show(r)}`);
  }
  // --task saves a file: consent first (REV-58), as for every command that changes files (--loop and --since only read).
  const { COMMANDS, mutates } = await lib('cli/commands.mjs');
  const row = COMMANDS.find((x) => x.name === 'receipt');
  assert.equal(mutates(row, { task: 'T-TU-1' }), true);
  assert.equal(mutates(row, { run: 'codex-T-TU-1-reviewer-1' }), true);
  assert.deepEqual([mutates(row, { loop: true }), mutates(row, { since: '2026-10-15' })], [false, false]);
  const refused = await cli(['receipt', '--task', 'T-TU-1'], p);
  assert.equal(refused.code, 7, show(refused));
  assert.ok(!existsSync(join(p.store, 'receipts')), 'nothing written without consent');
});

test('no transcripts: zero tokens with a warning, not partial; only the receipt file is written', async (t) => {
  const p = await project(t, { transcripts: false });
  const files = (dir) => readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile()).map((f) => [f, statSync(join(dir, f)).mtimeMs]).sort();
  const before = files(p.store);
  const r = await p.receipt(['--task', 'T-TU-2']);
  assert.equal(r.code, 0, show(r));
  const rc = r.out.data.receipt;
  assert.deepEqual(rc.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(rc.costMicroUsd, 0);
  assert.equal(rc.partial, false);
  assert.equal(rc.external.length, 1, 'the external run still appears');
  assert.ok(r.out.data.warnings.some((w) => w.code === 'no-transcripts'), show(r));
  const after = files(p.store);
  assert.deepEqual(after.filter(([f]) => !before.some(([g]) => g === f)).map(([f]) => f), [join('receipts', 'T-TU-2.json')]);
  for (const [f, mtime] of before) assert.deepEqual(after.find(([g]) => g === f), [f, mtime], `${f} unchanged`);
  assert.ok(!existsSync(join(p.env.CLAUDE_CONFIG_DIR, 'projects', slugOf(realpathSync(p.repo)))), 'nothing created for transcripts');
});

test('persisted receipt (spec §5.1, R70): saved through a lib/state kind, read back unchanged, integers only; never shrinks', async (t) => {
  const p = await project(t);
  const r = await p.receipt(['--task', 'T-TU-1']);
  assert.equal(r.code, 0, show(r));
  const file = join(p.store, 'receipts', 'T-TU-1.json');
  assert.deepEqual([r.out.data.saved, r.out.data.file], [true, file], show(r));
  const text = readFileSync(file, 'utf8');
  const onDisk = JSON.parse(text);
  assert.deepEqual(onDisk, r.out.data.receipt, 'the file holds the printed receipt');
  // Through the state unit: the receipt kind reads the same document back and its schema accepts it.
  const state = await lib('state/index.mjs');
  const { RECEIPT } = await lib('receipts/index.mjs');
  const store = state.open(p.store, { names, kinds: { ...state.KINDS, [RECEIPT.name]: RECEIPT } });
  assert.deepEqual(store.read(RECEIPT.name, 'T-TU-1'), onDisk);
  assert.deepEqual(state.check(RECEIPT, onDisk), []);
  assert.equal(state.serialize(RECEIPT, onDisk), text, 'written in the canonical form of lib/state');
  // R70: every number is an integer (micro-dollars, milliseconds, counts).
  const numbers = [];
  JSON.stringify(onDisk, (k, v) => { if (typeof v === 'number') numbers.push([k, v]); return v; });
  assert.ok(numbers.length > 30, 'the receipt carries numbers');
  for (const [k, v] of numbers) assert.ok(Number.isSafeInteger(v), `${k}: ${v} is an integer`);
  // A run's duration is its record's elapsedMs (94,500), not the span of its timestamps (95 s).
  assert.deepEqual([onDisk.costMicroUsd, onDisk.wallMs, onDisk.external[0].wallMs], [T1_COST, 3580000, 94500]);
  // The same data again: the file is not rewritten.
  const ino = statSync(file).ino;
  const again = await p.receipt(['--task', 'T-TU-1']);
  assert.equal(again.code, 0, show(again));
  assert.equal(again.out.data.saved, false);
  assert.equal(statSync(file).ino, ino, 'not replaced');
  // Transcripts gone (cleaned up, or another machine): fewer tokens never replace the saved receipt.
  rmSync(p.main, { recursive: true, force: true });
  const gone = await p.receipt(['--task', 'T-TU-1']);
  assert.equal(gone.code, 0, show(gone));
  assert.equal(gone.out.data.saved, false);
  assert.ok(gone.out.data.warnings.some((w) => w.code === 'receipt-kept'), show(gone));
  assert.equal(readFileSync(file, 'utf8'), text);
});

test('inactive repository: receipt --task prints the receipt and writes nothing anywhere (GC2)', async (t) => {
  const iso = isolatedEnv({ gitConfig: identity, prefix: 'receipts-inactive-' });
  t.after(iso.cleanup);
  const repo = join(iso.base, 'repo');
  mkdirSync(repo);
  git(repo, iso.env, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(repo, iso.env, ['commit', '-q', '--allow-empty', '-m', 'start']);
  place(join(FIXTURES, 'repo'), join(iso.env.CLAUDE_CONFIG_DIR, 'projects', slugOf(realpathSync(repo))));
  const snapshot = () => readdirSync(iso.base, { recursive: true }).sort().map((f) => {
    const st = lstatSync(join(iso.base, f));
    return `${f} ${st.size} ${st.mtimeMs} ${st.ino}`;
  });
  const before = snapshot();
  const r = await cli(['receipt', '--task', 'T-TU-1', '--yes'], { cwd: repo, env: iso.env });
  assert.equal(r.code, 0, show(r));
  const rc = r.out.data.receipt;
  // No state directory: no task document and no run records; the transcripts still count.
  assert.deepEqual(rc.tokens, { input: T1.input - 12000, output: T1.output - 3000, cacheRead: T1.cacheRead - 8000, cacheWrite: T1.cacheWrite });
  assert.equal(rc.costMicroUsd, T1_COST - 50000);
  assert.deepEqual([rc.class, rc.rounds, rc.external], [null, null, []]);
  assert.deepEqual([r.out.data.saved, r.out.data.file], [false, null]);
  assert.ok(r.out.data.warnings.some((w) => w.code === 'not-saved'), show(r));
  assert.deepEqual(snapshot(), before, 'no file or directory created or changed under the repository or HOME');
  assert.ok(!existsSync(join(repo, names.stateDir)));
});

test('output holds numbers and labels only: no transcript or run text reaches stdout or stderr', async (t) => {
  const p = await project(t);
  const human = await p.receipt(['--task', 'T-TU-1'], { json: false });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.out, /T-TU-1/);
  assert.match(human.out, /0\.093324/);
  assert.match(human.out, /codex-T-TU-1-reviewer-2.*not reported|usage event missing/);
  for (const r of [human, await p.receipt(['--task', 'T-TU-1']), await p.receipt(['--run', 'codex-T-TU-1-reviewer-1'], { json: false })]) {
    const all = `${typeof r.out === 'string' ? r.out : JSON.stringify(r.out)}${r.stderr}`;
    assert.doesNotMatch(all, /SYNTH/, 'prompts, tool output, signatures and last lines are never printed');
  }
});

test('price table: dated; every model priced in every category; cache-read ratios; long-prompt prices; dated model IDs resolve', async () => {
  const { PRICES, priceOf, requestMicroUsd } = await lib('receipts/index.mjs');
  assert.match(PRICES.date, /^\d{4}-\d\d-\d\d$/);
  assert.equal(PRICES.currency, 'USD');
  const CATS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];
  assert.ok(Object.keys(PRICES.models).length >= 10);
  // Pricing page footnotes: cache reads cost 0.025x base input on Fable 5.1 and Mythos 5.1, 0.05x on Opus 5.5 and
  // Sonnet 5.5, 0.1x on every other model.
  const READ_RATIO = { 'claude-fable-5-1': 0.025, 'claude-mythos-5-1': 0.025, 'claude-opus-5-5': 0.05, 'claude-sonnet-5-5': 0.05 };
  for (const [model, p] of Object.entries(PRICES.models)) {
    for (const c of CATS) assert.ok(Number.isFinite(p[c]) && p[c] >= 0, `${model}.${c}`);
    for (const rates of [p, p.longPrompt].filter(Boolean)) {
      assert.ok(Math.abs(rates.cacheRead - rates.input * (READ_RATIO[model] ?? 0.1)) < 1e-9, `${model}: cache read ${rates.cacheRead} for input ${rates.input}`);
    }
    if (p.longPrompt) for (const c of [...CATS, 'overTokens']) assert.ok(Number.isFinite(p.longPrompt[c]) && p.longPrompt[c] > 0, `${model}.longPrompt.${c}`);
  }
  assert.ok(PRICES.models['claude-haiku-5-5'].longPrompt, 'Haiku 5.5 prices requests over 100k prompt tokens higher');
  assert.equal(priceOf('claude-haiku-4-5-20251001'), PRICES.models['claude-haiku-4-5']);
  for (const odd of ['constructor', '__proto__', '<synthetic>', null]) assert.equal(priceOf(odd), null, String(odd));
  const t = (o) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...o });
  // USD per million tokens = micro-dollars per token: one million tokens of a category cost its price in dollars.
  for (const c of CATS) assert.equal(requestMicroUsd('claude-opus-5-5', t({ [c]: 1e6 })), PRICES.models['claude-opus-5-5'][c] * 1e6);
  // A request is rounded to whole micro-dollars once: 3 · 0.2 = 0.6000000000000001 → 1.
  assert.equal(requestMicroUsd('claude-opus-5-5', t({ cacheRead: 3 })), 1);
  // Exactly at the threshold: normal prices; one token over: the whole request at the long-prompt prices.
  assert.equal(requestMicroUsd('claude-haiku-5-5', t({ input: 100000 })), 10000);
  assert.equal(requestMicroUsd('claude-haiku-5-5', t({ input: 100001 })), 50001);
  assert.equal(requestMicroUsd('claude-future-9', t({ input: 5 })), null);
});

test('transcript directories: the slug of a working directory, as Claude Code names it', async () => {
  const { slug } = await lib('receipts/index.mjs');
  // Observed in ~/.claude/projects (Claude Code 2.1.296-2.1.300).
  assert.equal(slug('/Users/me/Documents/Code/Landfall-wt/I1.1'), '-Users-me-Documents-Code-Landfall-wt-I1-1');
  assert.equal(slug('/private/tmp/claude-501/-Users-me-Code/3c67/scratchpad/w2_tagt'), '-private-tmp-claude-501--Users-me-Code-3c67-scratchpad-w2-tagt');
});

// ---- receipt --loop and receipt --since … --by class|executor (spec §7.11 aggregation) ------------------------------
// Hand-computed loop totals (prices above; requests of every session of the repository and its worktree, any task):
//   loop started 2026-10-15T09:05:30Z, running: msg_07 (09:06) 764 · req_08 (10:00:05) 1828 · req_10 (11:00:05)
//     1·4 + 10·20 + 100·0.2 = 224 · req_09 (11:00:30) 224 → 3040 µ$; tokens input 1+7+1+1 = 10, output 20+70+10+10 = 110,
//     cache read 1800+2000+100+100 = 4000, cache write 0. Runs: reviewer-1 ended 09:04:55, before the start (left
//     out); reviewer-2 and implementer-1 have no tokens and no cost. Earlier requests (req_x1 at 09:05:10) are left out.
//   the same loop ended at 10:30Z: msg_07 + req_08 → 2592 µ$; input 8, output 90, cache read 3800.
// Hand-computed --since totals from the saved receipts (T-TU-1 routed standard, T-TU-2 trivial) and one run record
// saved after them (codex-T-TU-1-reviewer-3, 2026-10-16, 10,000 µ$, input 1000, output 500, cached 200):
//   by class since 2026-10-15: standard 93324 + 10000 = 103324 (tokens T1 + the run) · trivial 2256 (T2) → 105580
//   by executor: main 9924 + 2256 = 12180 · <plugin>:implementer 24420 · Explore 8675 · <plugin>:external 305 ·
//     codex 50000 + 10000 = 60000 (4 runs) → 105580
//   since 2026-10-16: both receipts ended on 10-15 (left out); the run → standard 10000.
const LOOP_T1 = { input: 10, output: 110, cacheRead: 4000, cacheWrite: 0 };
const RUN3 = { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 };
const plus = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + b[k]]));

async function writeLoop(p, patch = {}) {
  const loop = await lib('loop/index.mjs');
  const state = await lib('state/index.mjs');
  const doc = { ...loop.newLoop({ now: Date.parse('2026-10-15T09:05:30.000Z') }), ...patch };
  state.open(p.store, { names, kinds: loop.STORE_KINDS }).write(loop.LOOP.name, null, doc);
  return doc;
}

test('receipt --loop: tokens and cost of the current loop since its start (until its exit), read-only; no loop exits 1', async (t) => {
  const p = await project(t);
  const none = await cli(['receipt', '--loop'], p);
  assert.deepEqual([none.code, none.out.errors[0].code], [1, 'no-loop'], show(none));
  const doc = await writeLoop(p);
  const r = await cli(['receipt', '--loop'], p); // no --yes: it writes nothing, so it needs no consent
  assert.equal(r.code, 0, show(r));
  const d = r.out.data;
  assert.deepEqual(d.loop, { id: doc.id, startedAt: '2026-10-15T09:05:30.000Z', exit: null, exitAt: null });
  assert.deepEqual(d.tokens, LOOP_T1, 'token counts are exact');
  assert.equal(d.costMicroUsd, 3040, 'cost in micro-dollars, exactly');
  assert.equal(d.partial, false);
  const text = await cli(['receipt', '--loop'], { ...p, json: false });
  assert.match(text.out, new RegExp(`^loop ${doc.id} · since 2026-10-15T09:05:30\\.000Z \\(running\\) · input 10 · output 110 · cache read 4000 · cache write 0 · USD 0\\.003040 \\(estimate\\)`, 'm'));

  await writeLoop(p, { id: doc.id, exit: 'DONE', exitAt: '2026-10-15T10:30:00.000Z', reason: 'stopped' });
  const ended = await cli(['receipt', '--loop'], p);
  assert.equal(ended.code, 0, show(ended));
  assert.deepEqual([ended.out.data.tokens, ended.out.data.costMicroUsd], [{ input: 8, output: 90, cacheRead: 3800, cacheWrite: 0 }, 2592], 'an ended loop counts until its exit');
  assert.ok(!existsSync(join(p.store, 'receipts')), 'nothing saved');
});

test('receipt --since --by class|executor: totals from saved receipts and the run records outside them', async (t) => {
  const p = await project(t);
  for (const args of [['route', 'T-TU-1', '--paths', 'src/a.js,src/b.js,src/c.js', '--loc', '120'], ['route', 'T-TU-2', '--paths', 'a.js', '--loc', '3'],
    ['receipt', '--task', 'T-TU-1'], ['receipt', '--task', 'T-TU-2']]) {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 0, `${args.join(' ')}: ${show(r)}`);
  }
  writeFileSync(join(p.runs, 'codex-T-TU-1-reviewer-3.json'), JSON.stringify({
    schema: 1, runId: 'codex-T-TU-1-reviewer-3', task: 'T-TU-1', role: 'reviewer', provider: 'codex', model: 'gpt-5.5-codex', status: 'done',
    startedAt: '2026-10-16T08:00:00.000Z', endedAt: '2026-10-16T08:01:00.000Z', elapsedMs: 60000, tokens: { input: 1000, output: 500, cached: 200 }, costMicroUsd: 10000, exit: 0,
  }));
  const before = readdirSync(p.store, { recursive: true }).sort();
  const byClass = await cli(['receipt', '--since', '2026-10-15', '--by', 'class'], p); // read-only: no --yes
  assert.equal(byClass.code, 0, show(byClass));
  const d = byClass.out.data;
  assert.deepEqual([d.since, d.by, d.receipts, d.runs, d.partial], ['2026-10-15', 'class', 2, 1, false]);
  const row = (data, key) => data.groups.find((g) => g.key === key);
  assert.deepEqual(d.groups.map((g) => g.key).sort(), ['standard', 'trivial']);
  assert.deepEqual([row(d, 'standard').costMicroUsd, row(d, 'standard').tokens, row(d, 'standard').tasks, row(d, 'standard').runs], [103324, plus(T1, RUN3), ['T-TU-1'], 3]);
  assert.deepEqual([row(d, 'trivial').costMicroUsd, row(d, 'trivial').tokens, row(d, 'trivial').tasks, row(d, 'trivial').runs], [T2_COST, T2, ['T-TU-2'], 1]);
  assert.deepEqual([d.total.costMicroUsd, d.total.tokens], [105580, plus(plus(T1, T2), RUN3)]);
  const dflt = await cli(['receipt', '--since', '2026-10-15'], p);
  assert.deepEqual(dflt.out.data, d, '--by class is the default');

  const byExec = (await cli(['receipt', '--since', '2026-10-15', '--by', 'executor'], p)).out.data;
  const costs = Object.fromEntries(byExec.groups.map((g) => [g.key, g.costMicroUsd]));
  assert.deepEqual(costs, { main: 12180, [`${names.plugin}:implementer`]: 24420, Explore: 8675, [`${names.plugin}:external`]: 305, codex: 60000 });
  assert.deepEqual(row(byExec, 'main').tokens, { input: 20, output: 310, cacheRead: 9900, cacheWrite: 490 });
  assert.deepEqual([row(byExec, 'codex').tokens, row(byExec, 'codex').runs], [{ input: 13000, output: 3500, cacheRead: 8200, cacheWrite: 0 }, 4]);
  assert.equal(byExec.total.costMicroUsd, 105580, 'the same total, split by executor');

  const later = (await cli(['receipt', '--since', '2026-10-16'], p)).out.data;
  assert.deepEqual([later.receipts, later.runs, later.groups.map((g) => [g.key, g.costMicroUsd]), later.total.costMicroUsd], [0, 1, [['standard', 10000]], 10000]);
  const text = await cli(['receipt', '--since', '2026-10-15', '--by', 'executor'], { ...p, json: false });
  assert.match(text.out, /^receipts since 2026-10-15 by executor · 2 saved receipts, 1 run outside them$/m);
  assert.match(text.out, /^total +2 +4 +\d+ .*0\.105580$/m);
  assert.deepEqual(readdirSync(p.store, { recursive: true }).sort(), before, 'nothing written');

  // A run record that cannot be read: the numbers found, partial, exit 1.
  writeFileSync(join(p.runs, 'codex-T-TU-1-reviewer-4.json'), '{ not json');
  const partial = await cli(['receipt', '--since', '2026-10-15'], p);
  assert.equal(partial.code, 1, show(partial));
  assert.deepEqual([partial.out.data.partial, partial.out.data.total.costMicroUsd, partial.out.errors[0].code], [true, 105580, 'run-invalid']);
});

test('receipt forms: one of --task, --run, --loop, --since; --by only with --since; dates and groups are checked', async (t) => {
  const p = await project(t);
  for (const [args, code] of [
    [['--loop', '--task', 'T-TU-1'], 'conflicting-flags'],
    [['--since', '2026-10-15', '--loop'], 'conflicting-flags'],
    [['--by', 'class'], 'missing-flag'],
    [['--loop', '--by', 'class'], 'missing-flag'],
    [['--since', '2026-13-40'], 'invalid-value'],
    [['--since', 'yesterday'], 'invalid-value'],
    [['--since', '2026-10-15', '--by', 'owner'], 'invalid-value'],
  ]) {
    const r = await p.receipt(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${show(r)}`);
    assert.equal(r.out.errors[0].code, code, `${args.join(' ')}: ${show(r)}`);
  }
  // In an inactive repository there is nothing saved: zero totals with a warning.
  const plain = join(p.repo, '..', 'plain');
  mkdirSync(plain);
  git(plain, p.env, ['init', '-q']);
  const r = await cli(['receipt', '--since', '2026-10-15'], { ...p, cwd: plain });
  assert.equal(r.code, 0, show(r));
  assert.deepEqual([r.out.data.groups, r.out.data.total.costMicroUsd], [[], 0]);
  assert.ok(r.out.data.warnings.some((w) => w.code === 'not-active'), show(r));
});

// ---- fix round 1 (review-r1): receipt --since ---------------------------------------------------------------------
// The project of the --since test above: T-TU-1 routed standard, T-TU-2 trivial, both receipts saved.
async function savedReceipts(t) {
  const p = await project(t);
  for (const args of [['route', 'T-TU-1', '--paths', 'src/a.js,src/b.js,src/c.js', '--loc', '120'], ['route', 'T-TU-2', '--paths', 'a.js', '--loc', '3']]) {
    const r = await cli([...args, '--yes'], p);
    assert.equal(r.code, 0, `${args.join(' ')}: ${show(r)}`);
  }
  p.save = async (task) => {
    const r = await cli(['receipt', '--task', task, '--yes'], p);
    assert.equal(r.code, 0, `receipt --task ${task}: ${show(r)}`);
    return r.out.data.receipt;
  };
  return p;
}
const run3 = (doc) => ({
  schema: 1, runId: 'codex-T-TU-1-reviewer-3', task: 'T-TU-1', role: 'reviewer', provider: 'codex', model: 'gpt-5.5-codex', status: 'running',
  startedAt: '2026-10-16T23:00:00.000Z', endedAt: null, tokens: null, costMicroUsd: null, exit: null, ...doc,
});

test('F1 receipt --since: an included saved receipt that is partial makes the totals partial (exit 1), the numbers kept', async (t) => {
  const p = await savedReceipts(t);
  await p.save('T-TU-1');
  await p.save('T-TU-2');
  const state = await lib('state/index.mjs');
  const { RECEIPT } = await lib('receipts/index.mjs');
  state.open(p.store, { names, kinds: { ...state.KINDS, [RECEIPT.name]: RECEIPT } }).update(RECEIPT.name, 'T-TU-1', (doc) => ({ ...doc, partial: true }));
  const r = await cli(['receipt', '--since', '2026-10-15'], p);
  assert.equal(r.code, 1, show(r));
  assert.equal(r.out.data.partial, true);
  assert.equal(r.out.data.total.costMicroUsd, T1_COST + T2_COST, 'the available totals are kept');
  assert.ok(r.out.errors.some((e) => e.code === 'receipt-partial' && e.message.includes('T-TU-1')), show(r));
  // A partial receipt left out by the date does not make the totals partial.
  const later = await cli(['receipt', '--since', '2026-10-16'], p);
  assert.deepEqual([later.code, later.out.data.partial], [0, false], show(later));
});

test('F2 receipt --since: a run still running when its task receipt was saved counts with its finished usage', async (t) => {
  const p = await savedReceipts(t);
  writeFileSync(join(p.runs, 'codex-T-TU-1-reviewer-3.json'), JSON.stringify(run3({})));
  const saved = await p.save('T-TU-1');
  assert.ok(saved.external.some((e) => e.runId === 'codex-T-TU-1-reviewer-3' && e.costMicroUsd === null), 'the receipt saved the running run without usage');
  assert.equal(saved.endedAt, '2026-10-16T23:00:00.000Z');
  await p.save('T-TU-2');
  // The run finishes after the receipt was saved.
  writeFileSync(join(p.runs, 'codex-T-TU-1-reviewer-3.json'), JSON.stringify(run3({ status: 'done', endedAt: '2026-10-17T01:00:00.000Z', elapsedMs: 7200000, tokens: { input: 1000, output: 500, cached: 200 }, costMicroUsd: 10000, exit: 0 })));
  const byClass = (await cli(['receipt', '--since', '2026-10-15'], p)).out.data;
  const row = (data, key) => data.groups.find((g) => g.key === key);
  assert.deepEqual([row(byClass, 'standard').costMicroUsd, row(byClass, 'standard').tokens, row(byClass, 'standard').runs], [103324, plus(T1, RUN3), 3]);
  assert.equal(byClass.total.costMicroUsd, 105580);
  const byExec = (await cli(['receipt', '--since', '2026-10-15', '--by', 'executor'], p)).out.data;
  assert.deepEqual([row(byExec, 'codex').costMicroUsd, row(byExec, 'codex').runs], [60000, 4]);
  assert.equal(byExec.total.costMicroUsd, 105580);
  // The receipt ended (by its saved times) before the day; the run ended after it: the run still counts.
  const later = await cli(['receipt', '--since', '2026-10-17'], p);
  assert.equal(later.code, 0, show(later));
  assert.deepEqual([later.out.data.receipts, later.out.data.runs, later.out.data.groups.map((g) => [g.key, g.costMicroUsd])], [0, 1, [['standard', 10000]]]);
});

test('F3 receipt --since: a saved receipt of a newer schema refuses with exit 7 and the upgrade hint (GC9); an invalid one is partial', async (t) => {
  const p = await savedReceipts(t);
  const saved = await p.save('T-TU-1');
  const file = join(p.store, 'receipts', 'T-TU-1.json');
  writeFileSync(file, JSON.stringify({ ...saved, schema: 2 }));
  const r = await cli(['receipt', '--since', '2026-10-15'], p);
  assert.equal(r.code, 7, show(r));
  assert.deepEqual([r.out.exit, r.out.errors[0].code], ['REFUSED', 'schema-newer']);
  assert.match(r.out.errors[0].hint, /update the plugin/);
  writeFileSync(file, '{ not json');
  const bad = await cli(['receipt', '--since', '2026-10-15'], p);
  assert.deepEqual([bad.code, bad.out.data.partial, bad.out.errors[0].code], [1, true, 'state-invalid'], show(bad));
});

test('receipt without a selector in an active repository means --since the activation day; an inactive one exits 2', async (t) => {
  const p = await project(t);
  const { open, resolve } = await lib('state/index.mjs');
  const where = resolve({ cwd: p.repo, env: p.env, names });
  const day = open(where.dir, { names }).read('state', null).activatedAt.slice(0, 10);
  const r = await p.receipt([]);
  assert.equal(r.code, 0, show(r));
  assert.equal(r.out.data.since, day);
  assert.equal(r.out.data.defaulted, true);
  const explicit = await p.receipt(['--since', day]);
  assert.notEqual(explicit.out.data.defaulted, true);
  const plain = join(p.repo, '..', 'plain2');
  mkdirSync(plain);
  git(plain, p.env, ['init', '-q']);
  const none = await cli(['receipt'], { ...p, cwd: plain });
  assert.equal(none.code, 2, show(none));
  assert.equal(none.out.errors[0].code, 'missing-flag');
});
