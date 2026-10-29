// The `route` command (spec §7.5, §8.2): three forms, checked before anything is read.
//   route <task> --paths <p,…> --loc <n> [--flags <f,…>]     classify the plan, apply the ratchet (writes task.json)
//   route --probe --paths <p,…> --loc <n> [--flags <f,…>]    classify only: no task, nothing written, works in an
//                                                            untracked repository and outside git (spec §7.2)
//   route <task> --override <class> --by user --quote <text> the user's override (a decision when it lowers)
// Context comes from the target (COD-9): the repository of the current directory, its git user.email (the
// caller's handle in the store's team registry), never process state. Paths are repository-relative and
// comma-separated; an absolute path inside the repository (the worktree of the current directory, lib/state resolve) is
// made relative.
// Risk globs: the router defaults plus the profile's additions (profile.riskPaths, read through lib/profile by an
// injectable reader; makeRoute takes another one in tests). A probe reads the profile only in a tracked repository.
// Exit 0 done · 1 not classified yet, task changed meanwhile, invalid state · 2 usage · 7 no consent, untracked
// repository, not the task's owner, no registered handle, newer schema · 8 not a git repository, git missing.
import { isAbsolute, relative } from 'node:path';
import { EXIT } from '../cli/commands.mjs';
import { openStore, riskGlobsOf } from '../profile/index.mjs';
import { StateError, emailHash, gitIdentity, open, resolve } from '../state/index.mjs';
import { executorData as suggestionFor } from '../receipts/index.mjs';
import { reviewShown } from '../verify/artifacts.mjs';
import { classify } from './classify.mjs';
import { RouteError, usage } from './errors.mjs';
import { ignoredReasons, overrideTask, routeTask, routerThresholds } from './ratchet.mjs';
import { rank, routeFor } from './routes.mjs';

const list = (value) => String(value).split(',').map((s) => s.trim()).filter(Boolean);

function parseLoc(value) {
  if (value === undefined) throw usage('missing-loc', 'the plan needs a LOC estimate', 'pass --loc <n>');
  if (!/^\d{1,9}$/.test(value)) throw usage('invalid-loc', `--loc takes a whole number, got ${JSON.stringify(String(value).slice(0, 40))}`, 'pass --loc <n>, for example --loc 120');
  return Number(value);
}

// The form and its checked inputs; any mix of forms is a usage error.
function form(args, flags, bin) {
  const help = `run '${bin} route --help'`;
  const mix = (message) => usage('invalid-combination', message, help);
  const plan = flags.paths !== undefined || flags.loc !== undefined || flags.flags !== undefined;
  if (flags.probe && flags.override !== undefined) throw mix('--probe and --override are different forms');
  if (flags.override === undefined && (flags.by !== undefined || flags.quote !== undefined)) throw mix('--by and --quote belong to --override');
  if (flags.override !== undefined) {
    if (plan) throw mix('--override takes no plan (--paths, --loc, --flags)');
    if (args.task === undefined) throw usage('missing-task', 'name the task to override', help);
    return { kind: 'override', task: args.task };
  }
  if (flags.probe && args.task !== undefined) throw mix('--probe classifies a plan without a task; drop the task ID');
  if (!flags.probe && args.task === undefined) throw usage('missing-task', 'name the task, or classify without one with --probe', help);
  const paths = flags.paths === undefined ? [] : list(flags.paths);
  if (paths.length === 0) throw usage('missing-paths', 'name at least one path the plan changes', 'pass --paths <p,…> (repository-relative, comma-separated)');
  const loc = parseLoc(flags.loc);
  return { kind: flags.probe ? 'probe' : 'classify', task: args.task, paths, loc, flags: flags.flags === undefined ? [] : list(flags.flags) };
}

const inRepo = (repo, paths) => paths.map((p) => (repo && isAbsolute(p) && (p === repo || p.startsWith(`${repo}/`)) ? relative(repo, p) || '.' : p));

// The caller's handle: the team entry holding the hash of the repository's git user.email (null: none).
function callerHandle(store, repo, env) {
  const { email } = gitIdentity(repo, { env });
  if (!email) return null;
  const hash = emailHash(email);
  return store.list('team').find((h) => store.read('team', h)?.emailSha256 === hash) ?? null;
}

function tracked({ io, names }) {
  const where = resolve({ cwd: io.cwd, env: io.env, names });
  if (!where.active) {
    throw new RouteError('inactive', 'REFUSED', 'this repository is not tracked yet, so it has no tasks', {
      hint: `classify a plan without a task: ${names.bin} route --probe --paths <p,…> --loc <n>; or start tracking: ${names.bin} init --yes`,
    });
  }
  const store = open(where.dir, { names });
  const handle = callerHandle(store, where.repo, io.env);
  if (handle === null) {
    throw new RouteError('no-handle', 'REFUSED', 'the git user.email of this repository has no registered handle here', {
      hint: 'set git user.email to the address you registered with, or register this developer first',
    });
  }
  return { where, store, handle };
}

