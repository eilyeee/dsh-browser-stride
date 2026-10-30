import { describe, expect, it } from 'vitest'
import {
  BROWSER_ERROR_CODES,
  blocksNewWrites,
  errorDefault,
  fromLegacyToolError,
  makeBrowserError,
  mayAutoRetry,
  outcomeAfterError,
} from '../../src/contracts/errors.ts'

describe('error defaults', () => {
  it('defines a recovery step for every code', () => {
    for (const code of BROWSER_ERROR_CODES) {
      const defaults = errorDefault(code)
      expect(defaults.nextStep.length).toBeGreaterThan(0)
      expect(typeof defaults.retryable).toBe('boolean')
      expect(typeof defaults.blocksWrites).toBe('boolean')
    }
  })

  it('treats unrecoverable or unknown-effect failures as write blocking', () => {
    expect(blocksNewWrites(makeBrowserError('permission_denied', 'site access revoked'))).toBe(true)
    expect(blocksNewWrites(makeBrowserError('version_mismatch', 'protocol 2 required'))).toBe(true)
    expect(blocksNewWrites(makeBrowserError('result_unknown', 'receipt missing'))).toBe(true)
    expect(blocksNewWrites(makeBrowserError('page_busy', 'spinner still running'))).toBe(false)
  })

  it('lets a caller override a default without losing the code', () => {
    const error = makeBrowserError('target_expired', 'stale element', { retryable: false, details: { observationId: 'obs-1' } })
    expect(error.nextStep).toBe('reobserve')
    expect(error.retryable).toBe(false)
    expect(error.details).toEqual({ observationId: 'obs-1' })
  })
})

describe('fromLegacyToolError', () => {
  it.each(['action-duplicate', 'action-conflict', 'receipt-unavailable'])('requires reconciliation for %s instead of suggesting another write', code => {
    expect(fromLegacyToolError(code, 'synthetic error')).toMatchObject({
      code: 'result_unknown', nextStep: 'reconcile_business_state', retryable: false,
      blocksWrites: true, sideEffectUnknown: true,
    })
  })
  it('maps a timeout to an unknown side effect rather than a retry', () => {
    const error = fromLegacyToolError('timeout', 'tool timed out')
    expect(error.code).toBe('result_unknown')
    expect(error.sideEffectUnknown).toBe(true)
    expect(error.retryable).toBe(false)
    expect(mayAutoRetry('sent_unconfirmed', 'uncertain')).toBe(false)
  })

  it('maps the current wire codes', () => {
    expect(fromLegacyToolError('no-active-tab', '').code).toBe('target_unavailable')
    expect(fromLegacyToolError('content-unavailable', '').code).toBe('target_unavailable')
    expect(fromLegacyToolError('action-failed', '').code).toBe('action_failed')
    expect(fromLegacyToolError('bridge-closed', '').code).toBe('connection_unavailable')
    expect(fromLegacyToolError('bad-args', '').code).toBe('bad_args')
    expect(fromLegacyToolError('internal', '').code).toBe('internal')
  })

  it('does not silently accept unknown codes', () => {
    const error = fromLegacyToolError('something-new', 'detail')
    expect(error.code).toBe('internal')
    expect(error.message).toContain('something-new')
  })
})

describe('outcomeAfterError', () => {
  it('records a failure only when nothing was sent', () => {
    expect(outcomeAfterError('not_sent', makeBrowserError('bad_args', 'no such field'))).toBe('failed')
  })

  it('records uncertainty once an effect could have started', () => {
    for (const state of ['sent_unconfirmed', 'accepted', 'effect_started'] as const) {
      expect(outcomeAfterError(state, makeBrowserError('action_failed', 'no confirmation'))).toBe('uncertain')
    }
  })

  it('records cancellation only when no side effect started', () => {
    expect(outcomeAfterError('not_sent', makeBrowserError('cancelled', 'user stopped'))).toBe('cancelled')
    expect(outcomeAfterError('accepted', makeBrowserError('cancelled', 'user stopped'))).toBe('uncertain')
  })

  it('honours an explicit unknown-effect flag even before dispatch', () => {
    expect(outcomeAfterError('not_sent', makeBrowserError('result_unknown', 'state unclear', { sideEffectUnknown: true })))
      .toBe('uncertain')
  })
})

describe('mayAutoRetry', () => {
  it('retries only provably unsent actions', () => {
    expect(mayAutoRetry('not_sent', 'failed')).toBe(true)
    expect(mayAutoRetry('effect_started', 'failed')).toBe(false)
    expect(mayAutoRetry('accepted', 'failed')).toBe(false)
    expect(mayAutoRetry('sent_unconfirmed', 'uncertain')).toBe(false)
    expect(mayAutoRetry('not_sent', 'verified')).toBe(false)
    expect(mayAutoRetry('not_sent', 'cancelled')).toBe(false)
  })
})
