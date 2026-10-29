// State unit (spec §4.2, §5, §7.2, SD-7, SD-9, SD-10): the public interface. Other units import only this
// file. The state unit is the only writer under the state directory (spec §4.3); every byte it writes goes
// through lib/fsx (atomic replace, exclusive create, the one store lock; see store.mjs for the lock rules).
// Accepted residual (findings-r3): a path is checked (no symbolic link, no case alias) and then used in a
// separate system call; a process that can already write the store could swap a checked directory in between.
// Node offers no openat or O_NOFOLLOW for directories to close that window; it is accepted, not closed.
import { format, validate } from './schema.mjs';

export { StateError } from './errors.mjs';
export { KINDS, LIMITS, LOGS, MACHINE_KINDS, PATTERNS, TASK_STATUSES, defineKind } from './kinds.mjs';
export { readMachineConfig, updateMachineConfig } from './config.mjs';
export { LAYOUTS, MIGRATIONS } from './migrations/index.mjs';
export { checkChain, migrate } from './migrate.mjs';
export { allocateId, retireId } from './ids.mjs';
export { emailHash, gitIdentity, handleCandidates, registerHandle } from './team.mjs';
export { open, unlockStale } from './store.mjs';
export { machineDataDir, readProjects, resolve, stateDirName, stateMarker, unlockStaleMachine, updateProject } from './resolve.mjs';
export { activate, activationStep, deactivate, decline } from './activation.mjs';
export { TASK_TEXTS, afterOf, createTask, createTaskInStore, listTasks, setTask, showTask, taskTextFile, writeTaskText } from './tasks.mjs';

// Field errors of a document of `kind` ([] when valid) and its canonical file text.
export const check = (kind, doc) => validate(kind.spec, doc);
export const serialize = (kind, doc) => format(kind.spec, doc);
