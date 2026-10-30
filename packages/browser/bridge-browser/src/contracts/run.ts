/**
 * Run lifecycle: the states a browser task may occupy, and the controls that
 * are allowed to move it.
 *
 * The contract fixes the semantics of each state because two entry points
 * and a recovery path all read them: `stopped` must mean the executor has
 * confirmed no further dispatch (not "we asked"), `blocked` and `paused` are
 * resumable while terminal states are not, and a target change invalidates
 * queued actions without pretending earlier effects were undone.
 *
 * Modelling this as one transition table keeps the UI, the Host scheduler and
 * the recovery logic from inventing different rules. Anything not listed here
 * is a bug, not a judgement call.
 *
 * The Host run-record service and explicit execution scopes use these rules.
 * The panel exposes pause/stop for existing runs; task creation stays Host-only.
 *
 * @module
 */

import type { ActionId, ControlRevision } from './ids.ts'

/** Run states. `stopped`, `completed` and `failed` are terminal. */
export type RunState = 'queued' | 'running' | 'blocked' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'failed'

/** Controls a user or the Host can apply to a run. */
export type RunControl =
  | 'target_changed'
  | 'definition_changed'
  | 'pause'
  | 'resume'
  | 'takeover'
  | 'stop'
  | 'progress_query'
  | 'supplement'

/** States from which a run may resume rather than requiring a new run. */
const RESUMABLE: readonly RunState[] = ['blocked', 'paused']

/** States with no legal successor. */
const TERMINAL: readonly RunState[] = ['stopped', 'completed', 'failed']

const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['running', 'blocked', 'paused', 'stopped', 'failed'],
  running: ['blocked', 'paused', 'stopping', 'completed', 'failed'],
  blocked: ['running', 'paused', 'stopping', 'failed'],
  paused: ['running', 'stopping', 'failed'],
  stopping: ['stopped'],
  stopped: [],
  completed: [],
  failed: [],
}

/** Controls that change what the run is allowed to do, so they bump `controlRevision`. */
const BUMPING_CONTROLS: readonly RunControl[] = ['target_changed', 'definition_changed', 'pause', 'resume', 'takeover', 'stop']

/**
 * Is this state terminal (no further dispatch, no resume)?
 * @param state - run state.
 * @returns true for stopped/completed/failed.
 */
export function isTerminal(state: RunState): boolean {
  return TERMINAL.includes(state)
}

/**
 * May a user continue this run rather than start a new one?
 * @param state - run state.
 * @returns true for blocked/paused.
 */
export function mayContinue(state: RunState): boolean {
  return RESUMABLE.includes(state)
}

/**
 * May the Host dispatch new actions for this run?
 *
 * `stopping` is deliberately excluded: a stop request is pending and new
 * writes could race with the executor's acknowledgement.
 *
 * @param state - run state.
 * @returns true only while running.
 */
export function isDispatchAllowed(state: RunState): boolean {
  return state === 'running'
}

/**
 * Is this transition legal?
 * @param from - current state.
 * @param to - requested state.
 * @returns true when the transition is in the table.
 */
export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * Assert a legal transition.
 * @param from - current state.
 * @param to - requested state.
 * @throws RangeError when the transition is not allowed.
 */
export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new RangeError(`illegal run transition ${from} -> ${to}`)
}

/**
 * Does applying this control bump the run's control revision?
 *
 * A progress question does not change what the run may do, so it must not bump
 * the revision — bumping would invalidate queued actions and approved
 * authorizations for a question. `supplement` only adds
 * information; a target change is expressed as `target_changed`.
 *
 * @param control - control being applied.
 * @returns true when the revision must advance.
 */
export function bumpsControlRevision(control: RunControl): boolean {
  return BUMPING_CONTROLS.includes(control)
}

/**
 * Compute the control revision after a control is applied.
 * @param current - current revision.
 * @param control - control being applied.
 * @returns the same revision, or the next one.
 */
export function nextControlRevision(current: ControlRevision, control: RunControl): ControlRevision {
  return (bumpsControlRevision(control) ? current + 1 : current) as ControlRevision
}

