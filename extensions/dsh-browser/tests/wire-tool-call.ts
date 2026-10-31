import { createHash } from 'node:crypto'
import { toolCommandMaterial } from '@eilyeee/dsh-browser-stride/src/tool-identity.ts'
import { BRIDGE_CONFIRM_TOOL_METHOD, type ToolExecutionScope } from '@eilyeee/dsh-browser-stride/src/protocol.ts'

/** Test Host fixture; production peers must supply an explicit scope. */
export function wireToolCall(frame: unknown): unknown {
  if (typeof frame !== 'object' || frame === null) return frame
  const call = frame as { t?: string; id?: string; name?: string; args?: Record<string, unknown>; sessionId?: string; action?: unknown; execution?: ToolExecutionScope }
  if (call.t !== 'tool.call') return frame
  const execution = 'execution' in call ? call.execution : { kind: 'legacy' as const }
  if ('action' in call) return { ...frame, execution }
  const actionId = `act_${call.id}`
  const requestDigest = createHash('sha256').update(toolCommandMaterial({ actionId, name: call.name!, args: call.args!, execution,
    ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }) })).digest('hex')
  return { ...frame, execution, action: { actionId, requestDigest } }
}

export function confirmTestTool(frame: unknown, reply: (value: unknown) => void): void {
  const rpc = frame as { t?: string; id?: string; method?: string; payload?: object }
  if (rpc.t === 'rpc' && rpc.method === BRIDGE_CONFIRM_TOOL_METHOD) {
    reply({ t: 'rpc.result', id: rpc.id, ok: true, result: { ...rpc.payload, confirmed: true } })
  }
}
