// `<bin> method <pack|section>` (spec §7.15, §8.2): one pack or one section of the method through lib/method, the
// counterpart of `rule`. A pack is a name of the index "packs" table; a section is "<topic>/<section slug>". Text: a
// "Pack <name> (when: …)" line for a pack, then per section a "## <topic title> › <section> (<name>)" heading and one
// line per rule, "<ID>. <text>". Exit 0 found · 2 an unknown name: the names are printed (--json: data.names). A stale
// index is a broken copy: it throws, so the CLI reports INTERNAL (70).
import { methodPart, openMethod, partNames } from '../method/index.mjs';
import { EXIT } from './commands.mjs';

function namesText(names) {
  const byTopic = new Map();
  for (const s of names.sections) {
    const cut = s.lastIndexOf('/');
    const topic = s.slice(0, cut);
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(s.slice(cut + 1));
  }
  return [`Packs: ${names.packs.join(', ')}`, 'Sections (<topic>/<section>):', ...[...byTopic].map(([t, slugs]) => `  ${t}/: ${slugs.join(', ')}`)].join('\n');
}

export function method({ args, names: { bin } }) {
  const m = openMethod();
  const part = methodPart(m, args.name);
  if (!part) {
    const names = partNames(m);
    return {
      code: EXIT.USAGE,
      data: { names },
      errors: [{ code: 'unknown-method-name', message: `unknown pack or section: ${args.name}`, hint: `use a pack or a <topic>/<section> name listed (--json: data.names), such as ${bin} method ${names.packs[0]}` }],
      text: `${namesText(names)}\n`,
    };
  }
  const sections = part.sections.map((s) => ({ ...s, rules: s.rules.map((r) => ({ id: r.id, text: r.text })) }));
  const body = sections.map((s) => [`## ${s.title} › ${s.section} (${s.name})`, ...s.rules.map((r) => `${r.id}. ${r.text}`)].join('\n')).join('\n\n');
  const head = part.kind === 'pack' ? `Pack ${part.name} (when: ${part.when})\n\n` : '';
  return { data: { kind: part.kind, name: part.name, when: part.when, sections }, text: `${head}${body}\n` };
}
