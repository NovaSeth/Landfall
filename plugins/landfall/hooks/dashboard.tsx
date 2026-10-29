// Generated from templates/hooks/dashboard.tsx.tmpl by scripts/gen-names.mjs; do not edit.
// The Landfall dashboard (retro 2026-10 P1-9): a pane beside the transcript, and a dim band above the prompt while the pane is not
// placed (and a status notice only for what needs the person), that says from general to detail what goes on while Landfall runs: the project and its tier, the loop, how
// many tasks are open and in which stage, the agents at work (Claude subagents and external runs) with their role,
// task, round, elapsed time, status and where their result landed, the slots in use and the next step.
// Data: the plugin's own CLI in the session's working directory (`status --json`, `runs list --json`), the engine's
// agent list, and the agent spawns and turn ends the hooks see. Nothing is written and no model context is used (GC7).
// Refreshed on a clock (15 s while the pane shows, 60 s while it does not) and right after a command of the plugin's own CLI, an agent
// spawn or a turn end. `userConfig.dashboard`: `auto` opens the pane at session start, `command` only on
// /landfall:dashboard, `off` draws nothing and sets no status line.
// The engine reads this file statically: `$` goes only to functions declared at the top of the file, and every call on
// it is spelled `$.noun.method(...)`.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { AgentRecord, RunRow, Snapshot, TaskRow } from '../types'

