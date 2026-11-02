// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageAccess, PAGE_ACCESS_KEY, CONTROL_GROUP_TITLE } from '../src/background/page-access.ts'

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
afterEach(() => vi.unstubAllGlobals())

describe('native page access and visible control group', () => {
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
    approved.groupId = -1; h.access.observe(approved, true)
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
