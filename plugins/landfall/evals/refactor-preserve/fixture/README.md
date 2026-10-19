# sales-report

`buildReport(orders, options)` in `src/report.mjs` renders the monthly sales report that finance imports
into its ledger tool. Finance parses the text, so its exact format is part of the contract.

- `orders`: `[{ customer, amountCents, refunded }]`
- `options.currency`: `'USD'` (default) or `'EUR'`

Run the tests with `npm test`.
