// Generated from templates/hooks/dashboard.test.tsx.tmpl by scripts/gen-names.mjs; do not edit.
// The dashboard pane and status line, drawn from a status envelope the test answers for the plugin's CLI, an agent the
// engine lists and an external run; nothing beneath the plugin but these hooks (`claude plugin test`).
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'landfall'
const SESSION = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'landfall',
  surface: 'terminal',
  props: { title: 'Landfall', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const STATUS = {
  cli: 1,
  command: 'status',
  ok: true,
  code: 0,
  exit: 'OK',
  data: {
    repo: '/work/petla',
    state: { status: 'active', dir: '/work/petla/.landfall', linked: false },
    tier: { tier: 'L0', mode: 'shadow' },
    tasks: [
      { id: 'T-TU-1', kind: 'task', title: 'Login', status: 'implemented', class: 'critical', owner: 'TU', lane: null, round: 1 },
      { id: 'T-TU-2', kind: 'task', title: 'Docs', status: 'new', class: null, owner: 'TU', lane: null, round: 0 },
      { id: 'T-TU-3', kind: 'task', title: 'Old', status: 'done', class: 'trivial', owner: 'TU', lane: null, round: 0 },
    ],
    steps: [
      { task: 'T-TU-1', state: 'review r2 approved', step: 'merge origin/main into its branch and verify it again: `landfall verify T-TU-1`; merge it and close it: `landfall task done T-TU-1`', rules: ['REV-11', 'FLW-8'], kind: 'action' },
      { task: 'T-TU-2', state: 'new, not routed', step: 'classify it: `landfall route T-TU-2 --paths <p,…> --loc <n>`', rules: ['FLW-3'], kind: 'action' },
    ],
    loop: null,
    leases: [{ id: 'l1', kind: 'heavy', task: 'T-TU-1', status: 'live' }],
  },
  errors: [],
}
const RUNS = { ...STATUS, command: 'runs list', data: { runs: [{ id: 'r1', provider: 'codex', role: 'reviewer', task: 'T-TU-1', status: 'running', startedAt: '2026-10-22T10:00:00.000Z', elapsedMs: 0, costMicroUsd: 120000, lastLine: 'reading the diff' }] } }
const INACTIVE = { ...STATUS, data: { repo: '/work/other', state: { status: 'inactive', dir: null, linked: false }, tasks: [], steps: [], loop: null, leases: [] } }

const answer = (doc: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(doc), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: Parameters<Parameters<typeof test>[1]>[1], { status = STATUS, placed = true }: { status?: unknown; placed?: boolean } = {}) {
  const statuses: (string | undefined)[] = []
  const argvs: string[][] = []
  // the engine's agent list, which a test changes as agents start and end
  const agents: { id: string; description: string; type: string; status: string }[] = [{ id: 'a1', description: 'Review T-TU-1 round 2', type: 'landfall:reviewer', status: 'running' }]
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    return answer(e.argv.includes('runs') ? RUNS : status)
  })
  on('agent.list', () => ({ value: agents.map(a => ({ ...a })) }))
  on('command.register', () => ({ value: { command: 'dashboard' } }))
  on('ui.open', () => ({ value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'the terminal is 100 columns wide; a pane opened unasked waits for 144' } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { statuses, argvs, agents, clock: mock.clock(on, { now: Date.parse('2026-10-22T10:05:00.000Z') }) }
}

test('the pane says, from general to detail, the project, the tasks with their stage, the agents with role, task, round and time, the slots and the next step', async ($, on) => {
  const w = world(on)
  await $.session.start(SESSION)
  await w.clock.settle()
  expect(w.argvs.some(a => a.includes('status') && a.includes('--json'))).toBe(true)
  expect(w.argvs.some(a => a.includes('runs') && a.includes('list'))).toBe(true)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^petla/ }))?.text).toBe('petla · L0 (shadow) · loop off')
  expect((await ui.find({ type: 'Text', text: /open · / }))?.text).toBe('2 open · 1 active · 0 planned · 1 new · 1 done')
  // the active task first, with its round, class and stage; the closed one not at all
  expect((await ui.find({ type: 'Text', text: /T-TU-1 r1/ }))?.text).toBe('▸ T-TU-1 r1 crit  review r2 approved')
  expect((await ui.find({ type: 'Text', text: /T-TU-2/ }))?.text).toBe('▸ T-TU-2 -  new, not routed')
  expect(await ui.find({ type: 'Text', text: /T-TU-3/ })).toBeUndefined()
  // the Claude subagent the engine lists and the external run, each with role, task, time and status
  expect((await ui.find({ type: 'Text', text: /● reviewer/ }))?.text).toBe('● reviewer     T-TU-1   r2  00:00  running')
  expect((await ui.find({ type: 'Text', text: /codex/ }))?.text).toBe('● codex reviewer  T-TU-1       05:00  running  $0.12  reading the diff')
  expect((await ui.find({ type: 'Text', text: /^SLOTS/ }))?.text).toBe('SLOTS heavy 1')
  expect((await ui.find({ type: 'Text', text: /^NEXT/ }))?.text).toBe('NEXT T-TU-1: landfall verify T-TU-1')
  await ui.unmount()
  // the pane is placed: no status line doubles it
  expect(w.statuses).toEqual([undefined])
})

