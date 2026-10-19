// URL slugs for post titles.

export function slugify(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/^-|-$/g, '');
}
