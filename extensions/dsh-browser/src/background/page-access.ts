import { readPageAccessEpoch, writePageAccessEpoch } from './credential-store.ts'
import { debuggerPages } from './debugger-pages.ts'

/** Native action or the opted-in newly-created-tab path grants access. Group membership never does. */
export const PAGE_ACCESS_KEY = 'dshPageAccess'
export const CONTROL_GROUP_TITLE = 'DSH 控制'
interface Grant { tabId: number; windowId: number; origin: string; nonce: string; groupId?: number; mode?: 'debugger'; pending?: true }
/** Cleanup belongs to one creation attempt and cannot revoke a newer user grant. */
export interface CreatedPageAccess {
  current: () => boolean
  release: () => Promise<void>
  canClose: () => boolean
}
type Page = Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'url'> & Partial<Pick<chrome.tabs.Tab, 'groupId'>>
const origin = (url?: string): string | undefined => {
  try { const parsed = new URL(url ?? ''); return /^https?:$/.test(parsed.protocol) ? parsed.origin : undefined } catch { return undefined }
}

export class PageAccess {
  private grants = new Map<number, Grant>()
  private writes = Promise.resolve()
  private groups = new Map<number, number>()
  private grouping = Promise.resolve()
  private epoch?: string
  private restoring = true
  private pendingObservations: Array<{ tab: chrome.tabs.Tab; groupChanged: boolean }> = []
  private pendingRevocations = new Set<number>()
  private restoreOverflow = false
  readonly ready: Promise<void>
  constructor(private changed: (tabId?: number) => void) {
    this.ready = this.restore().then(async () => {
      this.restoring = false
      if (this.restoreOverflow) {
        this.epoch = crypto.randomUUID()
        this.grants.clear()
        await this.persist()
      }
      for (const observation of this.pendingObservations) this.observe(observation.tab, observation.groupChanged)
      for (const tabId of this.pendingRevocations) await this.revoke(tabId)
      this.pendingObservations = []
      this.pendingRevocations.clear()
      await this.writes
    }).catch(() => {
      this.restoring = false
      this.pendingObservations = []
      this.pendingRevocations.clear()
      this.grants.clear()
      this.groups.clear()
    })
  }
  private async restore(): Promise<void> {
    const [cached, epoch] = await Promise.all([chrome.storage.session.get(PAGE_ACCESS_KEY), readPageAccessEpoch()])
    this.epoch = epoch
    const value = cached[PAGE_ACCESS_KEY] as { grants?: unknown; epoch?: unknown } | undefined
    // Debugger sessions are never recovered into authority. Detach only our recorded targets.
    if (Array.isArray(value?.grants)) for (const row of value.grants) {
      if (row?.mode === 'debugger' && Number.isSafeInteger(row.tabId) && row.tabId >= 0) await debuggerPages.detach(row.tabId)
    }
    if (!Array.isArray(value?.grants) || value.epoch !== epoch) return
    let pruned = false
    for (const row of value.grants as Partial<Grant>[]) {
      if (row === null || typeof row !== 'object' || typeof row.tabId !== 'number' || !Number.isSafeInteger(row.tabId) || row.tabId < 0
        || typeof row.windowId !== 'number' || typeof row.origin !== 'string' || origin(row.origin) !== row.origin
        || typeof row.nonce !== 'string' || row.nonce === '' || (row.mode !== undefined && row.mode !== 'debugger')
        || (row.groupId !== undefined && (typeof row.groupId !== 'number' || !Number.isSafeInteger(row.groupId) || row.groupId < 0))) { pruned = true; continue }
      const grant = row as Grant
      if (grant.mode === 'debugger') { pruned = true; continue }
      try {
        const native = await chrome.tabs.get(grant.tabId)
        if (native.id !== grant.tabId || native.windowId !== grant.windowId || origin(native.url) !== grant.origin
          || (grant.groupId !== undefined && native.groupId !== grant.groupId)) { pruned = true; continue }
        // Chrome's tabs permission exposes metadata even without activeTab.
        // Cached URL/group identity alone is no longer evidence of page access.
        const probe = await chrome.scripting.executeScript({ target: { tabId: grant.tabId }, func: () => location.origin })
        if (!probe.some(frame => frame.frameId === 0 && frame.result === grant.origin)) { pruned = true; continue }
        const live = await chrome.tabs.get(grant.tabId)
        if (live.id !== grant.tabId || live.windowId !== grant.windowId || origin(live.url) !== grant.origin
          || (grant.groupId !== undefined && live.groupId !== grant.groupId)) { pruned = true; continue }
      } catch { pruned = true; continue }
      this.grants.set(grant.tabId, { ...grant })
      if (typeof grant.groupId === 'number' && grant.groupId >= 0) this.groups.set(grant.windowId, grant.groupId)
    }
    if (pruned) {
      this.epoch = crypto.randomUUID()
      await this.persist()
    }
  }
  has(tabId: number | undefined): boolean { return !this.restoring && tabId !== undefined && this.grants.has(tabId) && this.grants.get(tabId)?.pending !== true }
  unclaimed(tabId: number): boolean { return !this.restoring && !this.grants.has(tabId) }
  ids(): number[] { return [...this.grants.keys()] }
  allows(tab: Page): boolean {
    const grant = tab.id === undefined ? undefined : this.grants.get(tab.id)
    return !this.restoring && grant !== undefined && grant.pending !== true && grant.windowId === tab.windowId
      && (grant.mode === 'debugger' ? origin(tab.url) !== undefined && debuggerPages.has(grant.tabId) : grant.origin === origin(tab.url))
      && (grant.groupId === undefined || grant.groupId === tab.groupId)
  }
  allowsFrame(tabId: number, url: string | undefined): boolean { return this.has(tabId) && this.grants.get(tabId)?.mode !== 'debugger' && this.grants.get(tabId)?.origin === origin(url) && origin(url) !== undefined }
  lease(tabId: number): () => boolean {
    const captured = this.has(tabId) ? this.grants.get(tabId) : undefined
    return () => captured !== undefined && this.grants.get(tabId) === captured
  }
  /** A request cannot inherit a later toolbar grant, including one for the same tab. */
  snapshot(): { allows: (tab: Page) => boolean; current: () => boolean } {
    const captured = new Map(this.restoring ? [] : [...this.grants].filter(([, grant]) => grant.pending !== true))
    return {
      allows: tab => tab.id !== undefined && captured.get(tab.id) === this.grants.get(tab.id) && this.allows(tab),
      current: () => [...captured].every(([tabId, grant]) => this.grants.get(tabId) === grant),
    }
  }
  private persist(): Promise<void> {
    const epoch = this.epoch
    const value = { ...(epoch === undefined ? {} : { epoch }), grants: [...this.grants.values()].map(grant => ({ ...grant })) }
    const next = this.writes.catch(() => {}).then(async () => {
      if (epoch !== undefined) await writePageAccessEpoch(epoch)
      await chrome.storage.session.set({ [PAGE_ACCESS_KEY]: value })
    })
    this.writes = next
    return next
  }
  /** Called exclusively by chrome.action.onClicked, never by a panel message. */
  async grantFromAction(tab: chrome.tabs.Tab): Promise<void> {
    await this.ready
    if (tab.id !== undefined && this.grants.get(tab.id)?.mode === 'debugger') return
    const site = origin(tab.url)
    if (tab.id === undefined || site === undefined) throw new Error('page-access-required')
    const grant: Grant = { tabId: tab.id, windowId: tab.windowId, origin: site, nonce: crypto.randomUUID() }
    this.grants.set(tab.id, grant)
    try {
      await this.persist()
      if (this.grants.get(tab.id) !== grant || !this.allows(await chrome.tabs.get(tab.id))) throw new Error('page-access-required')
      await this.refresh(tab)
      if (this.grants.get(tab.id) !== grant) throw new Error('page-access-required')
      const live = await chrome.tabs.get(tab.id)
      if (!this.allows(live)) throw new Error('page-access-required')
      if (!live.pinned) await this.joinGroup(grant)
      this.changed()
    } catch (error) {
      if (this.grants.get(tab.id) === grant) void this.revoke(tab.id).catch(() => {})
      throw error
    }
  }
  /** Only called with the native result of this request's tabs.create, after explicit settings opt-in. */
  async grantCreated(tabId: number, current: () => boolean, signal: AbortSignal, capture?: (access: CreatedPageAccess) => void): Promise<void> {
    await this.ready
    if (!current() || signal.aborted || this.grants.has(tabId)) throw new Error('Automatic page control was cancelled.')
    const tab = await chrome.tabs.get(tabId)
    if (!current() || signal.aborted) throw new Error('Automatic page control was cancelled.')
    const grant: Grant = { tabId, windowId: tab.windowId, origin: origin(tab.url) ?? 'https://pending.invalid', nonce: crypto.randomUUID(), mode: 'debugger', pending: true }
    this.grants.set(tabId, grant)
    const allowed = () => this.grants.get(tabId) === grant && current()
    let releasedByOwner = false
    let releasedEpoch: string | undefined
    const ownership: CreatedPageAccess = {
      current: () => allowed() && grant.pending !== true,
      release: () => {
        if (this.grants.get(tabId) !== grant) return Promise.resolve()
        releasedByOwner = true
        const persisted = this.revoke(tabId)
        releasedEpoch = this.epoch
        return persisted
      },
      // An intervening revocation is conservative evidence of user takeover,
      // even if a newer grant has already been stopped again.
      canClose: () => this.grants.get(tabId) === grant || (releasedByOwner && releasedEpoch === this.epoch && !this.grants.has(tabId)),
    }
    try {
      capture?.(ownership)
      const deadline = Date.now() + 8000
      await this.persist()
      if (!allowed() || signal.aborted) throw new Error('Automatic page control was cancelled.')
      await debuggerPages.attachCreated(tabId, allowed, signal, Math.max(0, deadline - Date.now()))
      if (!await debuggerPages.ready(tabId, undefined, signal, Math.max(0, deadline - Date.now()))) throw new Error('The new page did not become ready for automatic control.')
      const live = await chrome.tabs.get(tabId)
      delete grant.pending
      if (!allowed() || signal.aborted || !this.allows(live)) throw new Error('The new page changed before it could be controlled.')
      grant.origin = origin(live.url)!
      if (!live.pinned) await this.joinGroup(grant)
      if (!allowed() || signal.aborted) throw new Error('Automatic page control was cancelled.')
      this.changed()
    } catch (error) {
      await ownership.release().catch(() => {})
      throw error
    }
  }
  async revokeAutomatic(): Promise<void> {
    await this.ready
    await Promise.all([...this.grants.values()].filter(grant => grant.mode === 'debugger').map(grant => this.revoke(grant.tabId)))
  }
  /** Chrome keeps same-origin activeTab grants; Firefox may require another action click. */
  async refresh(tab: Page): Promise<void> {
    if (!this.allows(tab) || tab.id === undefined) return
    if (this.grants.get(tab.id)?.mode === 'debugger') return
    const lease = this.lease(tab.id)
    try {
      const receiver = await chrome.tabs.sendMessage(tab.id, { type: 'DSH_PING' }, { frameId: 0 }).catch(() => undefined)
      if (receiver?.ok === true || !lease()) return
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    }
    catch { if (lease()) void this.revoke(tab.id).catch(() => {}) }
  }
  observe(tab: chrome.tabs.Tab, groupChanged = false): void {
    if (tab.id === undefined) return
    if (this.restoring) {
      if (this.pendingObservations.length < 256) this.pendingObservations.push({ tab: { ...tab }, groupChanged })
      else this.restoreOverflow = true
      return
    }
    const grant = this.grants.get(tab.id)
    // Loading/title events may arrive before debugger attachment. Keep the
    // staged record private; only window/group escape can revoke it here.
    if (grant?.pending === true) {
      if (tab.windowId !== grant.windowId || (grant.groupId !== undefined && tab.groupId !== grant.groupId)) void this.revoke(tab.id).catch(() => {})
      return
    }
    if (grant !== undefined && (!this.allows(tab) || (groupChanged && grant.groupId !== undefined && tab.groupId !== grant.groupId))) void this.revoke(tab.id).catch(() => {})
    // Dragging an unapproved page into the group does not grant access.
    else if (grant === undefined && tab.groupId !== undefined && this.groups.get(tab.windowId) === tab.groupId) {
      void chrome.tabs.ungroup(tab.id).catch(() => {})
    }
  }
  revoke(tabId: number): Promise<void> {
    if (this.restoring) {
      this.pendingRevocations.add(tabId)
      return this.ready.then(() => this.revoke(tabId))
    }
    const previous = this.grants.get(tabId)
    if (previous === undefined) return Promise.resolve()
    this.grants.delete(tabId)
    if (previous.mode === 'debugger') void debuggerPages.detach(tabId)
    this.epoch = crypto.randomUUID()
    // Queue durability before notifying other components. An observer failure
    // must not leave a revoked grant in the restart cache. No await occurs here.
    const persisted = this.persist()
    try { this.changed(tabId) } catch { /* authority is already withdrawn */ }
    void chrome.tabs.sendMessage(tabId, { type: 'DSH_DEACTIVATE' }).catch(() => {})
    if (previous.groupId !== undefined) void chrome.tabs.get(tabId).then(tab => {
      if (!this.has(tabId) && tab.groupId === previous.groupId) return chrome.tabs.ungroup(tabId)
    }).catch(() => {})
    return persisted
  }
  clear(): Promise<void> {
    if (this.restoring) return this.ready.then(() => this.clear())
    return Promise.all(this.ids().map(id => this.revoke(id))).then(() => {})
  }
  private async joinGroup(grant: Grant): Promise<void> {
    if (typeof chrome.tabs.group !== 'function' || chrome.tabGroups === undefined) return
    const work = this.grouping.catch(() => {}).then(async () => {
      if (this.grants.get(grant.tabId) !== grant) return
      let groupId = this.groups.get(grant.windowId)
      if (groupId !== undefined) {
        try { const group = await chrome.tabGroups.get(groupId); if (group.windowId !== grant.windowId) groupId = undefined }
        catch { groupId = undefined }
      }
      if (this.grants.get(grant.tabId) !== grant) return
      try { groupId = await chrome.tabs.group({ tabIds: grant.tabId, ...(groupId === undefined ? { createProperties: { windowId: grant.windowId } } : { groupId }) }) }
      catch { return } // Pinned tabs and browsers without grouping remain permission-scoped.
      if (this.grants.get(grant.tabId) !== grant) { await chrome.tabs.ungroup(grant.tabId).catch(() => {}); return }
      grant.groupId = groupId
      this.groups.set(grant.windowId, groupId)
      await chrome.tabGroups.update(groupId, { title: CONTROL_GROUP_TITLE, color: 'blue', collapsed: false })
      await this.persist()
    })
    this.grouping = work
    await work
  }
  /** Browser-session grants expire on restart. The reserved group must not imply otherwise. */
  async cleanExpiredGroups(): Promise<void> {
    await this.ready
    if (chrome.tabGroups === undefined || typeof chrome.tabs.ungroup !== 'function') return
    for (const group of await chrome.tabGroups.query({ title: CONTROL_GROUP_TITLE })) {
      for (const tab of await chrome.tabs.query({ groupId: group.id })) {
        if (tab.id !== undefined && !this.has(tab.id)) await chrome.tabs.ungroup(tab.id).catch(() => {})
      }
    }
  }
}
