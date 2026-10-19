// Field checks for state files (spec §5): strict objects, typed fields, length limits and patterns. A spec is
// plain data; any spec may carry `null: true`:
//   { t: 'int', min, max } · { t: 'str', max, min, re } · { t: 'enum', of } · { t: 'time' } (ISO 8601 with offset)
//   { t: 'obj', f: { name: spec }, opt: [optional names] } · { t: 'map', key: { t: 'str', … }, v: spec, max }
//   { t: 'arr', of: spec, max } · { t: 'data', maxBytes } (a plain JSON object, measured serialized in bytes)
// A document validates only when it also survives its own serialization unchanged (validate below).
// validate() returns [{ path, code, message }]: code `limit-exceeded` for a length, count or size over its limit
// (spec §5: such a write fails, never truncates), `invalid-value` for anything else. Strings are counted in
// characters and refuse control, zero-width and bidi characters. serialize() writes keys in spec order (map keys
// sorted), 2-space indent and a trailing newline; call it only on a document that validates.
import { isDeepStrictEqual } from 'node:util';

const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const MAX_MESSAGE = 300;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const join = (path, key) => (path === '' ? String(key) : `${path}.${key}`);
const show = (v) => {
  let s;
  try { s = JSON.stringify(v) ?? String(v); } catch { s = typeof v === 'bigint' ? `${v}n` : `a ${typeof v}`; }
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

function err(errors, path, code, text) {
  const message = `${path || 'document'}: ${text}`;
  errors.push({ path, code, message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message });
}

function checkStr(spec, v, path, errors) {
  if (typeof v !== 'string') return err(errors, path, 'invalid-value', `expected a string, got ${show(v)}`);
  const length = [...v].length;
  if (spec.max !== undefined && length > spec.max) return err(errors, path, 'limit-exceeded', `${length} characters, the limit is ${spec.max}`);
  if (length < (spec.min ?? 0)) return err(errors, path, 'invalid-value', `at least ${spec.min} characters required`);
  if (FORBIDDEN.test(v)) return err(errors, path, 'invalid-value', 'control, zero-width or bidi characters are not allowed');
  if (spec.re && !spec.re.test(v)) return err(errors, path, 'invalid-value', `${show(v)} does not match ${spec.re}`);
}

function check(spec, v, path, errors) {
  if (v === null && spec.null) return;
  if (v === undefined) return err(errors, path, 'invalid-value', 'missing');
  switch (spec.t) {
    case 'int':
      if (!Number.isInteger(v)) return err(errors, path, 'invalid-value', `expected an integer, got ${show(v)}`);
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) return err(errors, path, 'invalid-value', `${v} is outside ${spec.min ?? '-∞'}..${spec.max ?? '∞'}`);
      return;
    case 'str':
      return checkStr(spec, v, path, errors);
    case 'enum':
      if (!spec.of.includes(v)) return err(errors, path, 'invalid-value', `${show(v)} is not one of ${spec.of.join('|')}`);
      return;
    case 'time':
      if (typeof v !== 'string' || !TIME.test(v) || Number.isNaN(Date.parse(v))) return err(errors, path, 'invalid-value', `${show(v)} is not an ISO 8601 time with an offset`);
      return;
    case 'data': {
      if (!isObject(v)) return err(errors, path, 'invalid-value', 'expected an object');
      let bytes;
      try { bytes = Buffer.byteLength(JSON.stringify(v)); } catch { return err(errors, path, 'invalid-value', 'not serializable as JSON'); }
      if (bytes > spec.maxBytes) return err(errors, path, 'limit-exceeded', `${bytes} bytes, the limit is ${spec.maxBytes}`);
      return;
    }
    case 'arr':
      if (!Array.isArray(v)) return err(errors, path, 'invalid-value', 'expected an array');
      if (spec.max !== undefined && v.length > spec.max) return err(errors, path, 'limit-exceeded', `${v.length} items, the limit is ${spec.max}`);
      v.forEach((item, i) => check(spec.of, item, join(path, i), errors));
      return;
    case 'map': {
      if (!isObject(v)) return err(errors, path, 'invalid-value', 'expected an object');
      const keys = Object.keys(v);
      if (spec.max !== undefined && keys.length > spec.max) return err(errors, path, 'limit-exceeded', `${keys.length} entries, the limit is ${spec.max}`);
      for (const k of keys) {
        const before = errors.length;
        checkStr(spec.key, k, join(path, k), errors);
        if (errors.length === before) check(spec.v, v[k], join(path, k), errors);
      }
      return;
    }
    case 'obj': {
      if (!isObject(v)) return err(errors, path, 'invalid-value', 'expected an object');
      for (const k of Object.keys(v)) if (!Object.hasOwn(spec.f, k)) err(errors, join(path, k), 'invalid-value', 'unknown field');
      for (const [k, fieldSpec] of Object.entries(spec.f)) {
        if (!Object.hasOwn(v, k) && spec.opt?.includes(k)) continue;
        check(fieldSpec, v[k], join(path, k), errors);
      }
      return;
    }
    default:
      throw new Error(`schema: unknown spec type ${spec.t}`);
  }
}

// The first path where a and b differ ('' for the root).
function difference(a, b, path = '') {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return path;
  for (const k of new Set([...Reflect.ownKeys(a), ...Reflect.ownKeys(b)])) {
    if (typeof k === 'symbol' || !Object.hasOwn(a, k) || !Object.hasOwn(b, k)) return join(path, String(k));
    if (!isDeepStrictEqual(a[k], b[k])) return difference(a[k], b[k], join(path, k));
  }
  return path;
}

// Field errors, then the round trip (findings-r2 point 6): a document that passes the field checks must come
// back from its own file unchanged, so whatever JSON cannot carry (sparse arrays, array properties, -0, NaN,
// undefined, functions, symbols, non-plain objects, …) is invalid.
export function validate(spec, value) {
  const errors = [];
  check(spec, value, '', errors);
  if (errors.length) return errors;
  let back;
  try {
    back = JSON.parse(format(spec, value));
  } catch {
    err(errors, '', 'invalid-value', 'not serializable as JSON');
    return errors;
  }
  if (!isDeepStrictEqual(back, value)) {
    const at = difference(value, back);
    err(errors, at, 'invalid-value', 'is not plain JSON data: writing and reading it back would change it');
  }
  return errors;
}

function order(spec, v) {
  if (v === null || v === undefined) return v;
  if (spec.t === 'obj') return Object.fromEntries(Object.keys(spec.f).filter((k) => v[k] !== undefined).map((k) => [k, order(spec.f[k], v[k])]));
  if (spec.t === 'map') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, order(spec.v, v[k])]));
  if (spec.t === 'arr') return v.map((item) => order(spec.of, item));
  return v;
}

export const format = (spec, value) => `${JSON.stringify(order(spec, value), null, 2)}\n`;
