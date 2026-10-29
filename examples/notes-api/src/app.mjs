import { ValidationError } from './store.mjs';

// D-MG-2: 16 KiB body limit
const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, payload) {
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const fail = (res, status, message) => send(res, status, { error: message });

// Stop reading: close the connection after the answer and destroy the request.
function tooLarge(req, res) {
  res.setHeader('connection', 'close');
  // Node's own finish handler calls req.resume() (via _dump) to drain the rest of
  // the body, which would flow the buffered bytes after the 413. Make resume a
  // no-op on this request, pause it, and destroy it once the answer is out.
  req.resume = () => req;
  req.pause();
  res.once('finish', () => req.destroy());
  return new HttpError(413, 'body too large');
}

function readJson(req, res) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    return Promise.reject(new HttpError(415, 'content type must be application/json'));
  }
  if (Number(req.headers['content-length']) > MAX_BODY) {
    return Promise.reject(tooLarge(req, res));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        chunks.length = 0;
        req.pause();
        req.removeAllListeners('data');
        reject(tooLarge(req, res));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp(store) {
  return async function handler(req, res) {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] !== 'notes' || parts.length > 2 || pathname.includes('//')) {
        return fail(res, 404, 'not found');
      }
      if (parts.length === 1) {
        if (req.method === 'GET') return send(res, 200, store.list());
        if (req.method === 'POST') {
          const input = await readJson(req, res);
          return send(res, 201, store.create(input));
        }
        return fail(res, 405, 'method not allowed');
      }
      let id;
      try {
        id = decodeURIComponent(parts[1]);
      } catch {
        return fail(res, 400, 'invalid note id');
      }
      if (req.method === 'GET') {
        const note = store.get(id);
        return note ? send(res, 200, note) : fail(res, 404, 'note not found');
      }
      if (req.method === 'DELETE') {
        return store.remove(id) ? send(res, 204) : fail(res, 404, 'note not found');
      }
      return fail(res, 405, 'method not allowed');
    } catch (e) {
      if (e instanceof HttpError) return fail(res, e.status, e.message);
      if (e instanceof ValidationError) return fail(res, 400, e.message);
      console.error(e);
      return fail(res, 500, 'internal error');
    }
  };
}
