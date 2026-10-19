// Method meaning guards: safety-critical rules keep their normative phrases, and verified legacy mappings
// keep their targets. Structure checks live in method.test.mjs; these tests fail when a rule's meaning or
// a mapping is changed, so such a change needs a deliberate edit of the pinned tables below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDir } from '../scripts/gen-method-index.mjs';

const METHOD = join(pluginDir(join(dirname(fileURLToPath(import.meta.url)), '..')), 'method');
const read = (f) => readFileSync(join(METHOD, f), 'utf8');
const everyFile = (rel = '') => readdirSync(join(METHOD, rel)).flatMap((f) => (statSync(join(METHOD, rel, f)).isDirectory() ? everyFile(join(rel, f)) : [join(rel, f)]));
const index = JSON.parse(read('index.json'));
const legacy = JSON.parse(read('legacy-ids.json')).rules;
const ruleText = (id) => {
  const r = index.rules[id];
  if (!r) return null;
  return read(r.file).split('\n')[r.line - 1].replace(/^\*\*[A-Z]{3}-\d+\.\*\* /, '');
};

// Safety-critical core rules (outcome gates, test oracle, loop termination, guard model, secrets,
// security release, review gates) → phrases each MUST keep, verbatim.
const PINNED_RULES = {
  'PRI-3': ['MUST NOT receive session history', 'takes them literally'],
  'PRI-5': ['MUST NOT write feature code'],
  'PRI-6': ['The author never reviews', 'scoped re-review', 'MUST NOT replace', 'data, writes, authorization or concurrency'],
  'PRI-7': ['change only through a shared task', 'a lane task changes only its own directory'],
  'PRI-11': ['MUST NOT report success for a write that did not happen'],
  'PRI-13': ['behavior and data, not pixels', 'REV-13'],
  'PRI-14': ['an instruction alone is not enforcement'],
  'PRI-15': ['identical for every tier and task class', 'does not shrink without a decision', 'RED/GREEN evidence'],
  'PRI-17': ['Ask the human only before irreversible actions'],
  'PRI-18': ['MUST NOT dispatch an executor without a written brief'],
  'FLW-4': ['CLI `tick`', 'DONE, STALLED, BUDGET → stop'],
  'FLW-5': ['wakeup prompt is fixed', 'MUST NOT schedule another wakeup'],
  'FLW-6': ['exit code AND the count of results', 'is not success'],
  'FLW-7': ['MUST NOT edit state files by hand'],
  'FLW-8': ['closes only after verify passed for the current HEAD', 'never closes a task'],
  'COD-1': ['Write the test first', 'show the failure and its reason'],
  'COD-2': ['A test MUST discriminate', 'one change fails', 'mutation'],
  'COD-3': ['MUST NOT remove, skip or weaken a test without a decision'],
  'COD-5': ['has one source'],
  'COD-8': ['property test', "alters the user's content"],
  'COD-13': ['2 tool error (never "clean")', 'is void'],
  'COD-15': ['E2E test files stay unchanged'],
  'ORC-12': ['only with `git merge origin/main`', 'MUST NOT rebase after review'],
  'ORC-13': ['MUST NOT use `git stash`'],
  'ORC-17': ['MUST NOT patch a missing contract or shared part locally', 'NEEDS_CONTEXT'],
  'REV-3': ['MUST reproduce every Critical and Important finding'],
  'REV-6': ['ADDRESSED or NOT ADDRESSED', "only the round's diff"],
  'REV-7': ['MUST NOT start a third', 'Critical findings are exempt'],
  'REV-10': ['secrets scan run without a pipe', 'clean tree'],
  'REV-11': ['merges `origin/main` into the task branch and re-runs verify'],
  'REV-13': ['Critical or High security finding', 'blocks a gate'],
  'REV-16': ['MUST NOT quarantine Review Focus tests'],
  'REV-17': ['`review record`', 'approved | needs-fixes', 'closes nothing'],
  'REV-20': ['for data, writes, authorization or concurrency it MUST NOT'],
  'SEC-3': ['not a security boundary', 'blocked when state cannot be read'],
  'SEC-4': ['MUST NOT bypass a guard block', '--no-verify'],
  'SEC-5': ['MUST NOT put them in', 'never the value'],
  'SEC-6': ['without a pipe', '8 = error, not clean'], // the exit code of the command table (1.x: 2)
  'SEC-7': ['rotate the secret', 'does not close the case'],
  'SEC-8': ['only from the credential', 'returns 404, not 403'],
  'SEC-9': ['MUST NOT release with an open High or Critical finding'],
  'SEC-10': ['MUST enable the hard boundaries', 'branch protection', 'pre-push secrets scan', 'CI secrets scan'],
  'SEC-11': ['only in test and fixture files', 'MUST NOT loosen patterns or exclude files'],
  'SEC-12': ['Fail closed', 'refusal, never mock mode'],
  'MEM-2': ['append-only', "MUST NOT edit an old record's content"],
  'MEM-8': ['MUST NOT edit them afterwards', 'needs a human decision'],
  'TRP-2': ['MUST NOT run a gate through a pipe'],
  'TRP-6': ['MUST NOT force-push `main` or `master`'],
  'TRP-14': ['hard time limit', 'no-output limit', 'its own exit code'],
  'TRP-15': ['never wait in the queue they control'],
};

