/** Explicit panel-owned, document-bound diagnostics; model calls can only read. */
import { DIAGNOSTIC_LIMIT, diagnosticRoute, diagnosticEntrySchema, diagnosticsSchema, type DiagnosticEntry, type DiagnosticsSnapshot } from '@eilyeee/dsh-browser-stride/src/diagnostics.ts'
import { debuggerPages, type DebuggerPages, type ReadDebugLease } from './debugger-pages.ts'
import { waitForReply } from './native-wait.ts'

export interface DiagnosticsStatus { enabled: boolean; captureId?: string; startedAt?: number; count: number; dropped: number }
interface Capture {
  active: boolean; ready: boolean; id: string; startedAt: number; current: () => boolean; lease?: ReadDebugLease; unsubscribe?: () => void
  document?: string; frame?: string; origin?: string; contexts: Map<number, string>; pending: Map<string, { entry: DiagnosticEntry; started: number }>
  entries: DiagnosticEntry[]; sequence: number; dropped: number
  ownerScope: string; timer?: ReturnType<typeof setTimeout>
}
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
const errorTypes = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError'])
// Settle before the panel's 15-second RPC deadline. The original queue slot
// remains owned until native cleanup or a confirmed exclusive detach.
const START_TIMEOUT_MS = 10_000

export class DiagnosticsNotEnabledError extends Error {
  constructor() { super('diagnostics-not-enabled') }
}

