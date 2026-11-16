/** Fixed native-toolbar outcomes; no page text, URL or browser error is retained. */
export type PageAuthorizationFailure = 'unsupported-page' | 'pinned-tab' | 'page-access-denied' | 'group-unavailable' | 'storage-unavailable' | 'page-changed'
export type PageAuthorizationStatus = { phase: 'authorizing' | 'granted'; tabId: number } | { phase: 'failed'; tabId: number; code: PageAuthorizationFailure }
export class PageAuthorizationError extends Error {
  constructor(readonly code: PageAuthorizationFailure) { super('page-access-required') }
}
/** Last native attempt per window; a late outcome cannot replace a newer click. */
export class PageAuthorizationAttempts {
  private windows = new Map<number, { token: object; status: PageAuthorizationStatus }>()
  begin(windowId: number, tabId: number): (code?: PageAuthorizationFailure) => void {
    const token = {}, status: PageAuthorizationStatus = { phase: 'authorizing', tabId }
    this.windows.delete(windowId); this.windows.set(windowId, { token, status })
    if (this.windows.size > 32) this.windows.delete(this.windows.keys().next().value!)
    return code => {
      if (this.windows.get(windowId)?.token !== token) return
      this.windows.set(windowId, { token, status: code === undefined ? { phase: 'granted', tabId } : { phase: 'failed', tabId, code } })
    }
  }
  forget(windowId: number): void { this.windows.delete(windowId) }
  get(windowId: number): PageAuthorizationStatus | undefined { const status = this.windows.get(windowId)?.status; return status === undefined ? undefined : { ...status } }
}
