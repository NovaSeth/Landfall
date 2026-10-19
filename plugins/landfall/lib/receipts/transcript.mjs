// Transcript parser (spec §6.1 P3, §7.11, U2): one Claude Code session transcript (JSONL), read line by line.
// Kept: assistant lines with message.usage. One API request spans several lines (one per content block) that repeat
// its usage while output_tokens grows, so lines are merged per request key (requestId, else message.id) taking each
// count's maximum, never a sum. Lines of the model "<synthetic>" are local messages (no API request) and skipped.
// From each request's content: the Bash commands that switch the active task (`<bin> task|route|brief|verify|exec`
// followed by a task ID: the first ID after the subcommand) and the Agent tool calls (id, name, description).
// A complete line that is not JSON counts as malformed; an unterminated last line is a write in progress, ignored.
// Only counts and labels leave this module: no prompt, output or command text.
import { closeSync, openSync, readSync } from 'node:fs';

const CHUNK = 1 << 20;
export const TASK_ID = /\bT-[A-Z]{2,4}-[1-9]\d{0,5}\b/;
const TASK_SWITCH_SUBCOMMANDS = ['task', 'route', 'brief', 'verify', 'exec'];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Calls fn(line) for every complete line of `file`; true when an unterminated last line was left.
export function eachLine(file, fn) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let rest = Buffer.alloc(0);
    for (let n; (n = readSync(fd, buf, 0, CHUNK, null)) > 0;) {
      const data = Buffer.concat([rest, buf.subarray(0, n)]);
      let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        fn(data.toString('utf8', start, end).replace(/\r$/, ''));
        start = end + 1;
      }
      rest = data.subarray(start);
    }
    return rest.length > 0;
  } finally {
    closeSync(fd);
  }
}

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Token counts of one usage object; cache writes split by lifetime (1h writes cost more than 5m ones).
export function tokensOf(usage) {
  const written = count(usage.cache_creation_input_tokens);
  const hour = isObject(usage.cache_creation) ? Math.min(count(usage.cache_creation.ephemeral_1h_input_tokens), written) : 0;
  return { input: count(usage.input_tokens), output: count(usage.output_tokens), cacheRead: count(usage.cache_read_input_tokens), cacheWrite5m: written - hour, cacheWrite1h: hour };
}

// The task IDs a shell command switches to, in order (`task new` names no task yet: an ID in its title is no switch).
export function switchesIn(command, bin) {
  const re = new RegExp(`(?:^|[\\s;&|(\`'"/])${escape(bin)}\\s+(${TASK_SWITCH_SUBCOMMANDS.join('|')})(?=\\s)([^;&|\\n]*)`, 'g');
  const out = [];
  for (const [, sub, rest] of command.matchAll(re)) {
    if (sub === 'task' && /^\s*new\b/.test(rest)) continue;
    const id = TASK_ID.exec(rest);
    if (id) out.push(id[0]);
  }
  return out;
}

const time = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const VERSION = /^\d+\.\d+\.\d+/;

// { requests: [{ key, model, at, tokens, switches, agents: [{ toolUseId, name, description }] }] in first-seen
// order, malformed (count of broken complete lines), versions (Set of Claude Code versions seen) }.
export function parseTranscript(file, { bin }) {
  const requests = new Map();
  const versions = new Set();
  let malformed = 0;
  eachLine(file, (line) => {
    if (!line.includes('"usage"')) return; // only assistant lines carry usage
    let o;
    try { o = JSON.parse(line); } catch { malformed++; return; }
    const msg = o?.message;
    if (o?.type !== 'assistant' || !isObject(msg) || !isObject(msg.usage) || msg.model === '<synthetic>') return;
    if (typeof o.version === 'string' && VERSION.test(o.version)) versions.add(o.version.match(VERSION)[0]);
    const key = typeof o.requestId === 'string' && o.requestId ? o.requestId : typeof msg.id === 'string' && msg.id ? msg.id : `line-${requests.size}`;
    let req = requests.get(key);
    if (!req) {
      req = { key, model: typeof msg.model === 'string' ? msg.model : null, at: time(o.timestamp), tokens: tokensOf(msg.usage), switches: [], agents: [], seen: new Set() };
      requests.set(key, req);
    } else {
      const t = tokensOf(msg.usage);
      for (const k of Object.keys(t)) req.tokens[k] = Math.max(req.tokens[k], t[k]);
      req.at ??= time(o.timestamp);
    }
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string' || req.seen.has(block.id)) continue;
      req.seen.add(block.id);
      const input = isObject(block.input) ? block.input : {};
      if (block.name === 'Bash' && typeof input.command === 'string') req.switches.push(...switchesIn(input.command, bin));
      if (block.name === 'Agent' || block.name === 'Task') {
        req.agents.push({ toolUseId: block.id, name: typeof input.name === 'string' ? input.name : null, description: typeof input.description === 'string' ? input.description : null });
      }
    }
  });
  return { requests: [...requests.values()].map(({ seen, ...r }) => r), malformed, versions };
}
