// @vitest-environment jsdom

import { BRIDGE_PROTOCOL_VERSION } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wireToolCall } from './wire-tool-call.ts'
import { BridgeClient, type BridgeState } from '../src/background/bridge.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

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

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('BridgeClient connection probe', () => {
  it.each([
    { frame: { t: 'hello.ok' }, state: 'update-host' },
    { frame: { t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION - 1 }, state: 'update-host' },
    { frame: { t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION + 1 }, state: 'update-extension' },
    { frame: { t: 'hello.ok', protocolVersion: '1' }, state: 'incompatible' },
    { frame: { t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 64000, maxInteractiveItems: 60 } }, state: 'incompatible' },
    { frame: { t: 'error', code: 'protocol-upgrade-extension', message: 'update extension' }, state: 'update-extension' },
    { frame: { t: 'error', code: 'protocol-upgrade-host', message: 'update host' }, state: 'update-host' },
  ])('stops on an incompatible handshake ($state) without saving credentials or executing tools', async ({ frame, state }) => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const save = vi.fn()
    const onFrame = vi.fn()
    const client = new BridgeClient({ onStateChange: () => {}, onFrame, onHelloOk: save })
    client.start('ws://127.0.0.1:3080/ext/bridge', 'synthetic-code')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({ caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 }, credential: 'a'.repeat(64), ...frame })
    socket.receive({ t: 'tool.call', id: 'must-not-run', name: 'browser_click', args: {}, expiresAt: Date.now() + 10000 })
    await vi.advanceTimersByTimeAsync(30000)
    expect(client.state).toBe(state)
    expect(client.connected).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(onFrame.mock.calls.some(([value]) => value.t === 'tool.call')).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('allows an explicit restart after an upgrade and ignores frames from the old socket', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const save = vi.fn()
    const client = new BridgeClient({ onStateChange: () => {}, onFrame: () => {}, onHelloOk: save })
    client.start('ws://127.0.0.1:3080/ext/bridge', 'token')
    await vi.advanceTimersByTimeAsync(0)
    const old = FakeWebSocket.instances[0]!
    old.open()
    await vi.advanceTimersByTimeAsync(0)
    old.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })
    expect(client.state).toBe('update-host')
    client.start('ws://127.0.0.1:3080/ext/bridge', 'token')
    await vi.advanceTimersByTimeAsync(0)
    const replacement = FakeWebSocket.instances[1]!
    replacement.open()
    await vi.advanceTimersByTimeAsync(0)
    old.receive({ t: 'error', code: 'protocol-upgrade-extension', message: 'stale' })
    replacement.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 16000, maxInteractiveItems: 30 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.connected).toBe(true)
    expect(save).toHaveBeenCalledWith({ textOnly: true, snapshotMaxChars: 16000, maxInteractiveItems: 30 }, undefined, 'token')
    client.stop()
  })

  it('waits for the installation credential to persist before dispatching frames or reporting connected', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let finish!: () => void
    let sentFromQueuedFrame = false
    const frames: unknown[] = []
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: frame => { frames.push(frame); sentFromQueuedFrame = client.send({ t: 'pong' }) },
      onHelloOk: save,
    })
    client.start('ws://127.0.0.1:3080/ext/bridge', 'one-time-code', 'installation-1234567890')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.connected).toBe(false)
    socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, credential: 'a'.repeat(64), caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({ t: 'event', frame: { type: 'ready' } })
    expect(client.connected).toBe(false)
    expect(frames).toHaveLength(0)
    expect(save).toHaveBeenCalledWith(expect.anything(), 'a'.repeat(64), 'one-time-code')
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.connected).toBe(true)
    expect(frames).toHaveLength(1)
    expect(sentFromQueuedFrame).toBe(true)
    client.stop()
  })

  it('closes when persisting a new credential fails or never finishes', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({ onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => new Promise(() => {}) })
    client.start('ws://127.0.0.1:3080/ext/bridge', 'one-time-code', 'installation-1234567890')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, credential: 'a'.repeat(64), caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(client.connected).toBe(false)
    client.stop()
  })

  it('closes if the credential callback throws synchronously', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => { throw new Error('storage unavailable') },
    })
    client.start('ws://127.0.0.1:3080/ext/bridge', 'one-time-code', 'installation-1234567890')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, credential: 'a'.repeat(64), caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(client.connected).toBe(false)
    client.stop()
  })

  it('waits without opening a WebSocket while the local bridge is unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const probe = vi.fn(async () => false)
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, probe)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(probe).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(states.at(-1)).toBe('reconnecting')
    client.stop()
  })

  it('opens the WebSocket after the probe succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('does not retry after the bridge explicitly replaces this connection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({
      t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')

    socket.close(4000, 'replaced')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('stops reconnecting after its user-owned lease disappears', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let active = true
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true, () => active)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    active = false
    socket.close()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
