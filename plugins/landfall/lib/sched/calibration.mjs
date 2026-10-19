// Calibration (spec §7.8, §7.8a, U12): cores, RAM and the platform memory method, with LOAD_MAX = 1.7 × cores,
// FREE_MIN = 30 % and the per-kind max as defaults. Written on first use and again when older than 30 days or when
// the cores or RAM changed; overrides (`slots calibrate`) survive a recalibration.
// Refused (§7.8a): FREE_MIN 0 (the memory check never turns off) and LOAD_MAX off while the load can be measured;
// where it cannot be measured the load check is off by itself.
import { join } from 'node:path';
import { writeAtomic } from '../fsx/index.mjs';
import { StateError } from '../state/index.mjs';
import { CALIBRATION, DEFAULTS, KIND_NAMES, MAX_SLOTS } from './kinds.mjs';
import { dataDirOf, locked, readDoc, toText } from './files.mjs';
import { readings } from './machine.mjs';

const fileOf = (dir) => join(dir, CALIBRATION.path());
const oneDecimal = (x) => (Math.round(x * 10) / 10).toFixed(1);
const usage = (code, message, hint) => new StateError(code, 'USAGE', message, { hint });

// Overrides checked against the readings: { loadMax?, freeMinPct?, max? }.
export function checkOverrides({ loadMax, freeMin, max } = {}, r) {
  const out = {};
  if (loadMax !== undefined) {
    if (loadMax === 'off') {
      if (r.loadMeasurable) throw usage('load-check-required', 'LOAD_MAX=off is refused while the load can be measured', 'set a number, such as 1.7 × cores');
      out.loadMax = 'off';
    } else {
      const s = String(loadMax);
      if (!/^\d{1,5}(?:\.\d+)?$/.test(s) || Number(s) <= 0) throw usage('invalid-value', `--load-max ${s}: expected a number above 0, or off`, 'such as 17 for 10 cores');
      out.loadMax = oneDecimal(Number(s));
    }
  }
  if (freeMin !== undefined) {
    const n = typeof freeMin === 'string' && freeMin.trim() === '' ? NaN : Number(freeMin);
    if (n === 0) throw usage('memory-check-required', 'FREE_MIN=0 is refused: the free memory check cannot be turned off', 'set a percentage from 1 to 95');
    if (!Number.isInteger(n) || n < 1 || n > 95) throw usage('invalid-value', `--free-min ${freeMin}: expected a whole percentage from 1 to 95`, 'such as 30');
    out.freeMinPct = n;
  }
  if (max !== undefined) {
    out.max = {};
    for (const [kind, value] of Object.entries(max)) {
      if (!KIND_NAMES.includes(kind)) throw usage('invalid-value', `--max ${kind}: unknown kind`, `kinds: ${KIND_NAMES.join(', ')}`);
      if (!Number.isInteger(value) || value < 1 || value > MAX_SLOTS) throw usage('invalid-value', `--max ${kind}=${value}: expected 1 to ${MAX_SLOTS}`, 'such as heavy=1');
      out.max[kind] = value;
    }
  }
  return out;
}

function compute(r, overrides) {
  const keepOff = overrides.loadMax !== 'off' || !r.loadMeasurable; // a machine that can measure load again checks it
  const loadMax = overrides.loadMax !== undefined && keepOff ? overrides.loadMax : r.loadMeasurable ? oneDecimal(DEFAULTS.loadFactor * r.cores) : 'off';
  return {
    schema: CALIBRATION.version,
    at: new Date().toISOString(),
    cores: r.cores,
    totalMemBytes: r.totalBytes,
    memMethod: r.memMethod,
    loadMeasurable: r.loadMeasurable,
    loadMax,
    freeMinPct: overrides.freeMinPct ?? DEFAULTS.freeMinPct,
    max: Object.fromEntries(KIND_NAMES.map((k) => [k, overrides.max?.[k] ?? DEFAULTS.max[k]])),
    overrides,
  };
}

const isDue = (doc, r) => Date.now() - Date.parse(doc.at) > DEFAULTS.recalibrateDays * 86400e3 || doc.cores !== r.cores || doc.totalMemBytes !== r.totalBytes;

const newer = (file) => new StateError('schema-newer', 'REFUSED', `${file} has a newer schema than this plugin knows`, { hint: 'update the plugin, then retry' });

// Inside the scheduler lock: the saved calibration, recalibrated first when missing, unreadable or due.
export function ensureCalibration(dir, r) {
  const file = fileOf(dir);
  const found = readDoc(CALIBRATION, file);
  if (found.newer) throw newer(file);
  if (found.doc && !isDue(found.doc, r)) return found.doc;
  const doc = compute(r, found.doc?.overrides ?? {});
  writeAtomic(file, toText(CALIBRATION, doc));
  return doc;
}

// Read-only: { calibration, saved, due }; defaults from the readings when nothing is saved.
export function currentCalibration(opts = {}) {
  const r = opts.readings ?? readings();
  const file = fileOf(dataDirOf(opts));
  const found = readDoc(CALIBRATION, file);
  if (found.newer) throw newer(file);
  if (found.doc) return { calibration: found.doc, saved: true, due: isDue(found.doc, r) };
  return { calibration: compute(r, {}), saved: false, due: true };
}

// `slots calibrate`: overrides { loadMax, freeMin, max } merged into the saved ones; returns the saved calibration.
export function calibrate(opts = {}) {
  const dir = dataDirOf(opts);
  const r = opts.readings ?? readings();
  const given = checkOverrides(opts, r);
  return locked(dir, () => {
    const file = fileOf(dir);
    const found = readDoc(CALIBRATION, file);
    if (found.newer) throw newer(file);
    const before = found.doc?.overrides ?? {};
    const overrides = { ...before, ...given };
    if (before.max || given.max) overrides.max = { ...before.max, ...given.max };
    const doc = compute(r, overrides);
    writeAtomic(file, toText(CALIBRATION, doc));
    return doc;
  }, { timeoutMs: opts.lockTimeoutMs, names: opts.names });
}
