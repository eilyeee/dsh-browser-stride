// @vitest-environment jsdom

import { authorizedExamplePages } from './page-access-fixture.ts'
import { PAGE_ACCESS_KEY } from '../src/background/page-access.ts'

import { BRIDGE_PROTOCOL_VERSION, BRIDGE_RUN_RETARGET_METHOD, BRIDGE_RUN_LIST_METHOD, BRIDGE_TASK_START_METHOD } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wireToolCall, confirmTestTool } from './wire-tool-call.ts'
import { PAGE_SESSION_CONTEXT_STORAGE_KEY } from '../src/background/session-continuity.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: unknown[] = []
  autoConfirm = true

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void {
    const frame = JSON.parse(value)
    this.sent.push(frame)
    if (this.autoConfirm) queueMicrotask(() => confirmTestTool(frame, reply => this.receive(reply)))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(wireToolCall(frame)) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: (...args: T) => void) => { listeners.delete(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = {
    name: 'dsh-panel',
    sender: { id: 'test-extension', url: 'chrome-extension://test/panel/index.html' },
    postMessage,
    onMessage,
    onDisconnect,
  } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

function mockChrome(options: {
  authorizedPages?: boolean
  localGet?: () => Promise<Record<string, unknown>>
  localSet?: (items: Record<string, unknown>) => Promise<void>
  localSetAccessLevel?: () => Promise<void>
  sessionGet?: (key: string) => Promise<Record<string, unknown>>
  tabGet?: (tabId: number) => Promise<chrome.tabs.Tab>
  tabQuery?: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
  tabRemove?: (tabId: number) => Promise<void>
  tabCreate?: (properties: chrome.tabs.CreateProperties) => Promise<chrome.tabs.Tab>
  tabSendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  executeScript?: () => Promise<unknown>
} = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const port = new URL(input.toString()).port
    return new Response(JSON.stringify({ wsUrl: `ws://127.0.0.1:${port}/ext/bridge` }), { status: 200 })
  }))
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const actionClick = chromeEvent<[chrome.tabs.Tab]>()
  const onUpdated = chromeEvent<[number, Parameters<Parameters<typeof chrome.tabs.onUpdated.addListener>[0]>[1], chrome.tabs.Tab]>()
  let pageState = options.authorizedPages === false ? undefined : authorizedExamplePages()[PAGE_ACCESS_KEY]
  const onCommitted = chromeEvent<[{ tabId: number; frameId: number }]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const alarms = {
    create: vi.fn(),
    clear: vi.fn(async () => true),
    onAlarm,
  }
  vi.stubGlobal('chrome', {
    action: { onClicked: actionClick },
    alarms,
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: {
      open: vi.fn(async () => {}),
      setPanelBehavior: vi.fn(async () => {}),
    },
    storage: {
      local: {
        get: vi.fn(options.localGet ?? (async () => ({}))),
        set: vi.fn(options.localSet ?? (async () => {})),
        setAccessLevel: vi.fn(options.localSetAccessLevel ?? (async () => {})),
      },
      session: {
        get: vi.fn(async (key: string) => key === PAGE_ACCESS_KEY ? { [key]: pageState } : await (options.sessionGet ?? (async () => ({})))(key)),
        set: vi.fn(async (value: Record<string, unknown>) => { if (PAGE_ACCESS_KEY in value) pageState = value[PAGE_ACCESS_KEY] }),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(options.tabGet ?? (async (tabId: number) => ({ id: tabId, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab))),
      query: vi.fn(options.tabQuery ?? (async () => [{ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' }] as chrome.tabs.Tab[])),
      remove: vi.fn(options.tabRemove ?? (async () => {})),
      create: vi.fn(options.tabCreate ?? (async () => ({ id: 2, windowId: 1, status: 'complete', url: 'https://example.com/' } as chrome.tabs.Tab))),
      sendMessage: vi.fn(options.tabSendMessage ?? (async () => {})),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated,
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'document-1',
        url: 'https://example.com/',
      }]),
      onCommitted,
    },
    scripting: {
      executeScript: vi.fn(options.executeScript ?? (async () => [])),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { alarms, onConnect, onCommitted, actionClick, onUpdated, tabs: chrome.tabs }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background bridge lifecycle', () => {
  it('requires native page authorization even with confirmation bypass enabled; panel messages cannot grant it', async () => {
    const h = mockChrome({ authorizedPages: false,
      localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge', unrestrictedBrowserAccess: true } }),
      tabSendMessage: async (_tabId, message) => (message as { type?: string }).type === 'DSH_ACTION'
        ? { ok: true, result: { text: 'Synthetic authorized snapshot' } } : undefined,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort(); h.onConnect.emit(panel.port)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!
    try {
      socket.open(); await Promise.resolve()
      socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })
      socket.receive({ t: 'tool.call', id: 'unapproved-snapshot', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 10000 })
      await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'unapproved-snapshot', ok: false })))
      expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
      expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(([, m]) => (m as { type?: string }).type === 'DSH_ACTION')).toHaveLength(0)
      panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'panel-cannot-grant' })
      await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity.rebind.result', id: 'panel-cannot-grant', ok: false, error: expect.objectContaining({ code: 'page-access-required' }) })))
      h.actionClick.emit(await chrome.tabs.get(1))
      await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalled())
      panel.onMessage.emit({ type: 'page-access.revoke', id: 'stop-before-task', tabId: 1 })
      await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith({ type: 'page-access.revoke.result', id: 'stop-before-task', ok: true }))
      h.actionClick.emit(await chrome.tabs.get(1))
      await vi.waitFor(() => expect(vi.mocked(chrome.scripting.executeScript).mock.calls.length).toBe(2))
      socket.receive({ t: 'tool.call', id: 'approved-snapshot', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 10000 })
      await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'approved-snapshot', ok: true })))
      panel.onMessage.emit({ type: 'page-access.revoke', id: 'stop-page', tabId: 1 })
      await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith({ type: 'page-access.revoke.result', id: 'stop-page', ok: true }))
      socket.receive({ t: 'tool.call', id: 'revoked-snapshot', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 10000 })
      await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'revoked-snapshot', ok: false })))
    } finally { panel.onDisconnect.emit(); socket.close() }
  })

  it('requires another Firefox authorization after a new loopback document starts loading', async () => {
    vi.stubEnv('EXT_TARGET', 'firefox')
    const native = { id: 1, windowId: 1, url: 'http://127.0.0.1:39001/page', title: 'Synthetic loopback page' } as chrome.tabs.Tab
    const h = mockChrome({ authorizedPages: false, localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge' } }),
      tabGet: async () => native, tabQuery: async () => [native],
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort(); h.onConnect.emit(panel.port)
    try {
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
      h.actionClick.emit(native)
      await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'page-access', activeGranted: true })))
      panel.postMessage.mockClear()
      h.onUpdated.emit(1, { status: 'loading' }, native)
      await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'page-access', activeGranted: false })))
    } finally { panel.onDisconnect.emit(); FakeWebSocket.instances[0]?.close(); vi.unstubAllEnvs() }
  })

  it('does not close a newly reauthorized tab for a request that arrived under its old grant', async () => {
    let waiting = false, hold = false, finish!: (tab: chrome.tabs.Tab) => void
    const native = { id: 1, windowId: 1, url: 'https://example.com/', title: 'Synthetic page' } as chrome.tabs.Tab
    const h = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge', unrestrictedBrowserAccess: true } }),
      tabGet: async id => {
        if (hold && id === 1) { hold = false; waiting = true; return new Promise(resolve => { finish = resolve }) }
        return { ...native, id }
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort(); h.onConnect.emit(panel.port)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!
    try {
      socket.open(); await Promise.resolve()
      socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })
      hold = true
      socket.receive({ t: 'tool.call', id: 'old-grant-close', name: 'browser_close_tab', args: { tabId: 1 }, expiresAt: Date.now() + 10000 })
      await vi.waitFor(() => expect(waiting).toBe(true))
      h.onUpdated.emit(1, { url: 'https://other.example/' }, { ...native, url: 'https://other.example/' })
      h.actionClick.emit(native)
      await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalled())
      finish(native)
      await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-grant-close', ok: false })))
      expect(chrome.tabs.remove).not.toHaveBeenCalled()
    } finally { if (finish) finish(native); panel.onDisconnect.emit(); socket.close() }
  })

  it.each([true, false])('unpairs DSH locally even when remote revocation succeeds=%s and only resumes after explicit pairing', async remoteRevoked => {
    const credential = 'c'.repeat(64)
    const { readBridgeCredential, readBridgeDisconnected } = await import('../src/background/credential-store.ts')
    const h = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge', token: credential } }) })
    const discoveryFetch = fetch
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort(); h.onConnect.emit(panel.port)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!
    socket.open(); await Promise.resolve()
    socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })
    await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'status', state: 'connected' })))
    const revoke = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toMatchObject({ action: 'unpair', credential })
      if (!remoteRevoked) throw new Error('offline')
      return Response.json({ revoked: true })
    })
    vi.stubGlobal('fetch', revoke)
    panel.onMessage.emit({ type: 'browser-pairing.unpair', id: 'disconnect' })
    await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith({ type: 'browser-pairing.unpair.result', id: 'disconnect', ok: true, result: { remoteRevoked } }))
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(await readBridgeCredential()).toBeUndefined()
    expect(await readBridgeDisconnected()).toBe(true)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(panel.postMessage.mock.calls.filter(([message]) => message.type === 'status').at(-1)![0])
      .toMatchObject({ connectionDisconnected: true, hasCredential: false })
    panel.onDisconnect.emit()
    const next = panelPort(); h.onConnect.emit(next.port)
    h.alarms.onAlarm.emit({ name: 'bridge-keepalive' } as chrome.alarms.Alarm)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.stubGlobal('fetch', discoveryFetch)
    next.onMessage.emit({ type: 'settings', id: 'fresh', settings: { token: 'd'.repeat(64) } })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(await readBridgeDisconnected()).toBe(false)
    next.onDisconnect.emit(); FakeWebSocket.instances[1]!.close()
  })

  it('does not migrate an old public credential or connect after a worker restart while unpaired', async () => {
    const { writeBridgeCredential } = await import('../src/background/credential-store.ts')
    await writeBridgeCredential('', 'disable')
    const h = mockChrome({ localGet: async () => ({ dshSettings: { token: 'old-credential', bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge' } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort(); h.onConnect.emit(panel.port)
    await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'status', connectionDisconnected: true, hasCredential: false })))
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
    panel.onDisconnect.emit()
  })

  it.each([false, true])('does not let an already-started tab creation restore revoked authority after a fresh binding=%s', async rebind => {
    let finish!: () => void
    const hold = new Promise<void>(resolve => { finish = resolve })
    const h = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge', unrestrictedBrowserAccess: true } }),
      tabCreate: async () => { await hold; return { id: 2, windowId: 1, status: 'complete', url: 'https://example.com/' } as chrome.tabs.Tab } })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort(); h.onConnect.emit(panel.port)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!
    socket.open(); await Promise.resolve()
    socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })
    try {
      panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial' })
      await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'initial', ok: true }))
      socket.receive({ t: 'tool.call', id: 'late-open', name: 'browser_open_tab', args: { url: 'https://example.com/' }, expiresAt: Date.now() + 10000 })
      await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalled())
      const state = panel.postMessage.mock.calls.map(([m]) => m).filter(m => m.type === 'tab-affinity').at(-1).state
      panel.onMessage.emit({ type: 'tab-affinity.unbind', id: 'release', sessionId: null, revision: state.revision })
      await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.unbind.result', id: 'release', ok: true }))
      if (rebind) {
        panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'fresh' })
        await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'fresh', ok: true }))
      }
      finish()
      await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'late-open', ok: false })))
      panel.onMessage.emit({ type: 'request-status' })
      expect(panel.postMessage.mock.calls.filter(([m]) => m.type === 'tab-affinity').at(-1)![0].state).toMatchObject(rebind
        ? { status: 'following', controlled: { tabId: 1 } } : { detached: true, controlled: null })
    } finally { finish(); panel.onDisconnect.emit(); socket.close() }
  })

  it('requires a running task to pause before unbinding, then denies all browser tools after unbinding', async () => {
    const h = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge', unrestrictedBrowserAccess: true } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort(); h.onConnect.emit(panel.port)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!
    socket.open(); await Promise.resolve()
    socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })
    panel.onMessage.emit({ type: 'session.active', sessionId: 'selected', isNew: true })
    await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity', state: expect.objectContaining({ status: 'following' }) })))
    const state = panel.postMessage.mock.calls.map(([m]) => m).filter(m => m.type === 'tab-affinity').at(-1).state
    for (const [id, runState] of [['busy', 'running'], ['release', 'paused']]) {
      panel.onMessage.emit({ type: 'tab-affinity.unbind', id, sessionId: 'selected', revision: state.revision })
      await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'rpc', method: BRIDGE_RUN_LIST_METHOD })))
      const frame = socket.sent.filter(frame => (frame as { method?: string }).method === BRIDGE_RUN_LIST_METHOD).at(-1) as { id: string }
      socket.receive({ t: 'rpc.result', id: frame.id, ok: true, result: { type: 'server-response', rpcId: frame.id, result: { ok: true, value: { items: [{ state: runState }] } } } })
      await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity.unbind.result', id, ok: runState === 'paused' })))
      socket.sent.splice(0)
    }
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ dshDetachedSessions: { sessionIds: ['selected'], detached: true } })
    vi.mocked(chrome.tabs.sendMessage).mockClear()
    for (const name of ['browser_snapshot', 'browser_open_tab', 'browser_follow_tab']) {
      socket.receive({ t: 'tool.call', id: name, name, args: {}, sessionId: 'selected', expiresAt: Date.now() + 10000 })
      await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: name, ok: false })))
    }
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    panel.onDisconnect.emit(); socket.close()
  })

  it('keeps explicit page revocation after a worker or extension restart, even with stale saved bindings', async () => {
    const h = mockChrome({ localGet: async () => ({ dshDetachedSessions: { sessionIds: ['selected'], detached: true } }),
      sessionGet: async key => key === 'dshTabAffinity' ? { dshTabAffinity: { controlledTabId: 1, focusedSessionId: 'selected', sessionTabs: { selected: { tabId: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } } } } : {} })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort(); h.onConnect.emit(panel.port)
    await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity', state: expect.objectContaining({ detached: true, controlled: null }) })))
    panel.onMessage.emit({ type: 'session.active', sessionId: 'selected', isNew: true })
    await vi.waitFor(() => expect(chrome.storage.session.set).toHaveBeenCalledWith(expect.objectContaining({ dshTabAffinity: expect.objectContaining({ detached: true }) })))
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity', state: expect.objectContaining({ status: 'following' }) }))
    panel.onDisconnect.emit()
  })

  it.each([false, true])('creates native pins through the dedicated path, including initial start=%s, and fences a changed document', async start => {
    const method = start ? BRIDGE_TASK_START_METHOD : BRIDGE_RUN_RETARGET_METHOD
    const revision = start ? 0 : 3
    const fixture = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge', unrestrictedBrowserAccess: true } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort(); fixture.onConnect.emit(panel.port)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!
    socket.open(); await Promise.resolve()
    socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })
    panel.onMessage.emit({ type: 'session.active', sessionId: 'handoff-session', isNew: true })
    await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity', state: expect.objectContaining({ controlled: expect.objectContaining({ tabId: 1 }) }) })))
    panel.onMessage.emit({ type: 'rpc', id: 'generic', method, payload: {} })
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'rpc.result', id: 'generic', ok: false }))
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'rpc', method }))
    const state = panel.postMessage.mock.calls.map(([message]) => message as { type: string; state?: { revision: number } }).filter(message => message.type === 'tab-affinity').at(-1)!.state!
    panel.onMessage.emit({ type: 'browser-run.retarget', id: 'select', sessionId: 'handoff-session', runId: 'run_selected', expectedVersion: 2, controlRevision: start ? 0 : 1,
      affinityRevision: state.revision, ...(start ? { start: true, task: true } : {}), targetBinding: 'forged-panel-value', targetUrl: 'https://forged.test/' })
    await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'rpc', method })))
    const rpc = socket.sent.find(value => (value as { method?: string }).method === method) as { id: string; payload: { targetBinding: string } }
    expect(rpc.payload.targetBinding).toMatch(/^page_/)
    if (start) expect(rpc.payload).toMatchObject({ targetUrl: 'https://example.com/' })
    expect(rpc.payload.targetBinding).not.toBe('forged-panel-value')
    fixture.onCommitted.emit({ tabId: 1, frameId: 0 })
    socket.receive({ t: 'rpc.result', id: rpc.id, ok: true, result: { runId: 'run_selected', sessionId: 'handoff-session', controlRevision: revision, state: 'running', targetBinding: rpc.payload.targetBinding } })
    await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser-run.retarget.result', id: 'select', ok: true })))
    socket.receive({ t: 'tool.call', id: 'changed-handoff-document', name: 'browser_press', args: { key: 'Enter' }, sessionId: 'handoff-session',
      execution: { kind: 'run', runId: 'run_selected', controlRevision: revision }, targetBinding: rpc.payload.targetBinding, expiresAt: Date.now() + 10000 })
    await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'changed-handoff-document', ok: false, error: expect.objectContaining({ code: 'execution-denied' }) })))
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) => (message as { type?: string; action?: string }).type === 'DSH_ACTION'
      && (message as { action?: string }).action === 'browser_press')).toBe(false)
  })
  it('rejects a content script attempting to open the privileged panel channel', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const attacker = panelPort()
    const disconnect = vi.fn()
    Object.assign(attacker.port, { sender: { id: 'test-extension', url: 'https://example.com/' }, disconnect })
    chromeMock.onConnect.emit(attacker.port)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(attacker.onMessage.addListener).not.toHaveBeenCalled()
    expect(chromeMock.alarms.create).not.toHaveBeenCalled()
  })

  it('binds the saved installation id and persists the issued credential before connecting', async () => {
    let finish!: () => void
    let blockSettingsWrite = false
    const credential = 'a'.repeat(64)
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: { bridgeUrl: 'ws://127.0.0.1:3080/ext/bridge', token: 'one-time-code' },
        dshBridgeInstallationId: 'installation-1234567890',
      }),
      localSet: async items => {
        if (blockSettingsWrite && items.dshSettings !== undefined) {
          await new Promise<void>(resolve => { finish = resolve })
        }
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({
      t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: 'one-time-code', installationId: 'installation-1234567890',
    })) })
    blockSettingsWrite = true
    vi.mocked(chrome.storage.local.set).mockClear()
    socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, credential, caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalled() })
    const savedSettings = (vi.mocked(chrome.storage.local.set).mock.calls[0]![0] as Record<string, unknown>).dshSettings as Record<string, unknown>
    expect(savedSettings).not.toHaveProperty('token')
    const { readBridgeCredential } = await import('../src/background/credential-store.ts')
    expect(await readBridgeCredential()).toBe(credential)
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'status', state: 'connected' }))
    finish()
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'status', state: 'connected' })) })
    panel.onDisconnect.emit()
    socket.close()
  })

  it('restricts stored credentials before loading settings', async () => {
    let finish!: () => void
    mockChrome({ localSetAccessLevel: () => new Promise(resolve => { finish = resolve }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
    expect(chrome.storage.local.get).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })
  })

  it('does not probe, connect, or arm keepalive just because the extension loads', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(chromeMock.alarms.create).not.toHaveBeenCalled()
    expect(chromeMock.alarms.clear).toHaveBeenCalledWith('bridge-keepalive')
  })

  it('abandons an in-flight discovery when the last panel closes', async () => {
    const chromeMock = mockChrome()
    let finishDiscovery!: (response: Response) => void
    const fetchMock = vi.fn(async () => await new Promise<Response>((resolve) => {
      finishDiscovery = resolve
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    chromeMock.alarms.clear.mockClear()

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    expect(chromeMock.alarms.create).toHaveBeenCalledWith('bridge-keepalive', { periodInMinutes: 0.5 })

    panel.onDisconnect.emit()
    finishDiscovery(new Response(null, { status: 503 }))
    await vi.waitFor(() => { expect(chromeMock.alarms.clear).toHaveBeenCalledWith('bridge-keepalive') })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('does not let keepalive reclaim a bridge that replaced this client', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.close(4000, 'replaced')

    chromeMock.alarms.onAlarm.emit({ name: 'bridge-keepalive', scheduledTime: Date.now(), persistAcrossSessions: false })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates stale connection settings when their save outlives the panel', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    const chromeMock = mockChrome({ localSet: async () => await settingsWrite })
    const fetchMock = vi.fn(async (input: string | URL) => new Response(JSON.stringify({
      wsUrl: `ws://127.0.0.1:${new URL(input.toString()).port}/ext/bridge`,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const originalSocket = FakeWebSocket.instances[0]!
    originalSocket.open()
    await Promise.resolve()
    originalSocket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.waitFor(() => {
      expect(panel.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }))
    })

    panel.onMessage.emit({
      type: 'settings',
      settings: { bridgeUrl: 'ws://127.0.0.1:3081', token: 'new-token' },
    })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledOnce() })
    panel.onDisconnect.emit()
    expect(originalSocket.readyState).toBe(FakeWebSocket.OPEN)

    finishSettingsWrite()
    await vi.waitFor(() => { expect(originalSocket.readyState).toBe(FakeWebSocket.CLOSED) })

    const reopened = panelPort()
    chromeMock.onConnect.emit(reopened.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://127.0.0.1:3081/ext/bridge')
  })

  it('acknowledges a policy setting only after persistence without restarting the bridge', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge' } }),
      localSet: async () => { await settingsWrite },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })

    panel.onMessage.emit({
      type: 'settings',
      id: 'settings-1',
      settings: { unrestrictedBrowserAccess: true },
    })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledOnce() })
    panel.onMessage.emit({
      type: 'settings',
      id: 'settings-2',
      settings: { approvalNotifications: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).toHaveBeenCalledOnce()
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'settings.result',
      id: 'settings-1',
    }))
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)

    finishSettingsWrite()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'settings-1', ok: true })
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'settings-2', ok: true })
    })
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(2)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('reports a settings persistence failure to the requesting panel', async () => {
    let settingsWrites = 0
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge' } }),
      localSet: async () => {
        settingsWrites += 1
        if (settingsWrites === 1) throw new Error('Storage is unavailable')
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    panel.onMessage.emit({
      type: 'settings',
      id: 'settings-failed',
      settings: { unrestrictedBrowserAccess: true },
    })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({
        type: 'settings.result',
        id: 'settings-failed',
        ok: false,
        error: { message: 'Storage is unavailable' },
      })
    })

    panel.onMessage.emit({
      type: 'settings',
      id: 'unrelated-setting-after-failure',
      settings: { approvalNotifications: false },
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({
        type: 'settings.result',
        id: 'unrelated-setting-after-failure',
        ok: true,
      })
    })

    socket.receive({
      t: 'tool.call',
      id: 'close-after-failed-enable',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
  })

  it('disarms selection capture as soon as unrestricted access is disabled', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
          unrestrictedBrowserAccess: true,
          sharePageContent: 'off',
        },
      }),
      localSet: async () => { await settingsWrite },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_SELECTION_WATCH',
        enabled: true,
      }))
    })
    vi.mocked(chromeMock.tabs.sendMessage).mockClear()

    panel.onMessage.emit({
      type: 'settings',
      id: 'disable-selection',
      settings: { unrestrictedBrowserAccess: false },
    })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_SELECTION_WATCH',
        enabled: false,
      }))
    })
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'settings.result',
      id: 'disable-selection',
    }))

    finishSettingsWrite()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-selection', ok: true })
    })
  })

  it('cancels in-flight unrestricted calls before persisting revocation', async () => {
    let holdNativeLookup = false, lookupStarted = false
    let finishTabLookup!: (tab: chrome.tabs.Tab) => void
    const tabLookup = new Promise<chrome.tabs.Tab>((resolve) => { finishTabLookup = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      tabGet: async id => {
        if (holdNativeLookup) { lookupStarted = true; return await tabLookup }
        return { id, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    holdNativeLookup = true
    socket.receive({
      t: 'tool.call',
      id: 'close-in-flight',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(lookupStarted).toBe(true) })

    panel.onMessage.emit({
      type: 'settings',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
    panel.onMessage.emit({
      type: 'settings',
      settings: { approvalNotifications: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishTabLookup({ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab)
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual({
        t: 'tool.result', action: expect.objectContaining({ actionId: expect.any(String), requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        id: 'close-in-flight',
        ok: false,
        error: { code: 'action-failed', message: 'Tool call was cancelled' },
      })
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
      }))
    })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledTimes(2) })

    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
  })

  it('settles a committed unrestricted action before persisting revocation', async () => {
    const events: string[] = []
    let finishClose!: () => void
    const close = new Promise<void>((resolve) => { finishClose = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      localSet: async () => { events.push('saved') },
      tabRemove: async () => {
        await close
        events.push('closed')
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'close-committed',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({
      type: 'settings',
      settings: { unrestrictedBrowserAccess: false },
    })
    await Promise.resolve()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
    expect(socket.sent).not.toContainEqual(expect.objectContaining({
      t: 'tool.result', action: expect.objectContaining({ actionId: expect.any(String), requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      id: 'close-committed',
      ok: false,
    }))

    finishClose()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({
        t: 'tool.result', action: expect.objectContaining({ actionId: expect.any(String), requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        id: 'close-committed',
        ok: true,
      }))
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
      }))
    })
    expect(events).toEqual(['closed', 'saved'])
  })

  it('keeps a rapid re-enable restricted until revocation settles and persists toggles in order', async () => {
    let finishFirstClose!: () => void
    const firstClose = new Promise<void>((resolve) => { finishFirstClose = resolve })
    const persistedAccess: boolean[] = []
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      localSet: async (items) => {
        persistedAccess.push((items.dshSettings as { unrestrictedBrowserAccess: boolean }).unrestrictedBrowserAccess)
      },
      tabGet: async (tabId) => ({ id: tabId, windowId: 1, title: `Tab ${tabId}`, url: `https://example.com/${tabId}` } as chrome.tabs.Tab),
      tabRemove: async (tabId) => {
        if (tabId === 1) await firstClose
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'close-before-toggle',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({ type: 'settings', id: 'disable-fast', settings: { unrestrictedBrowserAccess: false } })
    panel.onMessage.emit({ type: 'settings', id: 'enable-fast', settings: { unrestrictedBrowserAccess: true } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    socket.receive({
      t: 'tool.call',
      id: 'close-during-revocation',
      name: 'browser_close_tab',
      args: { tabId: 2 },
      expiresAt: Date.now() + 10_000,
    })

    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    expect(chromeMock.tabs.remove).not.toHaveBeenCalledWith(2)
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishFirstClose()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-fast', ok: true })
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'enable-fast', ok: true })
    })
    expect(persistedAccess).toEqual([false, true])
    expect(FakeWebSocket.instances).toHaveLength(1)

    const approval = await vi.waitFor(() => {
      const message = panel.postMessage.mock.calls
        .map((args: unknown[]) => args[0] as { type?: string; request?: { id?: string } })
        .find((value) => value.type === 'approval.request')
      expect(message?.request?.id).toBeTypeOf('string')
      return message!
    })

    panel.onMessage.emit({
      type: 'approval.response',
      id: approval.request!.id,
      decision: 'allow-once',
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(2) })
  })

  it('waits for disconnected committed actions during revocation and drops their results', async () => {
    let finishClose!: () => void
    const close = new Promise<void>((resolve) => { finishClose = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      tabRemove: async () => { await close },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const originalSocket = FakeWebSocket.instances[0]!
    originalSocket.open()
    await Promise.resolve()
    originalSocket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    originalSocket.receive({
      t: 'tool.call',
      id: 'old-close',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({
      type: 'settings',
      settings: { bridgeUrl: 'ws://127.0.0.1:39002/ext/bridge' },
    })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    const replacementSocket = FakeWebSocket.instances[1]!
    replacementSocket.open()
    await Promise.resolve()
    replacementSocket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()

    panel.onMessage.emit({
      type: 'settings',
      id: 'disable-after-reconnect',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const savedBeforeClose = vi.mocked(chrome.storage.local.set).mock.calls.some(([items]) => (
      (items as { dshSettings: { unrestrictedBrowserAccess?: boolean } }).dshSettings.unrestrictedBrowserAccess === false
    ))
    finishClose()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-after-reconnect', ok: true })
    })
    expect(savedBeforeClose).toBe(false)

    expect(originalSocket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', action: expect.objectContaining({ actionId: expect.any(String), requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }), id: 'old-close' }))
    expect(replacementSocket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', action: expect.objectContaining({ actionId: expect.any(String), requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }), id: 'old-close' }))
  })

  it.each(['reconnect', 'same-tab rebind', 'same-URL navigation'])('does not persist an old navigation checkpoint after %s', async (change) => {
    let tab = { id: 1, windowId: 1, title: 'Authorized start page', url: 'https://example.com/blank' } as chrome.tabs.Tab
    let pauseCheckpoint = false
    let checkpointStarted = false
    let finishCheckpoint!: (tab: chrome.tabs.Tab) => void
    const checkpoint = new Promise<chrome.tabs.Tab>((resolve) => { finishCheckpoint = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: {
        bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
        unrestrictedBrowserAccess: true,
      } }),
      tabSendMessage: async (_id, message) => {
        if ((message as { action?: string }).action === 'browser_reload') pauseCheckpoint = true
        return { ok: true, result: { text: 'Synthetic reload acknowledged' } }
      },
      tabQuery: async () => [tab],
      tabGet: async () => {
        if (!pauseCheckpoint) return tab
        pauseCheckpoint = false
        checkpointStarted = true
        return checkpoint
      },
    })
    chrome.tabs.reload = vi.fn(async () => { pauseCheckpoint = true })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const original = FakeWebSocket.instances[0]!
    original.open()
    await Promise.resolve()
    original.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await Promise.resolve()
    original.receive({
      t: 'tool.call', id: 'follow-before-reload', name: 'browser_follow_tab',
      sessionId: 'checkpoint-session', args: { tabId: 1 }, expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(original.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', action: expect.objectContaining({ actionId: expect.any(String), requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }), id: 'follow-before-reload', ok: true }))
    })
    original.receive({
      t: 'tool.call', id: 'old-reload', name: 'browser_reload',
      sessionId: 'checkpoint-session', args: {}, expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(checkpointStarted).toBe(true) })
    if (change === 'reconnect') {
      panel.onMessage.emit({ type: 'settings', settings: { bridgeUrl: 'ws://127.0.0.1:39002/ext/bridge' } })
      await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
      const replacement = FakeWebSocket.instances[1]!
      replacement.open()
      await Promise.resolve()
      replacement.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
      await Promise.resolve()
    }
    if (change === 'same-URL navigation') {
      chromeMock.onCommitted.emit({ tabId: 1, frameId: 0 })
    } else {
      // A fresh explicit binding to the same tab id must survive the old read.
      tab = { ...tab, url: 'https://example.com/current' }
      panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'fresh-binding', sessionId: 'checkpoint-session' })
      await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'fresh-binding', ok: true }) })
    }
    const contextWrites = () => vi.mocked(chrome.storage.session.set).mock.calls.filter(([items]) => PAGE_SESSION_CONTEXT_STORAGE_KEY in items)
    const beforeOldRead = [...contextWrites()]
    finishCheckpoint({ ...tab, url: 'https://example.com/stale-checkpoint' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(contextWrites()).toEqual(beforeOldRead)
    if (change === 'reconnect') {
      for (const socket of FakeWebSocket.instances) {
        expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-reload' }))
      }
    }
  })

  it.each(['retained', 'replaced'])('finishes a deferred follow only for its %s connection owner', async (owner) => {
    let restore!: (value: Record<string, unknown>) => void
    const restored = new Promise<Record<string, unknown>>(resolve => { restore = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge', unrestrictedBrowserAccess: true } }),
      sessionGet: async key => key === PAGE_SESSION_CONTEXT_STORAGE_KEY ? restored : {},
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const original = FakeWebSocket.instances[0]!
    original.open()
    await Promise.resolve()
    original.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    const readsBeforeFollow = vi.mocked(chrome.tabs.get).mock.calls.filter(([id]) => id === 2).length
    original.receive({ t: 'tool.call', id: 'old-follow', name: 'browser_follow_tab', args: { tabId: 2 }, expiresAt: Date.now() + 10_000 })
    await vi.waitFor(() => { expect(vi.mocked(chrome.tabs.get).mock.calls.filter(([id]) => id === 2)).toHaveLength(readsBeforeFollow + 2) })
    if (owner === 'replaced') {
      panel.onMessage.emit({ type: 'settings', settings: { bridgeUrl: 'ws://127.0.0.1:39002/ext/bridge' } })
      await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
      const replacement = FakeWebSocket.instances[1]!
      replacement.open()
      await Promise.resolve()
      replacement.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    }
    restore({})
    await new Promise(resolve => { setTimeout(resolve, 0) })
    panel.onMessage.emit({ type: 'request-status' })
    const binding = expect.objectContaining({ type: 'tab-affinity', state: expect.objectContaining({ controlled: expect.objectContaining({ tabId: 2 }) }) })
    if (owner === 'retained') {
      expect(panel.postMessage).toHaveBeenCalledWith(binding)
      await vi.waitFor(() => { expect(original.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-follow', ok: true })) })
    } else {
      expect(panel.postMessage).not.toHaveBeenCalledWith(binding)
      for (const socket of FakeWebSocket.instances) {
        expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-follow' }))
      }
    }
  })

  it('cancels unrestricted recovery after an undelivered action rolls back its commit', async () => {
    let finishInjection!: () => void
    const injection = new Promise<void>((resolve) => { finishInjection = resolve })
    const actionMessages: unknown[] = []
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      tabSendMessage: async (_tabId, message) => {
        if ((message as { type?: unknown }).type !== 'DSH_ACTION') return undefined
        actionMessages.push(message)
        throw new Error('Could not establish connection. Receiving end does not exist.')
      },
      executeScript: async () => { await injection },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'recovering-action',
      name: 'browser_press',
      args: { key: 'Enter' },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chrome.scripting.executeScript).toHaveBeenCalledOnce() })

    panel.onMessage.emit({
      type: 'settings',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishInjection()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({
        t: 'tool.result', action: expect.objectContaining({ actionId: expect.any(String), requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        id: 'recovering-action',
        ok: false,
      }))
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
      }))
    })
    expect(actionMessages).toHaveLength(1)
  })

  it('keeps an already-started restricted call under approval across access toggles', async () => {
    let holdTarget = false
    let releaseTarget!: (tabs: chrome.tabs.Tab[]) => void
    const target = new Promise<chrome.tabs.Tab[]>((resolve) => { releaseTarget = resolve })
    const tab = { id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
          unrestrictedBrowserAccess: false,
          sharePageContent: 'auto',
        },
      }),
      tabQuery: async (queryInfo) => holdTarget && queryInfo.active === true ? await target : [tab],
      tabSendMessage: async (_tabId, message) => (message as { type?: unknown }).type === 'DSH_ACTION'
        ? { ok: true, result: { text: 'Pressed Enter.' } }
        : undefined,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    holdTarget = true
    socket.receive({
      t: 'tool.call',
      id: 'restricted-across-toggle',
      name: 'browser_press',
      args: { key: 'Enter' },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true })
    })

    panel.onMessage.emit({ type: 'settings', settings: { unrestrictedBrowserAccess: true } })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledOnce() })
    releaseTarget([tab])
    const approval = await vi.waitFor(() => {
      const message = panel.postMessage.mock.calls
        .map((args: unknown[]) => args[0] as { type?: string; request?: { id?: string } })
        .find((value) => value.type === 'approval.request')
      expect(message?.request?.id).toBeTypeOf('string')
      return message!
    })

    panel.onMessage.emit({ type: 'settings', settings: { unrestrictedBrowserAccess: false } })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledTimes(2) })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.sent).not.toContainEqual(expect.objectContaining({
      t: 'tool.result', action: expect.objectContaining({ actionId: expect.any(String), requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      id: 'restricted-across-toggle',
    }))

    panel.onMessage.emit({
      type: 'approval.response',
      id: approval.request!.id,
      decision: 'allow-once',
    })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({
        t: 'tool.result', action: expect.objectContaining({ actionId: expect.any(String), requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        id: 'restricted-across-toggle',
        ok: true,
      }))
    })
  })

  it('waits for and suppresses an unrestricted automatic snapshot during revocation', async () => {
    let finishSnapshot!: (answer: unknown) => void
    const snapshot = new Promise<unknown>((resolve) => { finishSnapshot = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
          unrestrictedBrowserAccess: true,
          sharePageContent: 'off',
        },
      }),
      tabSendMessage: async (_tabId, message) => (message as { type?: unknown }).type === 'DSH_ACTION'
        ? await snapshot
        : undefined,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-refresh', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_ACTION',
        action: 'browser_snapshot',
      }), expect.any(Object))
    })

    panel.onMessage.emit({
      type: 'settings',
      id: 'disable-refresh',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishSnapshot({ ok: true, result: { text: 'private page snapshot' } })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-refresh', ok: true })
    })
    expect(socket.sent).not.toContainEqual(expect.objectContaining({
      t: 'rpc',
      method: 'bridge.injectBrowserSnapshot',
    }))
  })
})
