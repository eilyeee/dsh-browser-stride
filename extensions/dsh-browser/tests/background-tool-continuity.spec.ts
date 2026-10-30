// @vitest-environment jsdom

import { BRIDGE_PROTOCOL_VERSION } from '@eilyeee/dsh-stride-browser-bridge/src/protocol.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wireToolCall } from './wire-tool-call.ts'
import { PAGE_SESSION_CONTEXT_STORAGE_KEY } from '../src/background/session-continuity.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: unknown[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value))
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
  const port = { name: 'dsh-panel', sender: { id: 'test-extension', url: 'chrome-extension://test/panel/index.html' }, postMessage: vi.fn(), onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port }
}

function browserTab(url: string): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    lastAccessed: 0,
    groupId: -1,
    windowId: 1,
    title: 'Page',
    url,
  }
}

function storedUrlKey(sessionData: Record<string, unknown>): string | undefined {
  return (sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY] as {
    tabs?: Record<string, { urlKey?: string }>
  } | undefined)?.tabs?.[1]?.urlKey
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('tool-driven session checkpoints', () => {
  it('updates only after a successful navigation candidate', async () => {
    let currentTab = browserTab('https://example.com/start')
    let action: (name: string, message?: unknown) => Promise<unknown> = async () => ({ ok: true, result: { text: 'snapshot' } })
    const onConnect = chromeEvent<[chrome.runtime.Port]>()
    const sessionData: Record<string, unknown> = {}
    const sendMessage = vi.fn(async (_tabId: number, message: unknown) => {
      const name = (message as { action?: string }).action
      return name === undefined ? undefined : await action(name, message)
    })
    vi.stubGlobal('chrome', {
      alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
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
      sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
      storage: {
        local: {
          get: vi.fn(async () => ({
            dshSettings: {
              bridgeUrl: 'ws://127.0.0.1:39001/ext/bridge',
              sharePageContent: 'auto',
              trustedActionOrigins: ['https://example.com'],
            },
          })),
          set: vi.fn(async () => {}),
        },
        session: {
          get: vi.fn(async (key: string) => ({ [key]: sessionData[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, items) }),
          remove: vi.fn(async (key: string) => { delete sessionData[key] }),
        },
      },
      tabs: {
        get: vi.fn(async () => currentTab),
        query: vi.fn(async () => [currentTab]),
        sendMessage,
        onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
        onUpdated: chromeEvent<[number, Parameters<Parameters<typeof chrome.tabs.onUpdated.addListener>[0]>[1], chrome.tabs.Tab]>(),
        onReplaced: chromeEvent<[number, number]>(),
        onRemoved: chromeEvent<[number]>(),
      },
      scripting: { executeScript: vi.fn(async () => []) },
      webNavigation: {
        getAllFrames: vi.fn(async () => [{
          tabId: 1,
          frameId: 0,
          parentFrameId: -1,
          documentId: 'document-1',
          url: currentTab.url!,
        }]),
        onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: chromeEvent<[number]>(),
        onRemoved: chromeEvent<[number]>(),
      },
    } as unknown as typeof chrome)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:39001/ext/bridge',
    }), { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' })) })
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
    await vi.waitFor(() => { expect(storedUrlKey(sessionData)).toBe('https://example.com/start') })
    panel.onDisconnect.emit()

    const call = async (id: string, name: string): Promise<void> => {
      socket.receive({
        t: 'tool.call',
        id,
        name,
        args: name === 'browser_navigate' ? { url: 'https://example.com/target' } : name === 'browser_press' ? { key: 'Enter' } : {},
        expiresAt: Date.now() + 10_000,
        sessionId: 'session-live',
      })
      await vi.waitFor(() => {
        expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id }))
      })
    }

    action = async (name) => {
      if (name === 'browser_navigate') {
        currentTab = browserTab('https://example.com/failed')
        return { ok: false, error: { code: 'action-failed', message: 'navigation failed' } }
      }
      return { ok: true, result: { text: 'snapshot' } }
    }
    await call('failed', 'browser_navigate')
    expect(storedUrlKey(sessionData)).toBe('https://example.com/start')

    action = async () => {
      currentTab = browserTab('https://example.com/non-navigation')
      return { ok: true, result: { text: 'snapshot' } }
    }
    await call('snapshot', 'browser_snapshot')
    expect(storedUrlKey(sessionData)).toBe('https://example.com/start')

    let finishCommitted!: () => void
    action = async () => await new Promise((resolve) => {
      finishCommitted = () => resolve({ ok: true, result: { text: 'navigated' } })
    })
    socket.receive({
      t: 'tool.call',
      id: 'committed',
      name: 'browser_navigate',
      args: { url: 'https://example.com/target' },
      expiresAt: Date.now() + 10_000,
      sessionId: 'session-live',
    })
    await vi.waitFor(() => { expect(finishCommitted).toBeTypeOf('function') })
    currentTab = browserTab('https://example.com/committed')
    socket.receive({ t: 'tool.cancel', id: 'committed' })
    finishCommitted()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'committed', ok: true }))
    })
    await vi.waitFor(() => { expect(storedUrlKey(sessionData)).toBe('https://example.com/committed') })

    action = async () => {
      currentTab = browserTab('https://example.com/success?step=2#done')
      return { ok: true, result: { text: 'navigated' } }
    }
    await call('success', 'browser_navigate')
    await vi.waitFor(() => { expect(storedUrlKey(sessionData)).toBe('https://example.com/success') })

    let writesStarted = 0
    let finishFirst!: () => void
    action = async (name) => {
      if (name !== 'browser_navigate') return { ok: true, result: { text: 'snapshot' } }
      writesStarted += 1
      if (writesStarted === 1) await new Promise<void>(resolve => { finishFirst = resolve })
      return { ok: true, result: { text: 'navigated' } }
    }
    const send = (id: string, name: string): void => {
      socket.receive({ t: 'tool.call', id, name,
        args: name === 'browser_navigate' ? { url: 'https://example.com/target' } : name === 'browser_press' ? { key: 'Enter' } : {},
        expiresAt: Date.now() + 10_000, sessionId: 'session-live' })
    }
    send('serial-first', 'browser_navigate')
    await vi.waitFor(() => { expect(writesStarted).toBe(1) })
    send('serial-cancelled', 'browser_navigate')
    send('parallel-read', 'browser_snapshot')
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'parallel-read', ok: true })) })
    expect(writesStarted).toBe(1)
    socket.receive({ t: 'tool.cancel', id: 'serial-cancelled' })
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'serial-cancelled', ok: false })) })
    send('serial-next', 'browser_navigate')
    expect(writesStarted).toBe(1)
    finishFirst()
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'serial-next', ok: true })) })
    expect(writesStarted).toBe(2)

    const settingsPanel = panelPort()
    onConnect.emit(settingsPanel.port)
    let finishPrivacyFirst!: () => void
    const privacyMessages: Array<{ includePageDelta?: boolean }> = []
    action = async (name, message) => {
      if (name === 'browser_press') {
        privacyMessages.push(message as { includePageDelta?: boolean })
        if (privacyMessages.length === 1) await new Promise<void>(resolve => { finishPrivacyFirst = resolve })
      }
      return { ok: true, result: { text: 'ok' } }
    }
    send('privacy-first', 'browser_press')
    await vi.waitFor(() => { expect(finishPrivacyFirst).toBeTypeOf('function') })
    send('privacy-next', 'browser_press')
    settingsPanel.onMessage.emit({ type: 'settings', id: 'privacy-off', settings: { sharePageContent: 'off' } })
    await vi.waitFor(() => { expect(settingsPanel.port.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'privacy-off', ok: true }) })
    finishPrivacyFirst()
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'privacy-next', ok: true })) })
    expect(privacyMessages).toHaveLength(2)
    expect(privacyMessages[1]!.includePageDelta).not.toBe(true)

    settingsPanel.onMessage.emit({ type: 'settings', id: 'privacy-auto', settings: { sharePageContent: 'auto' } })
    await vi.waitFor(() => { expect(settingsPanel.port.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'privacy-auto', ok: true }) })
    let finishSnapshot!: () => void
    action = async (name) => {
      if (name === 'browser_snapshot') await new Promise<void>(resolve => { finishSnapshot = resolve })
      return { ok: true, result: { text: 'private-page-content' } }
    }
    send('privacy-inflight', 'browser_snapshot')
    await vi.waitFor(() => { expect(finishSnapshot).toBeTypeOf('function') })
    settingsPanel.onMessage.emit({ type: 'settings', id: 'privacy-off-again', settings: { sharePageContent: 'off' } })
    await vi.waitFor(() => { expect(settingsPanel.port.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'privacy-off-again', ok: true }) })
    finishSnapshot()
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'privacy-inflight', ok: false })) })
    const protectedResult = socket.sent.find(value => (value as { id?: string }).id === 'privacy-inflight')
    expect(JSON.stringify(protectedResult)).not.toContain('private-page-content')

    settingsPanel.onMessage.emit({ type: 'settings', id: 'privacy-auto-again', settings: { sharePageContent: 'auto' } })
    await vi.waitFor(() => { expect(settingsPanel.port.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'privacy-auto-again', ok: true }) })
    let finishDelta!: () => void
    let deltaRequested = false
    action = async (name, message) => {
      if (name === 'browser_press') {
        deltaRequested = (message as { includePageDelta?: boolean }).includePageDelta === true
        await new Promise<void>(resolve => { finishDelta = resolve })
      }
      return { ok: true, result: { text: 'Action returned', pageContent: 'private-page-delta' } }
    }
    send('privacy-delta', 'browser_press')
    await vi.waitFor(() => { expect(finishDelta).toBeTypeOf('function') })
    expect(deltaRequested).toBe(true)
    settingsPanel.onMessage.emit({ type: 'settings', id: 'privacy-off-final', settings: { sharePageContent: 'off' } })
    await vi.waitFor(() => { expect(settingsPanel.port.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'privacy-off-final', ok: true }) })
    finishDelta()
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'privacy-delta', ok: true })) })
    const protectedDelta = socket.sent.find(value => (value as { id?: string }).id === 'privacy-delta')
    expect(JSON.stringify(protectedDelta)).not.toContain('private-page-delta')
    expect(JSON.stringify(protectedDelta)).toContain('withheld')
    settingsPanel.onDisconnect.emit()
  })
})
