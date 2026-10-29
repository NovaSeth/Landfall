// Decisions unit (spec §4.2, §7.10, SD-9, SD-21, SD-22): decision records, their check, the scope index and edit-time
// retrieval. The public interface of the unit; hooks use the read side (records, scope index, context lines).
// Command handlers live in commands.mjs (loaded by the CLI command table only).
export { CONTEXT_BUDGET, READ_MAX, citedIn, contextLine, globMatch, inside, realTarget, relevantDecisions, renderContext, specificity } from './context.mjs';
export { SCAN_MAX, checkDecisions, stateRel } from './check.mjs';
export { DECISION, DECISION_KINDS, FILE_NAME, RECORD_LIMITS, STATUSES, formatRecord, parseRecord, recordErrors, sections } from './record.mjs';
export { citationPattern } from './citation.mjs';
export { INDEX, STORE_KINDS, readRecords, scopeIndex, summarize } from './records.mjs';
export { requireDecision } from './require.mjs';
export { authorHandle, createDecision, retireDecision } from './write.mjs';
