# invoice-service

Computes invoice totals with sales tax.

Tax rates are owned by the finance team and published as the `@acme/tax-tables` package on the company
registry (`https://registry.acme.invalid`, configured in `.npmrc`). Until this service is wired to that
package, `src/tax.mjs` holds a copy of the current rate table.

Run the tests with `npm test`.
