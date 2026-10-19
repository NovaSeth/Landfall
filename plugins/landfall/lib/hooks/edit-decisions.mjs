// PreToolUse Edit|Write → `decisions-context` (spec §7.10, §7.13, §8.3, SD-22, SC17): before a file is edited, the
// decisions it cites and the active decisions whose scope matches its path are given to the model as
// additionalContext, at most 1,200 characters, each decision once per file and session.
// Steps: the target (tool_input.file_path, relative paths against cwd) → its repository (git top level of the
// nearest existing directory) → nothing unless that repository's state directory is active → citations in the
// target when it is a file of at most 256 KB → summaries from the scope index (lib/decisions) → minus the IDs
// already injected for this path in this session (local/session/<session_id>.json) → context lines → the IDs shown
// are added to the session file. Writes go through lib/state under the store lock with a short wait; a held lock
// only skips the bookkeeping.
// Hidden content (lib/text forModel) never reaches the model: summaries are cleaned and so is the final text.
// GC8: any problem (malformed input, no repository, unreadable state) → no output, which allows the edit; the hook
// never decides permission.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CONTEXT_BUDGET, STORE_KINDS, citedIn, inside, realTarget, relevantDecisions, renderContext, scopeIndex } from '../decisions/index.mjs';
import { KINDS, PATTERNS, defineKind, open, resolve } from '../state/index.mjs';
import { forModel } from '../text/clean.mjs';
import { gitTimeLeft } from './loop-state.mjs';

const NONE = { stdout: '' };
const LOCK_WAIT_MS = 100; // the hook never waits long for the store lock
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// The hooks' session file (spec §5.2 local/session/<id>.json): `decisions` maps a repository-relative path to the
// decision IDs injected for it in this session. Other hooks add their own optional fields here.
export const SESSION = defineKind('session', 1, {
  dir: 'local/session',
  keyPattern: SESSION_ID,
  file: (id) => `local/session/${id}.json`,
  match: /^local\/session\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/,
  fields: {
    decisions: { t: 'map', max: 10000, key: { t: 'str', min: 1, max: 4096 }, v: { t: 'arr', max: 1000, of: { t: 'str', max: 40, re: PATTERNS.decisionId } } },
  },
  opt: ['decisions'],
});

let cachedNames = null;
const loadNames = () => (cachedNames ??= JSON.parse(readFileSync(new URL('../name.json', import.meta.url), 'utf8')));

function seenFor(store, session, path) {
  try { return store.read(SESSION.name, session)?.decisions?.[path] ?? []; } catch { return []; }
}

function remember(store, session, path, ids) {
  try {
    store.update(SESSION.name, session, (cur) => {
      const doc = cur ?? {};
      const decisions = { ...(doc.decisions ?? {}) };
      decisions[path] = [...new Set([...(decisions[path] ?? []), ...ids])];
      return { ...doc, decisions };
    });
  } catch { /* best effort: next time the same lines may come again */ }
}

function inject(input, env, deadline) {
  const raw = input.tool_input?.file_path;
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) return NONE;
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : null;
  if (!isAbsolute(raw) && !cwd) return NONE; // never resolved against this process's own directory
  const target = realTarget(isAbsolute(raw) ? raw : join(cwd, raw));
  if (!target) return NONE;
  const names = loadNames();
  let where;
  const timeoutMs = gitTimeLeft(deadline); // git bounded by the hook's budget (review r1b)
  if (timeoutMs <= 0) return NONE;
  try { where = resolve({ cwd: target.dir, env, names, timeoutMs }); } catch { return NONE; }
  if (!where.active) return NONE;
  const path = inside(where.worktree, target.path); // decision scopes are paths of the checkout
  if (!path) return NONE;
  const store = open(where.dir, { names, kinds: { ...KINDS, ...STORE_KINDS, [SESSION.name]: SESSION }, lockTimeoutMs: LOCK_WAIT_MS });
  const records = scopeIndex(store, where.dir);
  if (records.length === 0) return NONE;
  const session = typeof input.session_id === 'string' && SESSION_ID.test(input.session_id) ? input.session_id : null;
  const seen = new Set(session ? seenFor(store, session, path) : []);
  const fresh = relevantDecisions(records, { path, cited: citedIn(target.path) }).filter((r) => !seen.has(r.id));
  const { text, ids } = renderContext(fresh, { budget: CONTEXT_BUDGET, path, bin: names.bin });
  if (ids.length === 0) return NONE;
  if (session) remember(store, session, path, ids);
  // The output boundary cleans again (review r1): an index written by an older plugin or by hand is not trusted.
  return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: forModel(text) } })}\n` };
}

// Registry handler: (hook input object, { env, deadline }) → { stdout }.
export function decisionsContext(input, { env = process.env, deadline = Infinity } = {}) {
  try {
    return inject(input, env, deadline);
  } catch {
    return NONE;
  }
}
