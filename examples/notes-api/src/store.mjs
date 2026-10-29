import fs from 'node:fs';
import crypto from 'node:crypto';

function load(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`notes file is not valid JSON: ${file}`);
  }
  if (!Array.isArray(data)) throw new Error(`notes file is not a JSON array: ${file}`);
  return data;
}

function save(file, notes) {
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(notes, null, 2));
    // D-MG-1: atomic write by rename
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// The only error class whose message is safe to show a client.
export class ValidationError extends TypeError {}

function validate(input) {
  const { title, body } = input ?? {};
  if (typeof title !== 'string' || title.length === 0 || title.length > 200) {
    throw new ValidationError('title must be a non-empty string of at most 200 characters');
  }
  if (typeof body !== 'string' || body.length > 10000) {
    throw new ValidationError('body must be a string of at most 10000 characters');
  }
  return { title, body };
}

export function openStore(file) {
  return {
    create(input) {
      const { title, body } = validate(input);
      const notes = load(file);
      const note = { id: crypto.randomUUID(), title, body, createdAt: new Date().toISOString() };
      notes.push(note);
      save(file, notes);
      return note;
    },
    list() {
      return load(file);
    },
    get(id) {
      return load(file).find((n) => n.id === id) ?? null;
    },
    remove(id) {
      const notes = load(file);
      const rest = notes.filter((n) => n.id !== id);
      if (rest.length === notes.length) return false;
      save(file, rest);
      return true;
    },
  };
}
