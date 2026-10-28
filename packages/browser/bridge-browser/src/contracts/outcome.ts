/**
 * Action facts: the durable, checkable record of what one action did.
 *
 * The contract separates three things that a tool result usually conflates:
 * how far the action got (`DispatchState`), what happened (`ActionOutcome`) and
 * whether the task is done (a run-level decision, see `./run.ts`). Keeping them
 * apart is what makes "the click was accepted but the save failed", "we never
 * sent it", and "we do not know" distinguishable after a crash — and therefore
 * what makes recovery honest instead of optimistic.
 *
 * The invariants below are:
 * `verified` needs recorded criteria and evidence, `cancelled` requires proof
 * that no side effect started, and an accepted action is not a success.
 *
 * These rules are not yet wired into the runtime.
 *
 * @module
 */

import type { ActionId, ControlRevision, ObservationId, RequestDigest } from './ids.ts'
import type { BrowserError } from './errors.ts'

/** Final classification of one action. */
export type ActionOutcome = 'verified' | 'failed' | 'uncertain' | 'cancelled'

/** How far an action got, independent of its outcome. */
export type DispatchState = 'not_sent' | 'sent_unconfirmed' | 'accepted' | 'effect_started'

/** Evidence that supports (or contradicts) a claimed outcome. */
export interface ActionEvidence {
  /** URL the evidence was read from. */
  url?: string
  /** Read-back form field values, keyed by field name. */
  fieldValues?: Readonly<Record<string, string>>
  /** Short observed text excerpts, e.g. a confirmation banner. */
  observedText?: readonly string[]
  /** Host artifact references: screenshots, downloaded files, structured results. */
  artifactRefs?: readonly string[]
}

/** One immutable action fact as recorded by the Host. */
export interface ActionFact {
  /** Logical action id, minted by the Host. */
  actionId: ActionId
  /** Digest binding target, arguments, pre-observation and control revision. */
  requestDigest: RequestDigest
  /** Control revision the action was authorized under. */
  controlRevision: ControlRevision
  /** How far the action got. */
  dispatchState: DispatchState
  /** What happened. */
  outcome: ActionOutcome
  /** Observation the action was planned from, when one was required. */
  beforeObservationId?: ObservationId
  /** Observation taken after the action, when one was taken. */
  afterObservationId?: ObservationId
  /** Criteria ids this action is claimed to satisfy; required for `verified`. */
  verifiedCriteriaIds?: readonly string[]
  /** Evidence supporting the outcome. */
  evidence?: ActionEvidence
  /** Failure detail; required for `failed`. */
  error?: BrowserError
}

/** Why an action fact is not admissible. */
export type ActionFactViolation =
  | 'verified-without-criteria'
  | 'empty-criteria-id'
  | 'verified-without-evidence'
  | 'verified-with-error'
  | 'criteria-on-non-verified'
  | 'verified-without-dispatch'
  | 'verified-unconfirmed-dispatch'
  | 'cancelled-after-dispatch'
  | 'failed-without-error'

/** Thrown by `assertActionFact` when a store boundary receives an inadmissible fact. */
export class ActionFactInvariantError extends Error {
  /** The violated invariants. */
  readonly violations: readonly ActionFactViolation[]

  /**
   * @param violations - the invariants that failed.
   */
  constructor(violations: readonly ActionFactViolation[]) {
    super(`inadmissible action fact: ${violations.join(', ')}`)
    this.name = 'ActionFactInvariantError'
    this.violations = violations
  }
}

/**
 * Check the invariants a recorded action fact must satisfy.
 *
 * @param fact - candidate fact.
 * @returns violations, empty when the fact may be persisted.
 */
export function validateActionFact(fact: ActionFact): ActionFactViolation[] {
  const violations: ActionFactViolation[] = []
  const criteria = fact.verifiedCriteriaIds ?? []
  if (fact.outcome === 'verified') {
    if (criteria.length === 0) violations.push('verified-without-criteria')
    if (!hasEvidence(fact.evidence)) violations.push('verified-without-evidence')
    if (fact.error !== undefined) violations.push('verified-with-error')
    if (fact.dispatchState === 'not_sent') violations.push('verified-without-dispatch')
    if (fact.dispatchState === 'sent_unconfirmed') violations.push('verified-unconfirmed-dispatch')
  } else if (criteria.length > 0) {
    violations.push('criteria-on-non-verified')
  }
  if (criteria.some(id => id.trim() === '')) violations.push('empty-criteria-id')
  if (fact.outcome === 'cancelled' && fact.dispatchState !== 'not_sent') {
    violations.push('cancelled-after-dispatch')
  }
  if (fact.outcome === 'failed' && fact.error === undefined) violations.push('failed-without-error')
  return violations
}

