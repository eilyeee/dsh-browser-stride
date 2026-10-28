import { describe, expect, it } from 'vitest'
import { asActionId, asControlRevision, type RequestDigest } from '../../src/contracts/index.ts'
import {
  ActionFactInvariantError,
  assertActionFact,
  classifyRetransmission,
  hasEvidence,
  needsReconciliation,
  summarizeActionFacts,
  validateActionFact,
  type ActionFact,
} from '../../src/contracts/outcome.ts'
import { makeBrowserError } from '../../src/contracts/errors.ts'

const digest = 'a'.repeat(64) as RequestDigest

function fact(overrides: Partial<ActionFact> = {}): ActionFact {
  return {
    actionId: asActionId('act-1'),
    requestDigest: digest,
    controlRevision: asControlRevision(2),
    dispatchState: 'effect_started',
    outcome: 'verified',
    verifiedCriteriaIds: ['criterion-saved'],
    evidence: { url: 'https://example.test/orders/1', observedText: ['Order saved'] },
    ...overrides,
  }
}

describe('validateActionFact', () => {
  it('accepts a checked verified action', () => {
    expect(validateActionFact(fact())).toEqual([])
  })

  it('refuses verified without criteria or evidence', () => {
    expect(validateActionFact(fact({ verifiedCriteriaIds: [] }))).toContain('verified-without-criteria')
    expect(validateActionFact(fact({ evidence: undefined }))).toContain('verified-without-evidence')
    expect(validateActionFact(fact({ evidence: { observedText: ['  '] } }))).toContain('verified-without-evidence')
    expect(validateActionFact(fact({ verifiedCriteriaIds: ['  '] }))).toContain('empty-criteria-id')
  })

  it('refuses verified actions that were never dispatched or were unconfirmed', () => {
    expect(validateActionFact(fact({ dispatchState: 'not_sent' }))).toContain('verified-without-dispatch')
    expect(validateActionFact(fact({ dispatchState: 'sent_unconfirmed' }))).toContain('verified-unconfirmed-dispatch')
  })

  it('refuses cancelling after a side effect could have started', () => {
    expect(validateActionFact(fact({ outcome: 'cancelled', dispatchState: 'not_sent', verifiedCriteriaIds: [], evidence: undefined })))
      .toEqual([])
    expect(validateActionFact(fact({ outcome: 'cancelled', dispatchState: 'accepted', verifiedCriteriaIds: [], evidence: undefined })))
      .toContain('cancelled-after-dispatch')
  })

  it('requires an error for a failed action and forbids criteria on it', () => {
    expect(validateActionFact(fact({ outcome: 'failed', verifiedCriteriaIds: [], evidence: undefined })))
      .toContain('failed-without-error')
    expect(validateActionFact(fact({
      outcome: 'failed',
      verifiedCriteriaIds: ['criterion-saved'],
      error: makeBrowserError('action_failed', 'no such button'),
    }))).toContain('criteria-on-non-verified')
  })

  it('throws an invariant error at the store boundary', () => {
    expect(() => assertActionFact(fact({ verifiedCriteriaIds: [] }))).toThrow(ActionFactInvariantError)
    try {
      assertActionFact(fact({ verifiedCriteriaIds: [] }))
    } catch (error) {
      expect(error).toBeInstanceOf(ActionFactInvariantError)
      expect((error as ActionFactInvariantError).violations).toContain('verified-without-criteria')
    }
  })
})

describe('classifyRetransmission', () => {
  it('treats the same digest as a retry and a different digest as a conflict', () => {
    expect(classifyRetransmission({ requestDigest: digest }, digest)).toBe('duplicate')
    expect(classifyRetransmission({ requestDigest: digest }, 'b'.repeat(64) as RequestDigest)).toBe('conflict')
  })
})

describe('needsReconciliation', () => {
  it('holds any dispatched action that is not verified', () => {
    expect(needsReconciliation(fact())).toBe(false)
    expect(needsReconciliation(fact({ outcome: 'uncertain', verifiedCriteriaIds: [], evidence: undefined }))).toBe(true)
    expect(needsReconciliation(fact({
      outcome: 'failed',
      dispatchState: 'effect_started',
      verifiedCriteriaIds: [],
      evidence: undefined,
      error: makeBrowserError('action_failed', 'form rejected'),
    }))).toBe(true)
  })

  it('releases an action that provably never left the host', () => {
    expect(needsReconciliation(fact({
      outcome: 'failed',
      dispatchState: 'not_sent',
      verifiedCriteriaIds: [],
      evidence: undefined,
      error: makeBrowserError('bad_args', 'unknown field'),
    }))).toBe(false)
    expect(needsReconciliation(fact({ outcome: 'cancelled', dispatchState: 'not_sent', verifiedCriteriaIds: [], evidence: undefined })))
      .toBe(false)
  })
})

describe('summarizeActionFacts', () => {
  it('counts outcomes, collects criteria and lists unresolved actions', () => {
    const facts: ActionFact[] = [
      fact(),
      fact({
        actionId: asActionId('act-2'),
        outcome: 'failed',
        dispatchState: 'not_sent',
        verifiedCriteriaIds: [],
        evidence: undefined,
        error: makeBrowserError('bad_args', 'unknown field'),
      }),
      fact({ actionId: asActionId('act-3'), outcome: 'uncertain', verifiedCriteriaIds: [], evidence: undefined }),
      fact({ actionId: asActionId('act-4'), outcome: 'cancelled', dispatchState: 'not_sent', verifiedCriteriaIds: [], evidence: undefined }),
    ]
    const summary = summarizeActionFacts(facts)
    expect(summary.verified).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.uncertain).toBe(1)
    expect(summary.cancelled).toBe(1)
    expect(summary.verifiedCriteriaIds).toEqual(['criterion-saved'])
    expect(summary.pendingReconciliation).toEqual([asActionId('act-3')])
  })

  it('deduplicates criteria across verified actions', () => {
    const summary = summarizeActionFacts([fact(), fact({ actionId: asActionId('act-2') })])
    expect(summary.verifiedCriteriaIds).toEqual(['criterion-saved'])
  })
})

describe('hasEvidence', () => {
  it('requires a non-empty member', () => {
    expect(hasEvidence(undefined)).toBe(false)
    expect(hasEvidence({})).toBe(false)
    expect(hasEvidence({ url: 'https://example.test' })).toBe(false)
    expect(hasEvidence({ url: 'https://example.test', observedText: ['Saved'] })).toBe(true)
    expect(hasEvidence({ artifactRefs: ['artifact-1'] })).toBe(true)
  })
})