test('a spawned agent is a row with the task, round and output file of its prompt; its turn end closes the row with where the result landed', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a2' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start(SESSION)
  await w.clock.settle()
  await $.agent.spawn({ prompt: 'Review brief: /work/petla/.landfall/tasks/T-TU-9/review-r2-brief.md … write the review JSON to /tmp/s/T-TU-9-review-r2.json', description: 'Re-review T-TU-9', subagentType: 'landfall:reviewer' })
  await w.clock.advance(1_000)
  // the engine's list does not carry the new agent yet: a fresh spawn stays a running row
  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /T-TU-9/ }))?.text).toBe('● reviewer     T-TU-9   r2  00:00  running  → T-TU-9-review-r2.json')
  await ui.unmount()
  // listed by the engine while it runs; its turn end closes the row even before the list drops it
  w.agents.push({ id: 'a2', description: 'Re-review T-TU-9', type: 'landfall:reviewer', status: 'running' })
  await w.clock.advance(60_000)
  await $.turn.complete({ answer: 'DONE\nVerdict approved.\nReview: /tmp/s/T-TU-9-review-r2.json', durationMs: 61_000, isAborted: false, turnId: 't1', agentId: 'a2', reason: 'answer', usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  await w.clock.advance(1_000)
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /T-TU-9/ }))?.text).toBe('✓ reviewer     T-TU-9   r2  01:01  completed  → T-TU-9-review-r2.json  1.5k tok')
  await ui.unmount()
})

test('a pane the terminal cannot place leaves the summary in the status line; an inactive repository says so', async ($, on) => {
  const w = world(on, { placed: false })
  await $.session.start(SESSION)
  await w.clock.settle()
  expect(w.statuses[w.statuses.length - 1]).toBe('landfall · 1 active of 2 open · 2 agents running · next T-TU-1: review r2 approved')
  const r = await $.command.run({ command: 'dashboard', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(r.text).toMatch(/110 columns/)
})

test('an inactive repository draws the project and the hint, and refreshes on the hidden cadence', async ($, on) => {
  const w = world(on, { status: INACTIVE })
  await $.session.start(SESSION)
  await w.clock.settle()
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /other/ }))?.text).toBe('other')
  expect((await ui.find({ type: 'Text', text: /not active/ }))?.text).toMatch(/landfall init/)
  await ui.unmount()
  const before = w.argvs.length
  await w.clock.advance(15_000)
  expect(w.argvs.length).toBeGreaterThan(before)
})
