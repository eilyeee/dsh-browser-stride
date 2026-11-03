/**
 * Session targets remain on explicitly authorized group pages. Human tab/window
 * focus is metadata only: it never pauses tools or changes their selected page.
 * Native page authorization is checked separately at dispatch.
 * @module
 */

/** Minimal, panel-safe metadata for one Chrome tab. */
export interface AffinityTab {
  tabId: number
  windowId: number
  title: string
  url: string
}

export type TabAffinityStatus = 'unbound' | 'following' | 'background' | 'lost'
/** Serializable state sent from the service worker to every side panel. */
export interface TabAffinityState {
  revision: number
  status: TabAffinityStatus
  controlled: AffinityTab | null
  active: AffinityTab | null
  /** Explicit user revocation, distinct from a closed tab. */
  detached?: true
}

export type TabTargetResolution =
  | { kind: 'initial' }
  | { kind: 'target'; tab: AffinityTab }
  | { kind: 'lost' }

function sameTab(left: AffinityTab | null, right: AffinityTab | null): boolean {
  return left?.tabId === right?.tabId
    && left?.windowId === right?.windowId
    && left?.title === right?.title
    && left?.url === right?.url
}

/** Owns the controlled-tab lifecycle for one extension/bridge connection. */
export class TabAffinityController {
  private controlled: AffinityTab | null = null
  private active: AffinityTab | null = null
  private hasBound = false
  private lost = false
  private revision = 0
  private sessionTabs = new Map<string, AffinityTab>()
  private focusedSessionId: string | null = null
  private detached = false
  private detachedSessions = new Set<string>()

  snapshot(): TabAffinityState {
    return {
      revision: this.revision,
      status: this.status(),
      controlled: this.controlled === null ? null : { ...this.controlled },
      active: this.active === null ? null : { ...this.active },
      ...(this.detached ? { detached: true as const } : {}),
    }
  }

  /** Associate a session with its controlled tab. */
  bindSession(sessionId: string, tab: AffinityTab): void {
    if (this.detachedSessions.has(sessionId)) return
    this.sessionTabs.set(sessionId, { ...tab })
  }

  sessionMap(): Record<string, AffinityTab> {
    const result: Record<string, AffinityTab> = {}
    for (const [sid, tab] of this.sessionTabs.entries()) {
      result[sid] = { ...tab }
    }
    return result
  }

  restoreSessionTabs(sessions: Record<string, AffinityTab>): void {
    for (const [sid, tab] of Object.entries(sessions)) {
      this.sessionTabs.set(sid, { ...tab })
    }
  }

  detachedSessionIds(): string[] { return [...this.detachedSessions] }

  restoreDetachedSessions(sessions: string[]): void {
    for (const sid of sessions) { this.detachedSessions.add(sid); this.sessionTabs.delete(sid) }
  }

  restoreDetached(): void {
    this.controlled = null; this.hasBound = true; this.lost = true; this.detached = true
    this.revision += 1
  }

  isDetached(sessionId?: string): boolean {
    return sessionId === undefined ? this.detached : this.detachedSessions.has(sessionId)
      || (this.detached && this.focusedSessionId === sessionId)
  }

  /** Revoke only the displayed session, without closing its page or conversation. */
  unbindSession(sessionId: string | undefined, revision: number): boolean {
    if (revision !== this.revision || this.focusedSessionId !== (sessionId ?? null) || this.controlled === null) return false
    if (sessionId !== undefined) { this.sessionTabs.delete(sessionId); this.detachedSessions.add(sessionId) }
    this.restoreDetached()
    return true
  }

  restoreFocusedSession(sessionId: string | null): void {
    this.focusedSessionId = sessionId
  }

  getSessionTab(sessionId: string): AffinityTab | undefined {
    return this.sessionTabs.get(sessionId)
  }

  focusedSession(): string | null {
    return this.focusedSessionId
  }

