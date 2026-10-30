import { createHash } from 'node:crypto'
import { toolCommandMaterial } from '@eilyeee/dsh-stride-browser-bridge/src/tool-identity.ts'

/** Test Host fixture: emit a valid v2 identity unless testing one explicitly. */
export function wireToolCall(frame: unknown): unknown {
  if (typeof frame !== 'object' || frame === null) return frame
  const call = frame as { t?: string; id?: string; name?: string; args?: Record<string, unknown>; sessionId?: string; action?: unknown }
  if (call.t !== 'tool.call' || 'action' in call) return frame
  const actionId = `act_${call.id}`
  const requestDigest = createHash('sha256').update(toolCommandMaterial({ actionId, name: call.name!, args: call.args!,
    ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }) })).digest('hex')
  return { ...frame, action: { actionId, requestDigest } }
}