/**
 * Persist-boundary assertion.
 * @param fact - candidate fact.
 * @throws ActionFactInvariantError when any invariant fails.
 */
export function assertActionFact(fact: ActionFact): void {
  const violations = validateActionFact(fact)
  if (violations.length > 0) throw new ActionFactInvariantError(violations)
}

/**
 * Does this evidence contain anything a reviewer could check?
 * @param evidence - candidate evidence.
 * @returns true when at least one member carries a value.
 */
export function hasEvidence(evidence: ActionEvidence | undefined): boolean {
  if (evidence === undefined) return false
  // A URL identifies where to look, but does not by itself establish that a
  // business condition was met. The Host must still check evidence against the
  // task's criteria; this is only a structural guard.
  if (Object.keys(evidence.fieldValues ?? {}).some(key => key.trim() !== '')) return true
  if ((evidence.observedText ?? []).some(text => text.trim() !== '')) return true
  if ((evidence.artifactRefs ?? []).some(ref => ref.trim() !== '')) return true
  return false
}

/**
 * Could a side effect have happened at this dispatch state?
 *
 * The distinction matters after a crash: `not_sent` permits re-dispatch,
 * everything else requires reconciliation first.
 *
 * @param dispatchState - recorded dispatch state.
 * @returns true when side effects are possible.
 */
export function isSideEffectPossible(dispatchState: DispatchState): boolean {
  return dispatchState !== 'not_sent'
}

/**
 * Classify a same-id request against a recorded fact.
 *
 * A transport retry reuses the action id and digest, so it is a duplicate.
 * The same id with a different digest means either a parameter change or a
 * forged/replayed request and must be rejected.
 *
 * @param recorded - the fact already stored.
 * @param incomingDigest - digest arriving with the incoming request.
 * @returns `duplicate` for a retransmission, `conflict` otherwise.
 */
export function classifyRetransmission(
  recorded: Pick<ActionFact, 'requestDigest'>,
  incomingDigest: RequestDigest,
): 'duplicate' | 'conflict' {
  return recorded.requestDigest === incomingDigest ? 'duplicate' : 'conflict'
}

/**
 * Does this action still require reconciliation before the run may continue?
 *
 * True for explicitly uncertain actions and for any dispatched action that did
 * not end verified. A `failed` action is included because failure text does not
 * prove the write was rolled back.
 *
 * @param fact - recorded fact.
 * @returns true when business state must be checked before proceeding.
 */
export function needsReconciliation(fact: ActionFact): boolean {
  if (fact.outcome === 'verified') return false
  return fact.outcome === 'uncertain' || isSideEffectPossible(fact.dispatchState)
}

/**
 * Aggregate action facts for a run summary and for completion decisions.
 *
 * @param facts - recorded facts, in any order.
 * @returns counts, unresolved action ids and the criteria claimed so far.
 */
export function summarizeActionFacts(facts: readonly ActionFact[]): {
  verified: number
  failed: number
  uncertain: number
  cancelled: number
  pendingReconciliation: readonly ActionId[]
  verifiedCriteriaIds: readonly string[]
} {
  const pending: ActionId[] = []
  const criteria = new Set<string>()
  let verified = 0
  let failed = 0
  let uncertain = 0
  let cancelled = 0
  for (const fact of facts) {
    switch (fact.outcome) {
      case 'verified':
        verified += 1
        for (const id of fact.verifiedCriteriaIds ?? []) criteria.add(id)
        break
      case 'failed':
        failed += 1
        break
      case 'uncertain':
        uncertain += 1
        break
      case 'cancelled':
        cancelled += 1
        break
    }
    if (needsReconciliation(fact)) pending.push(fact.actionId)
  }
  return {
    verified,
    failed,
    uncertain,
    cancelled,
    pendingReconciliation: pending,
    verifiedCriteriaIds: [...criteria],
  }
}
