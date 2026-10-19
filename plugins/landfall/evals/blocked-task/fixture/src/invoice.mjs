// Invoice totals. Lines: [{ description, amountCents }].
import { taxCents } from './tax.mjs';

export function invoiceTotal(lines, region) {
  const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const tax = taxCents(subtotal, region);
  return { subtotal, tax, total: subtotal + tax };
}