// The profile's risk globs of the state directory `dir` (classify adds them to the defaults): the scanned risk paths
// and the said fact riskGlobs; none before a scan or a said fact.
export const readProfileRiskPaths = ({ dir, names }) => riskGlobsOf(openStore(dir, names).read('profile'));

function probe(f, { io, names, readRisk }) {
  let where = null;
  try {
    where = resolve({ cwd: io.cwd, env: io.env, names });
  } catch (err) {
    if (!(err instanceof StateError && err.exit === 'ENV')) throw err; // outside git: paths stay as given
  }
  const riskPaths = where?.active ? readRisk({ dir: where.dir, names }) : [];
  const store = where?.active ? open(where.dir, { names }) : null;
  const thresholds = store ? routerThresholds(store) : undefined;
  const plan = classify({ paths: inRepo(where?.worktree ?? null, f.paths), loc: f.loc, flags: f.flags, riskPaths, thresholds });
  return {
    task: null, class: plan.class, computed: plan.class, previous: null, outcome: 'probed', escalated: false, reasons: [...plan.reasons, ...(store ? ignoredReasons(store) : [])],
    route: routeFor(plan.class, { flags: plan.flags }), addedSteps: [], decision: null, review: reviewShown(where?.active ? open(where.dir, { names }) : NO_STORE, plan.class, { names, env: io.env }), input: { files: plan.files, loc: plan.loc, flags: plan.flags },
  };
}

// A probe outside a tracked repository has no store: the applied tier is L0.
const NO_STORE = { read: () => null };

const HEADLINE = {
  classified: () => '',
  escalated: (d) => ` (raised from ${d.previous})`,
  held: (d) => ` (the plan is ${d.computed}; ${rank(d.computed) > rank(d.class) ? 'the user\'s override waived it' : 'the class only rises'})`,
  unchanged: () => ' (unchanged)',
  overridden: (d) => ` (overridden from ${d.previous}, decision ${d.decision})`,
  raised: (d) => ` (raised from ${d.previous} by the user)`,
  probed: () => ' (probe: nothing written)',
};

const fixed = (x) => x.toFixed(2);
const executorData = (cls, { io, names }) => suggestionFor(cls, { cwd: io.cwd, env: io.env, names });

function executorLines(ex) {
  return ex.results.map((r) => {
    if (r.executor === null) return `executor ${r.role}: role defaults (${r.reason})`;
    const c = r.cells.find((x) => x.executor === r.executor);
    return `executor ${r.role}: ${r.executor} (first pass ${fixed(c.firstPass.rate)}, 90% ${fixed(c.firstPass.lo)}-${fixed(c.firstPass.hi)}, ${c.tasks} tasks)`;
  });
}

function render(d, ex) {
  const lines = [`${d.task ?? 'plan'}: ${d.class}${HEADLINE[d.outcome](d)}`, `route: ${d.route.steps.join(' > ')}`];
  lines.push(`review: ${d.review.text}`);
  if (d.addedSteps.length) lines.push(`adds: ${d.addedSteps.join(', ')}`);
  lines.push(`outcome gates (the same for every class): ${d.route.gates.join(', ')}`, 'reasons:');
  for (const r of d.reasons) lines.push(`  - ${r.path ? `${r.path}: ` : ''}${r.text}`);
  if (ex) lines.push(...executorLines(ex));
  return `${lines.join('\n')}\n`;
}

// The command; `readProfileRiskPaths({ dir, names })` returns the profile's risk globs.
export function makeRoute({ readProfileRiskPaths: readRisk = readProfileRiskPaths } = {}) {
  return function route({ args, flags, names, io }) {
    try {
      const f = form(args, flags, names.bin);
      let data;
      if (f.kind === 'probe') data = { probe: true, ...probe(f, { io, names, readRisk }) };
      else {
        const { where, store, handle } = tracked({ io, names });
        const out = f.kind === 'override'
          ? { ...overrideTask(store, f.task, { to: flags.override, by: flags.by, quote: flags.quote, handle }), input: null }
          : routeTask(store, f.task, { paths: inRepo(where.worktree, f.paths), loc: f.loc, flags: f.flags, riskPaths: readRisk({ dir: where.dir, names }), handle });
        data = { probe: false, ...out, review: reviewShown(store, out.class, { names, env: io.env }) };
      }
      data = { task: data.task, probe: data.probe, class: data.class, computed: data.computed, previous: data.previous, outcome: data.outcome, escalated: data.escalated, reasons: data.reasons, route: data.route, addedSteps: data.addedSteps, decision: data.decision, review: data.review, input: data.input };
      if (flags.executor) data.executor = executorData(data.class, { io, names });
      return { data, text: render(data, data.executor) };
    } catch (err) {
      if (err instanceof RouteError || err instanceof StateError) return { code: EXIT[err.exit], errors: [err] };
      throw err;
    }
  };
}

export const route = makeRoute();
