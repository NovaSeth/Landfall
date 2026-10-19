// Claim refs on origin (spec §7.9, SD-20): the git plumbing of the lanes unit, through lib/git with argument arrays.
// A claim is refs/heads/<claimRefPrefix><lane> (prefix from lib/name.json) pointing at a root commit with the empty
// tree whose message is the JSON claim. Reads store nothing: ls-remote names the refs, a fetch without a destination
// brings only the missing commits (no local ref, no FETCH_HEAD, no remote-tracking update), cat-file reads them.
// Writes are pushes with --force-with-lease=<ref>:<seen> (empty <seen>: the ref must not exist), so origin applies
// each one only while the ref still holds the value seen.
// Every failure to reach or read origin throws remote-unreachable (ENV): a network error is never a free lane.
// Needs git ≥ 2.29 (fetch --no-write-fetch-head); with an older git the fetch fails, which is ENV, never free.
// site: { repo, env, names } — the repository, the env of the invocation and lib/name.json.
import { git } from '../git/index.mjs';
import { LaneError } from './errors.mjs';

export const REMOTE = 'origin';
const MAX_MESSAGE = 2048; // a claim message is about 150 bytes; anything longer is not a claim
const FETCH_ATTEMPTS = 2; // a ref that moves between ls-remote and fetch is listed again, at most this often
const NETWORK_TIMEOUT_MS = 30000;

const prefix = (names) => `refs/heads/${names.claimRefPrefix}`;
export const claimRef = (names, lane) => `${prefix(names)}${lane}`;
// No terminal prompt for credentials: an agent's command fails instead of hanging.
const network = (env) => ({ ...env, GIT_TERMINAL_PROMPT: '0' });
const firstLine = (r) => (r.error ? `git ${r.error}` : (r.stderr.split('\n').find((l) => l.trim()) ?? `exit ${r.status}`).trim());

export function unreachable(r, what) {
  return new LaneError('remote-unreachable', 'ENV', `${what} on ${REMOTE} failed: ${firstLine(r)}`, {
    hint: `check the network and 'git remote get-url ${REMOTE}'; a lane is never taken as free while ${REMOTE} cannot be read`,
  });
}

// lane → sha of the claim refs on origin (one lane, or every lane when lane is null).
function listRefs({ repo, env, names }, lane, isLane) {
  const r = git(['ls-remote', '--exit-code', REMOTE, lane === null ? `${prefix(names)}*` : claimRef(names, lane)], { cwd: repo, env: network(env), timeoutMs: NETWORK_TIMEOUT_MS });
  const refs = new Map();
  if (r.status === 2 && !r.error) return refs; // origin answered: no matching ref
  if (r.status !== 0 || r.error) throw unreachable(r, 'reading the lane claims');
  for (const line of r.stdout.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!ref?.startsWith(prefix(names))) continue; // ls-remote matches a pattern by its tail
    const name = ref.slice(prefix(names).length);
    if (isLane(name) && (lane === null || name === lane)) refs.set(name, sha);
  }
  return refs;
}

// The message of a local commit, or null when the object is not here.
function message({ repo, env }, sha) {
  const r = git(['cat-file', 'commit', sha], { cwd: repo, env });
  if (r.status !== 0 || r.error) return null;
  const at = r.stdout.indexOf('\n\n');
  return at < 0 ? '' : r.stdout.slice(at + 2);
}

// [{ lane, sha, message }] of the claims on origin, sorted by lane. The commits of the refs ls-remote lists are
// fetched by ref name; a ref that moved in between is listed again (bounded); a fetch that keeps failing is ENV.
export function readRefs(site, { lane = null, isLane }) {
  let failed = null;
  for (let attempt = 0; ; attempt++) {
    const out = [];
    const missing = [];
    for (const [name, sha] of listRefs(site, lane, isLane)) {
      const text = message(site, sha);
      if (text === null) missing.push(claimRef(site.names, name));
      else out.push({ lane: name, sha, message: text.length > MAX_MESSAGE ? '' : text.replace(/\n+$/, '') });
    }
    if (missing.length === 0) return out.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
    if (attempt === FETCH_ATTEMPTS) {
      if (failed) throw unreachable(failed, 'fetching the lane claims');
      throw new LaneError('remote-unreachable', 'ENV', `the lane claims on ${REMOTE} kept changing while they were read`, { hint: 'retry; a lane is never taken as free while its claim cannot be read' });
    }
    const f = git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', REMOTE, ...missing], { cwd: site.repo, env: network(site.env), timeoutMs: NETWORK_TIMEOUT_MS });
    failed = f.status !== 0 || f.error ? f : null;
  }
}

const localFailure = (r) => new LaneError('git-failed', 'ENV', `writing the claim commit failed: ${firstLine(r)}`, { hint: 'check that the repository is writable and git works' });

// The claim commit of `doc` (the empty tree, no parent, the JSON as message), dated doc.at. Author and committer are
// the handle without an email: a claim publishes the handle only (SD-9).
export function createClaimCommit({ repo, env }, doc) {
  const tree = git(['mktree'], { cwd: repo, env });
  if (tree.status !== 0 || tree.error) throw localFailure(tree);
  const date = `@${Math.floor(Date.parse(doc.at) / 1000)} +0000`;
  const who = { GIT_AUTHOR_NAME: doc.handle, GIT_AUTHOR_EMAIL: '', GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: doc.handle, GIT_COMMITTER_EMAIL: '', GIT_COMMITTER_DATE: date };
  const c = git(['commit-tree', tree.stdout.trim(), '-m', JSON.stringify(doc)], { cwd: repo, env: { ...env, ...who } });
  if (c.status !== 0 || c.error) throw localFailure(c);
  return c.stdout.trim();
}

// Sets the claim ref of `lane` to `sha` (null: deletes it) only while origin holds `seen` (null: no ref). true when
// origin applied it; false when origin rejected it (the caller reads the ref again to learn why); ENV when the push
// did not reach origin. --no-verify: the commit carries no files, so a pre-push gate has nothing to check; the push
// is never signed (a user's push.gpgSign would make origins without signed-push support refuse it).
export function pushClaim(site, lane, { seen, sha }) {
  const ref = claimRef(site.names, lane);
  const r = git(['push', '--porcelain', '--no-verify', '--no-signed', `--force-with-lease=${ref}:${seen ?? ''}`, REMOTE, `${sha ?? ''}:${ref}`], { cwd: site.repo, env: network(site.env), timeoutMs: NETWORK_TIMEOUT_MS });
  if (r.status === 0 && !r.error) return true;
  const rejected = r.stdout.split('\n').some((l) => l.startsWith('!\t') && (l.split('\t')[1] ?? '').endsWith(`:${ref}`));
  if (!rejected || r.error) throw unreachable(r, `updating ${ref}`);
  return false;
}
