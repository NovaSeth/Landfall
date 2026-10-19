// Request routing. A request is { method, url }; a response is { status, headers, body }.
import { listItems } from './items.mjs';

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const routes = [
  { method: 'GET', pattern: /^\/health$/, handler: () => json(200, { ok: true }) },
  { method: 'GET', pattern: /^\/items$/, handler: () => json(200, listItems()) },
];

export function handle(req) {
  const path = req.url.split('?')[0];
  const matching = routes.filter((route) => route.pattern.test(path));
  if (matching.length === 0) return json(404, { error: 'not found' });
  const route = matching.find((candidate) => candidate.method === req.method);
  if (!route) {
    const allow = [...new Set(matching.map((candidate) => candidate.method))].join(', ');
    return json(405, { error: 'method not allowed' }, { allow });
  }
  return route.handler(req, path.match(route.pattern));
}
