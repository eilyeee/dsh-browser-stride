import { BRIDGE_RUN_RETARGET_METHOD, BRIDGE_TASK_START_METHOD } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { BridgeRpcError } from './rpc.ts'

interface TargetCommit {
  runId: string; sessionId: string; expectedVersion: number; controlRevision: number; targetBinding: string; targetUrl?: string
}
interface PreparedTarget { current(): boolean; discard(): void }
type Request = (method: string, payload: unknown, options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>

/** Release an unused native pin only before send or on an explicit Host refusal. */
export async function commitRunTarget(request: Request, method: typeof BRIDGE_RUN_RETARGET_METHOD | typeof BRIDGE_TASK_START_METHOD,
  payload: TargetCommit, prepared: PreparedTarget, signal: AbortSignal): Promise<void> {
  let sent = false
  try {
    if (signal.aborted || !prepared.current()) throw new Error('Task target changed before submission')
    sent = true
    const result = await request(method, payload, { signal, timeoutMs: 12000 })
    if (typeof result !== 'object' || result === null) throw new Error('Task target reply was not confirmed')
    const value = result as { runId?: unknown; sessionId?: unknown; controlRevision?: unknown; state?: unknown; targetBinding?: unknown }
    if (value.runId !== payload.runId || value.sessionId !== payload.sessionId
      || value.controlRevision !== payload.controlRevision + (method === BRIDGE_TASK_START_METHOD ? 0 : 2)
      || value.state !== 'running' || value.targetBinding !== payload.targetBinding) throw new Error('Task target reply was not confirmed')
  } catch (error) {
    if (!sent || (error instanceof BridgeRpcError && error.targetState === 'unchanged')) prepared.discard()
    throw error
  }
}
