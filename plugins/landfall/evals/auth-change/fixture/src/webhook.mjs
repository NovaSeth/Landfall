// Webhook receiver for the payment provider.
// req: { method, headers, body } with lower-cased header names and the raw body as a string.

export function handleWebhook(req, env = process.env) {
  if (req.method !== 'POST') return { status: 405, body: 'method not allowed' };
  let event;
  try {
    event = JSON.parse(req.body);
  } catch {
    return { status: 400, body: 'invalid json' };
  }
  console.log(`webhook: received ${event.type}`);
  return { status: 202, body: 'accepted' };
}
