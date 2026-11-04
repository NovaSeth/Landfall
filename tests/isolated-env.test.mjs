// relaxAdmission (T-MG-156): an isolated env's scheduler admits whatever the machine's load and free memory are.
// Run: node --test tests/isolated-env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedEnv, relaxAdmission } from './helpers/isolated-env.mjs';
import { lib, names } from './helpers/hook-fixture.mjs';

const { admissionReasons, currentCalibration } = await lib('sched/index.mjs');
const busy = { cores: 8, load1: 500, loadMeasurable: true, totalBytes: 1e10, availBytes: 1e8, freePct: 1, memMethod: 'test' };

test('an isolated env admits under a load and memory pressure far above the defaults', (t) => {
  const iso = isolatedEnv({ prefix: 'relax-admission-' });
  t.after(iso.cleanup);
  const before = currentCalibration({ names, env: iso.env, readings: busy }).calibration;
  assert.ok(admissionReasons(busy, before).length > 0, 'default limits refuse this reading');
  relaxAdmission(iso.env);
  const { calibration, saved } = currentCalibration({ names, env: iso.env, readings: busy });
  assert.equal(saved, true);
  assert.deepEqual(admissionReasons(busy, calibration), []);
});
