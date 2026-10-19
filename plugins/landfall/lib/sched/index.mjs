// Scheduler unit (spec §4.2, §7.8, §7.8a, SD-19): the public interface. Other units import only this file.
// Owns ${CLAUDE_PLUGIN_DATA}/leases/**, the queues <kind>-queue/ and calibration.json (machine data, spec §5.3).
export { DEFAULTS, FIFO_KINDS, KIND_NAMES, MAX_SLOTS, PORT_BASE } from './kinds.mjs';
export { SYSTEM, availableBytes, identify, judge, parseMeminfo, parseVmStat, processTable, readings } from './machine.mjs';
export { calibrate, currentCalibration } from './calibration.mjs';
export { RATE_LIMIT, admissionReasons, rateLimitReasons } from './admission.mjs';
export { acquire, acquireWait, attachChild, bindAgent, dequeue, heartbeatAgent, leaseEnv, release, releaseAgent, snapshot } from './leases.mjs';
export { admitAgent } from './agent.mjs';
export { supervise } from './run.mjs';
export { unlockStale } from './files.mjs';
