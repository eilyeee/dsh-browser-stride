import { BridgeToolError } from './server.ts'

export const APPROVAL_RETRY_GUIDANCE = 'Browser approvals are paused for this turn. Stop browser calls and tell the user to return to the DSH Stride extension, then send a new message to retry and confirm the new request. Do not retry automatically or use another access method.'

/** A timeout is not a user decision. Keep retries local to a fresh user turn. */
export class BrowserApprovalGate {
  private readonly states = new WeakMap<object, { blocked: boolean }>()

  reset(agent: object): void { this.states.delete(agent) }

  async request<T>(agent: object | undefined, work: () => Promise<T>): Promise<T> {
    let state = agent === undefined ? undefined : this.states.get(agent)
    if (agent !== undefined && state === undefined) {
      state = { blocked: false }
      this.states.set(agent, state)
    }
    if (state?.blocked) throw new BridgeToolError('action-failed', APPROVAL_RETRY_GUIDANCE)
    try { return await work() } catch (error) {
      // Existing wire-v4 peers already distinguish approval failures in these
      // fixed errors. Do not confuse a page wait/transport timeout with one.
      if (error instanceof BridgeToolError && (
        (error.code === 'timeout' && /^The browser approval request for "[^"]+" timed out before the user responded\.$/.test(error.message))
        || (error.code === 'action-failed' && /^No browser side panel was available to receive or complete the approval request for "[^"]+"\.$/.test(error.message))
      )) {
        if (state !== undefined) state.blocked = true
        throw new BridgeToolError(error.code, `${error.message} ${APPROVAL_RETRY_GUIDANCE}`)
      }
      throw error
    }
  }
}
