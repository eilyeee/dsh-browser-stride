// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageAccess, PAGE_ACCESS_KEY, CONTROL_GROUP_TITLE } from '../src/background/page-access.ts'
import { debuggerPages } from '../src/background/debugger-pages.ts'

function fixture() {
  const data: Record<string, unknown> = {}
  const tabs = new Map<number, chrome.tabs.Tab>()
  const page = (id: number, windowId = 1, url = 'https://example.com/page') => {
    const tab = { id, windowId, url, groupId: -1 } as chrome.tabs.Tab
    tabs.set(id, tab); return tab
  }
  let nextGroup = 50
  const groups = new Map<number, { id: number; windowId: number; title?: string }>()
  const set = vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)) })
  const inject = vi.fn(async () => [])
  const sendMessage = vi.fn(async (): Promise<unknown> => ({}))
  const ungroup = vi.fn(async (id: number | number[]) => { for (const key of [id].flat()) { const tab = tabs.get(key); if (tab) tab.groupId = -1 } })
  vi.stubGlobal('chrome', {
    storage: { session: { get: vi.fn(async (key: string) => ({ [key]: data[key] })), set } },
    scripting: { executeScript: inject },
    tabs: { get: vi.fn(async (id: number) => { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id)! }),
      sendMessage, ungroup,
      group: vi.fn(async ({ tabIds, groupId }: { tabIds: number; groupId?: number }) => {
        const id = groupId ?? nextGroup++
        const tab = tabs.get(tabIds)!
        groups.set(id, { id, windowId: tab.windowId }); tab.groupId = id
        return id
      }),
      query: vi.fn(async ({ groupId }: { groupId: number }) => [...tabs.values()].filter(tab => tab.groupId === groupId)),
    },
    tabGroups: { get: vi.fn(async (id: number) => groups.get(id)),
      update: vi.fn(async (id: number, changes: object) => { Object.assign(groups.get(id)!, changes) }),
      query: vi.fn(async () => [...groups.values()]),
    },
  })
  const changed = vi.fn()
  const access = new PageAccess(changed)
  return { access, page, data, changed, inject, sendMessage, set, tabs, groups, ungroup }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native page access and visible control group', () => {
  it('keeps pending automatic grants private through load events and excludes them from earlier requests', async () => {
    const h = fixture(), created = h.page(42)
    let finish!: () => void
    vi.spyOn(debuggerPages, 'attachCreated').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    vi.spyOn(debuggerPages, 'ready').mockResolvedValue(true)
    vi.spyOn(debuggerPages, 'has').mockReturnValue(true)
    const pending = h.access.grantCreated(42, () => true, new AbortController().signal)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const earlierRequest = h.access.snapshot()
    const earlierLease = h.access.lease(42)
    h.access.observe(created)
    expect(h.access.allows(created)).toBe(false)
    expect(h.access.has(42)).toBe(false)
    finish(); await pending
    expect(h.access.allows(created)).toBe(true)
    expect(earlierRequest.allows(created)).toBe(false)
    expect(earlierLease()).toBe(false)
  })
  it('grants only the newly created tab under opt-in and detaches it on stop or settings revocation', async () => {
    const h = fixture(), created = h.page(42), sibling = h.page(7)
    const attached = new Set<number>()
    vi.spyOn(debuggerPages, 'attachCreated').mockImplementation(async id => { attached.add(id) })
    vi.spyOn(debuggerPages, 'ready').mockResolvedValue(true)
    vi.spyOn(debuggerPages, 'has').mockImplementation(id => attached.has(id))
    const detach = vi.spyOn(debuggerPages, 'detach').mockImplementation(async id => { attached.delete(id) })
    await expect(h.access.grantCreated(42, () => false, new AbortController().signal)).rejects.toThrow()
    expect(debuggerPages.attachCreated).not.toHaveBeenCalled()
    await h.access.grantCreated(42, () => true, new AbortController().signal)
    expect(h.access.allows(created)).toBe(true)
    expect(h.access.allows(sibling)).toBe(false)
    expect(created.groupId).toBe(50)
    created.url = 'https://other.example/'; h.access.observe(created)
    expect(h.access.allows(created)).toBe(true) // This opted-in tab can navigate across HTTP(S) sites.
    await h.access.revokeAutomatic()
    expect(detach).toHaveBeenCalledWith(42)
    expect(h.access.allows(created)).toBe(false)
  })

  it('never recovers a debugger-created grant after a worker restart', async () => {
    const h = fixture(), created = h.page(42)
    vi.spyOn(debuggerPages, 'attachCreated').mockResolvedValue()
    vi.spyOn(debuggerPages, 'ready').mockResolvedValue(true)
    vi.spyOn(debuggerPages, 'has').mockReturnValue(true)
    const detach = vi.spyOn(debuggerPages, 'detach').mockResolvedValue()
    await h.access.grantCreated(42, () => true, new AbortController().signal)
    const restarted = new PageAccess(vi.fn()); await restarted.ready
    expect(detach).toHaveBeenCalledWith(42)
    expect(restarted.allows(created)).toBe(false)
    expect((h.data[PAGE_ACCESS_KEY] as { grants: unknown[] }).grants).toEqual([])
  })

  it('cancels a created-tab grant when opt-in is withdrawn while attaching', async () => {
    const h = fixture(); h.page(42)
    let allowed = true
    vi.spyOn(debuggerPages, 'attachCreated').mockImplementation(async () => { allowed = false })
    vi.spyOn(debuggerPages, 'ready').mockResolvedValue(true)
    vi.spyOn(debuggerPages, 'has').mockReturnValue(true)
    const detach = vi.spyOn(debuggerPages, 'detach').mockResolvedValue()
    await expect(h.access.grantCreated(42, () => allowed, new AbortController().signal)).rejects.toThrow()
    expect(h.access.has(42)).toBe(false)
    expect(detach).toHaveBeenCalledWith(42)
    expect(chrome.tabs.group).not.toHaveBeenCalled()
  })
  it('starts denied, groups only native-action grants and excludes other tabs on the same site', async () => {
    const h = fixture(), first = h.page(1), other = h.page(2)
    await h.access.ready
    expect(h.access.allows(first)).toBe(false)
    await h.access.grantFromAction(first)
    expect(h.access.allows(first)).toBe(true)
    expect(h.access.allows(other)).toBe(false)
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(50, { title: CONTROL_GROUP_TITLE, color: 'blue', collapsed: false })
    await h.access.grantFromAction(other)
    expect(first.groupId).toBe(other.groupId)
    const separateWindow = h.page(3, 2)
    await h.access.grantFromAction(separateWindow)
    expect(separateWindow.groupId).not.toBe(first.groupId)
  })

  it('keeps the live document receiver during a late load-complete event', async () => {
    const h = fixture(), tab = h.page(1)
    await h.access.grantFromAction(tab)
    h.sendMessage.mockResolvedValue({ ok: true })
    await h.access.refresh(tab)
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.access.allows(tab)).toBe(true)
  })

  it('does not turn group membership into authorization and revokes when an authorized page leaves', async () => {
    const h = fixture(), approved = h.page(1), stranger = h.page(2)
    await h.access.grantFromAction(approved)
    stranger.groupId = approved.groupId
    h.access.observe(stranger, true)
    expect(h.access.has(2)).toBe(false)
    expect(h.ungroup).toHaveBeenCalledWith(2)
    const lease = h.access.lease(1)
    approved.groupId = -1
    expect(h.access.allows(approved)).toBe(false) // The native check also precedes a delayed group event.
    h.access.observe(approved, true)
    expect(lease()).toBe(false)
    expect(h.access.has(1)).toBe(false)
    expect(h.changed).toHaveBeenCalledWith(1)
  })

  it('keeps same-origin navigation, revokes on cross-origin navigation and never restores an old lease', async () => {
    const h = fixture(), tab = h.page(1)
    await h.access.grantFromAction(tab)
    const old = h.access.lease(1)
    tab.url = 'https://example.com/next'; h.access.observe(tab)
    expect(old()).toBe(true)
    expect(h.access.allowsFrame(1, 'https://another.example/frame')).toBe(false)
    tab.url = 'https://other.example/'; h.access.observe(tab)
    expect(old()).toBe(false)
    await h.access.grantFromAction(tab)
    expect(old()).toBe(false)
    expect(h.access.allows(tab)).toBe(true)
  })

  it('does not grant protected pages or recover native permission that the browser rejected', async () => {
    const h = fixture()
    await expect(h.access.grantFromAction(h.page(1, 1, 'chrome://settings/'))).rejects.toThrow('page-access-required')
    expect(h.inject).not.toHaveBeenCalled()
    h.inject.mockRejectedValue(new Error('Cannot access contents'))
    await expect(h.access.grantFromAction(h.page(2))).rejects.toThrow('page-access-required')
    expect(h.access.has(2)).toBe(false)
    expect(chrome.tabs.group).not.toHaveBeenCalled()
  })

  it('preserves grants only across workers in the same browser session and clears expired group labels after browser restart', async () => {
    const h = fixture(), tab = h.page(1)
    await h.access.grantFromAction(tab)
    const worker = new PageAccess(vi.fn()); await worker.ready
    expect(worker.allows(tab)).toBe(true)
    delete h.data[PAGE_ACCESS_KEY]
    const restarted = new PageAccess(vi.fn()); await restarted.cleanExpiredGroups()
    expect(restarted.allows(tab)).toBe(false)
    expect(tab.groupId).toBe(-1)
  })

  it('does not restore a grant after revocation storage failed and the worker restarted', async () => {
    const h = fixture(), tab = h.page(1)
    tab.pinned = true
    vi.mocked(chrome.tabs.group).mockRejectedValueOnce(new Error('Pinned tabs cannot be grouped'))
    await h.access.grantFromAction(tab)
    expect(chrome.tabs.group).not.toHaveBeenCalled()
    expect((h.data[PAGE_ACCESS_KEY] as { grants: Array<{ groupId?: number }> }).grants[0]?.groupId).toBeUndefined()
    h.set.mockRejectedValueOnce(new Error('session storage unavailable'))
    await expect(h.access.revoke(1)).rejects.toThrow('session storage unavailable')
    const restarted = new PageAccess(vi.fn()); await restarted.ready
    expect(restarted.allows(tab)).toBe(false)
  })

  it('rechecks a restored grant against native group membership and cannot revive it by dragging back', async () => {
    const h = fixture(), tab = h.page(1)
    await h.access.grantFromAction(tab)
    const groupId = tab.groupId
    tab.groupId = -1 // The tab was moved while this worker was not running.
    const restarted = new PageAccess(vi.fn()); await restarted.ready
    expect(restarted.allows(tab)).toBe(false)
    tab.groupId = groupId
    const again = new PageAccess(vi.fn()); await again.ready
    expect(again.allows(tab)).toBe(false)
  })

  it('does not give an old request a new toolbar grant for the same tab or another tab', async () => {
    const h = fixture(), first = h.page(1), second = h.page(2)
    await h.access.grantFromAction(first)
    const requestScope = h.access.snapshot()
    expect(requestScope.allows(first)).toBe(true)
    expect(requestScope.allows(second)).toBe(false)
    await h.access.revoke(1)
    expect(requestScope.current()).toBe(false)
    await h.access.grantFromAction(first)
    await h.access.grantFromAction(second)
    expect(requestScope.allows(first)).toBe(false)
    expect(requestScope.allows(second)).toBe(false)
    expect(h.access.snapshot().allows(first)).toBe(true)
  })

  it('does not lose a group exit delivered while native restoration was pending', async () => {
    const h = fixture(), tab = h.page(1)
    await h.access.grantFromAction(tab)
    const initial = { ...tab }
    let finish!: (value: chrome.tabs.Tab) => void
    let checking = false
    vi.mocked(chrome.tabs.get).mockImplementationOnce(() => { checking = true; return new Promise(resolve => { finish = resolve }) })
    const restarted = new PageAccess(vi.fn())
    await vi.waitFor(() => expect(checking).toBe(true))
    tab.groupId = -1; restarted.observe(tab, true)
    tab.groupId = initial.groupId; restarted.observe(tab, true)
    finish(initial)
    await restarted.ready
    expect(restarted.allows(tab)).toBe(false)
  })

  it('clears grants requested before restoration finished', async () => {
    const h = fixture(), tab = h.page(1)
    await h.access.grantFromAction(tab)
    const restarted = new PageAccess(vi.fn())
    await restarted.clear()
    expect(restarted.allows(tab)).toBe(false)
    const again = new PageAccess(vi.fn()); await again.ready
    expect(again.allows(tab)).toBe(false)
  })

  it('fails closed when the private revocation record is corrupt', async () => {
    const h = fixture(), tab = h.page(1)
    await h.access.grantFromAction(tab)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dsh-browser-private', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('credentials', 'readwrite')
        transaction.objectStore('credentials').put(false, 'page-access-epoch')
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
    } finally { db.close() }
    const restarted = new PageAccess(vi.fn()); await restarted.ready
    expect(restarted.allows(tab)).toBe(false)
  })

  it('commits revocation even if a UI or cancellation observer throws', async () => {
    const h = fixture(), tab = h.page(1)
    await h.access.grantFromAction(tab)
    h.changed.mockImplementation(() => { throw new Error('Synthetic observer failure') })
    await h.access.revoke(1)
    expect(h.access.allows(tab)).toBe(false)
    const restarted = new PageAccess(vi.fn()); await restarted.ready
    expect(restarted.allows(tab)).toBe(false)
  })

  it('revokes immediately while an injection is pending and refuses to regroup late work', async () => {
    const h = fixture(), tab = h.page(1)
    let finish!: () => void
    h.inject.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]) }))
    const pending = h.access.grantFromAction(tab).catch(error => error)
    await vi.waitFor(() => expect(h.inject).toHaveBeenCalled())
    await h.access.revoke(1); finish()
    expect(await pending).toBeInstanceOf(Error)
    expect(h.access.has(1)).toBe(false)
    expect(chrome.tabs.group).not.toHaveBeenCalled()
  })
})