  /** Focus or select a session to align the visible controlled tab in the panel. */
  focusSession(sessionId: string): boolean {
    const previousFocusedSessionId = this.focusedSessionId
    const previousControlled = this.controlled
    const previousLost = this.lost
    const previousDetached = this.detached
    this.focusedSessionId = sessionId
    const tab = this.sessionTabs.get(sessionId)
    this.detached = this.detachedSessions.has(sessionId) || (this.detached && tab === undefined)
    if (this.detached) this.detachedSessions.add(sessionId)
    if (tab === undefined) {
      this.controlled = null
      this.hasBound = true
      this.lost = true
    } else {
      this.controlled = { ...tab }
      this.hasBound = true
      this.lost = false
    }
    const changed = previousFocusedSessionId !== sessionId
      || !sameTab(previousControlled, this.controlled)
      || previousLost !== this.lost
      || previousDetached !== this.detached
    if (changed) this.revision += 1
    return changed
  }

  /** Observe the active tab after a user tab/window focus change. */
  observeActive(tab: AffinityTab): boolean {
    const previousActive = this.active
    const previousControlled = this.controlled
    this.active = { ...tab }
    if (this.controlled?.tabId === tab.tabId) {
      this.controlled = { ...tab }
    }
    return this.bumpIfChanged(previousActive, previousControlled)
  }

  /** Refresh title/URL metadata without interpreting it as a tab switch. */
  observeTab(tab: AffinityTab): boolean {
    const previousActive = this.active
    const previousControlled = this.controlled
    if (this.active?.tabId === tab.tabId) this.active = { ...tab }
    if (this.controlled?.tabId === tab.tabId) this.controlled = { ...tab }
    for (const [sid, sTab] of this.sessionTabs.entries()) {
      if (sTab.tabId === tab.tabId) this.sessionTabs.set(sid, { ...tab })
    }
    return this.bumpIfChanged(previousActive, previousControlled)
  }

  /** Bind the first prompt/direct call to a separately authorized group page. */
  bindInitial(tab: AffinityTab, sessionId?: string): boolean {
    const sid = sessionId?.trim()
    if (sid !== undefined && sid !== '') {
      if (this.detached || this.detachedSessions.has(sid)) return false
      if (this.sessionTabs.has(sid)) return false
      this.sessionTabs.set(sid, { ...tab })
      if (this.focusedSessionId === null) this.focusedSessionId = sid
      if (this.focusedSessionId === sid) {
        this.controlled = { ...tab }
        this.hasBound = true
        this.lost = false
      }
      this.revision += 1
      return true
    }
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.controlled = { ...tab }
    this.hasBound = true
    this.revision += 1
    return true
  }

  /** Bind an unmapped session only after an explicit new-session activation. */
  bindNewSession(sessionId: string, tab: AffinityTab): boolean {
    const sid = sessionId.trim()
    if (sid === '' || this.detached || this.detachedSessions.has(sid)) return false
    const previous = this.sessionTabs.get(sid)
    this.sessionTabs.set(sid, { ...tab })
    this.focusedSessionId = sid
    this.detached = false
    this.controlled = { ...tab }
    this.hasBound = true
    this.lost = false
    if (!sameTab(previous ?? null, tab)) this.revision += 1
    return true
  }

  /** Explicitly rebind to the active tab for the named session. */
  rebindActive(tab: AffinityTab, sessionId?: string): boolean {
    this.active = { ...tab }
    const sid = sessionId?.trim()
    this.detached = false
    if (sid !== undefined) this.detachedSessions.delete(sid)
    this.controlled = { ...tab }
    this.hasBound = true
    this.lost = false
    if (sid !== undefined && sid !== '') {
      this.sessionTabs.set(sid, { ...tab })
      this.focusedSessionId = sid
    }
    this.revision += 1
    return true
  }

  /** Explicitly control an existing tab without changing the browser's active tab. */
  rebindControlled(tab: AffinityTab, sessionId?: string): boolean {
    const sid = sessionId?.trim()
    this.detached = false
    if (sid !== undefined) this.detachedSessions.delete(sid)
    this.controlled = { ...tab }
    this.hasBound = true
    this.lost = false
    if (sid !== undefined && sid !== '') {
      this.sessionTabs.set(sid, { ...tab })
      this.focusedSessionId = sid
    }
    this.revision += 1
    return true
  }

