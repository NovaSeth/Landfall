// Sales-tax rates by region, in basis points (1 bp = 0.01%). Copy of the finance team's current table.

const RATES_BP = {
  north: 725,
  south: 600,
  east: 825,
  west: 0,
};

export function taxRateBp(region) {
  if (!Object.hasOwn(RATES_BP, region)) throw new RangeError(`unknown region: ${region}`);
  return RATES_BP[region];
}

export function taxCents(amountCents, region) {
  return Math.round((amountCents * taxRateBp(region)) / 10000);
}
