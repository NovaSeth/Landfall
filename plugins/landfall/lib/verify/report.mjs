// `report <id> --from <file> [--round <k>] [--force]`: stores the task report (tasks/<id>/report.md) for the task's owner.
// Round 0 checks the RED/GREEN frontmatter and the Status line; --round appends a fix round and keeps earlier bytes.
// Context comes from io (cwd, env), never from process state.
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { KINDS, StateError, setTask, writeTaskText } from '../state/index.mjs';
import { reportHasEvidence } from './artifacts.mjs';
import { activeWhere, storeOf, unknownTask } from './run.mjs';

const FROM_MAX = 262144;
const STATUS = /^Status:\s*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)\s*$/gm;
const EVENT = { DONE: 'done', DONE_WITH_CONCERNS: 'done-with-concerns', NEEDS_CONTEXT: 'needs-context', BLOCKED: 'blocked' };

const typed = (fn) => (ctx) => {
  try {
    return fn(ctx);
  } catch (err) {
    if (err instanceof StateError && err.exit !== 'INTERNAL' && Object.hasOwn(EXIT, err.exit)) return { code: EXIT[err.exit], errors: [err] };
    throw err;
  }
};
const usage = (code, message, hint) => ({ code: EXIT.USAGE, errors: [{ code, message, hint }] });
const fail = (id, code, message, hint) => ({ code: EXIT.FAIL, data: { task: id, written: false }, errors: [{ code, message, hint }] });

function readFrom(file, io) {
  const path = isAbsolute(file) ? file : resolvePath(io.cwd, file);
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > FROM_MAX) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// The body after a leading frontmatter block (CR LF read as LF), without leading blank lines.
function bodyOf(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  return (end < 0 ? lines : lines.slice(end + 1)).join('\n').replace(/^(\s*\n)+/, '');
}

const lastStatus = (text) => {
  const all = [...text.matchAll(STATUS)];
  return all.length ? all[all.length - 1][1] : null;
};

export const report = typed(({ args, flags, names, io }) => {
  const id = args.id;
  const bin = names.bin;
  if (typeof flags.from !== 'string' || flags.from === '') return usage('missing-flag', 'report needs --from <file>: the report text', `${bin} report ${id} --from <file>`);
  let round = 0;
  if (flags.round !== undefined && flags.round !== false) {
    const s = String(flags.round);
    round = /^[0-9]+$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(round) || round < 1 || round > 999) return usage('invalid-value', `--round must be an integer from 1 to 999, got ${JSON.stringify(s)}`, `${bin} report ${id} --from <file> --round <k>`);
    if (flags.force) return usage('invalid-combination', '--force replaces a whole report and cannot be combined with --round', 'drop --force or --round');
  }
  const input = readFrom(flags.from, io);
  if (input === null) return usage('report-unreadable', `${flags.from} is not a readable regular file of at most ${FROM_MAX} bytes`, 'nothing was written');

  const where = activeWhere({ cwd: io.cwd, env: io.env, names });
  KINDS.task.path(id);
  const store = storeOf(where, names);
  const task = store.read('task', id);
  if (task === null) throw unknownTask(id, where, names);
  if (task.status === 'done' || task.status === 'cancelled') return fail(id, 'task-closed', `${id} is ${task.status}: a closed task takes no report`, `'${bin} task new' starts a new task`);

  const rel = `tasks/${id}/report.md`;
  const stored = round === 0 ? input : bodyOf(input);
  const word = lastStatus(stored);
  if (word === null) return fail(id, 'report-no-status', 'the report has no "Status:" line', 'one line "Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED"; nothing was written');
  let outcome;
  let file;
  if (round === 0) {
    if (!reportHasEvidence(input)) return fail(id, 'report-no-evidence', 'the report frontmatter has no RED/GREEN evidence', 'start the file with ---, then red: {"command": …, "exit": <not 0>, "excerpt": …} and green: {"command": …, "exit": 0, "excerpt": …}, then ---; nothing was written');
    const w = writeTaskText({ cwd: io.cwd, env: io.env, names, id, name: 'report', text: input, replace: () => Boolean(flags.force) });
    if (w.outcome === 'kept') return fail(id, 'report-exists', `${id} already has a report`, '--round <k> appends a fix round; --force replaces the report');
    ({ outcome, file } = w);
  } else {
    const current = store.readText(rel);
    if (current === null) return fail(id, 'report-missing', `${id} has no report to append round ${round} to`, `store the task report first: ${bin} report ${id} --from <file>`);
    const heading = `## Fix round ${round}`;
    if (current.split('\n').some((l) => l.trimEnd() === heading)) return fail(id, 'round-exists', `the report already has "${heading}"`, 'pick the next round; nothing was written');
    let body = stored.startsWith(heading) ? stored : `${heading}\n\n${stored}`;
    body = `${body.replace(/\n+$/, '')}\n`;
    const text = `${current.replace(/\n+$/, '')}\n\n${body}`;
    // The append is built on what was read: a report changed meanwhile is kept, not overwritten.
    const w = writeTaskText({ cwd: io.cwd, env: io.env, names, id, name: 'report', text, replace: (cur) => cur === current });
    if (w.outcome === 'kept') return fail(id, 'report-changed', `${id}'s report changed while the round was appended`, 'run the command again; nothing was written');
    ({ outcome, file } = w);
  }
  const status = EVENT[word];
  const set = setTask({ cwd: io.cwd, env: io.env, names, id, state: 'implementer', options: { report: status, ...(round ? { round: String(round) } : {}) } });
  return {
    data: { task: id, round, status, file, outcome, event: set.event },
    text: `${id}: report stored (round ${round}, status ${word}): ${file}\n`,
  };
});
