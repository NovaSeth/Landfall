// Session transcripts of a repository (spec §6.1 P3, §7.11, SD-23): `<config>/projects/<slug>/<session>.jsonl`, the
// subagents of a session in `<session>/subagents/agent-<id>.jsonl` with `agent-<id>.meta.json` {agentType,
// description, toolUseId, parentAgentId, spawnDepth}. <config> is $CLAUDE_CONFIG_DIR or ~/.claude; <slug> is a
// session's working directory with every character outside A-Z, a-z, 0-9 replaced by '-'. Directories read: the
// repository and its linked worktrees (as listed by git and as real paths). Files are read, never followed through a
// link, never written.
// Attribution (spec §7.11; switches are read from the session's own Bash calls instead of a hook-written session
// file, so no other unit has to record them): in a main session, a request belongs to the task active when it was
// made; a command `<bin> task|route|brief|verify|exec … <T-…>` makes that task active for the requests after it. A
// subagent belongs to the task whose ID its description or its Agent call's name holds, else to the task of the
// subagent that spawned it, else to none. Requests are counted once across all files (a resumed session repeats
// earlier lines with their requestIds); sessions are taken in order of their first request.
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { git } from '../git/index.mjs';
import { TASK_ID, parseTranscript } from './transcript.mjs';

export const slug = (path) => path.replace(/[^A-Za-z0-9]/g, '-');
export const MAIN = 'main';
export const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,79}$/;
// A model or agent type as a plain label; anything else (hidden characters, long text) is "unknown".
export const label = (v) => (typeof v === 'string' && LABEL.test(v) ? v : 'unknown');
const firstTask = (text) => (typeof text === 'string' ? TASK_ID.exec(text)?.[0] ?? null : null);
const isFile = (p) => lstatSync(p, { throwIfNoEntry: false })?.isFile() === true;
const isDir = (p) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;

function configDir(env) {
  if (typeof env.CLAUDE_CONFIG_DIR === 'string' && isAbsolute(env.CLAUDE_CONFIG_DIR)) return env.CLAUDE_CONFIG_DIR;
  return typeof env.HOME === 'string' && isAbsolute(env.HOME) ? join(env.HOME, '.claude') : null;
}

// Working directories whose sessions belong to the repository: the repository and its linked worktrees.
function workingDirs(repo, env) {
  const dirs = new Set([repo]);
  const r = git(['worktree', 'list', '--porcelain'], { cwd: repo, env });
  if (r.status === 0) {
    for (const line of r.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path = line.slice(9);
      dirs.add(path);
      try { dirs.add(realpathSync.native(path)); } catch { /* a worktree that is gone */ }
    }
  }
  return [...dirs];
}

// Transcript directories of the repository that exist.
export function projectDirs({ repo, env }) {
  const config = configDir(env);
  if (!config) return [];
  return [...new Set(workingDirs(repo, env).map((d) => join(config, 'projects', slug(d))))].filter(isDir);
}

function readMeta(file) {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    return m !== null && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

// Parses one transcript into `problems` ({ code, message, hint }) and versions; null when unreadable.
function parse(file, { bin, problems, versions }) {
  try {
    const t = parseTranscript(file, { bin });
    if (t.malformed) problems.push({ code: 'transcript-malformed', message: `${file}: ${t.malformed} malformed line(s) skipped`, hint: 'the totals are a lower bound' });
    for (const v of t.versions) versions.add(v);
    return t;
  } catch (err) {
    problems.push({ code: 'transcript-unreadable', message: `${file}: ${err.code ?? err.message}`, hint: 'check the file permissions; the totals are a lower bound' });
    return null;
  }
}

function readSession(dir, name, ctx) {
  const main = parse(join(dir, name), ctx);
  if (!main) return null;
  const subDir = join(dir, name.slice(0, -'.jsonl'.length), 'subagents');
  const agents = [];
  let files = [];
  try { files = isDir(subDir) ? readdirSync(subDir).sort() : []; } catch (err) {
    ctx.problems.push({ code: 'transcript-unreadable', message: `${subDir}: ${err.code ?? err.message}`, hint: 'check the directory permissions; the totals are a lower bound' });
  }
  for (const f of files) {
    const m = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/.exec(f);
    if (!m || !isFile(join(subDir, f))) continue;
    const transcript = parse(join(subDir, f), ctx);
    if (!transcript) continue;
    const metaFile = join(subDir, `agent-${m[1]}.meta.json`);
    agents.push({ id: m[1], meta: isFile(metaFile) ? readMeta(metaFile) ?? {} : {}, transcript });
  }
  const starts = [main, ...agents.map((a) => a.transcript)].flatMap((t) => t.requests.map((r) => r.at)).filter(Boolean).sort();
  return { main, agents, start: starts[0] ?? '' };
}

// Requests of one session with their task (null: unattributed); `seen` holds request keys already counted.
function attribute(session, seen) {
  const out = [];
  const take = (r, agentType, task) => {
    if (seen.has(r.key)) return;
    seen.add(r.key);
    out.push({ key: r.key, model: r.model, at: r.at, tokens: r.tokens, agentType, task });
  };
  let active = null;
  for (const r of session.main.requests) {
    take(r, MAIN, active);
    if (r.switches.length) active = r.switches[r.switches.length - 1];
  }
  const calls = new Map(); // Agent tool_use id → { name, description }
  for (const t of [session.main, ...session.agents.map((a) => a.transcript)]) for (const r of t.requests) for (const c of r.agents) calls.set(c.toolUseId, c);
  const byId = new Map(session.agents.map((a) => [a.id, a]));
  const memo = new Map();
  const taskOf = (agent, depth = 0) => {
    if (memo.has(agent.id)) return memo.get(agent.id);
    const call = calls.get(agent.meta.toolUseId);
    let task = firstTask(agent.meta.description ?? call?.description) ?? firstTask(call?.name);
    const parent = byId.get(agent.meta.parentAgentId);
    if (!task && parent && depth < 8) task = taskOf(parent, depth + 1);
    memo.set(agent.id, task);
    return task;
  };
  for (const agent of session.agents) for (const r of agent.transcript.requests) take(r, label(agent.meta.agentType), taskOf(agent));
  return out;
}

// Every request of the repository's sessions: { requests: [{ key, model, at, tokens, agentType, task }], versions,
// problems (data that could not be read: totals are a lower bound), found (a transcript directory exists) }.
export function readLedger({ repo, env, bin }) {
  const problems = [];
  const versions = new Set();
  const dirs = projectDirs({ repo, env });
  const sessions = [];
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir).sort(); } catch (err) {
      problems.push({ code: 'transcript-unreadable', message: `${dir}: ${err.code ?? err.message}`, hint: 'check the directory permissions; the totals are a lower bound' });
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || !isFile(join(dir, name))) continue;
      const s = readSession(dir, name, { bin, problems, versions });
      if (s) sessions.push(s);
    }
  }
  sessions.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const seen = new Set();
  const requests = sessions.flatMap((s) => attribute(s, seen));
  return { requests, versions, problems, found: dirs.length > 0 };
}