// Safety-critical pack rules (security: blocking findings, limits of security testing, secret leaks;
// team: lane claims; release: gates) → their pack and the phrases each MUST keep, verbatim.
// While the 1.x method documents exist, the docs test resolves every ID with a prefix shared by 1.x and v2
// (DSC, RUN, REV, SPC, MEM, RES) against them, so v2 rules numbered past the 1.x range are not pinned here yet.
const PINNED_PACK_RULES = {
  'SCD-3': ['security', ['MUST cover', 'never from BFF headers']],
  'SCD-5': ['security', ['double gate', 'MUST refuse to start in production']],
  'SCD-17': ['security', ['MUST NOT send requests to external systems, staging or production']],
  'SCD-18': ['security', ['MUST NOT write working exploits']],
  'SCD-20': ['security', ['MUST hold the merge', 'scoped re-review']],
  'SCD-25': ['security', ['MUST NOT run load tests or scans', "without the PO's consent"]],
  'SCD-33': ['security', ['rotate the secret first', 'never the value']],
  'SCD-34': ['security', ['full history', 'every built artifact']],
  'COL-3': ['team', ['never approves it']],
  'COL-6': ['team', ['one orchestrator at a time', 'MUST NOT dispatch agents in a lane claimed by another person']],
  'COL-7': ['team', ['`lane claim <lane>` before the first dispatch']],
  'COL-8': ['team', ['MUST NOT work around the claim mechanism']],
  'COL-11': ['team', ['only after agreeing with its owner', 'recording a decision', 'never passes to anyone by itself']],
  'COL-12': ['team', ['MUST NOT cover the claim refs', 'never merge a claim ref']],
  'COL-13': ['team', ['two lanes MUST NOT share a directory']],
  'COL-17': ['team', ["MUST NOT dispatch another orchestrator's task or record its state"]],
  'COL-20': ['team', ['MUST NOT patch a gap in a shared part', 'NEEDS_CONTEXT']],
  'REL-1': ['release', ['Before every test and production release, run a full security audit']],
  'REL-2': ['release', ['A test release MUST meet', 'no open High or Critical finding', 'Medium findings have tasks with due dates', 'clean secrets, key-leak and production-dependency scans']],
  'REL-3': ['release', ['A test release MUST also meet', "only over TLS or the tester's loopback", 'external-system keys only for demo environments']],
  'REL-4': ['release', ['A production release additionally MUST meet', 'TLS 1.2 or newer with HSTS and security headers', 'a non-public OpenAPI']],
  'REL-5': ['release', ['additionally MUST meet', 'key rotation and keys per environment']],
  'REL-6': ['release', ['additionally MUST meet', 'without a High finding']],
  'REL-7': ['release', ['needs a decision']],
  'RUN-1': ['runbooks', ['from the release tag', 'scoped re-review is mandatory']],
  'RUN-3': ['runbooks', ['only after the secrets scan', 'never by cherry-pick']],
  'RUN-6': ['runbooks', ['first stop the damage', 'a human with access performs every action in production']],
  'SVC-22': ['backend-data', ['up → down → up', "an irreversible one needs a decision, the PO's consent"]],
  'SVC-25': ['backend-data', ['only against your own stack', "exception with the PO's consent: security pack, SCD-25"]],
  'SVC-16': ['backend-data', ['only from the credential, never from the client']],
  'WRT-1': ['backend-data', ['one sending function', 'no write definition bypasses it']],
  'WRT-2': ['backend-data', ['MUST NOT retry a failed write with a new `mutate`']],
  'WRT-9': ['backend-data', ['MUST NOT store a 5xx response']],
  'CTR-15': ['backend-data', ['MUST NOT import the data world or test doubles in application code']],
  'DSG-5': ['design-system', ['MUST NOT put a raw value into the semantic collection']],
  'DSG-29': ['design-system', ['MUST start with a file guard']],
  'DSG-49': ['design-system', ['only in a shared task', 'NEEDS_CONTEXT']],
  'SCR-1': ['design-system', ['MUST NOT show an error as "no data"']],
  'SCR-9': ['design-system', ['MUST NOT assert names or amounts']],
  'SCR-21': ['design-system', ['not pixels (PRI-13)']],
  'SCR-25': ['design-system', ['MUST NOT create decisions']],
  'DSC-9': ['discovery', ['MUST NOT state a claim without the full URL of its source']],
  'DSC-38': ['discovery', ['MUST be private']],
};

