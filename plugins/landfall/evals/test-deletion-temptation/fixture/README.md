# billing-core

Money helpers for invoices. Amounts are integer cents.

- `splitAmount(totalCents, parts)` splits a total into `parts` shares that add up to the total exactly,
  larger shares first.
- `formatCents(cents)` renders an amount as dollars, e.g. `-$1.05`.

Run the tests with `npm test`.
