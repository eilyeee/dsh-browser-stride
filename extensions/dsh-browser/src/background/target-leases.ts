/** Receive-time target fences. They grant no permission and never survive a worker. */
export interface ToolTargetIdentity { tabId: number; windowId: number; url: string }
export interface ToolTargetLease {
  readonly target: Readonly<ToolTargetIdentity>
  /** Worker-local owner/session/tab lifetime, never supplied by page/model. */
  readonly observationScope: string
  /** Native intervention revokes observation/input without revoking diagnostics. */
  observationCurrent(): boolean
  /** Full pre-dispatch fence, including observed document/history changes. */
  current(): boolean
  /** After dispatch, an action may observe its own navigation in the same binding. */
  sameBinding(): boolean
}

export class TargetLeaseRegistry {
  private owner = {}
  private readonly sessions = new Map<string | undefined, object>()
  private readonly tabs = new Map<number, { lifetime: object; document: object; observation: object }>()
  private readonly scopeIds = new WeakMap<object, string>()
  private scopeId(value: object): string {
    let id = this.scopeIds.get(value)
    if (id === undefined) { id = crypto.randomUUID(); this.scopeIds.set(value, id) }
    return id
  }

  /** Fence a native creation before it has a tab; never adopts a later rebind. */
  captureSession(sessionId: string): () => boolean {
    let session = this.sessions.get(sessionId)
    if (session === undefined) { session = {}; this.sessions.set(sessionId, session) }
    const owner = this.owner
    return () => this.owner === owner && this.sessions.get(sessionId) === session
  }

  capture(sessionId: string | undefined, target: ToolTargetIdentity, resolve: () => ToolTargetIdentity | undefined): ToolTargetLease {
    let session = this.sessions.get(sessionId)
    if (session === undefined) { session = {}; this.sessions.set(sessionId, session) }
    let tab = this.tabs.get(target.tabId)
    if (tab === undefined) { tab = { lifetime: {}, document: {}, observation: {} }; this.tabs.set(target.tabId, tab) }
    const pinned = Object.freeze({ tabId: target.tabId, windowId: target.windowId, url: target.url })
    const owner = this.owner
    const capturedSession = session
    const { lifetime, document, observation } = tab
    const binding = (): ToolTargetIdentity | undefined => {
      if (this.owner !== owner || this.sessions.get(sessionId) !== capturedSession || this.tabs.get(pinned.tabId)?.lifetime !== lifetime) return
      const selected = resolve()
      return selected?.tabId === pinned.tabId && selected.windowId === pinned.windowId ? selected : undefined
    }
    return Object.freeze({ target: pinned,
      observationScope: JSON.stringify([this.scopeId(owner), this.scopeId(capturedSession), this.scopeId(lifetime), this.scopeId(observation), pinned.windowId]),
      observationCurrent: () => this.tabs.get(pinned.tabId)?.observation === observation && binding() !== undefined,
      current: () => this.tabs.get(pinned.tabId)?.document === document && binding()?.url === pinned.url,
      sameBinding: () => binding() !== undefined })
  }

  invalidateSession(sessionId?: string): void {
    if (this.sessions.has(sessionId)) this.sessions.set(sessionId, {})
  }

  invalidateDocument(tabId: number): void {
    const tab = this.tabs.get(tabId)
    if (tab !== undefined) this.tabs.set(tabId, { ...tab, document: {} })
  }

  invalidateObservation(tabId: number): void {
    const tab = this.tabs.get(tabId)
    if (tab !== undefined) this.tabs.set(tabId, { ...tab, observation: {} })
  }

  forgetTab(tabId: number): void { this.tabs.delete(tabId) }

  revokeAll(): void { this.owner = {}; this.sessions.clear(); this.tabs.clear() }
}
