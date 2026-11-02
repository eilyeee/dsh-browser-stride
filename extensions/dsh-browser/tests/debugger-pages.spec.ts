// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DebuggerPages } from '../src/background/debugger-pages.ts'

function fixture() {
  let loader = 'document-a'
  let detached!: (target: chrome.debugger.Debuggee) => void
  const commands = vi.fn(async (_target: unknown, method: string, params?: { expression?: string }) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: loader, url: 'https://example.test/' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: loader === 'document-a' ? 10 : 20 }
    if (method === 'Runtime.evaluate') return { result: { value: params?.expression?.startsWith('globalThis.__strideDebuggerAction(') ? { ok: true } : undefined } }
    return {}
  })
  const attach = vi.fn(async () => {})
  const detach = vi.fn(async () => {})
  vi.stubGlobal('chrome', { debugger: { attach, detach, sendCommand: commands,
    onDetach: { addListener: (listener: typeof detached) => { detached = listener } } },
  runtime: { getURL: (file: string) => `chrome-extension://synthetic/${file}` } })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '/* packaged controller */' })))
  const pages = new DebuggerPages()
  return { pages, attach, detach, commands, navigate: () => { loader = 'document-b' }, disconnect: () => detached({ tabId: 42 }) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('new-tab debugger transport', () => {
  it('can attach only with current opt-in and never routes an unowned tab or child frame', async () => {
    const h = fixture()
    await expect(h.pages.attachCreated(42, () => false)).rejects.toThrow()
    expect(h.attach).not.toHaveBeenCalled()
    await h.pages.attachCreated(42, () => true)
    await expect(h.pages.send(7, { type: 'DSH_ACTION' })).rejects.toThrow('not attached')
    await expect(h.pages.send(42, { type: 'DSH_ACTION' }, { frameId: 1 })).rejects.toThrow('main document')
    await expect(h.pages.send(42, { type: 'DSH_PING' }, { frameId: 0 })).resolves.toEqual({ ok: true })
    expect(h.commands).toHaveBeenCalledWith({ tabId: 42 }, 'Page.createIsolatedWorld', {
      frameId: 'main', worldName: 'DSH Stride controller', grantUniveralAccess: false,
    })
    expect(h.commands.mock.calls.every(([target]) => (target as { tabId: number }).tabId === 42)).toBe(true)
  })

  it('pins document identity and rebuilds the isolated controller after navigation', async () => {
    const h = fixture(); await h.pages.attachCreated(42, () => true)
    const original = (await h.pages.frames(42))[0]!
    await h.pages.send(42, { type: 'DSH_PING' }, original)
    h.navigate()
    const before = h.commands.mock.calls.length
    await expect(h.pages.send(42, { type: 'DSH_ACTION' }, original)).rejects.toThrow('document changed')
    expect(h.commands.mock.calls.slice(before).some(([, method]) => method === 'Runtime.evaluate')).toBe(false)
    await h.pages.send(42, { type: 'DSH_PING' }, (await h.pages.frames(42))[0]!)
    expect(h.commands.mock.calls.filter(([, method]) => method === 'Page.createIsolatedWorld')).toHaveLength(2)
  })

  it('does not execute when opt-in is revoked during packaged source loading', async () => {
    const h = fixture(); let allowed = true
    let finish!: (value: string) => void
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: () => new Promise<string>(resolve => { finish = resolve }) })))
    await h.pages.attachCreated(42, () => allowed)
    const pending = h.pages.send(42, { type: 'DSH_ACTION', action: 'browser_click' }).catch(error => error)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    allowed = false; finish('/* packaged controller */')
    expect(await pending).toBeInstanceOf(Error)
    expect(h.commands.mock.calls.some(([, method]) => method === 'Runtime.evaluate')).toBe(false)
  })

  it('withdraws authority on native detach and never retries an uncertain action', async () => {
    const h = fixture(); await h.pages.attachCreated(42, () => true)
    await h.pages.send(42, { type: 'DSH_PING' })
    const original = h.commands.getMockImplementation()!
    h.commands.mockImplementation(async (target, method, params) => {
      if (method === 'Runtime.evaluate' && params?.expression?.includes('DSH_ACTION')) throw new Error('disconnected')
      return original(target, method, params)
    })
    await expect(h.pages.send(42, { type: 'DSH_ACTION' })).rejects.toThrow('disconnected')
    expect(h.commands.mock.calls.filter(([, method, params]) => method === 'Runtime.evaluate' && params?.expression?.includes('DSH_ACTION'))).toHaveLength(1)
    const callback = vi.fn(); h.pages.onDetached = callback; h.disconnect()
    expect(callback).toHaveBeenCalledWith(42)
    expect(h.pages.has(42)).toBe(false)
    await expect(h.pages.send(42, { type: 'DSH_PING' })).rejects.toThrow('not attached')
    expect(h.attach).toHaveBeenCalledTimes(1)
  })
})
