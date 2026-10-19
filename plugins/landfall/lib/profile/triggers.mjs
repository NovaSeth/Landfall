// Update triggers (spec §7.3): a scan is due when the profile was never scanned, HEAD moved ≥ 50 commits since the
// last scan, ≥ 7 days passed, or the last scanned HEAD is unknown to git (history rewritten). SessionStart runs the
// scan detached when one is due; `profile set` and `profile observe` update the profile directly.
// Thresholds are defaults to calibrate with a decision.
import { git } from '../git/index.mjs';

export const TRIGGERS = Object.freeze({ commits: 50, days: 7 });
const DAY_MS = 86400000;

// { due, reason: never-scanned | head-unknown | commits | days | null, commits, days }; commits: the count since
// lastScan.head (null when that HEAD is unknown), days: days since lastScan.at, floored to two decimals.
export function scanDue(profile, { commits, now }) {
  const last = profile?.lastScan ?? null;
  if (!last) return { due: true, reason: 'never-scanned', commits: null, days: null };
  const elapsed = (Date.parse(now) - Date.parse(last.at)) / DAY_MS;
  let reason = null;
  if (commits === null) reason = 'head-unknown';
  else if (commits >= TRIGGERS.commits) reason = 'commits';
  else if (elapsed >= TRIGGERS.days) reason = 'days';
  return { due: reason !== null, reason, commits, days: Math.floor(elapsed * 100) / 100 };
}

// The current HEAD commit of the repository, or null before the first commit.
export function headOf(repo, { env } = {}) {
  const r = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: repo, env });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Commits from `base` to HEAD (all commits when base is null; 0 before the first commit), or null when base is not
// an ancestor-reachable commit of this repository.
export function commitsSince(repo, base, { env } = {}) {
  if (headOf(repo, { env }) === null) return 0;
  const r = git(['rev-list', '--count', base ? `${base}..HEAD` : 'HEAD'], { cwd: repo, env });
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isInteger(n) ? n : null;
}
