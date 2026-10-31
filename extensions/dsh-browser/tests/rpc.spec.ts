// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createRpc, BridgeRpcError } from '../src/background/rpc.ts'
import type { BridgeClient } from '../src/background/bridge.ts'
import type { ServerFrame } from '@eilyeee/dsh-browser-stride/src/protocol.ts'

describe('bridge RPC failures', () => {
  it.each(['cancel', 'disconnect'])('drops a pending confirmation on %s and ignores a late reply', async reason => {
    const send = vi.fn((_frame: unknown) => true)
    const bridge = { connected: true, send, sinks: {} as { onFrame?: (frame: ServerFrame) => void; onStateChange?: (state: 'stopped') => void } }
    const rpc = createRpc(bridge as unknown as BridgeClient)
    const controller = new AbortController()
    const result = rpc.request('bridge.tool.confirm', {}, { signal: controller.signal }).catch(error => error)
    const frame = send.mock.calls[0][0] as { id: string }
    if (reason === 'cancel') controller.abort()
    else bridge.sinks.onStateChange?.('stopped')
    expect(await result).toBeInstanceOf(BridgeRpcError)
    bridge.sinks.onFrame?.({ t: 'rpc.result', id: frame.id, ok: true, result: { confirmed: true } })
    expect(await result).toMatchObject({ code: reason === 'cancel' ? 'cancelled' : 'bridge-closed' })
  })
  it('preserves a stale-control code for the panel instead of reporting a connection failure', async () => {
    const send = vi.fn((_frame: unknown) => true)
    const bridge = { connected: true, send, sinks: {} as { onFrame?: (frame: ServerFrame) => void } }
    const rpc = createRpc(bridge as unknown as BridgeClient)
    const pending = rpc.request('bridge.browserRuns.control', {}).catch(error => error)
    const frame = send.mock.calls[0][0] as { id: string }
    bridge.sinks.onFrame?.({ t: 'rpc.result', id: frame.id, ok: false, error: { code: 'stale-version', message: 'Refresh task status' } })
    expect(await pending).toBeInstanceOf(BridgeRpcError)
    expect(await pending).toMatchObject({ code: 'stale-version' })
  })
})