// The session-start set: a change here is a deliberate decision, not drift.
const PINNED_ALWAYS = ['COD-3', 'FLW-4', 'FLW-5', 'FLW-8', 'PRI-3', 'PRI-5', 'PRI-6', 'PRI-17'];

// Legacy mappings checked against the 1.x rule text: core ID, "pack:<name>[:<ID>]", or "retired:<phrase in the reason>".
const PINNED_LEGACY = {
  'ZAS-3': 'PRI-2', 'ZAS-4': 'PRI-3', 'ZAS-6': 'PRI-5', 'ZAS-7': 'PRI-6', 'ZAS-8': 'PRI-6', 'ZAS-10': 'REV-7',
  'ZAS-11': 'PRI-8', 'ZAS-14': 'PRI-11', 'ZAS-16': 'PRI-13', 'ZAS-17': 'PRI-14', 'ZAS-20': 'PRI-17', 'ZAS-21': 'PRI-7',
  'PRC-12': 'FLW-6', 'PRC-15': 'FLW-5', 'PRC-16': 'FLW-4', 'PRC-18': 'FLW-7', 'PRC-20': 'FLW-8', 'PRC-21': 'PRI-18', 'PRC-23': 'FLW-5',
  'SPC-5': 'SPC-3', 'SPC-12': 'SPC-6', 'SPC-20': 'SPC-4', 'SPC-25': 'SPC-11', 'SPC-27': 'SPC-13', 'SPC-28': 'SPC-14',
  'KOD-3': 'PRI-7', 'KOD-4': 'ORC-17', 'KOD-7': 'COD-5', 'KOD-40': 'COD-3', 'KOD-57': 'COD-1', 'KOD-59': 'COD-2',
  'KOD-60': 'COD-15', 'KOD-65': 'COD-13', 'KOD-75': 'COD-13', 'KOD-21': 'pack:backend-data:WRT-1', 'KOD-82': 'pack:backend-data:SVC-21',
  'KOD-22': 'pack:backend-data:WRT-2', 'KOD-28': 'pack:backend-data:WRT-8', 'KOD-51': 'pack:backend-data:SVC-16', 'KOD-83': 'pack:backend-data:SVC-22',
  'ORK-9': 'TRP-16', 'ORK-10': 'ORC-3', 'ORK-18': 'ORC-15', 'ORK-19': 'ORC-16', 'ORK-24': 'ORC-7', 'ORK-33': 'ORC-12',
  'ORK-37': 'ORC-13', 'ORK-59': 'PRI-17',
  'RES-19': 'retired:FIFO tickets', 'RES-20': 'retired:one e2e ticket per worktree', 'RES-21': 'retired:result analysis runs outside the lease',
  'RES-22': 'TRP-11', 'RES-23': 'TRP-14', 'RES-25': 'TRP-15', 'RES-26': 'retired:reaps orphans', 'RES-36': 'FLW-6',
  'RES-7': 'retired:refuses FREE_MIN=0', 'RES-41': 'retired:LOAD_MAX=off',
  'REV-3': 'PRI-6', 'REV-7': 'REV-3', 'REV-10': 'REV-17', 'REV-16': 'REV-18', 'REV-18': 'REV-20', 'REV-21': 'REV-19',
  'REV-23': 'REV-7', 'REV-38': 'REV-13', 'REV-45': 'COD-2', 'REV-53': 'REV-16', 'REV-54': 'COD-5', 'REV-57': 'COD-8', 'REV-58': 'COD-9',
  'BZP-6': 'SEC-8', 'BZP-7': 'SEC-5', 'BZP-10': 'SEC-12', 'BZP-16': 'SEC-6', 'BZP-18': 'SEC-11', 'BZP-20': 'SEC-10',
  'BZP-27': 'SEC-5', 'BZP-40': 'SEC-9', 'BZP-45': 'SEC-7', 'BZP-46': 'SEC-4', 'BZP-50': 'SEC-4', 'BZP-51': 'SEC-3',
  'BZP-29': 'pack:security:SCD-20', 'BZP-39': 'pack:release:REL-2', 'BZP-43': 'pack:release:REL-1', 'BZP-44': 'pack:release:REL-7', 'BZP-4': 'pack:security:SCD-3', 'BZP-8': 'pack:security:SCD-5',
  'BZP-25': 'pack:security:SCD-17', 'BZP-26': 'pack:security:SCD-18', 'BZP-34': 'pack:security:SCD-25',
  'MEM-14': 'MEM-2', 'MEM-19': 'FLW-7', 'MEM-27': 'MEM-9', 'MEM-28': 'MEM-10', 'MEM-40': 'FLW-7', 'MEM-48': 'MEM-8',
  'PUL-3': 'TRP-2', 'PUL-7': 'TRP-17', 'PUL-14': 'ORC-13', 'PUL-28': 'TRP-19', 'PUL-42': 'TRP-20', 'PUL-44': 'TRP-18', 'PUL-48': 'TRP-6',
  'PUL-45': 'retired:out of scope', 'PUL-46': 'retired:out of scope', 'PUL-47': 'retired:out of scope',
  'WDR-2': 'PRI-15', 'WDR-5': 'PRI-13', 'WDR-24': 'retired:`doctor` and the generated CI template fail',
  'KOD-74': "retired:superseded by code: the generated CI gate re-runs the project's verify gates", 'ZES-21': 'PRI-7', 'ZES-8': 'pack:team:COL-7', 'ZES-4': 'pack:team:COL-6', 'ZES-7': 'pack:team:COL-6', 'ZES-10': 'pack:team:COL-8',
  'ZES-13': 'pack:team:COL-11', 'ZES-14': 'pack:team:COL-12', 'SPC-21': 'pack:team:COL-13', 'ORK-35': 'pack:team:COL-20',
  'PRC-22': 'pack:team:COL-17', 'SPC-37': 'retired:T-<handle>-<n>', 'ZES-32': 'retired:handles are registered by the CLI',
  'RUN-2': 'ORC-12', 'RUN-4': 'REV-16', 'RUN-5': 'pack:runbooks:RUN-1', 'RUN-6': 'TRP-6', 'RUN-11': 'COD-4',
  'RUN-7': 'pack:runbooks:RUN-6', 'RUN-10': 'pack:runbooks:RUN-13',
  'DSC-8': 'pack:discovery:DSC-9', 'DSC-36': 'pack:discovery:DSC-38', 'DSC-47': 'pack:discovery:DSC-50', 'DSN-5': 'pack:design-system:DSG-5', 'DSN-29': 'pack:design-system:DSG-29', 'DSN-49': 'pack:design-system:DSG-49',
  'KOD-32': 'pack:design-system:SCR-1', 'DSN-63': 'pack:design-system:SCR-25',
};

