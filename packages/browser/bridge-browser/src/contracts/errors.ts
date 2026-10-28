/**
 * Browser error taxonomy with an explicit recovery step.
 *
 * Upstream settles every browser tool failure as one of seven codes
 * (`no-active-tab`, `content-unavailable`, `action-failed`, `timeout`,
 * `bridge-closed`, `bad-args`, `internal`). That is enough to print "tool call
 * failed" and not enough to recover: a stale element, a user who revoked site
 * access, a page still loading and a click whose result is unknown demand four
 * different next moves, and the contract identifies them.
 *
 * This module keeps the recovery step in the type, so an error cannot be
 * constructed without one, and it carries a compatibility translation from the
 * current wire codes so the browser tools can adopt the taxonomy before the
 * whole protocol changes.
 *
 * These rules are not yet wired into the runtime.
 *
 * @module
 */

import type { ActionOutcome, DispatchState } from './outcome.ts'

/** Closed set of browser failure codes. Adding one is a contract change. */
export type BrowserErrorCode =
  | 'connection_unavailable'
  | 'version_mismatch'
  | 'target_unavailable'
  | 'target_expired'
  | 'target_obscured'
  | 'navigated'
  | 'permission_denied'
  | 'focus_required'
  | 'debugger_unavailable'
  | 'page_busy'
  | 'action_failed'
  | 'bad_args'
  | 'budget_exhausted'
  | 'cancelled'
  | 'result_unknown'
  | 'internal'

/** Every code, for UI enumeration and coverage checks. */
export const BROWSER_ERROR_CODES: readonly BrowserErrorCode[] = [
  'connection_unavailable',
  'version_mismatch',
  'target_unavailable',
  'target_expired',
  'target_obscured',
  'navigated',
  'permission_denied',
  'focus_required',
  'debugger_unavailable',
  'page_busy',
  'action_failed',
  'bad_args',
  'budget_exhausted',
  'cancelled',
  'result_unknown',
  'internal',
]

/**
 * The recovery step attached to every error.
 *
 * These are the only sanctioned moves; the UI localizes them and the strategy
 * layer chooses among them. `none` exists for a genuinely terminal failure and
 * must not be used to avoid stating a step.
 */
export type NextStep =
  | 'reobserve'
  | 'focus_window'
  | 'reselect_instance'
  | 'request_permission'
  | 'repair_arguments'
  | 'wait_for_page'
  | 'release_debugger'
  | 'upgrade_runtime'
  | 'reconnect'
  | 'reconcile_business_state'
  | 'none'

/** One browser failure as it crosses a tool boundary. */
export interface BrowserError {
  /** Stable machine code. */
  code: BrowserErrorCode
  /** Human text for the model and the log; never the only signal. */
  message: string
  /** What the caller should do next. */
  nextStep: NextStep
  /** True when re-issuing the same logical action after `nextStep` can succeed. */
  retryable: boolean
  /** True when writes must not proceed until the condition is resolved. */
  blocksWrites: boolean
  /** True when the side effect of this specific action is unknown and must be reconciled. */
  sideEffectUnknown?: boolean
  /** Structured detail for diagnostics; must not carry page text or credentials. */
  details?: Record<string, unknown>
}

/** Defaults per code: recovery step, retryability and write blocking. */
interface ErrorDefault {
  nextStep: NextStep
  retryable: boolean
  blocksWrites: boolean
}

const CATALOG: Readonly<Record<BrowserErrorCode, ErrorDefault>> = {
  connection_unavailable: { nextStep: 'reconnect', retryable: true, blocksWrites: true },
  version_mismatch: { nextStep: 'upgrade_runtime', retryable: false, blocksWrites: true },
  target_unavailable: { nextStep: 'reobserve', retryable: true, blocksWrites: true },
  target_expired: { nextStep: 'reobserve', retryable: true, blocksWrites: true },
  target_obscured: { nextStep: 'focus_window', retryable: true, blocksWrites: true },
  navigated: { nextStep: 'reobserve', retryable: true, blocksWrites: true },
  permission_denied: { nextStep: 'request_permission', retryable: false, blocksWrites: true },
  focus_required: { nextStep: 'focus_window', retryable: true, blocksWrites: true },
  debugger_unavailable: { nextStep: 'release_debugger', retryable: true, blocksWrites: true },
  page_busy: { nextStep: 'wait_for_page', retryable: true, blocksWrites: false },
  action_failed: { nextStep: 'reobserve', retryable: true, blocksWrites: false },
  bad_args: { nextStep: 'repair_arguments', retryable: false, blocksWrites: false },
  budget_exhausted: { nextStep: 'none', retryable: false, blocksWrites: true },
  cancelled: { nextStep: 'none', retryable: false, blocksWrites: true },
  result_unknown: { nextStep: 'reconcile_business_state', retryable: false, blocksWrites: true },
  internal: { nextStep: 'reobserve', retryable: true, blocksWrites: false },
}

