# OWASP checks

**Purpose:** the OWASP Top 10:2025 as checks a security review runs over a diff and an audit runs over the code; OWA-n is A0n:2025 (A10 for OWA-10). **Reads:** the security reviewer; implementer and designer while the pack is active. **When:** a diff that touches a security trigger (SEC-13), an audit (SCD-23).

**Section map**
- §Access, configuration and supply chain — A01 to A03.
- §Cryptography, injection and design — A04 to A06.
- §Identity and integrity — A07 and A08.
- §Logging and errors — A09 and A10.

## Pack: security

### Access, configuration and supply chain
**OWA-1.** A01 Broken Access Control: the server checks the caller's right on every route and object, deny by default (SEC-8); look for a new route without a check, an object ID from the request without an owner or tenant check (BOLA), a role checked only in the client (BFLA), mass assignment of fields such as `role` or `tenantId`, CORS that reflects any origin, and a server-side request to a user-supplied URL without a host allow-list (SSRF).
**OWA-2.** A02 Security Misconfiguration: production defaults are closed: dev tools off (SCD-5), no default credentials, no stack traces or directory listings, security headers (CSP, HSTS, `X-Content-Type-Options`, frame-ancestors) and cookie flags (`Secure`, `HttpOnly`, `SameSite`) set, storage buckets and ports private; a missing configuration key means refusal (SEC-12).
**OWA-3.** A03 Software Supply Chain Failures: a new dependency is needed, maintained and from the expected publisher under the expected name (no typosquat), locked in the lockfile, without unexpected install scripts, and passes the package manager's audit or osv-scanner; CI actions pin a commit SHA (SCD-11) and no build step fetches unpinned code.

### Cryptography, injection and design
**OWA-4.** A04 Cryptographic Failures: TLS in transit and encryption at rest for sensitive data; passwords hashed with argon2id, scrypt or bcrypt, tokens and keys from a CSPRNG; no home-made crypto, no MD5 or SHA-1 for security, no ECB mode, no hard-coded keys or IVs, and secrets compared in constant time.
**OWA-5.** A05 Injection: untrusted input reaches a query, shell, template, file path, header or the DOM only as a parameter or encoded for that sink: parameterized SQL and NoSQL filters, an argument array instead of a shell string, output encoding without `innerHTML` or `eval` on untrusted data, a resolved path checked to stay under its root, and no unsafe deserialization.
**OWA-6.** A06 Insecure Design: a new flow names its abuse cases (enumeration, replay, races, limit bypass, skipped steps) and a control for each, such as a rate limit per credential, an idempotency key (backend-data pack, WRT-1) or server-side state for a multi-step flow; a missing control is a finding even when the code does what it says.

### Identity and integrity
**OWA-7.** A07 Authentication Failures: login, reset and MFA endpoints are rate-limited and answer an unknown user and a wrong password the same way; a session rotates on login and privilege change and ends on logout (SCD-7), a token is checked for signature, algorithm, issuer, audience and expiry; a reset link is single-use and short-lived.
**OWA-8.** A08 Software or Data Integrity Failures: updates, webhooks, plugins and serialized data are verified before use (a signature or HMAC check, no deserialization of untrusted data into objects, no `curl | sh` in builds), and CI that runs pull-request code from outside holds no secrets and no write token.

### Logging and errors
**OWA-9.** A09 Security Logging and Alerting Failures: failed logins, access denials, admin actions and rejected input are logged with actor, time and target, without secrets or personal data (SCD-9) and with newlines escaped against log injection; an abuse pattern raises an alert that reaches a person.
**OWA-10.** A10 Mishandling of Exceptional Conditions: every error, timeout and missing value fails closed (SEC-12): a caught exception never grants access or skips a check, a partial failure rolls back its transaction, an error response holds no stack, query or secret, and limits on body size, recursion and time hold (SCD-6).
