/**
 * Gateway RPC client: maps `rpc`/`rpc.result` frames to promises keyed by
 * correlation id, with a 30s timeout. One instance per bridge generation.
 *
 * @module
 */

import type { BridgeClient } from './bridge.ts'
import type { ServerFrame } from '@eilyeee/dsh-browser-stride/src/protocol.ts'

const RPC_TIMEOUT_MS = 30_000

interface PendingRpc {
  resolve(result: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}
interface RpcOptions { signal?: AbortSignal; timeoutMs?: number }

/** Preserve fixed bridge error codes across the panel port. */
export class BridgeRpcError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'BridgeRpcError' }
}

/**
 * Create an RPC facade over a live bridge. Wraps the bridge's frame sink so
 * other handlers keep working; settles `rpc.result` frames by correlation id.
 * @param bridge - the bridge client (must be connected).
 * @returns `{ request }` where request dispatches one unary gateway RPC.
 */
export function createRpc(bridge: BridgeClient): { request(method: string, payload: unknown, options?: RpcOptions): Promise<unknown> } {
  const pending = new Map<string, PendingRpc>()
  const finish = (id: string, error?: Error, value?: unknown): void => {
    const entry = pending.get(id)
    if (entry === undefined) return
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.removeAbort?.()
    if (error === undefined) entry.resolve(value)
    else entry.reject(error)
  }
  const previousState = bridge.sinks.onStateChange
  bridge.sinks.onStateChange = state => {
    previousState?.(state)
    if (state !== 'connected') {
      for (const id of [...pending.keys()]) finish(id, new BridgeRpcError('bridge-closed', 'The original connection closed'))
    }
  }

  const previous = bridge.sinks.onFrame
  bridge.sinks.onFrame = (frame: ServerFrame) => {
    previous?.(frame)
    if (frame.t !== 'rpc.result') return
    if (frame.ok) finish(frame.id, undefined, frame.result)
    else finish(frame.id, new BridgeRpcError(frame.error.code, frame.error.message))
  }

  return {
    request(method: string, payload: unknown, options: RpcOptions = {}): Promise<unknown> {
      if (!bridge.connected) {
        return Promise.reject(new Error('bridge not connected'))
      }
      const id = crypto.randomUUID()
      return new Promise<unknown>((resolve, reject) => {
        const timeout = Math.max(0, Math.min(RPC_TIMEOUT_MS, options.timeoutMs ?? RPC_TIMEOUT_MS))
        const timer = setTimeout(() => finish(id, new Error('Gateway RPC timed out')), timeout)
        pending.set(id, { resolve, reject, timer })
        if (options.signal !== undefined) {
          const cancel = (): void => finish(id, new BridgeRpcError('cancelled', 'Gateway RPC was cancelled'))
          if (options.signal.aborted) { cancel(); return }
          options.signal.addEventListener('abort', cancel, { once: true })
          pending.get(id)!.removeAbort = () => options.signal!.removeEventListener('abort', cancel)
        }
        try {
          if (!bridge.send({ t: 'rpc', id, method, payload })) finish(id, new Error('Bridge socket closed before request dispatch'))
        } catch { finish(id, new Error('Bridge socket closed before request dispatch')) }
      })
    },
  }
}
