// 1.x import, the removal checklist: lists the 1.x files and the 1.x hooks in .claude/settings.json for the human to
// remove. Read-only (GC2: it names a project settings file only to read it; it holds no write call). Nothing is deleted.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The hook scripts the 1.x kit added to .claude/settings.json (kit/.claude/settings.workflow.json of v1.5.1).
const HOOK_1X = /\.claude\/hooks\/(?:workflow-context|guard-bash|guard-schedule)\.mjs\b/;

// Absolute paths, and one line per 1.x hook: `<settings>: <event> hook <command>`.
export function removalChecklist(from) {
  const out = [];
  for (const rel of ['.workflow', join('docs', 'workflow')]) if (existsSync(join(from, rel))) out.push(join(from, rel));
  const settings = join(from, '.claude', 'settings.json');
  let doc = null;
  try { doc = JSON.parse(readFileSync(settings, 'utf8')); } catch { /* absent or not JSON: nothing to list */ }
  const hooks = doc && typeof doc.hooks === 'object' && doc.hooks ? doc.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (typeof h?.command === 'string' && HOOK_1X.test(h.command)) out.push(`${settings}: ${event} hook ${[...h.command].slice(0, 200).join('')}`);
      }
    }
  }
  return out;
}
