// Template engine of generated files (spec §7.14 step 1): a small, strict subset of Mustache, no escaping (each
// value arrives already escaped for its target format, see targets.mjs).
//   {{name}}               the value (string or number), looked up in the innermost section scope first
//   {{#name}}…{{/name}}    a list repeats the body once per item (the item's fields come into scope); true renders
//                          the body once; false or an empty list renders nothing
//   {{^name}}…{{/name}}    the body when the value is false or an empty list
// A line holding only a section tag (and spaces) disappears with its newline. `${{` (a GitHub Actions expression)
// is never a tag. An unknown name, a wrong value type or an unbalanced section throws: that is a template bug.

const TAG = /(?<!\$)\{\{([#^/]?)([A-Za-z][A-Za-z0-9]*)\}\}/g;
const STANDALONE = /^[ ]*(\{\{[#^/][A-Za-z][A-Za-z0-9]*\}\})[ ]*\n/gm;

export function renderTemplate(source, view, where = 'template') {
  const tree = parse(source.replace(STANDALONE, '$1'), where);
  return renderNodes(tree, [view], where);
}

function parse(source, where) {
  const rootNode = { children: [] };
  const stack = [rootNode];
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ text: source.slice(last, m.index) });
    last = m.index + m[0].length;
    const [, kind, name] = m;
    if (kind === '#' || kind === '^') {
      const node = { section: name, inverted: kind === '^', children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (kind === '/') {
      if (top.section !== name) throw new Error(`${where}: {{/${name}}} closes ${top.section ? `{{#${top.section}}}` : 'nothing'}`);
      stack.pop();
    } else {
      top.children.push({ name });
    }
  }
  if (stack.length > 1) throw new Error(`${where}: {{#${stack[stack.length - 1].section}}} is not closed`);
  if (last < source.length) rootNode.children.push({ text: source.slice(last) });
  return rootNode.children;
}

function lookup(scopes, name, where) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i];
    if (s !== null && typeof s === 'object' && Object.hasOwn(s, name)) return s[name];
  }
  throw new Error(`${where}: unknown name {{${name}}}`);
}

function renderNodes(nodes, scopes, where) {
  let out = '';
  for (const node of nodes) {
    if (node.text !== undefined) { out += node.text; continue; }
    const value = lookup(scopes, node.name ?? node.section, where);
    if (node.name !== undefined) {
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${where}: {{${node.name}}} is not a string`);
      out += String(value);
      continue;
    }
    if (!Array.isArray(value) && typeof value !== 'boolean') throw new Error(`${where}: section ${node.section} needs a list or a boolean`);
    const empty = value === false || (Array.isArray(value) && value.length === 0);
    if (node.inverted) { if (empty) out += renderNodes(node.children, scopes, where); continue; }
    if (value === true) out += renderNodes(node.children, scopes, where);
    else if (Array.isArray(value)) for (const item of value) out += renderNodes(node.children, [...scopes, item], where);
  }
  return out;
}