/**
 * The error catalog, for UI and strategy code that needs the default recovery step.
 * @param code - browser error code.
 * @returns the default recovery attributes for that code.
 */
export function errorDefault(code: BrowserErrorCode): Readonly<ErrorDefault> {
  return CATALOG[code]
}

/**
 * Build an error from the catalog defaults.
 *
 * @param code - browser error code.
 * @param message - human text.
 * @param overrides - per-instance facts such as `sideEffectUnknown` or `details`.
 * @returns a complete error value.
 */
export function makeBrowserError(
  code: BrowserErrorCode,
  message: string,
  overrides: Partial<Omit<BrowserError, 'code' | 'message'>> = {},
): BrowserError {
  const base = CATALOG[code]
  return {
    code,
    message,
    nextStep: overrides.nextStep ?? base.nextStep,
    retryable: overrides.retryable ?? base.retryable,
    blocksWrites: overrides.blocksWrites ?? base.blocksWrites,
    ...(overrides.sideEffectUnknown !== undefined ? { sideEffectUnknown: overrides.sideEffectUnknown } : {}),
    ...(overrides.details !== undefined ? { details: overrides.details } : {}),
  }
}

/**
 * Does this error forbid new writes until it is resolved?
 * @param error - browser error.
 * @returns true when the run must stop dispatching writes.
 */
export function blocksNewWrites(error: BrowserError): boolean {
  return error.blocksWrites
}

/**
 * Map an upstream `ToolErrorCode` onto the taxonomy.
 *
 * Compatibility seam: the current bridge settles tools with the smaller set.
 * `timeout` is the dangerous one — a timed-out tool may or may not have
 * produced a side effect, so it maps to `result_unknown` rather than to a
 * retryable "try again".
 *
 * @param code - upstream wire error code; unknown codes are treated as `internal`.
 * @param message - upstream message.
 * @returns the equivalent browser error.
 */
export function fromLegacyToolError(code: string, message: string): BrowserError {
  switch (code) {
    case 'no-active-tab':
      return makeBrowserError('target_unavailable', message)
    case 'content-unavailable':
      return makeBrowserError('target_unavailable', message)
    case 'action-failed':
      return makeBrowserError('action_failed', message)
    case 'timeout':
      return makeBrowserError('result_unknown', message, { sideEffectUnknown: true })
    case 'bridge-closed':
      return makeBrowserError('connection_unavailable', message)
    case 'bad-args':
      return makeBrowserError('bad_args', message)
    case 'internal':
      return makeBrowserError('internal', message)
    default:
      return makeBrowserError('internal', `unmapped tool error '${code}': ${message}`)
  }
}

/**
 * Derive the honest outcome of an action from its dispatch state and error.
 *
 * A missing receipt never proves "not sent", and
 * acceptance never proves business success. Once an action has left the Host,
 * an error makes its effect unknown until the browser or the site state is
 * reconciled.
 *
 * @param dispatchState - how far the action got.
 * @param error - failure reported by the executor, if any.
 * @returns the outcome that may be recorded.
 */
export function outcomeAfterError(
  dispatchState: DispatchState,
  error: BrowserError,
): 'failed' | 'uncertain' | 'cancelled' {
  if (error.code === 'cancelled' && dispatchState === 'not_sent') return 'cancelled'
  if (error.sideEffectUnknown === true) return 'uncertain'
  if (dispatchState === 'not_sent') return 'failed'
  return 'uncertain'
}

/**
 * May this action be re-dispatched automatically?
 *
 * Only when the protocol proves the action never entered a side-effecting
 * stage. `cancelled` actions and reconciliation results are excluded because
 * the decision to retry belongs to the run controller, not to a helper.
 *
 * @param dispatchState - recorded dispatch state.
 * @param outcome - recorded outcome.
 * @returns true when an automatic retry is safe.
 */
export function mayAutoRetry(dispatchState: DispatchState, outcome: ActionOutcome): boolean {
  if (outcome === 'verified' || outcome === 'cancelled') return false
  return dispatchState === 'not_sent'
}
