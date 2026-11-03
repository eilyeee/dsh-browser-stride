/** Chrome transport: automatic new pages and authorized visual connections. */
import type { TabFrame } from './frames.ts'
import { MAX_SCREENSHOT_BASE64, type VisualObservation } from '@eilyeee/dsh-browser-stride/src/visual.ts'

interface Session {
  current: () => boolean
  worlds: Map<number, { id: string; frameId: string }>
  context?: { document: string; id: string }
  preparing?: Promise<string>
}
interface Frame { id: string; loaderId: string; url: string }
interface VisualConnection { valid: boolean; attached: boolean; current: () => boolean; preparing?: Promise<void>; closing?: Promise<void> }
interface Evaluation { result?: { value?: unknown }; exceptionDetails?: unknown }
const CONTROLLER_WORLD = 'DSH Stride controller'
const VISUAL_CAPTURES_KEY = 'dshVisualCaptures'

/** Request authority is checked at the transport's actual delivery boundary. */
export interface PageDispatch {
  current?: () => boolean
  commit?: () => void
}
export class PageDispatchRevoked extends Error {
  constructor() { super('The original browser request was revoked before dispatch.') }
}
function commitDispatch(dispatch?: PageDispatch): void {
  if (dispatch?.current?.() === false) throw new PageDispatchRevoked()
  dispatch?.commit?.()
}

