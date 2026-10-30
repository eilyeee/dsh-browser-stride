import { BROWSER_RUN_LIST_LIMIT, BROWSER_RUN_STATES, type BrowserRunList, type BrowserRunSummary, type PanelRunControl } from '@eilyeee/dsh-browser-stride/src/protocol.ts'

export interface BrowserRunCopy {
  title: string
  task: (suffix: string) => string
  states: Record<BrowserRunSummary['state'], string>
  pause: string
  stop: string
  refresh: string
  loading: string
  pausedHelp: string
  stoppingHelp: string
  reconcileHelp: string
  truncated: (shown: number, total: number) => string
  error: (code: string) => string
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function counter(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value }

/** Reject foreign sessions and malformed controls before displaying any action. */
export function parseBrowserRuns(value: unknown, sessionId: string): BrowserRunList {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > BROWSER_RUN_LIST_LIMIT
    || !counter(value.total) || value.total < value.items.length) throw new Error('invalid browser run list')
  const seen = new Set<string>()
  const items = value.items.map((item: unknown): BrowserRunSummary => {
    if (!record(item) || !id(item.runId) || seen.has(item.runId) || item.sessionId !== sessionId
      || !BROWSER_RUN_STATES.includes(item.state as BrowserRunSummary['state'])
      || !counter(item.version) || !counter(item.controlRevision) || !counter(item.updatedAt)
      || typeof item.recoveryRequired !== 'boolean' || typeof item.requiresReconciliation !== 'boolean'
      || !Array.isArray(item.controls) || new Set(item.controls).size !== item.controls.length) throw new Error('invalid browser run summary')
    const state = item.state as BrowserRunSummary['state']
    const allowed: PanelRunControl[] = state === 'running' || state === 'queued' ? ['pause', 'stop']
      : state === 'blocked' || state === 'paused' ? ['stop'] : []
    if (item.controls.some(control => !allowed.includes(control))) throw new Error('invalid browser run controls')
    seen.add(item.runId)
    return { runId: item.runId, sessionId, state, version: item.version, controlRevision: item.controlRevision,
      updatedAt: item.updatedAt, recoveryRequired: item.recoveryRequired, requiresReconciliation: item.requiresReconciliation,
      controls: [...item.controls] }
  })
  return { items, total: value.total }
}
