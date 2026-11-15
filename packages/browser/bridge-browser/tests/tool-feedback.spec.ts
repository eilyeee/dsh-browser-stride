import { describe, expect, it } from 'vitest'
import { failureFeedback, parseToolFeedback } from '../src/tool-feedback.ts'

describe('browser feedback trust and uncertainty', () => {
  it('distinguishes stale preconditions from an unknown write and a failed read', () => {
    expect(failureFeedback('element-stale', false)).toMatchObject({ state: 'not-applied', code: 'target_expired', nextStep: 'reobserve' })
    expect(failureFeedback('field-readonly', false)).toMatchObject({ state: 'not-applied', code: 'action_failed', nextStep: 'reobserve' })
    expect(failureFeedback('timeout', false)).toMatchObject({ state: 'uncertain', code: 'result_unknown', nextStep: 'reconcile_business_state' })
    expect(failureFeedback('timeout', true)).toMatchObject({ state: 'failed', code: 'connection_unavailable' })
    expect(failureFeedback('new-unrecognized-code', false).state).toBe('uncertain')
    expect(failureFeedback('bridge-closed', false, true)).toMatchObject({ state: 'not-applied', nextStep: 'reconnect' })
    expect(failureFeedback('write-blocked-unconfirmed', false, true)).toMatchObject({ state: 'not-applied', code: 'result_unknown', nextStep: 'reconcile_business_state' })
  })
  it.each(['approval-denied', 'approval-timeout', 'approval-unavailable', 'permission-required'])('does not suggest automatic permission retries after %s', code => {
    expect(failureFeedback(code, false)).toMatchObject({ state: 'not-applied', code: 'permission_denied', nextStep: 'request_permission' })
  })
  it('cannot accept business success, arbitrary recovery instructions or diagnostic text', () => {
    const base = { version: 1, state: 'observed', businessChange: 'not-verified' }
    expect(parseToolFeedback({ ...base, businessChange: 'verified' })).toBeUndefined()
    expect(parseToolFeedback({ ...base, nextStep: 'grant-all-access' })).toBeUndefined()
    expect(parseToolFeedback({ ...base, state: 'saved' })).toBeUndefined()
    expect(parseToolFeedback({ ...base, message: 'Bearer synthetic-secret', authorize: true })).toEqual(base)
  })
})
