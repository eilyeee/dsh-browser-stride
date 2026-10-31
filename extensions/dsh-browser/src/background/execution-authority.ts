import { isToolDispatchConfirmation, sameToolConfirmation, type ToolDispatchConfirmation, type ServerFrame } from '@eilyeee/dsh-browser-stride/src/protocol.ts'

/** One confirmation for one original call. Cancellation cannot be renewed. */
export class ToolExecutionFence {
  private granted = false
  private revoked = false
  private checking?: Promise<boolean>
  private signal?: AbortSignal
  readonly confirmation: ToolDispatchConfirmation

  constructor(private readonly call: Extract<ServerFrame, { t: 'tool.call' }>, private readonly ownsCall: () => boolean, proposedTarget?: string) {
    const targetBinding = proposedTarget ?? call.targetBinding
    this.confirmation = Object.freeze({ id: call.id, action: Object.freeze({ ...call.action }),
      execution: Object.freeze({ ...call.execution }), ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
      ...(targetBinding === undefined ? {} : { targetBinding }) })
  }

  current(): boolean { return this.granted && !this.revoked && !this.signal?.aborted && this.ownsCall() }
  revoke(): void { this.revoked = true }

  confirm(request: (payload: ToolDispatchConfirmation) => Promise<unknown>, signal: AbortSignal): Promise<boolean> {
    return this.checking ??= this.check(request, signal)
  }

  private async check(request: (payload: ToolDispatchConfirmation) => Promise<unknown>, signal: AbortSignal): Promise<boolean> {
    this.signal = signal
    if (this.revoked || signal.aborted || !this.ownsCall() || Date.now() >= this.call.expiresAt) return false
    if (this.call.targetBinding !== undefined && this.confirmation.targetBinding !== this.call.targetBinding) return false
    try {
      const result = await request(this.confirmation)
      if (typeof result !== 'object' || result === null || Array.isArray(result)) return false
      const { confirmed, ...identity } = result as Record<string, unknown>
      if (confirmed !== true || !isToolDispatchConfirmation(identity) || !sameToolConfirmation(identity, this.confirmation)) return false
      if (this.revoked || signal.aborted || !this.ownsCall() || Date.now() >= this.call.expiresAt) return false
      this.granted = true
      return true
    } catch { return false }
  }
}
