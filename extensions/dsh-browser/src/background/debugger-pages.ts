/** Chrome-only transport. Only the open-tab path may attach a newly created tab. */
import type { TabFrame } from './frames.ts'

interface Session {
  current: () => boolean
  context?: { document: string; id: number }
  preparing?: Promise<number>
}
interface Frame { id: string; loaderId: string; url: string }
interface Evaluation { result?: { value?: unknown }; exceptionDetails?: unknown }

export class DebuggerPages {
  private sessions = new Map<number, Session>()
  private source?: Promise<string>
  onDetached: (tabId: number) => void = () => {}
  constructor() {
    if (typeof chrome !== 'undefined') chrome.debugger?.onDetach.addListener(target => {
      if (target.tabId === undefined || !this.sessions.delete(target.tabId)) return
      this.onDetached(target.tabId)
    })
  }
  has(tabId: number): boolean { return this.sessions.has(tabId) }
  private allowed(tabId: number, session: Session): void {
    if (this.sessions.get(tabId) !== session || !session.current()) throw new Error('The debugger page is no longer authorized.')
  }
  private async command<T>(tabId: number, session: Session, method: string, params?: object): Promise<T> {
    this.allowed(tabId, session)
    const answer = await chrome.debugger.sendCommand({ tabId }, method, params) as T
    this.allowed(tabId, session)
    return answer
  }
  async attachCreated(tabId: number, current: () => boolean): Promise<void> {
    if (chrome.debugger === undefined || !current() || this.has(tabId)) throw new Error('Automatic page control is unavailable.')
    const session: Session = { current }
    this.sessions.set(tabId, session)
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
      this.allowed(tabId, session)
      await this.command(tabId, session, 'Page.enable')
    } catch (error) {
      if (this.sessions.get(tabId) === session) this.sessions.delete(tabId)
      await chrome.debugger.detach({ tabId }).catch(() => {})
      throw error
    }
  }
  async detach(tabId: number): Promise<void> {
    // Withdraw locally before awaiting Chrome. No late command can acquire a new session.
    this.sessions.delete(tabId)
    if (chrome.debugger !== undefined) await chrome.debugger.detach({ tabId }).catch(() => {})
  }
  private session(tabId: number): Session {
    const session = this.sessions.get(tabId)
    if (session === undefined) throw new Error('The debugger page is not attached.')
    this.allowed(tabId, session)
    return session
  }
  private async frame(tabId: number, session: Session): Promise<Frame> {
    const result = await this.command<{ frameTree: { frame: Frame } }>(tabId, session, 'Page.getFrameTree')
    if (!/^https?:\/\//i.test(result.frameTree.frame.url)) throw new Error('Only HTTP(S) pages can be controlled.')
    return result.frameTree.frame
  }
  async frames(tabId: number): Promise<TabFrame[]> {
    const frame = await this.frame(tabId, this.session(tabId))
    // Automatic control currently supports the top document only. Child frames get no authority.
    return [{ frameId: 0, parentFrameId: -1, url: frame.url, documentId: `${frame.id}:${frame.loaderId}` }]
  }
  private async context(tabId: number, session: Session, frame: Frame): Promise<number> {
    const document = `${frame.id}:${frame.loaderId}`
    if (session.context?.document === document) return session.context.id
    if (session.preparing !== undefined) { await session.preparing; this.allowed(tabId, session); return this.context(tabId, session, frame) }
    const preparing = (async () => {
      const source = await (this.source ??= fetch(chrome.runtime.getURL('debugger-content.js')).then(response => {
        if (!response.ok) throw new Error('The packaged browser controller is unavailable.')
        return response.text()
      }).catch(error => { this.source = undefined; throw error }))
      const world = await this.command<{ executionContextId: number }>(tabId, session, 'Page.createIsolatedWorld', {
        frameId: frame.id, worldName: 'DSH Stride controller', grantUniveralAccess: false,
      })
      const installed = await this.command<Evaluation>(tabId, session, 'Runtime.evaluate', {
        contextId: world.executionContextId, expression: source, returnByValue: true,
      })
      if (installed.exceptionDetails !== undefined) throw new Error('The packaged browser controller could not start.')
      const live = await this.frame(tabId, session)
      if (`${live.id}:${live.loaderId}` !== document) throw new Error('The page changed while preparing its controller.')
      session.context = { document, id: world.executionContextId }
      return world.executionContextId
    })()
    session.preparing = preparing
    try { return await preparing } finally { if (session.preparing === preparing) session.preparing = undefined }
  }
  async send(tabId: number, message: unknown, options?: { frameId?: number; documentId?: string }): Promise<unknown> {
    const session = this.session(tabId)
    if (options?.frameId !== undefined && options.frameId !== 0) throw new Error('Automatic control supports only the main document.')
    const frame = await this.frame(tabId, session)
    const document = `${frame.id}:${frame.loaderId}`
    if (options?.documentId !== undefined && options.documentId !== document) throw new Error('The target document changed before dispatch.')
    const contextId = await this.context(tabId, session, frame)
    const live = await this.frame(tabId, session)
    if (`${live.id}:${live.loaderId}` !== document || live.url !== frame.url) throw new Error('The target document changed before dispatch.')
    const response = await this.command<Evaluation>(tabId, session, 'Runtime.evaluate', {
      contextId, expression: `globalThis.__strideDebuggerAction(JSON.parse(${JSON.stringify(JSON.stringify(message))}))`,
      awaitPromise: true, returnByValue: true,
    })
    if (response.exceptionDetails !== undefined) throw new Error('The page stopped responding after dispatch. Observe it before another action.')
    const answer = response.result?.value as { result?: { navigationPending?: boolean } } | undefined
    if (answer?.result?.navigationPending !== true) {
      const after = await this.frame(tabId, session)
      if (`${after.id}:${after.loaderId}` !== document || after.url !== frame.url) throw new Error('The page changed during the operation. Observe it before another action.')
    }
    return response.result?.value
  }
  async ready(tabId: number, previousDocumentId: string | undefined, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (!signal.aborted && Date.now() < deadline && this.has(tabId)) {
      try {
        const session = this.session(tabId)
        const frame = await this.frame(tabId, session)
        if (`${frame.id}:${frame.loaderId}` !== previousDocumentId) {
          const contextId = await this.context(tabId, session, frame)
          const state = await this.command<Evaluation>(tabId, session, 'Runtime.evaluate', {
            contextId, expression: 'document.readyState', returnByValue: true,
          })
          if (state.result?.value === 'interactive' || state.result?.value === 'complete') return !signal.aborted
        }
      } catch { /* navigation can destroy an execution context; never replay an action */ }
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    }
    return false
  }
}

export const debuggerPages = new DebuggerPages()

/** One transport per page; a stopped debugger page never falls back to broader native access. */
export function sendPageMessage(tabId: number, message: unknown, options?: chrome.tabs.MessageSendOptions): Promise<unknown> {
  return debuggerPages.has(tabId) ? debuggerPages.send(tabId, message, options)
    : options === undefined ? chrome.tabs.sendMessage(tabId, message) : chrome.tabs.sendMessage(tabId, message, options)
}
