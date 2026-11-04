// relaxAdmission (T-MG-156): an isolated env's scheduler admits whatever the machine's load and free memory are.
// T-MG-163: isolatedEnv and isolateProcessEnv relax admission themselves unless the caller passes { admission: 'real' }.
// Run: node --test tests/isolated-env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedEnv, isolateProcessEnv, relaxAdmission } from './helpers/isolated-env.mjs';
import { lib, names } from './helpers/hook-fixture.mjs';

const { acquire, admissionReasons, currentCalibration, release } = await lib('sched/index.mjs');
const busy = { cores: 8, load1: 500, loadMeasurable: true, totalBytes: 1e10, availBytes: 1e8, freePct: 1, memMethod: 'test' };

test('an isolated env admits under a load and memory pressure far above the defaults', (t) => {
  const iso = isolatedEnv({ prefix: 'relax-admission-', admission: 'real' });
  t.after(iso.cleanup);
  const before = currentCalibration({ names, env: iso.env, readings: busy }).calibration;
  assert.ok(admissionReasons(busy, before).length > 0, 'default limits refuse this reading');
  relaxAdmission(iso.env);
  const { calibration, saved } = currentCalibration({ names, env: iso.env, readings: busy });
  assert.equal(saved, true);
  assert.deepEqual(admissionReasons(busy, calibration), []);
});

const heavy = (env, cwd) => acquire('heavy', { names, env, cwd, mode: 'on', owner: { pid: process.pid }, readings: busy });

test('T-MG-163: a default isolated env admits a heavy lease at load 500; { admission: \'real\' } keeps the real calibration', (t) => {
  const relaxed = isolatedEnv({ prefix: 'relax-default-' });
  t.after(relaxed.cleanup);
  const got = currentCalibration({ names, env: relaxed.env, readings: busy });
  assert.equal(got.saved, true, 'the default isolated env saves a calibration');
  assert.deepEqual(admissionReasons(busy, got.calibration), [], 'load 500 and 1 % free memory are admitted');
  const lease = heavy(relaxed.env, relaxed.base);
  assert.equal(lease.ok, true, JSON.stringify(lease));
  release(lease.lease, { names, env: relaxed.env });

  const real = isolatedEnv({ prefix: 'relax-real-', admission: 'real' });
  t.after(real.cleanup);
  const kept = currentCalibration({ names, env: real.env, readings: busy });
  assert.equal(kept.saved, false, 'nothing saved: the defaults from the readings');
  assert.ok(admissionReasons(busy, kept.calibration).length > 0, 'the real calibration refuses load 500');
  const refused = heavy(real.env, real.base);
  assert.equal(refused.ok, false, 'a heavy lease at load 500 is refused with the real calibration');
  assert.ok(refused.reasons.some((r) => /load/.test(r.message)), JSON.stringify(refused.reasons));
  assert.throws(() => isolatedEnv({ admission: 'off' }), /admission/, 'an unknown admission value is refused');
});

test('T-MG-163: isolateProcessEnv relaxes admission too, unless { admission: \'real\' }', () => {
  const relaxed = isolateProcessEnv({ prefix: 'relax-proc-' });
  try {
    assert.deepEqual(admissionReasons(busy, currentCalibration({ names, env: process.env, readings: busy }).calibration), []);
  } finally { relaxed.cleanup(); }
  const real = isolateProcessEnv({ prefix: 'relax-proc-real-', admission: 'real' });
  try {
    assert.equal(currentCalibration({ names, env: process.env, readings: busy }).saved, false);
  } finally { real.cleanup(); }
});
