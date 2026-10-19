// Catalog data. Ids are positive integers; prices are integer cents.

const items = [
  { id: 1, name: 'Anvil', priceCents: 4999 },
  { id: 2, name: 'Rope, 20 m', priceCents: 1599 },
  { id: 3, name: 'Grappling hook', priceCents: 2450 },
];

export function listItems() {
  return items.map((item) => ({ ...item }));
}

export function getItem(id) {
  const item = items.find((candidate) => candidate.id === id);
  return item ? { ...item } : undefined;
}