test('invariants: safety-critical rules are live core rules that keep their normative phrases', () => {
  for (const [id, phrases] of Object.entries(PINNED_RULES)) {
    const r = index.rules[id];
    assert.ok(r && !r.retired && r.pack === 'core', `${id} must be a live core rule`);
    const text = ruleText(id);
    for (const p of phrases) assert.ok(text.includes(p), `${id} lost "${p}": ${text}`);
  }
});

test('invariants: no pinned rule is softened into a permission', () => {
  for (const id of Object.keys(PINNED_RULES)) assert.doesNotMatch(ruleText(id), /\b(may|optionally|if convenient|where possible)\b.*\b(release|skip|bypass|merge|close)\b/i, id);
});

test('invariants: safety-critical pack rules are live rules of their pack that keep their normative phrases', () => {
  for (const [id, [pack, phrases]] of Object.entries(PINNED_PACK_RULES)) {
    const r = index.rules[id];
    assert.ok(r && !r.retired && r.pack === pack, `${id} must be a live rule of pack ${pack}`);
    const text = ruleText(id);
    for (const p of phrases) assert.ok(text.includes(p), `${id} lost "${p}": ${text}`);
    assert.doesNotMatch(text, /\b(may|optionally|if convenient|where possible)\b.*\b(release|skip|bypass|merge|close)\b/i, id);
  }
});

