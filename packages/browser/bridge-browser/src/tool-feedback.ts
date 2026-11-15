/** Bounded diagnostic feedback. It never grants access or verifies a business change. */
import { BROWSER_ERROR_CODES, errorDefault, type BrowserErrorCode, type NextStep } from './contracts/errors.ts'

export const READONLY_FIELD_GUIDANCE = 'This field is read-only for direct editing. Do not force this edit through another interaction method. Continue only with other writable controls within existing authorization, or ask the user.'

export const FEEDBACK_STATES = ['observed', 'dispatched', 'readback-unconfirmed', 'not-applied', 'failed', 'uncertain'] as const
export interface BrowserToolFeedback {
  version: 1
  state: typeof FEEDBACK_STATES[number]
  businessChange: 'not-verified'
  code?: BrowserErrorCode
  nextStep?: NextStep
}
const NEXT_STEPS = ['reobserve', 'focus_window', 'reselect_instance', 'request_permission', 'repair_arguments', 'wait_for_page', 'release_debugger', 'upgrade_runtime', 'reconnect', 'reconcile_business_state', 'none'] as const
export function parseToolFeedback(value: unknown): BrowserToolFeedback | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (v.version !== 1 || v.businessChange !== 'not-verified' || !FEEDBACK_STATES.includes(v.state as BrowserToolFeedback['state'])
    || (v.code !== undefined && !BROWSER_ERROR_CODES.includes(v.code as BrowserErrorCode))
    || (v.nextStep !== undefined && !NEXT_STEPS.includes(v.nextStep as NextStep))) return undefined
  return { version: 1, state: v.state as BrowserToolFeedback['state'], businessChange: 'not-verified',
    ...(v.code === undefined ? {} : { code: v.code as BrowserErrorCode }), ...(v.nextStep === undefined ? {} : { nextStep: v.nextStep as NextStep }) }
}
export function observationFeedback<S extends BrowserToolFeedback['state']>(state: S): { version: 1; state: S; businessChange: 'not-verified' } {
  return { version: 1, state, businessChange: 'not-verified' }
}

/** Only stable execution error identities select recovery; never parse page/error text. */
export function failureFeedback(code: string, readOnly: boolean, notDispatched = false): BrowserToolFeedback {
  let kind: BrowserErrorCode
  let state: BrowserToolFeedback['state'] = 'failed'
  switch (code) {
    case 'write-blocked-unconfirmed': kind = 'result_unknown'; state = 'not-applied'; break
    case 'element-stale': kind = 'target_expired'; state = 'not-applied'; break
    case 'target-navigated': kind = 'navigated'; state = 'not-applied'; break
    case 'permission-required': case 'approval-denied': case 'approval-unavailable': case 'approval-timeout':
      kind = 'permission_denied'; state = 'not-applied'; break
    case 'no-active-tab': kind = 'target_unavailable'; state = 'not-applied'; break
    case 'bad-args': kind = 'bad_args'; state = 'not-applied'; break
    case 'field-readonly': case 'design-zoom-not-selected': kind = 'action_failed'; state = 'not-applied'; break
    case 'timeout': case 'bridge-closed': case 'action-duplicate': case 'action-conflict': case 'receipt-unavailable': case 'execution-denied':
      kind = readOnly ? 'connection_unavailable' : 'result_unknown'; state = readOnly ? 'failed' : 'uncertain'; break
    case 'content-unavailable': kind = 'target_unavailable'; state = readOnly ? 'failed' : 'uncertain'; break
    case 'action-failed': kind = readOnly ? 'action_failed' : 'result_unknown'; state = readOnly ? 'failed' : 'uncertain'; break
    default: kind = readOnly ? 'internal' : 'result_unknown'; state = readOnly ? 'failed' : 'uncertain'
  }
  if (state === 'uncertain') kind = 'result_unknown'
  if (notDispatched) {
    state = 'not-applied'
    if (kind === 'result_unknown' && code !== 'write-blocked-unconfirmed') kind = code === 'bridge-closed' || code === 'timeout' ? 'connection_unavailable' : 'action_failed'
  }
  return { ...observationFeedback(state), code: kind, nextStep: errorDefault(kind).nextStep }
}
export function feedbackText(feedback: BrowserToolFeedback): string {
  return `Browser operation feedback: ${JSON.stringify(feedback)}. This is diagnostic state, not authorization or proof of a saved business change.`
}
