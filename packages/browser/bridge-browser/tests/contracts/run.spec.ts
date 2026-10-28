import { describe, expect, it } from 'vitest'
import { asActionId, asControlRevision } from '../../src/contracts/index.ts'
import {
  bumpsControlRevision,
  canTransition,
  decideCompletion,
  dispatchGate,
  isDispatchAllowed,
  isTerminal,
  mayContinue,
  nextControlRevision,
  requestPause,
  requestResume,
  requestStop,
  rerunRequiresReconciliation,
  assertTransition,
  type RunState,
} from '../../src/contracts/run.ts'

const ALL_STATES: readonly RunState[] = ['queued', 'running', 'blocked', 'paused', 'stopping', 'stopped', 'completed', 'failed']

describe('run states', () => {
  it('classifies terminal, resumable and dispatching states', () => {
    const terminal = ALL_STATES.filter(isTerminal)
    expect(terminal).toEqual(['stopped', 'completed', 'failed'])
    expect(ALL_STATES.filter(mayContinue)).toEqual(['blocked', 'paused'])
    expect(ALL_STATES.filter(isDispatchAllowed)).toEqual(['running'])
  })

  it('allows the documented transitions and rejects the rest', () => {
    expect(canTransition('queued', 'running')).toBe(true)
    expect(canTransition('running', 'completed')).toBe(true)
    expect(canTransition('running', 'stopping')).toBe(true)
    expect(canTransition('stopping', 'stopped')).toBe(true)
    expect(canTransition('blocked', 'running')).toBe(true)
    expect(canTransition('paused', 'running')).toBe(true)
    expect(canTransition('stopped', 'running')).toBe(false)
    expect(canTransition('completed', 'running')).toBe(false)
    expect(canTransition('failed', 'running')).toBe(false)
    expect(() => assertTransition('stopped', 'running')).toThrow(RangeError)
  })

  it('keeps stopping non-terminal until the executor confirms', () => {
    expect(isTerminal('stopping')).toBe(false)
    expect(isDispatchAllowed('stopping')).toBe(false)
  })
})

describe('control revision', () => {
  it('bumps on controls that change the run but not on questions', () => {
    expect(bumpsControlRevision('target_changed')).toBe(true)
    expect(bumpsControlRevision('definition_changed')).toBe(true)
    expect(bumpsControlRevision('pause')).toBe(true)
    expect(bumpsControlRevision('resume')).toBe(true)
    expect(bumpsControlRevision('takeover')).toBe(true)
    expect(bumpsControlRevision('stop')).toBe(true)
    expect(bumpsControlRevision('progress_query')).toBe(false)
    expect(bumpsControlRevision('supplement')).toBe(false)
  })

  it('advances the revision only when the control changes the run', () => {
    const revision = asControlRevision(4)
    expect(nextControlRevision(revision, 'target_changed')).toBe(5)
    expect(nextControlRevision(revision, 'progress_query')).toBe(4)
  })

  it('gates dispatch on state and revision equality', () => {
    expect(dispatchGate('running', asControlRevision(4), asControlRevision(4))).toBe('allowed')
    expect(dispatchGate('running', asControlRevision(5), asControlRevision(4))).toBe('stale-control-revision')
    expect(dispatchGate('paused', asControlRevision(4), asControlRevision(4))).toBe('not-dispatching')
    expect(dispatchGate('stopping', asControlRevision(4), asControlRevision(4))).toBe('not-dispatching')
  })
})

describe('requests', () => {
  it('stops a queued run immediately and asks a dispatched run to stop', () => {
    expect(requestStop('queued')).toBe('stopped')
    expect(requestStop('running')).toBe('stopping')
    expect(requestStop('blocked')).toBe('stopping')
    expect(requestStop('stopping')).toBe('stopping')
    expect(requestStop('completed')).toBe('completed')
    expect(requestStop('stopped')).toBe('stopped')
  })

  it('pauses only a run that is not already at rest', () => {
    expect(requestPause('running')).toBe('paused')
    expect(requestPause('queued')).toBe('paused')
    expect(requestPause('blocked')).toBe('blocked')
    expect(requestPause('completed')).toBe('completed')
  })

  it('resumes only blocked or paused runs', () => {
    expect(requestResume('blocked')).toBe('running')
    expect(requestResume('paused')).toBe('running')
    expect(requestResume('stopped')).toBe('stopped')
    expect(requestResume('running')).toBe('running')
  })
})

describe('decideCompletion', () => {
  it('does not complete a task without defined success criteria', () => {
    expect(decideCompletion({ requiredCriteriaIds: [], verifiedCriteriaIds: [], pendingReconciliation: [] }))
      .toMatchObject({ status: 'incomplete', reason: 'missing-criteria-definition' })
    expect(decideCompletion({ requiredCriteriaIds: [' '], verifiedCriteriaIds: [' '], pendingReconciliation: [] }))
      .toMatchObject({ status: 'incomplete', reason: 'missing-criteria-definition' })
  })
  it('completes only when every criterion is verified and nothing is unreconciled', () => {
    expect(decideCompletion({
      requiredCriteriaIds: ['saved', 'exported'],
      verifiedCriteriaIds: ['saved', 'exported'],
      pendingReconciliation: [],
    })).toEqual({ status: 'complete', verifiedCriteriaIds: ['saved', 'exported'] })
  })

  it('reports missing criteria', () => {
    expect(decideCompletion({
      requiredCriteriaIds: ['saved', 'exported'],
      verifiedCriteriaIds: ['saved'],
      pendingReconciliation: [],
    })).toEqual({
      status: 'incomplete',
      missingCriteriaIds: ['exported'],
      pendingReconciliation: [],
      reason: 'missing-criteria',
    })
  })

  it('refuses to complete while an effect is unreconciled, even if criteria look met', () => {
    const decision = decideCompletion({
      requiredCriteriaIds: ['saved'],
      verifiedCriteriaIds: ['saved'],
      pendingReconciliation: [asActionId('act-9')],
    })
    expect(decision.status).toBe('incomplete')
    expect(decision).toMatchObject({ reason: 'unreconciled-effects', pendingReconciliation: [asActionId('act-9')] })
  })

  it('requires parent reconciliation before a rerun', () => {
    expect(rerunRequiresReconciliation([])).toBe(false)
    expect(rerunRequiresReconciliation([asActionId('act-9')])).toBe(true)
  })
})