/**
 * Gate one dispatch attempt against the run's current control revision.
 *
 * @param state - run state.
 * @param runRevision - authoritative revision of the run.
 * @param actionRevision - revision the action was authorized under.
 * @returns the gate decision, with a stable machine reason when refused.
 */
export function dispatchGate(
  state: RunState,
  runRevision: ControlRevision,
  actionRevision: ControlRevision,
): 'allowed' | 'not-dispatching' | 'stale-control-revision' {
  if (!isDispatchAllowed(state)) return 'not-dispatching'
  if (runRevision !== actionRevision) return 'stale-control-revision'
  return 'allowed'
}

/**
 * Apply a stop request.
 *
 * A queued run has nothing in flight, so it can stop immediately; anything
 * else enters `stopping` until the executor confirms. A run already stopping
 * or terminal is unchanged.
 *
 * @param state - current state.
 * @returns the state after requesting a stop.
 */
export function requestStop(state: RunState): RunState {
  if (isTerminal(state) || state === 'stopping') return state
  return state === 'queued' ? 'stopped' : 'stopping'
}

/**
 * Apply a pause request.
 * @param state - current state.
 * @returns the state after pausing; unchanged when pausing is not meaningful.
 */
export function requestPause(state: RunState): RunState {
  return state === 'running' || state === 'queued' ? 'paused' : state
}

/**
 * Apply a resume request to a blocked or paused run.
 * @param state - current state.
 * @returns the state after resuming; unchanged when the run is not resumable.
 */
export function requestResume(state: RunState): RunState {
  return mayContinue(state) ? 'running' : state
}

/** Required success criteria and the facts available for judging them. */
export interface CompletionInput {
  /** Criteria ids the task definition requires. */
  requiredCriteriaIds: readonly string[]
  /** Criteria ids the action facts claim to satisfy. */
  verifiedCriteriaIds: readonly string[]
  /** Actions whose effects are still unknown or unverified. */
  pendingReconciliation: readonly ActionId[]
}

/** Outcome of the run-level completion decision. */
export type CompletionDecision =
  | { status: 'complete'; verifiedCriteriaIds: readonly string[] }
  | {
    status: 'incomplete'
    missingCriteriaIds: readonly string[]
    pendingReconciliation: readonly ActionId[]
    reason: 'missing-criteria-definition' | 'missing-criteria' | 'unreconciled-effects'
  }

/**
 * Decide whether a run may be reported complete.
 *
 * Completeness is a run-level judgement, not a property of the last action: a
 * verified click does not finish the task, and an unreconciled write blocks
 * completion even when every criterion looks satisfied.
 *
 * @param input - required criteria and the facts known so far.
 * @returns the decision; `incomplete` always says why.
 */
export function decideCompletion(input: CompletionInput): CompletionDecision {
  const verified = new Set(input.verifiedCriteriaIds)
  const missing = input.requiredCriteriaIds.filter(id => !verified.has(id))
  if (input.pendingReconciliation.length > 0) {
    return {
      status: 'incomplete',
      missingCriteriaIds: missing,
      pendingReconciliation: input.pendingReconciliation,
      reason: 'unreconciled-effects',
    }
  }
  if (input.requiredCriteriaIds.length === 0 || input.requiredCriteriaIds.some(id => id.trim() === '')) {
    return {
      status: 'incomplete',
      missingCriteriaIds: missing,
      pendingReconciliation: [],
      reason: 'missing-criteria-definition',
    }
  }
  if (missing.length > 0) {
    return {
      status: 'incomplete',
      missingCriteriaIds: missing,
      pendingReconciliation: [],
      reason: 'missing-criteria',
    }
  }
  return { status: 'complete', verifiedCriteriaIds: [...verified] }
}

/**
 * Must a new run reconcile before it starts?
 *
 * A rerun after a terminal state is a new run with `parentRunId`; it may not
 * bypass the uncertain effects of its parent.
 *
 * @param pendingReconciliation - unresolved actions from the parent run.
 * @returns true when the parent must be reconciled first.
 */
export function rerunRequiresReconciliation(pendingReconciliation: readonly ActionId[]): boolean {
  return pendingReconciliation.length > 0
}
