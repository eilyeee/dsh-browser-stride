import { BridgeToolError } from './server.ts'
import { isReadOnlyBrowserTool } from './protocol.ts'
import { failureFeedback, parseToolFeedback } from './tool-feedback.ts'

export const UNCERTAIN_WRITE_GUIDANCE = 'A previous browser write has an unconfirmed result. Read the current page and check the business state. Do not issue another write in this turn or repeat the submission. Report the uncertainty and ask the user before continuing.'

export const APPROVAL_RETRY_GUIDANCE = 'Browser approvals are paused for this turn. Stop browser calls and tell the user to return to the DSH Stride extension, then send a new message to retry and confirm the new request. Do not retry automatically or use another access method.'
export const DESIGN_VIEW_RETRY_GUIDANCE = 'Design-view preparation failed for this turn. Stop browser calls and ask the user to enlarge the design view manually, then send a new message before continuing. Do not guess canvas points or retry via other tools.'
export const DESIGN_VIEW_RECOVERY_GUIDANCE = 'No percentage selection was dispatched. A menu may remain open. Take a fresh observation and choose another supported method within the existing page grant, or ask for the missing view/control. Do not guess canvas points, change CSS/browser zoom or bypass authorization. Verify the actual scale before continuing.'

/** Agent-local fences; only a trusted no-selection failure releases view preparation. */
export class BrowserApprovalGate {
  private readonly states = new WeakMap<object, { blocked: boolean; uncertainWrite?: true; designView?: 'pending' | 'failed' }>()

  reset(agent: object): void { this.states.delete(agent) }

  async request<T>(agent: object | undefined, work: () => Promise<T>, toolName?: string): Promise<T> {
    let state = agent === undefined ? undefined : this.states.get(agent)
    if (agent !== undefined && state === undefined) {
      state = { blocked: false }
      this.states.set(agent, state)
    }
    if (state?.blocked) throw new BridgeToolError('approval-unavailable', APPROVAL_RETRY_GUIDANCE)
    const readOnly = toolName !== undefined && (isReadOnlyBrowserTool(toolName) || toolName === 'browser_read_design_styles')
    if (state?.designView !== undefined) throw new BridgeToolError('content-unavailable', state.designView === 'pending'
      ? 'Design-view preparation is in progress. Wait for its result before other browser calls.'
      : DESIGN_VIEW_RETRY_GUIDANCE)
    if (state?.uncertainWrite && !readOnly) throw new BridgeToolError('write-blocked-unconfirmed', UNCERTAIN_WRITE_GUIDANCE, true)
    const preparesDesign = toolName === 'browser_set_design_zoom'
    if (preparesDesign && state !== undefined) state.designView = 'pending'
    try {
      const result = await work()
      const feedback = parseToolFeedback(typeof result === 'object' && result !== null ? (result as { feedback?: unknown }).feedback : undefined)
      if (!readOnly && feedback?.state === 'readback-unconfirmed' && state !== undefined) state.uncertainWrite = true
      if (preparesDesign && state !== undefined) delete state.designView
      return result
    } catch (error) {
      if (!readOnly && state !== undefined && failureFeedback(error instanceof BridgeToolError ? error.code : 'internal', false, error instanceof BridgeToolError && error.notDispatched).state === 'uncertain') state.uncertainWrite = true
      const recoverable = preparesDesign && error instanceof BridgeToolError && error.code === 'design-zoom-not-selected'
      if (preparesDesign && state !== undefined) {
        if (recoverable) delete state.designView
        else state.designView = 'failed'
      }
      // Existing wire-v4 peers already distinguish approval failures in these
      // fixed errors. Do not confuse a page wait/transport timeout with one.
      if (error instanceof BridgeToolError && (
        error.code === 'approval-unavailable' || error.code === 'approval-timeout' || error.code === 'approval-denied'
        || (error.code === 'action-failed' && /^The user denied the browser approval request for "[^"]+"\.$/.test(error.message))
        || (error.code === 'timeout' && /^The browser approval request for "[^"]+" timed out before the user responded\.$/.test(error.message))
        || (error.code === 'action-failed' && /^No browser side panel was available to receive or complete the approval request for "[^"]+"\.$/.test(error.message))
      )) {
        if (state !== undefined) state.blocked = true
        throw new BridgeToolError(error.code, `${error.message} ${APPROVAL_RETRY_GUIDANCE}`)
      }
      if (preparesDesign) throw new BridgeToolError(error instanceof BridgeToolError ? error.code : 'content-unavailable',
        (error instanceof Error ? error.message : 'Design zoom could not be confirmed.') + ' '
        + (recoverable ? DESIGN_VIEW_RECOVERY_GUIDANCE : DESIGN_VIEW_RETRY_GUIDANCE))
      throw error
    }
  }
}
