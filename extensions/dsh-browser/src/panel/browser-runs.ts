import { BROWSER_RUN_LIST_LIMIT, BROWSER_RUN_STATES, type BrowserRunList, type BrowserRunSummary, type PanelRunControl } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { taskBudgetExhausted } from '@eilyeee/dsh-browser-stride/src/task-budget.ts'

export interface BrowserRunCopy {
  title: string
  task: (suffix: string) => string
  states: Record<BrowserRunSummary['state'], string>
  pause: string
  stop: string
  retarget: string
  retargetHelp: string
  start: string
  waitingHelp: string
  newPageUrl: string
  startNewPage: string
  automaticControlRequired: string
  outcomes: Record<NonNullable<BrowserRunSummary['task']>['outcome'], string>
  refresh: string
  loading: string
  pausedHelp: string
  disconnectedHelp: string
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
      || (item.pauseReason !== undefined && (item.pauseReason !== 'browser-disconnected' || item.state !== 'paused' || item.task === undefined))
      || (item.canRetarget !== undefined && (typeof item.canRetarget !== 'boolean'
        || (item.canRetarget && (item.state !== 'paused' || item.recoveryRequired || item.requiresReconciliation))))
      || !Array.isArray(item.controls) || new Set(item.controls).size !== item.controls.length) throw new Error('invalid browser run summary')
    const state = item.state as BrowserRunSummary['state']
    const allowed: PanelRunControl[] = state === 'running' || state === 'queued' ? ['pause', 'stop']
      : state === 'blocked' || state === 'paused' ? ['stop'] : []
    if (item.controls.some(control => !allowed.includes(control))) throw new Error('invalid browser run controls')
    let task: BrowserRunSummary['task']
    if (item.task !== undefined) {
      const value = item.task
      if (!record(value) || typeof value.goal !== 'string' || value.goal.trim() === '' || value.goal.length > 4096
        || !counter(value.activeMs) || !counter(value.modelRequests) || !counter(value.toolCalls)
        || !['pending', 'verified', 'needs-review', 'not-completed', 'budget-exhausted'].includes(value.outcome as string)
        || typeof value.canStart !== 'boolean' || (value.canStart && (state !== 'queued' || item.recoveryRequired || item.requiresReconciliation))
        || (value.canStartNewPage !== undefined && (typeof value.canStartNewPage !== 'boolean' || (value.canStartNewPage && !value.canStart)))) throw new Error('invalid browser task')
      const hasBudget = !taskBudgetExhausted({ activeMs: value.activeMs, modelRequests: value.modelRequests, toolCalls: value.toolCalls })
      // Older compatible Hosts may still advertise exhausted task controls.
      task = { goal: value.goal, activeMs: value.activeMs, modelRequests: value.modelRequests, toolCalls: value.toolCalls,
        outcome: value.outcome as NonNullable<BrowserRunSummary['task']>['outcome'], canStart: value.canStart && hasBudget,
        ...(value.canStartNewPage === undefined ? {} : { canStartNewPage: value.canStartNewPage && hasBudget }) }
    }
    seen.add(item.runId)
    return { runId: item.runId, sessionId, state, version: item.version, controlRevision: item.controlRevision,
      updatedAt: item.updatedAt, recoveryRequired: item.recoveryRequired, requiresReconciliation: item.requiresReconciliation,
      ...(item.pauseReason === undefined ? {} : { pauseReason: item.pauseReason as 'browser-disconnected' }),
      controls: [...item.controls], ...(item.canRetarget === undefined ? {} : { canRetarget: item.canRetarget && (task === undefined || !taskBudgetExhausted(task)) }), ...(task === undefined ? {} : { task }) }
  })
  return { items, total: value.total }
}
