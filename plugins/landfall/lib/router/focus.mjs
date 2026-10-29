// Review focus (SEC-13): whether a diff gets the security reviewer and which OWASP checklists. The globs and the
// checklist rule IDs live in focus.json; matching is the router's globMatch. Pure: no I/O besides loading the JSON.
import { readFileSync } from 'node:fs';
import { DEFAULT_RISK_PATHS, globMatch } from './classify.mjs';

const data = JSON.parse(readFileSync(new URL('./focus.json', import.meta.url), 'utf8'));
const MAX_TRIGGERS = 10;

export const SECURITY_PATHS = Object.freeze([...new Set([...DEFAULT_RISK_PATHS, ...data.securityPaths])]);
// Agent instructions (CLAUDE.md, SKILL.md, .claude/**, prompts, agent definitions) are router risk paths, single-sourced in
// thresholds.json; they are AI paths too, so the AI checklist joins for them. One list: the AI globs of focus.json plus the
// risk globs that name agent instructions.
const AGENT_RISK = /^\.claude\/|CLAUDE\.md|AGENTS\.md|GEMINI\.md|SKILL\.md|agents\/|prompts\//;
export const AI_PATHS = Object.freeze([...new Set([...data.aiPaths, ...DEFAULT_RISK_PATHS.filter((g) => AGENT_RISK.test(g))])]);
export const CHECKLISTS = Object.freeze({ web: Object.freeze([...data.checklists.web]), ai: Object.freeze([...data.checklists.ai]) });

const firstMatch = (globs, file) => globs.find((g) => globMatch(g, file));

// { focus: 'security' | 'general', checklists: [] | ['web'] | ['web', 'ai'], triggers: [string] }
export function reviewFocus({ files, security = false, routeFlags = [], llm = false }) {
  const triggers = [];
  if (security) triggers.push('--security');
  if (routeFlags.includes('security')) triggers.push('route flag security');
  let ai = false;
  let hits = 0;
  for (const file of files) {
    const inAi = firstMatch(AI_PATHS, file);
    const glob = firstMatch(SECURITY_PATHS, file) ?? inAi;
    if (inAi) ai = true;
    if (!glob) continue;
    hits++;
    if (hits <= MAX_TRIGGERS) triggers.push(`${file} (${glob})`);
  }
  if (hits > MAX_TRIGGERS) triggers.push(`… and ${hits - MAX_TRIGGERS} more files`);
  if (!triggers.length) return { focus: 'general', checklists: [], triggers: [] };
  return { focus: 'security', checklists: llm || ai ? ['web', 'ai'] : ['web'], triggers };
}
