// Store schema 1 → 2 (spec §5.1, §14, SD-38): the capability flags move from state.json to config.json.
// up: state.json keeps codename, createdWith and activatedAt. carry: the old flags map goes to config.json, under the
// entries config.json already has (they were written later, so they win); an empty map carries nothing. The store
// applies the carry on every read of config.json while state.json is at schema 1 (nothing lost before `migrate`), and
// `migrate` writes it to config.json before it rewrites state.json.
export default Object.freeze({
  id: '001-state-flags-to-config',
  kind: 'state',
  from: 1,
  to: 2,
  up(doc) {
    const { flags, ...rest } = doc;
    return rest;
  },
  carry: Object.freeze({
    kind: 'config',
    into(target, source) {
      const old = source.flags && typeof source.flags === 'object' && !Array.isArray(source.flags) ? source.flags : {};
      if (Object.keys(old).length === 0) return undefined;
      const doc = target ?? { schema: 1 };
      return { ...doc, flags: { ...old, ...(doc.flags ?? {}) } };
    },
  }),
});