export class DebuggerPages {
  private sessions = new Map<number, Session>()
  private captures = new Map<number, VisualConnection>()
  private captureRecovery?: Promise<void>
  private captureWrites = Promise.resolve()
  private source?: Promise<string>
  onDetached: (tabId: number) => void = () => {}
  constructor() {
    if (typeof chrome !== 'undefined') chrome.debugger?.onDetach.addListener(target => {
      if (target.tabId === undefined) return
      const capture = this.captures.get(target.tabId)
      if (capture !== undefined) {
        capture.valid = false
        capture.attached = false
        if (capture.closing === undefined) {
          this.onDetached(target.tabId)
          void this.detachVisual(target.tabId).catch(() => {})
        }
        return
      }
      if (!this.sessions.delete(target.tabId)) return
      this.onDetached(target.tabId)
    })
    if (typeof chrome !== 'undefined') chrome.debugger?.onEvent?.addListener((target, method, params) => {
      if (target.tabId === undefined || target.sessionId !== undefined) return
      const session = this.sessions.get(target.tabId)
      if (session === undefined) return
      if (method === 'Runtime.executionContextCreated') {
        const context = params?.context as { id?: unknown; uniqueId?: unknown; name?: unknown; auxData?: { frameId?: unknown; isDefault?: unknown } } | undefined
        if (typeof context?.id !== 'number' || !Number.isSafeInteger(context.id) || typeof context.uniqueId !== 'string'
          || context.uniqueId === '' || context.name !== CONTROLLER_WORLD || context.auxData?.isDefault !== false
          || typeof context.auxData.frameId !== 'string') return
        const previous = session.worlds.get(context.id)
        if (previous?.id === session.context?.id && previous?.id !== context.uniqueId) session.context = undefined
        session.worlds.set(context.id, { id: context.uniqueId, frameId: context.auxData.frameId })
      } else if (method === 'Runtime.executionContextDestroyed') {
        const id = params?.executionContextId
        if (typeof id !== 'number') return
        const previous = session.worlds.get(id)
        if (previous === undefined || (typeof params?.executionContextUniqueId === 'string' && params.executionContextUniqueId !== previous.id)) return
        session.worlds.delete(id)
        if (session.context?.id === previous.id) session.context = undefined
      } else if (method === 'Runtime.executionContextsCleared') {
        session.worlds.clear()
        session.context = undefined
      }
    })
  }
  has(tabId: number): boolean { return this.sessions.has(tabId) }
  private async detachRecordedVisual(tabId: number): Promise<void> {
    try { await chrome.debugger.detach({ tabId }) }
    catch (error) {
      // Only native evidence of an absent target/connection confirms cleanup.
      // Unknown failures retain the invalid owned record and block successors.
      if (!(error instanceof Error) || !/(?:Debugger is not attached|No tab with|No target with|Target closed)/i.test(error.message)) throw error
    }
  }
  /** Cleanup records never restore authority, including after a worker crash. */
  recoverCaptures(): Promise<void> {
    return this.captureRecovery ??= (async () => {
      if (chrome.debugger === undefined) return
      const stored = (await chrome.storage.session.get(VISUAL_CAPTURES_KEY))[VISUAL_CAPTURES_KEY]
      if (stored === undefined) return
      if (Array.isArray(stored)) for (const id of stored) {
        if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) await this.detachRecordedVisual(id)
      }
      await chrome.storage.session.set({ [VISUAL_CAPTURES_KEY]: [] })
    })()
  }
  private persistCaptures(): Promise<void> {
    const ids = [...this.captures.keys()]
    const pending = this.captureWrites.catch(() => {}).then(() => chrome.storage.session.set({ [VISUAL_CAPTURES_KEY]: ids }))
    this.captureWrites = pending
    return pending
  }
  private allowed(tabId: number, session: Session): void {
    if (this.sessions.get(tabId) !== session || !session.current()) throw new Error('The debugger page is no longer authorized.')
  }
  private async command<T>(tabId: number, session: Session, method: string, params?: object, dispatch?: PageDispatch): Promise<T> {
    this.allowed(tabId, session)
    commitDispatch(dispatch)
    const answer = await chrome.debugger.sendCommand({ tabId }, method, params) as T
    this.allowed(tabId, session)
    return answer
  }
  async attachCreated(tabId: number, current: () => boolean, signal?: AbortSignal, timeoutMs = 8000): Promise<void> {
    if (chrome.debugger === undefined || !current() || this.has(tabId) || this.captures.has(tabId)) throw new Error('Automatic page control is unavailable.')
    const session: Session = { current, worlds: new Map() }
    this.sessions.set(tabId, session)
    try {
      const deadline = Date.now() + timeoutMs
      let attached = false
      let lastError: unknown
      while (!signal?.aborted && Date.now() < deadline) {
        this.allowed(tabId, session)
        const tab = await chrome.tabs.get(tabId)
        this.allowed(tabId, session)
        if (signal?.aborted) break
        if (/^https?:\/\//i.test(tab.url ?? '')) {
          try { await chrome.debugger.attach({ tabId }, '1.3'); attached = true; break }
          catch (error) {
            this.allowed(tabId, session)
            // A transitioning new-tab renderer can still reject attachment.
            // Completed-page refusals and explicit policy errors are final;
            // native cancellation removes this session and cannot reattach.
            if (!(error instanceof Error) || !/^Cannot attach to this target\.?$/.test(error.message)
              || (tab.status !== 'loading' && tab.pendingUrl === undefined)) throw error
            lastError = error
          }
        } else if (!/^https?:\/\//i.test(tab.pendingUrl ?? '')
          && tab.url !== 'about:blank' && !/^chrome:\/\/(?:newtab|new-tab-page)\//.test(tab.url ?? '')) {
          throw new Error('Only HTTP(S) pages can be controlled.')
        }
        await new Promise<void>(resolve => { setTimeout(resolve, 50) })
      }
      if (!attached) throw signal?.aborted ? new Error('Automatic page control was cancelled.')
        : lastError ?? new Error('The new HTTP(S) tab was not ready for debugging.')
      if (signal?.aborted) throw new Error('Automatic page control was cancelled.')
      this.allowed(tabId, session)
      await this.command(tabId, session, 'Page.enable')
      await this.command(tabId, session, 'Runtime.enable')
    } catch (error) {
      if (this.sessions.get(tabId) === session) this.sessions.delete(tabId)
      await chrome.debugger.detach({ tabId }).catch(() => {})
      throw error
    }
  }
  /** Attach before measuring the viewport; Chrome's debug UI can resize it. */
  async prepareViewportCapture(tabId: number, current: () => boolean, authorization: () => boolean): Promise<void> {
    await this.recoverCaptures()
    if (!current() || !authorization()) throw new PageDispatchRevoked()
    if (this.has(tabId)) { this.session(tabId); return }
    const previous = this.captures.get(tabId)
    if (previous !== undefined && (!previous.valid || !previous.current())) await this.detachVisual(tabId)
    if (!current() || !authorization()) throw new PageDispatchRevoked()
    const live = this.captures.get(tabId)
    if (live !== undefined) {
      if (!live.attached) throw new Error('A visual connection is still being prepared.')
      return
    }
    if (chrome.debugger === undefined) throw new Error('Chrome visual capture is unavailable.')
    const lease: VisualConnection = { valid: true, attached: false, current: authorization }
    this.captures.set(tabId, lease)
    const preparing = (async () => {
      try {
        await this.persistCaptures()
        if (!current() || !lease.current() || !lease.valid) throw new PageDispatchRevoked()
        await chrome.debugger.attach({ tabId }, '1.3')
        lease.attached = true
        if (!current() || !lease.current() || !lease.valid || this.captures.get(tabId) !== lease) throw new PageDispatchRevoked()
      } catch (error) {
        lease.valid = false
        // Keep ownership through a late attach and its confirmed detach. A
        // successor cannot acquire this native tab while cleanup is pending.
        const closing = Promise.resolve().then(async () => {
          if (lease.attached) await this.detachRecordedVisual(tabId)
          if (this.captures.get(tabId) === lease) this.captures.delete(tabId)
          await this.persistCaptures()
        })
        lease.closing = closing
        await closing
        throw error
      }
    })()
    lease.preparing = preparing
    try { await preparing } finally { if (lease.preparing === preparing) lease.preparing = undefined }
  }
  /** Only already-authorized native targets; never the currently visible personal tab. */
  async captureViewport(tabId: number, view: VisualObservation, current: () => boolean): Promise<string> {
    if (!current()) throw new PageDispatchRevoked()
    const zoom = await chrome.tabs.getZoom(tabId)
    if (!current() || !Number.isFinite(zoom) || zoom <= 0) throw new PageDispatchRevoked()
    // CDP clips use device-independent pixels; page events use CSS pixels.
    // Browser page zoom is distinct from the screen's device pixel ratio.
    const params = { format: 'jpeg', quality: 85, fromSurface: true, captureBeyondViewport: false,
      clip: { x: view.scrollX * zoom, y: view.scrollY * zoom, width: view.width * zoom, height: view.height * zoom,
        scale: Math.min(1, 1600 / view.width, 1200 / view.height) / view.devicePixelRatio } }
    let answer: { data?: unknown }
    if (!current()) throw new PageDispatchRevoked()
    if (this.has(tabId)) answer = await this.command(tabId, this.session(tabId), 'Page.captureScreenshot', params, { current })
    else {
      const lease = this.captures.get(tabId)
      if (lease === undefined || !lease.attached || !lease.valid || !lease.current()) throw new PageDispatchRevoked()
      answer = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params) as { data?: unknown }
      if (this.captures.get(tabId) !== lease || !lease.valid || !lease.current()) throw new PageDispatchRevoked()
    }
    if (!current() || typeof answer.data !== 'string' || answer.data.length === 0 || answer.data.length > MAX_SCREENSHOT_BASE64) {
      throw new Error('The screenshot was cancelled or exceeded its image budget.')
    }
    return answer.data
  }
  /** Withdraw first; the native slot stays owned until pending cleanup settles. */
  async detachVisual(tabId: number): Promise<void> {
    const lease = this.captures.get(tabId)
    if (lease === undefined) return
    lease.valid = false
    if (lease.closing !== undefined) { await lease.closing; return }
    if (lease.preparing !== undefined) {
      await lease.preparing.catch(() => {})
      // Revocation can arrive after prepare's last guard, while its settled
      // promise is still installed. Finish cleanup instead of leaving a native
      // connection behind; never touch a successor that acquired the tab.
      if (this.captures.get(tabId) === lease) await this.detachVisual(tabId)
      return
    }
    const closing = Promise.resolve().then(async () => {
      if (lease.attached) await this.detachRecordedVisual(tabId)
      if (this.captures.get(tabId) === lease) this.captures.delete(tabId)
      await this.persistCaptures()
    })
    lease.closing = closing
    await closing
  }
  async releaseStaleVisual(): Promise<void> {
    await Promise.all([...this.captures].filter(([, lease]) => !lease.current()).map(([id]) => this.detachVisual(id)))
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
  private async context(tabId: number, session: Session, frame: Frame): Promise<string> {
    const document = `${frame.id}:${frame.loaderId}`
    if (session.context?.document === document) return session.context.id
    if (session.preparing !== undefined) { await session.preparing; this.allowed(tabId, session); return this.context(tabId, session, frame) }
    const preparing = (async () => {
      const source = await (this.source ??= fetch(chrome.runtime.getURL('debugger-content.js')).then(response => {
        if (!response.ok) throw new Error('The packaged browser controller is unavailable.')
        return response.text()
      }).catch(error => { this.source = undefined; throw error }))
      const world = await this.command<{ executionContextId: number }>(tabId, session, 'Page.createIsolatedWorld', {
        frameId: frame.id, worldName: CONTROLLER_WORLD, grantUniveralAccess: false,
      })
      // Numeric context ids can be reused after cross-process navigation.
      // Resolve the browser-issued unique id and never evaluate using the number.
      const deadline = Date.now() + 1000
      while (!session.worlds.has(world.executionContextId) && Date.now() < deadline) {
        this.allowed(tabId, session)
        await new Promise<void>(resolve => { setTimeout(resolve, 10) })
      }
      const identified = session.worlds.get(world.executionContextId)
      if (identified?.frameId !== frame.id) throw new Error('The isolated page controller could not be identified.')
      const installed = await this.command<Evaluation>(tabId, session, 'Runtime.evaluate', {
        uniqueContextId: identified.id, expression: source, returnByValue: true,
      })
      if (installed.exceptionDetails !== undefined) throw new Error('The packaged browser controller could not start.')
      const live = await this.frame(tabId, session)
      if (`${live.id}:${live.loaderId}` !== document || session.worlds.get(world.executionContextId)?.id !== identified.id) throw new Error('The page changed while preparing its controller.')
      session.context = { document, id: identified.id }
      return identified.id
    })()
    session.preparing = preparing
    try { return await preparing } finally { if (session.preparing === preparing) session.preparing = undefined }
  }
  async send(tabId: number, message: unknown, options?: { frameId?: number; documentId?: string }, dispatch?: PageDispatch): Promise<unknown> {
    const session = this.session(tabId)
    if (options?.frameId !== undefined && options.frameId !== 0) throw new Error('Automatic control supports only the main document.')
    const frame = await this.frame(tabId, session)
    const document = `${frame.id}:${frame.loaderId}`
    if (options?.documentId !== undefined && options.documentId !== document) throw new Error('The target document changed before dispatch.')
    const uniqueContextId = await this.context(tabId, session, frame)
    const live = await this.frame(tabId, session)
    if (`${live.id}:${live.loaderId}` !== document || live.url !== frame.url) throw new Error('The target document changed before dispatch.')
    const response = await this.command<Evaluation>(tabId, session, 'Runtime.evaluate', {
      uniqueContextId, expression: `globalThis.__strideDebuggerAction(JSON.parse(${JSON.stringify(JSON.stringify(message))}))`,
      awaitPromise: true, returnByValue: true,
    }, dispatch)
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
          const uniqueContextId = await this.context(tabId, session, frame)
          const state = await this.command<Evaluation>(tabId, session, 'Runtime.evaluate', {
            uniqueContextId, expression: 'document.readyState', returnByValue: true,
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
export function sendPageMessage(tabId: number, message: unknown, options?: chrome.tabs.MessageSendOptions, dispatch?: PageDispatch): Promise<unknown> {
  if (debuggerPages.has(tabId)) return debuggerPages.send(tabId, message, options, dispatch)
  commitDispatch(dispatch)
  return options === undefined ? chrome.tabs.sendMessage(tabId, message) : chrome.tabs.sendMessage(tabId, message, options)
}