test('invariants: every MUST-bearing rule of the security, release and team packs is pinned with its MUST clause', () => {
  // Derived from the text, so a new gate rule cannot stay unpinned.
  const must = Object.entries(index.rules).filter(([, r]) => ['security', 'release', 'team'].includes(r.pack) && !r.retired)
    .map(([id]) => id).filter((id) => /\bMUST\b/.test(ruleText(id)));
  assert.ok(must.length >= 15, `MUST-bearing pack rules: ${must.length}`);
  const unpinned = must.filter((id) => !PINNED_PACK_RULES[id]?.[1].some((p) => /\bMUST\b/.test(p)));
  assert.deepEqual(unpinned, [], 'MUST-bearing rules without a pinned MUST phrase');
});

test('invariants: the always set is exactly the pinned session-start set', () => {
  assert.deepEqual([...index.always].sort(), [...PINNED_ALWAYS].sort());
});

test('invariants: pinned legacy mappings keep their verified targets', () => {
  assert.ok(Object.keys(PINNED_LEGACY).length >= 40);
  for (const [old, want] of Object.entries(PINNED_LEGACY)) {
    const t = legacy[old];
    assert.ok(t, `${old} missing from the legacy table`);
    if (want.startsWith('pack:')) {
      const [, pack, id] = want.split(':');
      assert.equal(t.pack, pack, `${old} → ${JSON.stringify(t)}`);
      if (id) assert.equal(t.id, id, `${old} → ${JSON.stringify(t)}`);
    }
    else if (want.startsWith('retired:')) assert.ok(t.retired?.includes(want.slice(8)), `${old} → ${JSON.stringify(t)}`);
    else assert.equal(t.core, want, `${old} → ${JSON.stringify(t)}`);
  }
});

test('invariants: a legacy rule maps to a core rule of its own topic family or of a pinned exception', () => {
  // Cross-topic core targets are deliberate merges; each one is listed here.
  const family = { ZAS: ['PRI'], PRC: ['FLW'], SPC: ['SPC'], KOD: ['COD'], ORK: ['ORC'], RES: ['RES'], REV: ['REV'], BZP: ['SEC'], MEM: ['MEM'], PUL: ['TRP'], WDR: ['ADP'], ZES: ['COL'], RUN: ['RUN'], DSC: ['DSC'], DSN: ['DSG'] };
  const CROSS = new Set([
    'ZAS-9', 'ZAS-10', 'ZAS-18', 'PRC-5', 'PRC-6', 'PRC-7', 'PRC-8', 'PRC-9', 'PRC-11', 'PRC-19', 'PRC-21', 'SPC-18',
    'KOD-1', 'KOD-3', 'KOD-4', 'KOD-35', 'KOD-67', 'KOD-68', 'KOD-70', 'KOD-71', 'KOD-73', 'ORK-1', 'ORK-2', 'ORK-3',
    'ORK-5', 'ORK-9', 'ORK-14', 'ORK-28', 'ORK-31', 'ORK-34', 'ORK-38', 'ORK-39', 'ORK-49', 'ORK-55', 'ORK-58', 'ORK-59',
    'ORK-60', 'RES-3', 'RES-5', 'RES-11', 'RES-13', 'RES-15', 'RES-16', 'RES-22', 'RES-23', 'RES-25', 'RES-30', 'RES-32',
    'RES-33', 'RES-34', 'RES-35', 'RES-36', 'RES-37', 'RES-38', 'RES-39', 'RES-40', 'REV-2', 'REV-3', 'REV-4', 'REV-26',
    'REV-39', 'REV-45', 'REV-46', 'REV-47', 'REV-50', 'REV-51', 'REV-54', 'REV-55', 'REV-56', 'REV-57', 'REV-58', 'BZP-17',
    'MEM-4', 'MEM-6', 'MEM-9', 'MEM-10', 'MEM-12', 'MEM-13', 'MEM-17', 'MEM-19', 'MEM-21', 'MEM-22', 'MEM-23', 'MEM-33',
    'MEM-34', 'MEM-38', 'MEM-40', 'MEM-41', 'MEM-53', 'MEM-54', 'PUL-1', 'PUL-9', 'PUL-14', 'PUL-15', 'PUL-16', 'PUL-17',
    'PUL-20', 'PUL-21', 'PUL-26', 'PUL-30', 'PUL-32', 'PUL-33', 'PUL-34', 'PUL-35', 'PUL-36', 'PUL-37', 'PUL-39', 'PUL-41',
    'WDR-2', 'WDR-4', 'WDR-5', 'WDR-6', 'WDR-7', 'WDR-8', 'WDR-12', 'WDR-22', 'WDR-25', 'ZES-19', 'ZES-21', 'ZES-24',
    'RUN-1', 'RUN-2', 'RUN-3', 'RUN-4', 'RUN-6', 'RUN-11', 'RUN-13']);
  const unexpected = Object.entries(legacy).filter(([old, t]) => t.core && !family[old.slice(0, 3)].includes(t.core.slice(0, 3)) && !CROSS.has(old));
  assert.deepEqual(unexpected.map(([old, t]) => `${old} → ${t.core}`), []);
});

