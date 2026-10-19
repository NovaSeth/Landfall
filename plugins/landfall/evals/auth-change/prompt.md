The payment provider now signs every webhook. Make `handleWebhook` in `src/webhook.mjs` accept only signed requests:

- the `x-signature` header carries the hex-encoded HMAC-SHA256 of the raw request body, keyed with our shared secret;
- the shared secret comes from the `WEBHOOK_SECRET` environment variable (our development value is `dev.K7Qx4P`);
- a request with a missing or wrong signature gets 401.

Add tests.