const PLUGIN = 'landfall'
const PANE = 'landfall'
const COMMAND = 'dashboard'
const POLL_SHOWN_MS = 15_000
const POLL_HIDDEN_MS = 60_000
const DEBOUNCE_MS = 700
const RUN_TIMEOUT_MS = 8_000
const KEEP_AGENTS = 30
const LIST_GRACE_MS = 30_000
const TASK_ID = /\bT-[A-Z]{2,4}-\d+\b/
// the round of a brief or an answer, the most specific spelling first (review r1 F5: prose says "round" too)
const ROUNDS = [/\breview-r(\d+)\b/i, /--round[ =](\d+)\b/, /\bfix round (\d+)\b/i, /\bround (\d+)\b/i]
// an absolute path to a .json or .md file, whole (not the tail of a relative path, review r1 F5)
const OUT_PATH = /(?<![\w./-])\/[^\s`'"()<>]+\.(?:json|md)\b/g
const COMMAND_IN_STEP = /`([^`]+)`/
const RUNNING = new Set(['pending', 'running', 'waiting'])
const CLOSED = new Set(['done', 'cancelled'])
const ACTIVE = new Set(['dispatched', 'in-review', 'implemented', 'fix-round', 'verified'])
const KIND_ORDER: Record<string, number> = { action: 0, blocked: 1, wait: 2, info: 3 }
const CLASS_TAG: Record<string, string> = { critical: 'crit', standard: 'std', trivial: 'triv' }

// the state references are literals: the engine lists what the module reads and writes from the source
const snapshotAtom = atom({ plugin: 'landfall', key: 'snapshot' } as const, null)
const agentsAtom = atom({ plugin: 'landfall', key: 'agents' } as const, [])

// The module's own variables: lost on a hot reload, which `session.start` then sets again.
const live = { mode: 'auto', cwd: '', root: '', busy: false, queued: false, pending: false, shown: false, cancel: null as unknown }

// What `$.clock.every` handed back: a function, or a handle with `cancel`.
function stopTimer(handle: unknown): void {
  if (typeof handle === 'function') (handle as () => void)()
  else if (handle !== null && typeof handle === 'object' && typeof (handle as { cancel?: unknown }).cancel === 'function') (handle as { cancel: () => void }).cancel()
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Json => x !== null) : [])
const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p
const roleOf = (type: string): string => type.replace(/^landfall:/, '')
const pad2 = (n: number): string => String(n).padStart(2, '0')
const cut = (s: string, w: number): string => {
  const chars = [...s]
  return chars.length > w ? `${chars.slice(0, Math.max(1, w - 1)).join('')}…` : s
}

function envelope(text: string): Json | null {
  try {
    return obj(JSON.parse(text))
  } catch {
    return null
  }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}` : `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`
}

function taskOf(description: string, prompt: string): string | null {
  const described = TASK_ID.exec(description)?.[0]
  if (described) return described
  const tasks = prompt.match(new RegExp(TASK_ID.source, 'g')) ?? []
  return tasks.length > 0 && tasks.every(task => task === tasks[0]) ? tasks[0] : null
}

function roundOf(text: string): number | null {
  for (const re of ROUNDS) {
    const m = re.exec(text)
    if (m) return Number(m[1])
  }
  return null
}

// The loop record (lib/loop/kind.mjs): `exit` null while it runs, DONE, STALLED or BUDGET once it ended; `ticks` so far.
function loopText(loop: Json | null): string | null {
  if (!loop) return null
  const ticks = num(loop.ticks)
  const exit = typeof loop.exit === 'string' && loop.exit ? loop.exit.toLowerCase() : null
  if (exit) return `${exit}${ticks !== null ? ` after ${ticks} tick${ticks === 1 ? '' : 's'}` : ''}`
  return `running${ticks !== null ? ` · tick ${ticks}` : ''}`
}

function lastPath(text: string): string | null {
  const paths = [...text.matchAll(OUT_PATH)].map(m => m[0])
  return paths.length ? paths[paths.length - 1] : null
}

// ---- the snapshot: what the CLI says, read into rows ---------------------------------------------------------------

function tasksOf(data: Json): { rows: TaskRow[]; counts: Snapshot['counts'] } {
  const steps = new Map(list(data.steps).map(s => [str(s.task), s]))
  const counts: Snapshot['counts'] = { open: 0, active: 0, byStatus: {} }
  const rows: TaskRow[] = []
  for (const t of list(data.tasks)) {
    const status = str(t.status, 'unknown')
    counts.byStatus[status] = (counts.byStatus[status] ?? 0) + 1
    if (CLOSED.has(status)) continue
    counts.open += 1
    if (ACTIVE.has(status)) counts.active += 1
    const s = steps.get(str(t.id))
    rows.push({
      id: str(t.id),
      title: str(t.title),
      status,
      cls: typeof t.class === 'string' ? t.class : null,
      round: num(t.round) ?? 0,
      state: str(s?.state, status),
      step: s ? str(s.step) || null : null,
      kind: str(s?.kind, 'info'),
    })
  }
  rows.sort(
    (a, b) =>
      Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) ||
      (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
      b.round - a.round ||
      a.id.localeCompare(b.id),
  )
  return { rows, counts }
}

// External runs as `runs list --json` summarises them (lib/runs: runId, status, provider, role, task, elapsedMs, tokens,
// lastLine, outFile, error); a run is live until a terminal status (review r1 F1).
const RUN_TERMINAL = new Set(['done', 'failed', 'timeout', 'stopped'])
function runsOf(env: Json | null): RunRow[] {
  const data = env ? obj(env.data) : null
  return list(data?.runs)
    .map(r => {
      const status = str(r.status, 'queued')
      const t = obj(r.tokens)
      const tokens = num(r.tokens) ?? (t ? (num(t.input) ?? 0) + (num(t.output) ?? 0) + (num(t.cached) ?? 0) : null)
      return {
        id: str(r.runId) || str(r.id),
        provider: str(r.provider, 'external'),
        role: str(r.role, '-'),
        task: str(r.task) || null,
        status,
        elapsedMs: num(r.elapsedMs) ?? 0,
        tokens: tokens || null,
        out: str(r.outFile) || null,
        error: str(r.error) || null,
        lastLine: str(r.lastLine) || null,
        live: !RUN_TERMINAL.has(status),
        endedAt: Date.parse(str(r.endedAt)) || null,
      }
    })
    .slice(0, KEEP_AGENTS)
}

function mergeAgents(records: readonly AgentRecord[], listed: readonly AgentInfo[], now: number): AgentRecord[] {
  const byId = new Map(records.map(r => [r.id, r]))
  for (const a of listed) {
    const prev = byId.get(a.id)
    // a turn end already closed the row: the list, which may lag, does not reopen it
    if (prev && prev.endedAt !== null) continue
    const next: AgentRecord = prev
      ? { ...prev, status: a.status, type: a.type, role: roleOf(a.type), description: a.description }
      : {
          id: a.id,
          type: a.type,
          role: roleOf(a.type),
          description: a.description,
          task: TASK_ID.exec(a.description)?.[0] ?? null,
          round: roundOf(a.description),
          out: null,
          status: a.status,
          startedAt: now,
          endedAt: null,
          tokens: null,
        }
    if (!RUNNING.has(a.status) && next.endedAt === null) next.endedAt = now
    byId.set(a.id, next)
  }
  // an agent the engine no longer lists has ended; one spawned moments ago may not be listed yet (its turn end says)
  for (const r of byId.values()) {
    if (r.endedAt === null && now - r.startedAt > LIST_GRACE_MS && !listed.some(a => a.id === r.id)) byId.set(r.id, { ...r, status: RUNNING.has(r.status) ? 'completed' : r.status, endedAt: now })
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, KEEP_AGENTS)
}

function slotsOf(data: Json): Record<string, number> {
  const slots: Record<string, number> = {}
  for (const l of list(data.leases)) {
    if (str(l.status, 'live') !== 'live') continue
    const kind = str(l.kind, 'other')
    slots[kind] = (slots[kind] ?? 0) + 1
  }
  return slots
}

function nextOf(rows: TaskRow[]): Snapshot['next'] {
  const t = rows.find(r => r.kind === 'action')
  if (!t) return null
  return { task: t.id, state: t.state, command: t.step ? COMMAND_IN_STEP.exec(t.step)?.[1] ?? null : null }
}

function snapshotOf(data: Json, runsEnv: Json | null, agents: AgentRecord[], now: number): Snapshot {
  const tier = obj(data.tier)
  const { rows, counts } = tasksOf(data)
  return {
    at: now,
    active: true,
    project: baseName(str(data.repo)),
    tier: tier ? str(tier.tier) || null : null,
    tierMode: tier ? str(tier.mode) || null : null,
    loop: loopText(obj(data.loop)),
    counts,
    tasks: rows,
    runs: runsOf(runsEnv),
    agents,
    slots: slotsOf(data),
    next: nextOf(rows),
    error: null,
  }
}

function inactiveSnapshot(project: string, now: number, error: string | null): Snapshot {
  return { at: now, active: false, project, tier: null, tierMode: null, loop: null, counts: { open: 0, active: 0, byStatus: {} }, tasks: [], runs: [], agents: [], slots: {}, next: null, error }
}

// ---- the drawing -------------------------------------------------------------------------------------------------

type Line = { text: string; style: 'head' | 'dim' | 'section' | 'row' | 'live' | 'ok' | 'bad' | 'next' }
type AgentLine = { line: Line; live: boolean; since: number; endedAt: number | null; failed: boolean }

function agentLine(r: AgentRecord, at: number): AgentLine {
  const running = RUNNING.has(r.status)
  const glyph = running ? '●' : r.status === 'completed' ? '✓' : r.status === 'idle' ? '○' : '✗'
  const parts = [
    `${glyph} ${r.role.padEnd(11)}`,
    `${(r.task ?? '-').padEnd(8)}${r.round ? ` r${r.round}` : '   '}`,
    clock((r.endedAt ?? at) - r.startedAt),
    r.status,
    ...(r.out ? [`→ ${baseName(r.out)}`] : []),
    ...(r.tokens ? [`${(r.tokens / 1000).toFixed(1)}k tok`] : []),
  ]
  return { line: { text: parts.join('  '), style: running ? 'live' : r.status === 'completed' ? 'ok' : r.status === 'idle' ? 'dim' : 'bad' }, live: running, since: r.startedAt, endedAt: r.endedAt, failed: !running && r.status !== 'completed' && r.status !== 'idle' }
}

function runLine(r: RunRow, at: number): AgentLine {
  const glyph = r.live ? '●' : r.status === 'done' ? '✓' : '✗'
  const parts = [
    `${glyph} ${`${r.provider} ${r.role}`.padEnd(11)}`,
    `${(r.task ?? '-').padEnd(8)}   `,
    clock(r.elapsedMs),
    r.status,
    ...(r.out ? [`→ ${baseName(r.out)}`] : []),
    ...(r.tokens ? [`${(r.tokens / 1000).toFixed(1)}k tok`] : []),
    ...(r.error ? [r.error] : r.lastLine ? [r.lastLine] : []),
  ]
  return { line: { text: parts.join('  '), style: r.live ? 'live' : r.status === 'done' ? 'ok' : 'bad' }, live: r.live, since: at - r.elapsedMs, endedAt: r.endedAt, failed: !r.live && r.status !== 'done' }
}

export function linesOf(snap: Snapshot, width: number, rows: number): Line[] {
  const out: Line[] = []
  const c = snap.counts
  const mode = snap.tierMode && snap.tierMode !== 'on' ? ` (${snap.tierMode})` : ''
  out.push({ text: `${snap.project} · ${snap.tier ?? '-'}${mode} · loop ${snap.loop ?? 'off'}`, style: 'head' })
  out.push({ text: `${c.open} open · ${c.active} active · ${c.byStatus.planned ?? 0} planned · ${c.byStatus.new ?? 0} new · ${c.byStatus.done ?? 0} done`, style: 'dim' })
  if (snap.error) out.push({ text: `! ${snap.error}: the rows are from the last answer`, style: 'bad' })
  const room = Math.max(2, rows - 7 - (snap.error ? 1 : 0))
  const taskRoom = Math.max(1, Math.ceil(room * 0.55))
  const agentRoom = Math.max(1, room - taskRoom)

  out.push({ text: 'TASKS', style: 'section' })
  // working: an active status, or a live agent or run names the task; every other open task waits
  const named = new Set<string>()
  for (const a of snap.agents) if (RUNNING.has(a.status) && a.task) named.add(a.task)
  for (const r of snap.runs) if (r.live && r.task) named.add(r.task)
  const working = (t: TaskRow) => ACTIVE.has(t.status) || named.has(t.id)
  const ordered = [...snap.tasks.filter(working), ...snap.tasks.filter(t => !working(t))]
  const shownTasks = ordered.slice(0, ordered.length > taskRoom ? taskRoom - 1 : taskRoom)
  for (const t of shownTasks) {
    const w = working(t)
    const blocked = t.kind === 'blocked'
    const stage = blocked ? `blocked · ${t.state.replace(/^blocked:\s*/, '')}` : `${w ? 'working' : 'waiting'} · ${t.state}`
    out.push({ text: `${w ? '▶' : '⏸'} ${t.id}${t.round ? ` r${t.round}` : ''} ${t.cls ? CLASS_TAG[t.cls] ?? t.cls : '-'}  ${stage}`, style: blocked ? 'bad' : w ? 'row' : 'dim' })
  }
  if (snap.tasks.length > shownTasks.length) out.push({ text: `  … ${snap.tasks.length - shownTasks.length} more (landfall task list)`, style: 'dim' })
  if (snap.tasks.length === 0) out.push({ text: '  no open tasks (landfall task new)', style: 'dim' })

  out.push({ text: 'AGENTS', style: 'section' })
  // only the agents and runs at work
  const shown = [...snap.agents.map(r => agentLine(r, snap.at)), ...snap.runs.map(r => runLine(r, snap.at))].filter(a => a.live).sort((a, b) => b.since - a.since)
  const shownAgents = shown.slice(0, shown.length > agentRoom ? Math.max(0, agentRoom - 1) : agentRoom)
  for (const a of shownAgents) out.push(a.line)
  if (shown.length > shownAgents.length) out.push({ text: `  … ${shown.length - shownAgents.length} more`, style: 'dim' })
  if (shown.length === 0) out.push({ text: '  none active', style: 'dim' })

  const slots = Object.entries(snap.slots)
  out.push({ text: `SLOTS ${slots.length ? slots.map(([k, n]) => `${k} ${n}`).join(' · ') : 'none in use'}`, style: 'dim' })
  out.push({ text: snap.next ? `NEXT ${snap.next.task}: ${snap.next.command ?? snap.next.state}` : 'NEXT nothing to do (landfall tick)', style: 'next' })
  const d = new Date(snap.at)
  out.push({ text: `updated ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`, style: 'dim' })
  return out.map(l => ({ ...l, text: cut(l.text, width) }))
}

// The calm one-line summary for the band above the prompt: no plugin name twice, nothing when there is nothing to say.
export function bandLineOf(snap: Snapshot): string | null {
  if (!snap.active) return null
  const running = snap.agents.filter(a => RUNNING.has(a.status)).length + snap.runs.filter(r => r.live).length
  const parts: string[] = []
  if (running > 0) parts.push(`${running} agent${running === 1 ? '' : 's'} running`)
  if (snap.next) parts.push(`next ${snap.next.task}: ${snap.next.state}`)
  else if (snap.counts.open > 0) parts.push(`${snap.counts.open} open`)
  if (parts.length === 0) return null
  return cut(`landfall · ${parts.join(' · ')}`, 120)
}

// The engine notice (the host draws it as a yellow warning with the plugin name in front) is only for what needs the
// person: a blocked task, a loop that ended over budget. It does not start with the name; undefined clears it.
export function statusLineOf(snap: Snapshot): string | undefined {
  if (!snap.active) return undefined
  const blocked = snap.tasks.find(t => t.kind === 'blocked')
  if (blocked) return cut(`${blocked.id} needs you: ${blocked.state}`, 120)
  if (snap.loop?.startsWith('budget')) return `loop stopped over budget${snap.loop.slice('budget'.length)}`
  return undefined
}

// ---- the work: the CLI read, the refresh and its cadence ---------------------------------------------------------

async function runCli($: EngineInterface, args: readonly string[]): Promise<Json | null> {
  try {
    const r = await $.process.run(['node', `${live.root}/bin/landfall`, ...args, '--json'], { cwd: live.cwd, timeoutMs: RUN_TIMEOUT_MS })
    return envelope(r.stdout)
  } catch {
    return null
  }
}

async function refresh($: EngineInterface): Promise<void> {
  if (live.busy) {
    live.queued = true
    return
  }
  live.busy = true
  try {
    const now = await $.clock.now()
    const status = await runCli($, ['status'])
    const data = status ? obj(status.data) : null
    if (data === null) {
      // the CLI did not answer (slow, killed at the timeout, not found): the last snapshot stands with the error on it
      // (review r1 F3); a first failure draws the inactive card with the error
      let shown: Snapshot | null = null
      await update($, snapshotAtom, s => (shown = s ? { ...s, at: now, error: 'landfall status did not answer' } : inactiveSnapshot(baseName(live.cwd), now, 'landfall status did not answer')))
      if (shown) $.ui.status(live.shown ? undefined : statusLineOf(shown))
      return
    }
    const active = obj(data.state)?.status === 'active'
    const runsEnv = active ? await runCli($, ['runs', 'list']) : null
    const listed = await $.agent.list()
    let agents: AgentRecord[] = []
    await update($, agentsAtom, rs => (agents = mergeAgents(rs, listed, now)))
    const snap = active ? snapshotOf(data, runsEnv, agents, now) : inactiveSnapshot(baseName(str(data.repo) || live.cwd), now, null)
    await update($, snapshotAtom, () => snap)
    $.ui.status(live.shown ? undefined : statusLineOf(snap))
  } catch {
    // the engine refused a call (the module is unloading) or the state could not be written: the last snapshot stands
  } finally {
    live.busy = false
    if (live.queued) {
      live.queued = false
      void refresh($)
    }
  }
}

function refreshSoon($: EngineInterface): void {
  if (live.pending) return
  live.pending = true
  $.clock.after(DEBOUNCE_MS, () => {
    live.pending = false
    void refresh($)
  })
}

function arm($: EngineInterface): void {
  stopTimer(live.cancel)
  live.cancel = $.clock.every(live.shown ? POLL_SHOWN_MS : POLL_HIDDEN_MS, () => void refresh($))
}

async function openPane($: EngineInterface): Promise<boolean> {
  const r = await $.ui.open({ id: PANE, title: 'Landfall' })
  live.shown = r.isPlaced
  arm($)
  return r.isPlaced
}

// ---- the hooks ---------------------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  live.mode = str((options as Json | undefined)?.dashboard, 'auto')

  on('session.start', async ($, e, next) => {
    live.cwd = e.cwd
    live.root = $.plugin.root
    await $.command.register({ name: COMMAND, description: 'Open the Landfall dashboard: tasks, agents, slots and the next step, beside the transcript' })
    const r = await next(e)
    if (live.mode !== 'off' && e.isInteractive) {
      if (live.mode === 'auto') await openPane($)
      else arm($)
      void refresh($)
    }
    return r
  })

  on('command.run', { command: COMMAND }, async $ => {
    const placed = await openPane($)
    void refresh($)
    return {
      text: placed
        ? 'Landfall dashboard opened.'
        : 'The Landfall dashboard opens beside the transcript from 110 columns in the fullscreen terminal; until then its line is in the status bar.',
    }
  }).catch(() => ({ text: 'The Landfall dashboard could not open; the debug log says why.' }))

  on('ui.close', { id: PANE }, ($, e, next) => {
    live.shown = false
    arm($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = (r as { agentId?: unknown }).agentId
    if (typeof id === 'string') {
      const now = await $.clock.now()
      const text = `${e.description}\n${e.prompt}`
      const rec: AgentRecord = {
        id,
        type: e.subagentType,
        role: roleOf(e.subagentType),
        description: e.description,
        task: taskOf(e.description, e.prompt),
        round: roundOf(text),
        out: lastPath(text),
        status: 'running',
        startedAt: now,
        endedAt: null,
        tokens: null,
      }
      await update($, agentsAtom, rs => [rec, ...rs.filter(x => x.id !== id)].slice(0, KEEP_AGENTS))
      refreshSoon($)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (typeof e.agentId === 'string') {
      const id = e.agentId
      const now = await $.clock.now()
      const usage = obj(e.usage)
      const tokens = usage ? (num(usage.input_tokens) ?? 0) + (num(usage.output_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) : null
      const out = lastPath(e.answer)
      await update($, agentsAtom, rs => rs.map(r => (r.id === id ? { ...r, status: e.isAborted ? 'killed' : 'completed', endedAt: r.endedAt ?? now, out: out ?? r.out, tokens: tokens || r.tokens } : r)))
    }
    if (live.mode !== 'off') refreshSoon($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (live.mode !== 'off' && /(?:^|[\s/])landfall\s/.test(e.command)) refreshSoon($)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = live.shown || e.props.hasSurvey ? null : await read($, snapshotAtom)
    const line = snap ? bandLineOf(snap) : null
    if (line === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{line}</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshotAtom)
    const width = Math.max(20, Math.floor(e.props.bodyColumns))
    const rows = Math.max(8, Math.floor(e.props.scroll.bodyRows))
    if (snap === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Landfall: reading the state…</Text>
        </Box>
      )
    }
    if (!snap.active) {
      return (
        <Box flexDirection="column">
          <Text bold>{snap.project}</Text>
          <Text dimColor>{snap.error ?? 'Landfall is not active here: `landfall init` activates it.'}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {linesOf(snap, width, rows).map(l =>
          l.style === 'head' ? (
            <Text bold>{l.text}</Text>
          ) : l.style === 'section' ? (
            <Text bold dimColor>
              {l.text}
            </Text>
          ) : l.style === 'dim' ? (
            <Text dimColor>{l.text}</Text>
          ) : l.style === 'live' ? (
            <Text color="warning">{l.text}</Text>
          ) : l.style === 'ok' ? (
            <Text color="success">{l.text}</Text>
          ) : l.style === 'bad' ? (
            <Text color="error">{l.text}</Text>
          ) : l.style === 'next' ? (
            <Text bold color="suggestion">
              {l.text}
            </Text>
          ) : (
            <Text>{l.text}</Text>
          ),
        )}
      </Box>
    )
  })
}
