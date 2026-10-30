/** Panel controls expose metadata only; creation, resume and facts stay Host-owned. */
import { z } from 'zod'
import { asRunId, asSessionId } from './contracts/ids.ts'
import { summarizeActionFacts } from './contracts/outcome.ts'
import { isTerminal } from './contracts/run.ts'
import { BrowserRunStoreError, type BrowserRunStore, type BrowserRunRecord } from './run-store.ts'
import { BROWSER_RUN_LIST_LIMIT, BRIDGE_RUN_LIST_METHOD, BRIDGE_RUN_CONTROL_METHOD, type BrowserRunList, type BrowserRunSummary } from './protocol.ts'

export type RunPanelStore = Pick<BrowserRunStore, 'list' | 'get' | 'control' | 'dispatches'>
const id = z.string().min(1).max(200).refine(value => value.trim() === value)
const sessionPayload = z.strictObject({ sessionId: id })
const controlPayload = z.strictObject({ sessionId: id, runId: id,
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), control: z.enum(['pause', 'stop']) })

class RunPanelError extends Error {
  constructor(readonly code: 'bad-request' | 'not-found' | 'unavailable') { super(code) }
}

function priority(run: BrowserRunRecord): number {
  return run.state === 'running' || run.state === 'stopping' ? 0 : isTerminal(run.state) ? 2 : 1
}

function reconciliationRequired(store: RunPanelStore, sessionId: string): boolean {
  return store.list(asSessionId(sessionId)).some(run => run.recoveryRequired || summarizeActionFacts(run.facts).pendingReconciliation.length > 0)
    || store.dispatches.list(sessionId).some(row => row.effect === 'write'
      && (row.state === 'unresolved' || (row.state === 'returned' && row.receipt?.ok === false)))
}

function summary(run: BrowserRunRecord, requiresReconciliation: boolean): BrowserRunSummary {
  return { runId: run.runId, sessionId: run.sessionId, state: run.state, version: run.version,
    controlRevision: run.controlRevision, updatedAt: run.updatedAt, recoveryRequired: run.recoveryRequired, requiresReconciliation,
    controls: [...(run.state === 'running' || run.state === 'queued' ? ['pause' as const] : []),
      ...(!isTerminal(run.state) && run.state !== 'stopping' ? ['stop' as const] : [])] }
}

export async function browserRunPanelRpc(store: RunPanelStore | undefined, method: string, payload: unknown, signal: AbortSignal): Promise<BrowserRunList | { item: BrowserRunSummary }> {
  if (store === undefined) throw new RunPanelError('unavailable')
  if (method === BRIDGE_RUN_LIST_METHOD) {
    const parsed = sessionPayload.safeParse(payload)
    if (!parsed.success) throw new RunPanelError('bad-request')
    const sessionId = parsed.data.sessionId
    const records = store.list(asSessionId(sessionId)).sort((a, b) => priority(a) - priority(b)
      || b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId))
    const uncertain = reconciliationRequired(store, sessionId)
    return { items: records.slice(0, BROWSER_RUN_LIST_LIMIT).map(run => summary(run, uncertain)), total: records.length }
  }
  if (method === BRIDGE_RUN_CONTROL_METHOD) {
    const parsed = controlPayload.safeParse(payload)
    if (!parsed.success) throw new RunPanelError('bad-request')
    const { sessionId, runId, expectedVersion, control } = parsed.data
    const run = store.get(asRunId(runId))
    if (run === undefined || run.sessionId !== sessionId) throw new RunPanelError('not-found')
    const changed = await store.control(run.runId, expectedVersion, control, signal)
    return { item: summary(changed, reconciliationRequired(store, sessionId)) }
  }
  throw new RunPanelError('bad-request')
}

/** Fixed errors: never echo payloads, page evidence or storage diagnostics. */
export function browserRunPanelFailure(error: unknown): { code: string; message: string } {
  const code = error instanceof RunPanelError ? error.code : error instanceof BrowserRunStoreError ? error.code : 'internal'
  return { code, message: 'Browser task state could not be read or changed. Refresh its status before another control request.' }
}
