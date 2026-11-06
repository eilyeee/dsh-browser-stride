// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageUrlKey, reuseAuthorizedTab } from '../src/background/open-tab-reuse.ts'
import type { ToolAnswer, ToolCall } from '../src/background/tools.ts'

const URL = 'https://wiki.example/pages/viewpage.action?pageId=42&spaceKey=TEST'
const tab = (id: number, url = URL) => ({ id, url, windowId: 1 }) as chrome.tabs.Tab
const call = (args: Record<string, unknown> = {}): ToolCall => ({ id: 'reuse', name: 'browser_open_tab', args: { url: URL, ...args } })
function setup(tabs: chrome.tabs.Tab[], allowed = new Set(tabs.map(t => t.id))) {
  const query = vi.fn(async () => tabs)
  vi.stubGlobal('chrome', { tabs: { query } })
  let current = true
  const follow = vi.fn(async (_id: number, allows: (t: chrome.tabs.Tab) => boolean, _active: boolean): Promise<ToolAnswer> => (
    allows(tabs.find(t => t.id === _id)!) ? { ok: true as const, result: { text: 'followed' } }
      : { ok: false as const, error: { code: 'content-unavailable', message: 'revoked or changed' } }
  ))
  const context = { empty: allowed.size === 0, allows: (t: chrome.tabs.Tab) => allowed.has(t.id), capture: vi.fn(() => () => current), follow }
  return { context, query, follow, revoke: () => { current = false } }
}
afterEach(() => vi.unstubAllGlobals())

describe('authorized page reuse', () => {
  it('matches query order but preserves document IDs, protocols, query values and SPA fragments', () => {
    expect(pageUrlKey(URL)).toBe(pageUrlKey('https://wiki.example/pages/viewpage.action?spaceKey=TEST&pageId=42'))
    for (const different of [URL.replace('42', '43'), URL.replace('https:', 'http:'), URL + '&mode=edit', URL + '#/other']) {
      expect(pageUrlKey(URL)).not.toBe(pageUrlKey(different))
    }
    expect(pageUrlKey('javascript:alert(1)')).toBeUndefined()
  })
  it('reuses the granted document without granting or navigating another tab', async () => {
    const h = setup([tab(1)])
    expect(await reuseAuthorizedTab(call(), h.context)).toMatchObject({ ok: true })
    expect(h.follow).toHaveBeenCalledWith(1, expect.any(Function), true)
  })
  it('keeps background reuse in the background', async () => {
    const h = setup([tab(1)])
    await reuseAuthorizedTab(call({ active: false }), h.context)
    expect(h.follow).toHaveBeenCalledWith(1, expect.any(Function), false)
  })
  it('uses the current session target when several authorized copies exist', async () => {
    const h = setup([tab(1), tab(2)])
    await reuseAuthorizedTab(call(), { ...h.context, controlledTabId: 2 })
    expect(h.follow).toHaveBeenCalledWith(2, expect.any(Function), true)
  })
  it('does not guess between copies or fall through to a new tab', async () => {
    const h = setup([tab(1), tab(2)])
    expect(await reuseAuthorizedTab(call(), h.context)).toMatchObject({ ok: false })
    expect(h.follow).not.toHaveBeenCalled()
  })
  it('ignores unauthorized matching tabs and distinct documents on the same Wiki', async () => {
    const h = setup([tab(1), tab(2, URL.replace('42', '43'))], new Set([2]))
    expect(await reuseAuthorizedTab(call(), h.context)).toBeUndefined()
    expect(h.follow).not.toHaveBeenCalled()
  })
  it('ignores a tab whose pending navigation leads to another document', async () => {
    const h = setup([{ ...tab(1), pendingUrl: URL.replace('42', '43') }])
    expect(await reuseAuthorizedTab(call(), h.context)).toBeUndefined()
  })
  it('allows an explicitly separate copy without scanning existing tabs', async () => {
    const h = setup([tab(1)])
    expect(await reuseAuthorizedTab(call({ newTab: true }), h.context)).toBeUndefined()
    expect(h.query).not.toHaveBeenCalled()
  })
  it('does not read tab metadata when no grants were admitted', async () => {
    const h = setup([tab(1)], new Set())
    expect(await reuseAuthorizedTab(call(), h.context)).toBeUndefined()
    expect(h.query).not.toHaveBeenCalled()
  })
  it.each(['revoked', 'navigated'])('fails without creating a replacement when the target is %s during approval', async reason => {
    const tabs = [tab(1)], h = setup(tabs)
    h.follow.mockImplementationOnce(async (_id, allows) => {
      if (reason === 'revoked') h.revoke()
      else tabs[0] = tab(1, URL.replace('42', '43'))
      expect(allows(tabs[0])).toBe(false)
      return { ok: false, error: { code: 'content-unavailable', message: 'changed' } }
    })
    expect(await reuseAuthorizedTab(call(), h.context)).toMatchObject({ ok: false })
  })
  it('fails closed if native tab lookup fails', async () => {
    const h = setup([tab(1)])
    h.query.mockRejectedValueOnce(new Error('not available'))
    expect(await reuseAuthorizedTab(call(), h.context)).toMatchObject({ ok: false })
  })
  it('rejects a malformed force-new flag', async () => {
    const h = setup([tab(1)])
    expect(await reuseAuthorizedTab(call({ newTab: 'false' }), h.context)).toMatchObject({ ok: false })
    expect(h.query).not.toHaveBeenCalled()
  })
})
