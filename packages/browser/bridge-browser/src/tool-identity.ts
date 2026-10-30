/** Digest of the logical command, independent of its transport attempt. */
import { canonicalize } from './contracts/ids.ts'

export interface ToolCommandMaterial {
  actionId: string
  name: string
  args: Record<string, unknown>
  sessionId?: string
}

export function toolCommandMaterial(command: ToolCommandMaterial): string {
  return canonicalize({ actionId: command.actionId, name: command.name, args: command.args,
    ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }) })
}

export async function computeToolCommandDigest(command: ToolCommandMaterial): Promise<string> {
  const bytes = new TextEncoder().encode(toolCommandMaterial(command))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
