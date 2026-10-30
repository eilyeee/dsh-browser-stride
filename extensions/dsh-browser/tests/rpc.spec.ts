// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createRpc, BridgeRpcError } from '../src/background/rpc.ts'
import type { BridgeClient } from '../src/background/bridge.ts'
import type { ServerFrame } from '@eilyeee/dsh-stride-browser-bridge/src/protocol.ts'

describe('bridge RPC failures', () => {
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
