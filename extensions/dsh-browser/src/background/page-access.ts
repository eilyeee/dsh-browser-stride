/** Browser action grants access. Group membership, pages and model tools never do. */
export const PAGE_ACCESS_KEY = 'dshPageAccess'
export const CONTROL_GROUP_TITLE = 'DSH 控制'
interface Grant { tabId: number; windowId: number; origin: string; nonce: string; groupId?: number }
type Page = Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'url'>
const origin = (url?: string): string | undefined => {
  try { const parsed = new URL(url ?? ''); return /^https?:$/.test(parsed.protocol) ? parsed.origin : undefined } catch { return undefined }
}

export class PageAccess {
  private grants = new Map<number, Grant>()
  private writes = Promise.resolve()
  private groups = new Map<number, number>()
  private grouping = Promise.resolve()
  readonly ready: Promise<void>
  constructor(private changed: (tabId?: number) => void) {
    this.ready = this.restore().catch(() => { this.grants.clear() })
  }
  private async restore(): Promise<void> {
    const value = (await chrome.storage.session.get(PAGE_ACCESS_KEY))[PAGE_ACCESS_KEY] as { grants?: unknown } | undefined
    if (!Array.isArray(value?.grants)) return
    for (const row of value.grants as Partial<Grant>[]) {
      if (typeof row.tabId !== 'number' || !Number.isSafeInteger(row.tabId) || row.tabId < 0
        || typeof row.windowId !== 'number' || typeof row.origin !== 'string' || origin(row.origin) !== row.origin
        || typeof row.nonce !== 'string' || row.nonce === '') continue
      const grant = row as Grant
      this.grants.set(grant.tabId, { ...grant })
      if (typeof grant.groupId === 'number' && grant.groupId >= 0) this.groups.set(grant.windowId, grant.groupId)
    }
  }
  has(tabId: number | undefined): boolean { return tabId !== undefined && this.grants.has(tabId) }
  ids(): number[] { return [...this.grants.keys()] }
  allows(tab: Page): boolean {
    const grant = tab.id === undefined ? undefined : this.grants.get(tab.id)
    return grant !== undefined && grant.windowId === tab.windowId && grant.origin === origin(tab.url)
  }
  allowsFrame(tabId: number, url: string | undefined): boolean { return this.grants.get(tabId)?.origin === origin(url) && origin(url) !== undefined }
  lease(tabId: number): () => boolean {
    const captured = this.grants.get(tabId)
    return () => captured !== undefined && this.grants.get(tabId) === captured
  }
  private persist(): Promise<void> {
    const value = { grants: [...this.grants.values()].map(grant => ({ ...grant })) }
    const next = this.writes.catch(() => {}).then(() => chrome.storage.session.set({ [PAGE_ACCESS_KEY]: value }))
    this.writes = next
    return next
  }
  /** Called exclusively by chrome.action.onClicked, never by a panel message. */
  async grantFromAction(tab: chrome.tabs.Tab): Promise<void> {
    await this.ready
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
      await this.joinGroup(grant)
      this.changed()
    } catch (error) {
      if (this.grants.get(tab.id) === grant) void this.revoke(tab.id).catch(() => {})
      throw error
    }
  }
  /** Chrome keeps same-origin activeTab grants; Firefox may require another action click. */
  async refresh(tab: Page): Promise<void> {
    if (!this.allows(tab) || tab.id === undefined) return
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
    const grant = this.grants.get(tab.id)
    if (grant !== undefined && (!this.allows(tab) || (groupChanged && grant.groupId !== undefined && tab.groupId !== grant.groupId))) void this.revoke(tab.id).catch(() => {})
    // Dragging an unapproved page into the group does not grant access.
    else if (grant === undefined && tab.groupId !== undefined && this.groups.get(tab.windowId) === tab.groupId) {
      void chrome.tabs.ungroup(tab.id).catch(() => {})
    }
  }
  revoke(tabId: number): Promise<void> {
    const previous = this.grants.get(tabId)
    if (previous === undefined) return Promise.resolve()
    this.grants.delete(tabId)
    this.changed(tabId) // Revoke queued work synchronously, before any storage or browser await.
    const persisted = this.persist()
    void chrome.tabs.sendMessage(tabId, { type: 'DSH_DEACTIVATE' }).catch(() => {})
    if (previous.groupId !== undefined) void chrome.tabs.get(tabId).then(tab => {
      if (!this.has(tabId) && tab.groupId === previous.groupId) return chrome.tabs.ungroup(tabId)
    }).catch(() => {})
    return persisted
  }
  clear(): Promise<void> { return Promise.all(this.ids().map(id => this.revoke(id))).then(() => {}) }
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
