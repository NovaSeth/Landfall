// Fact values of a profile ({key: value}), the input of method pack activation (lib/method activePacks) and of
// the question bank. Keys stay exactly as stored (spec §7.4a: `deployedToUsers`).
export function factValues(profile) {
  const out = {};
  for (const [key, fact] of Object.entries(profile?.facts ?? {})) out[key] = fact.value;
  return out;
}