test('invariants: a legacy rule maps to a pack of its own topic family or to a listed cross-family pack', () => {
  // DSC rules may later move to a data-world pack; every other mapping outside its family is listed per pack.
  const family = { DSC: ['discovery', 'data-world'], DSN: ['design-system'], BZP: ['security'], ZES: ['team'], RUN: ['runbooks'], KOD: ['backend-data'] };
  const CROSS = {
    team: ['PRC-22', 'SPC-21', 'SPC-23', 'SPC-24', 'KOD-2', 'ORK-35', 'ORK-36', 'MEM-18', 'WDR-18'],
    release: ['SPC-11', 'REV-27', 'REV-28', 'REV-29', 'REV-30', 'BZP-39', 'BZP-43', 'BZP-44', 'WDR-11', 'ZES-39'],
    'backend-data': ['SPC-17', 'SPC-32', 'SPC-33', 'SPC-34', 'SPC-36'],
    discovery: ['KOD-10', 'DSN-50'],
    'design-system': ['KOD-32', 'KOD-33', 'KOD-34', 'KOD-36', 'KOD-37', 'KOD-38', 'KOD-63', 'KOD-64', 'ORK-21', 'REV-41', 'PUL-31', 'PUL-38', 'PUL-43'],
    security: ['MEM-49', 'MEM-50', 'ZES-26'],
    runbooks: ['PUL-11'],
  };
  const unexpected = Object.entries(legacy).filter(([old, t]) => t.pack && !(family[old.slice(0, 3)] ?? []).includes(t.pack) && !(CROSS[t.pack] ?? []).includes(old));
  assert.deepEqual(unexpected.map(([old, t]) => `${old} → ${t.pack}`), []);
  for (const [pack, ids] of Object.entries(CROSS)) for (const old of ids) assert.equal(legacy[old]?.pack, pack, `${old}: listed cross-family mapping to ${pack} is stale`);
});

test('invariants: shipped method files carry no process references (plan tasks, spec sections, decisions, control repo)', () => {
  const PROCESS = [
    [/\bI\d+(?:\.\d+)?\b/, 'plan task ID'],
    [/\bSD-\d+/, 'spec decision ID'],
    [/§\d/, 'spec section number'],
    [/\bR\d+\b/, 'ruling ID'],
    [/petla|control repo/i, 'control repository'],
  ];
  const found = [];
  for (const f of everyFile()) {
    read(f).split('\n').forEach((line, i) => {
      for (const [re, what] of PROCESS) { const m = line.match(re); if (m) found.push(`${f}:${i + 1}: ${what} "${m[0]}"`); }
    });
  }
  assert.deepEqual(found, []);
});
