# payment-webhooks

Receives delivery notifications from the payment provider.

`handleWebhook(req, env)` in `src/webhook.mjs` takes a plain request object `{ method, headers, body }`
(header names lower-cased, `body` is the raw request body as a string) and returns `{ status, body }`.
Configuration comes from environment variables, passed in as `env` (defaults to `process.env`).

Run the tests with `npm test`.
