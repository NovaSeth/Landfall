// Seeds tasks with a saved receipt, a `dispatched` event and a first `verify` event in a tracked store, the inputs of
// executorRecords (T-MG-21) and of lesson promotion (T-MG-29). Writes go through lib/state.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// store: a lib/state store opened with the receipt kind; rows: [{ cls, executor, pass, endedAt, cost }].
export async function seedReceipts(pluginDir, store, rows, { first = 1, handle = 'AB' } = {}) {
  const { RECEIPT } = await import(pathToFileURL(join(pluginDir, 'lib', 'receipts', 'index.mjs')).href);
  const ids = [];
  rows.forEach((row, i) => {
    const id = `T-${handle}-${first + i}`;
    const at = row.endedAt ?? '2020-01-01T00:00:00.000Z';
    const ev = (event, data) => ({ at, by: handle, event, data });
    store.write('task', id, {
      id, kind: 'task', title: `Seeded ${id}`, lane: null, owner: handle, class: row.cls ?? 'standard', classHistory: [], status: 'done', round: 0,
      events: [ev('created', {}), ev('dispatched', { executor: row.executor ?? 'landfall:implementer', base: 'abc1234' }), ev('verify', { result: row.pass ? 'pass' : 'fail', attempt: 1 })],
      base: null, branch: null,
    });
    store.write(RECEIPT.name, id, {
      task: id, class: row.cls ?? 'standard', tier: null, startedAt: at, endedAt: at, wallMs: 1000,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costMicroUsd: row.cost ?? 1000, byAgent: [], external: [], rounds: 1,
      gates: null, defectsBeforeMerge: null, processOverhead: { wrapperTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, hookInjectedChars: null },
      priceTable: '2026-01-01', source: 'test', partial: false,
    });
    ids.push(id);
  });
  return ids;
}