export class PageDiagnostics {
  private captures = new Map<number, Capture>()
  private queues = new Map<number, Promise<unknown>>()
  constructor(private pages: DebuggerPages = debuggerPages) {}
  private serial<T>(tabId: number, job: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(tabId) ?? Promise.resolve()).catch(() => {}).then(job)
    this.queues.set(tabId, next)
    void next.finally(() => { if (this.queues.get(tabId) === next) this.queues.delete(tabId) }).catch(() => {})
    return next
  }
  private valid(tabId: number, capture: Capture): boolean {
    return this.captures.get(tabId) === capture && capture.active && capture.current() && capture.lease?.current() === true
  }
  private clear(capture: Capture): void {
    capture.active = false; capture.ready = false; capture.unsubscribe?.(); capture.unsubscribe = undefined
    capture.entries = []; capture.pending.clear(); capture.contexts.clear()
    if (capture.timer !== undefined) clearTimeout(capture.timer)
  }
  private async close(capture: Capture): Promise<void> {
    this.clear(capture)
    if (capture.lease !== undefined) {
      // Commands are idempotent domain cleanup, never page actions. Automatic
      // DOM controllers keep Runtime enabled in the shared transport.
      for (const method of ['Network.disable', 'Runtime.disable'] as const) await capture.lease.command(method).catch(() => {})
      await capture.lease.release()
    }
  }
  start(tabId: number, current: () => boolean, authorization: () => boolean, ownerScope: string): Promise<DiagnosticsStatus> {
    if (ownerScope.trim() === '' || ownerScope.length > 200) return Promise.reject(Error('diagnostics-session-required'))
    for (const [id, capture] of this.captures) if (!capture.current()) void this.stop(id).catch(() => {})
    if (!this.captures.has(tabId) && this.captures.size >= 8) return Promise.reject(Error('diagnostics-page-limit'))
    const previous = this.captures.get(tabId)
    if (previous !== undefined) this.clear(previous)
    const capture: Capture = { active: true, ready: false, id: `diag_${crypto.randomUUID()}`, startedAt: Date.now(), current,
      contexts: new Map(), pending: new Map(), entries: [], sequence: 0, dropped: 0, ownerScope }
    const detached = new AbortController()
    this.captures.set(tabId, capture)
    const starting = this.serial(tabId, async () => {
      if (previous !== undefined) await this.close(previous)
      try {
        if (!capture.active || !current() || !authorization()) throw Error('diagnostics-revoked')
        // Lifetime authority is the page lease. Native capture generation is
        // checked separately, so stopping can still clean its owned domains.
        capture.lease = await this.pages.acquireReadLease(tabId, authorization, authorization)
        if (!this.valid(tabId, capture)) throw Error('diagnostics-revoked')
        const tree = await waitForReply(capture.lease.command<{ frameTree?: { frame?: { id?: string; loaderId?: string; url?: string } } }>('Page.getFrameTree'), detached.signal)
        if (!this.valid(tabId, capture)) throw Error('diagnostics-revoked')
        const frame = tree.frameTree?.frame
        if (!frame?.id || !frame.loaderId || !frame.url || !/^https?:/.test(frame.url)) throw Error('diagnostics-document-unavailable')
        capture.frame = frame.id; capture.document = `${frame.id}:${frame.loaderId}`; capture.origin = new URL(frame.url).origin
        capture.unsubscribe = capture.lease.subscribe((method, params) => {
          if (this.valid(tabId, capture)) this.event(tabId, capture, method, params ?? {})
          else void this.stop(tabId, capture.id).catch(() => {})
        })
        for (const context of capture.lease.contexts()) if (context.frameId === capture.frame) capture.contexts.set(context.id, context.uniqueId)
        for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable'] as const) {
          if (!this.valid(tabId, capture)) throw Error('diagnostics-revoked')
          await waitForReply(capture.lease.command(method, method === 'Network.enable'
            ? { maxTotalBufferSize: 65_536, maxResourceBufferSize: 4_096, maxPostDataSize: 0 } : undefined), detached.signal)
        }
        if (!this.valid(tabId, capture)) throw Error('diagnostics-revoked')
        capture.ready = true
        capture.timer = setTimeout(() => { void this.stop(tabId, capture.id).catch(() => {}) }, 10 * 60_000)
        return this.status(tabId)
      } catch (error) {
        await this.close(capture).catch(() => {})
        if (this.captures.get(tabId) === capture) this.captures.delete(tabId)
        throw error
      }
    })
    let timeout: ReturnType<typeof setTimeout>
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        // Invalidate immediately, but never detach a successor or release the
        // serial slot while an older native attach/command still owns it.
        this.clear(capture)
        if (this.captures.get(tabId) === capture) this.captures.delete(tabId)
        const error = Error('diagnostics-start-timeout')
        reject(error)
        // A reply from the retired connection cannot enable a new capture.
        // Shared connections retain the original wait and cleanup order.
        void capture.lease?.detachIfExclusive().then(confirmed => {
          if (confirmed) detached.abort(error)
        }).catch(() => {})
      }, START_TIMEOUT_MS)
    })
    // The losing native promise remains observed and performs its own cleanup;
    // a late reply cannot enable capture, replay an expired start or lose errors.
    return Promise.race([starting, expired]).finally(() => { clearTimeout(timeout) })
  }
  stop(tabId: number, expectedId?: string): Promise<void> {
    const capture = this.captures.get(tabId)
    if (capture === undefined) return Promise.resolve()
    if (expectedId !== undefined && expectedId !== capture.id) return Promise.reject(Error('diagnostics-stale'))
    this.clear(capture); this.captures.delete(tabId)
    return this.serial(tabId, () => this.close(capture))
  }
  stopAll(): void { for (const tabId of this.captures.keys()) void this.stop(tabId).catch(() => {}) }
  status(tabId: number, ownerScope?: string): DiagnosticsStatus {
    const capture = this.captures.get(tabId)
    if (capture !== undefined && (!capture.current() || capture.lease !== undefined && !capture.lease.current())) void this.stop(tabId, capture.id).catch(() => {})
    if (capture === undefined || (ownerScope !== undefined && capture.ownerScope !== ownerScope) || !capture.ready || !this.valid(tabId, capture)) return { enabled: false, count: 0, dropped: 0 }
    return { enabled: true, captureId: capture.id, startedAt: capture.startedAt, count: capture.entries.length, dropped: capture.dropped }
  }
  async read(tabId: number, current: () => boolean, ownerScope: string, limit = 30): Promise<DiagnosticsSnapshot> {
    const capture = this.captures.get(tabId)
    if (capture !== undefined && (!capture.current() || capture.lease !== undefined && !capture.lease.current())) void this.stop(tabId, capture.id).catch(() => {})
    if (!current()) throw Error('diagnostics-document-changed')
    if (capture === undefined || !capture.ready || capture.ownerScope !== ownerScope || !this.valid(tabId, capture)) throw new DiagnosticsNotEnabledError()
    const tree = await capture.lease!.command<{ frameTree: { frame: { id: string; loaderId: string } } }>('Page.getFrameTree')
    if (`${tree.frameTree.frame.id}:${tree.frameTree.frame.loaderId}` !== capture.document || !current() || !this.valid(tabId, capture)) {
      await this.stop(tabId, capture.id); throw Error('diagnostics-document-changed')
    }
    return diagnosticsSchema.parse({ version: 1, captureId: capture.id, startedAt: capture.startedAt, scope: 'authorized-top-document', complete: false,
      omitted: ['past-events', 'subframes', 'workers', 'messages', 'headers', 'bodies', 'query-values', 'raw-paths', ...(capture.dropped > 0 ? ['buffer-overflow'] : [])],
      dropped: capture.dropped, entries: capture.entries.slice(-Math.max(1, Math.min(DIAGNOSTIC_LIMIT, Math.floor(limit)))) })
  }
  private push(capture: Capture, value: unknown): void {
    const parsed = diagnosticEntrySchema.safeParse(value)
    if (!parsed.success) return
    if (capture.entries.length === DIAGNOSTIC_LIMIT) { capture.entries.shift(); capture.dropped++ }
    capture.entries.push(parsed.data)
  }
  private event(tabId: number, c: Capture, method: string, p: Record<string, unknown>): void {
    if (method === 'DSH.detached' || method === 'Runtime.executionContextsCleared' || method === 'Page.frameNavigated' && record(p.frame).parentId === undefined) {
      void this.stop(tabId, c.id).catch(() => {}); return
    }
    if (method === 'Runtime.executionContextCreated') {
      const context = record(p.context), aux = record(context.auxData)
      if (number(context.id)) c.contexts.delete(context.id)
      if (number(context.id) && aux.frameId === c.frame && aux.isDefault === true && typeof context.uniqueId === 'string') {
        if (c.contexts.size < 64) c.contexts.set(context.id, context.uniqueId); else c.dropped++
      }
      return
    }
    if (method === 'Runtime.executionContextDestroyed' && number(p.executionContextId)) {
      if (p.executionContextUniqueId === undefined || p.executionContextUniqueId === c.contexts.get(p.executionContextId)) c.contexts.delete(p.executionContextId)
      return
    }
    if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
      const exception = record(p.exceptionDetails), context = method === 'Runtime.consoleAPICalled' ? p.executionContextId : exception.executionContextId
      if (!number(context) || !c.contexts.has(context)) return
      if (typeof p.timestamp !== 'number' || !Number.isFinite(p.timestamp) || p.timestamp < c.startedAt) return
      if (method === 'Runtime.consoleAPICalled' && p.type !== 'error' && p.type !== 'warning') return
      const first = Array.isArray(p.args) ? record(p.args[0]) : record(exception.exception)
      const errorType = typeof first.className === 'string' && errorTypes.has(first.className) ? first.className : undefined
      const stack = record(method === 'Runtime.consoleAPICalled' ? p.stackTrace : exception.stackTrace), frame = Array.isArray(stack.callFrames) ? record(stack.callFrames[0]) : exception
      this.push(c, { sequence: ++c.sequence, observedAt: Date.now(), kind: 'console', level: p.type === 'warning' ? 'warning' : 'error',
        ...(errorType === undefined ? {} : { errorType }), ...(typeof frame.url === 'string' ? { route: diagnosticRoute(frame.url) } : {}),
        ...(number(frame.lineNumber) ? { line: frame.lineNumber } : {}), ...(number(frame.columnNumber) ? { column: frame.columnNumber } : {}) })
      return
    }
    const id = p.requestId
    if (typeof id !== 'string' || id.length > 200) return
    if (method === 'Network.requestWillBeSent') {
      c.pending.delete(id)
      if (p.frameId !== c.frame || (typeof p.loaderId === 'string' && p.loaderId !== c.document?.slice((c.frame?.length ?? 0) + 1))
        || typeof p.wallTime !== 'number' || !Number.isFinite(p.wallTime) || p.wallTime * 1000 < c.startedAt) return
      const request = record(p.request), method = typeof request.method === 'string' && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER'
      let sameOrigin = false
      try { sameOrigin = new URL(String(request.url)).origin === c.origin } catch { /* no raw URL is retained */ }
      const type = typeof p.type === 'string' ? p.type.toLowerCase() : 'other'
      if (c.pending.size >= DIAGNOSTIC_LIMIT) { c.pending.delete(c.pending.keys().next().value!); c.dropped++ }
      c.pending.set(id, { started: Date.now(), entry: diagnosticEntrySchema.parse({ sequence: ++c.sequence, observedAt: Date.now(), kind: 'network', method,
        resourceType: ['document', 'script', 'stylesheet', 'image', 'fetch', 'xhr'].includes(type) ? type : 'other', sameOrigin,
        route: sameOrigin && typeof request.url === 'string' ? diagnosticRoute(request.url) : '/[segment]' }) })
    } else {
      const pending = c.pending.get(id)
      if (pending === undefined) return
      if (method === 'Network.responseReceived') {
        if (p.frameId !== undefined && p.frameId !== c.frame) { c.pending.delete(id); return }
        const status = record(p.response).status
        if (number(status) && status >= 100 && status <= 599 && pending.entry.kind === 'network') {
          pending.entry.status = status
          if (status >= 400) pending.entry.failure = 'http-error'
        }
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const value = { ...pending.entry, durationMs: Math.min(600_000, Math.max(0, Date.now() - pending.started)),
          ...(method === 'Network.loadingFailed' ? { failure: p.canceled === true ? 'cancelled' : typeof p.blockedReason === 'string' ? 'blocked' : 'network-error' } : {}) }
        c.pending.delete(id); this.push(c, value)
      }
    }
  }
}
export const pageDiagnostics = new PageDiagnostics()
