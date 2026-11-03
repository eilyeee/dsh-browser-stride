import { BRIDGE_TASK_PAGE_PREPARE_METHOD, BRIDGE_TASK_PAGE_CANCEL_METHOD, BRIDGE_TASK_START_METHOD, taskPageUrl } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { BridgeRpcError } from './rpc.ts'
import type { CreatedPageAccess } from './page-access.ts'

/** Grant withdrawal invalidates a tab lifetime, so check session ownership again afterwards. */
export async function cleanupOwnedTaskPage(access: CreatedPageAccess, before: () => boolean, after: () => boolean,
  remove: () => Promise<void>): Promise<void> {
  if (!before() || !access.canClose()) return
  await access.release()
  if (after() && access.canClose()) await remove()
}

export interface TaskPageStartRequest {
  runId: string; sessionId: string; expectedVersion: number; controlRevision: number; url: string
}
export interface PreparedTaskPage {
  targetUrl: string; targetBinding: string
  current(): boolean
  /** Only releases this attempt's grant/tab, and respects native takeover. */
  cleanup(): Promise<void>
  discard(): void
}
interface Dependencies {
  current(): boolean
  request(method: string, payload: unknown, options: { signal?: AbortSignal; timeoutMs: number }): Promise<unknown>
  enqueue<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>
  create(url: string): Promise<PreparedTaskPage>
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A native click creates one page. A missing commit reply never authorizes replay or closure. */
export async function startTaskPage(input: TaskPageStartRequest, deps: Dependencies, signal: AbortSignal): Promise<void> {
  const url = taskPageUrl(input.url)
  const check = () => { if (signal.aborted || !deps.current()) throw new Error('Task page selection changed') }
  check()
  if (url === undefined) throw new BridgeRpcError('start-rejected', 'A complete HTTP or HTTPS URL is required')
  const scope = { runId: input.runId, sessionId: input.sessionId, expectedVersion: input.expectedVersion, controlRevision: input.controlRevision }
  const reserved = await deps.request(BRIDGE_TASK_PAGE_PREPARE_METHOD, { ...scope, url }, { signal, timeoutMs: 5000 })
  if (!record(reserved) || typeof reserved.startTicket !== 'string' || reserved.startTicket.length === 0 || reserved.startTicket.length > 200
    || reserved.launchUrl !== url || typeof reserved.expiresAt !== 'number' || !Number.isSafeInteger(reserved.expiresAt)) {
    throw new BridgeRpcError('start-rejected', 'Task page reservation was not confirmed')
  }
  const startTicket = reserved.startTicket
  const expiresAt = reserved.expiresAt
  let sent = false
  let cancelReservation = true
  let page: PreparedTaskPage | undefined
  try {
    await deps.enqueue(signal, async () => {
      try {
        check()
        if (Date.now() >= expiresAt) throw new Error('Task page reservation expired')
        page = await deps.create(url)
        check()
        if (!page.current() || Date.now() >= expiresAt) throw new Error('Task page changed before startup')
        // The Host can start its Agent before replying. From here on, silence is uncertainty.
        sent = true
        cancelReservation = false
        const result = await deps.request(BRIDGE_TASK_START_METHOD, { ...scope, startTicket, launchUrl: url,
          targetBinding: page.targetBinding, targetUrl: page.targetUrl }, { signal, timeoutMs: 12000 })
        if (!record(result) || result.runId !== input.runId || result.sessionId !== input.sessionId
          || result.controlRevision !== input.controlRevision || result.state !== 'running' || result.targetBinding !== page.targetBinding) {
          throw new Error('Task startup reply was not confirmed')
        }
      } catch (error) {
        if (sent && !(error instanceof BridgeRpcError && error.code === 'start-rejected')) {
          throw new BridgeRpcError('start-uncertain', 'Task startup was not confirmed. Keep the page and check task status.')
        }
        cancelReservation = true
        page?.discard()
        try { await page?.cleanup() }
        catch { throw new BridgeRpcError('start-cleanup-unconfirmed', 'Task did not start; page cleanup was not confirmed.') }
        throw error
      }
    })
  } finally {
    if (cancelReservation) await deps.request(BRIDGE_TASK_PAGE_CANCEL_METHOD, { runId: input.runId, sessionId: input.sessionId, startTicket },
      { timeoutMs: 2000 }).catch(() => {})
  }
}