  /** Rehydrate a still-live controlled tab after an MV3 worker restart. */
  restoreControlled(tab: AffinityTab): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.controlled = { ...tab }
    this.hasBound = true
    this.revision += 1
    return true
  }

  /** Rehydrate the fail-closed state when the prior controlled tab was lost. */
  restoreLost(): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.hasBound = true
    this.lost = true
    this.revision += 1
    return true
  }

  sessionIdsForTab(tabId: number): string[] {
    const result: string[] = []
    for (const [sid, tab] of this.sessionTabs.entries()) {
      if (tab.tabId === tabId) result.push(sid)
    }
    return result
  }

  /** Remove stale state when Chrome closes a tracked tab. */
  removeTab(tabId: number): boolean {
    let sessionRemoved = false
    for (const [sid, sTab] of this.sessionTabs.entries()) {
      if (sTab.tabId === tabId) {
        this.sessionTabs.delete(sid)
        if (this.focusedSessionId === sid) this.focusedSessionId = null
        sessionRemoved = true
      }
    }
    if (this.controlled?.tabId !== tabId && this.active?.tabId !== tabId) {
      if (sessionRemoved) this.revision += 1
      return sessionRemoved
    }
    const previousActive = this.active
    const previousControlled = this.controlled
    if (this.controlled?.tabId === tabId) {
      this.controlled = null
      this.hasBound = true
      this.lost = true
    }
    if (this.active?.tabId === tabId) this.active = null
    return this.bumpIfChanged(previousActive, previousControlled) || sessionRemoved
  }

  /** Transfer tracked identity when Chrome replaces a tab without a user switch. */
  replaceTab(removedTabId: number, addedTabId: number): boolean {
    if (removedTabId === addedTabId) return false
    let sessionReplaced = false
    for (const [sid, sTab] of this.sessionTabs.entries()) {
      if (sTab.tabId === removedTabId) {
        this.sessionTabs.set(sid, { ...sTab, tabId: addedTabId })
        sessionReplaced = true
      }
    }
    if (this.controlled?.tabId !== removedTabId
      && this.active?.tabId !== removedTabId) {
      if (sessionReplaced) this.revision += 1
      return sessionReplaced
    }
    const previousActive = this.active
    const previousControlled = this.controlled
    if (this.controlled?.tabId === removedTabId) {
      this.controlled = { ...this.controlled, tabId: addedTabId }
    }
    if (this.active?.tabId === removedTabId) {
      this.active = { ...this.active, tabId: addedTabId }
    }
    return this.bumpIfChanged(previousActive, previousControlled) || sessionReplaced
  }

  /** Resolve whether a tool may run and, if so, which tab owns it. */
  resolveTarget(sessionId?: string): TabTargetResolution {
    if (sessionId !== undefined) {
      const tab = this.sessionTabs.get(sessionId)
      return tab === undefined ? { kind: 'lost' } : { kind: 'target', tab: { ...tab } }
    }
    switch (this.status()) {
      case 'unbound': return { kind: 'initial' }
      case 'lost': return { kind: 'lost' }
      case 'following':
      case 'background':
        return { kind: 'target', tab: { ...this.controlled! } }
    }
  }

  tracks(tabId: number): boolean {
    if (this.controlled?.tabId === tabId || this.active?.tabId === tabId) return true
    for (const tab of this.sessionTabs.values()) {
      if (tab.tabId === tabId) return true
    }
    return false
  }

  /** Final dispatch guard for async calls that began before a tab switch. */
  allowsTarget(tabId: number, sessionId?: string): boolean {
    if (sessionId !== undefined) {
      return this.sessionTabs.get(sessionId)?.tabId === tabId
    }
    const resolution = this.resolveTarget()
    return resolution.kind === 'target' && resolution.tab.tabId === tabId
  }

  private status(): TabAffinityStatus {
    if (this.controlled === null) return this.lost ? 'lost' : 'unbound'
    if (this.active?.tabId === this.controlled.tabId) return 'following'
    return 'background'
  }

  private bumpIfChanged(
    previousActive: AffinityTab | null,
    previousControlled: AffinityTab | null,
  ): boolean {
    const changed = !sameTab(previousActive, this.active)
      || !sameTab(previousControlled, this.controlled)
    // Switching an unrelated human page cannot stale an in-flight native task
    // selection. Only selected-page metadata changes advance its revision.
    if (!sameTab(previousControlled, this.controlled)) this.revision += 1
    return changed
  }
}
