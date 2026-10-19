// Money helpers. Amounts are integer cents.

export function splitAmount(totalCents, parts) {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new RangeError('totalCents must be a non-negative integer');
  }
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError('parts must be a positive integer');
  }
  const share = Math.round(totalCents / parts);
  return Array.from({ length: parts }, () => share);
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
