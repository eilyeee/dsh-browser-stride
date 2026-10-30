/**
 * Durable browser-run records for trusted Host plugins. This service does not
 * dispatch tools or expose an RPC. Trusted Host execution scopes gate browser
 * dispatch against these records; business-success facts remain independent.
 * A storage root has one Host owner, as required by the DSH JSON domain backend.
 */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { canonicalize, asActionId, asObservationId, asControlRevision, asRunId, asSessionId, type RequestDigest, type RunId, type SessionId } from './contracts/ids.ts'
import { BROWSER_ERROR_CODES } from './contracts/errors.ts'
import { validateActionFact, summarizeActionFacts, type ActionFact } from './contracts/outcome.ts'
import { assertTransition, decideCompletion, dispatchGate, isTerminal, nextControlRevision, requestPause, requestResume, requestStop } from './contracts/run.ts'
import { BrowserDispatchLedger } from './dispatch-ledger.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { browserRuns: BrowserRunStore }
}

const id = z.string().min(1).max(200).refine(value => value.trim() === value)
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const revision = counter.transform(asControlRevision)
const criteria = z.array(id).min(1).max(128).refine(items => new Set(items).size === items.length)
const text = z.string().max(8192)
const factSchema = z.strictObject({
  actionId: id.transform(asActionId),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as RequestDigest),
  controlRevision: revision,
  dispatchState: z.enum(['not_sent', 'sent_unconfirmed', 'accepted', 'effect_started']),
  outcome: z.enum(['verified', 'failed', 'uncertain', 'cancelled']),
  beforeObservationId: id.transform(asObservationId).optional(),
  afterObservationId: id.transform(asObservationId).optional(),
  verifiedCriteriaIds: z.array(id).max(128).optional(),
  evidence: z.strictObject({
    url: text.optional(),
    fieldValues: z.record(id, text).optional(),
    observedText: z.array(text).max(128).optional(),
    artifactRefs: z.array(text).max(128).optional(),
  }).optional(),
  error: z.strictObject({
    code: z.enum(BROWSER_ERROR_CODES), message: text,
    nextStep: z.enum(['reobserve', 'focus_window', 'reselect_instance', 'request_permission', 'repair_arguments', 'wait_for_page', 'release_debugger', 'upgrade_runtime', 'reconnect', 'reconcile_business_state', 'none']),
    retryable: z.boolean(), blocksWrites: z.boolean(), sideEffectUnknown: z.boolean().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  for (const message of validateActionFact(value as ActionFact)) ctx.addIssue({ code: 'custom', message })
}).transform(value => value as ActionFact)

const runSchema = z.strictObject({
  runId: id.transform(asRunId), sessionId: id.transform(asSessionId),
  parentRunId: id.transform(asRunId).optional(),
  state: z.enum(['queued', 'running', 'blocked', 'paused', 'stopping', 'stopped', 'completed', 'failed']),
  controlRevision: revision,
  version: counter,
  createdAt: counter, updatedAt: counter,
  requiredCriteriaIds: criteria,
  recoveryRequired: z.boolean(),
  facts: z.array(factSchema).max(256),
}).superRefine((run, ctx) => {
  if (run.updatedAt < run.createdAt) ctx.addIssue({ code: 'custom', message: 'invalid timestamps' })
  if (new Set(run.facts.map(fact => fact.actionId)).size !== run.facts.length) ctx.addIssue({ code: 'custom', message: 'duplicate action id' })
  if (run.facts.some(fact => fact.controlRevision > run.controlRevision)) ctx.addIssue({ code: 'custom', message: 'future action revision' })
  if (run.state === 'completed' && (run.recoveryRequired || decideCompletion({
    requiredCriteriaIds: run.requiredCriteriaIds, ...summarizeActionFacts(run.facts),
  }).status !== 'complete')) ctx.addIssue({ code: 'custom', message: 'unverified completion' })
})

/** Version is a compare-and-swap record version; controlRevision is authority. */
export type BrowserRunRecord = z.infer<typeof runSchema>

/** Host-owned metadata; never accepted from a page, model argument or RPC. */
export interface BrowserRunExecution {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly controlRevision: number
  readonly signal: AbortSignal
}
interface ExecutionContext {
  owner: BrowserRunStore
  execution: BrowserRunExecution
  controller: AbortController
  active: boolean
}
// Keep the async boundary across plugin reloads. A callback from a disposed
// owner must be rejected by its successor, never fall back to legacy dispatch.
const executionKey = Symbol.for('dsh-stride.browser-run-execution.v1')
const hostGlobals = globalThis as typeof globalThis & { [key: symbol]: unknown }
if (hostGlobals[executionKey] === undefined) Object.defineProperty(hostGlobals, executionKey, { value: new AsyncLocalStorage<ExecutionContext>() })
if (!(hostGlobals[executionKey] instanceof AsyncLocalStorage)) throw new TypeError('invalid browser execution context owner')
const executionContext = hostGlobals[executionKey] as AsyncLocalStorage<ExecutionContext>

function specFor(profile: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new TypeError('invalid browser run profile')
  // Encode instead of lowercasing/replacing: distinct profile names must not
  // collide, and DSH unit names allow only lowercase letters/digits/underscores.
  return defineDomain({ name: `browser_runs_${Buffer.from(profile).toString('hex')}`, version: 1, tables: { runs: domainTable(runSchema) } })
}
type RunDomain = Domain<ReturnType<typeof specFor>>

/** Stable failures contain no page content, arguments or credentials. */
export class BrowserRunStoreError extends Error {
  constructor(readonly code: 'not-found' | 'stale-version' | 'session-busy' | 'reconciliation-required' | 'action-conflict' | 'invalid-state' | 'storage-unavailable' | 'closed'
    | 'execution-context-required' | 'execution-context-expired' | 'execution-session-mismatch' | 'not-dispatching' | 'stale-control-revision') {
    super(`browser run store: ${code}`)
    this.name = 'BrowserRunStoreError'
  }
}

function snapshot<T>(value: T): T { return structuredClone(value) }

/** Durable lifecycle/facts plus explicit Host scopes; stored state alone grants no dispatch. */
export class BrowserRunStore {
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  private writeFaulted = false
  private disposal: Promise<void> | undefined
  private readonly executions = new Set<ExecutionContext>()
  private constructor(private readonly domain: RunDomain, readonly dispatches: BrowserDispatchLedger) {}

  static async open(facility: Pick<DomainFacility, 'open'>, profile: string): Promise<BrowserRunStore> {
    const domain = await facility.open(specFor(profile))
    let dispatches: BrowserDispatchLedger | undefined
    try {
      dispatches = await BrowserDispatchLedger.open(facility, profile)
      const store = new BrowserRunStore(domain, dispatches)
      const records = [...domain.table('runs').entries()]
      for (const [key, run] of records) {
        if (key !== run.runId) throw new TypeError('browser run key mismatch')
        const seen = new Set([run.runId])
        let parentId = run.parentRunId
        while (parentId !== undefined) {
          const parent = domain.table('runs').get(parentId)
          if (parent === undefined || parent.sessionId !== run.sessionId || !isTerminal(parent.state) || seen.has(parentId)) throw new TypeError('invalid browser run parent')
          seen.add(parentId)
          parentId = parent.parentRunId
        }
      }
      for (const [, run] of records) {
        // Persist a fence before publishing the service. A previous Host's
        // execution context cannot survive a restart, even without a final fact.
        if (!isTerminal(run.state) && run.state !== 'queued') {
          await store.save({ ...run, state: run.state === 'running' ? 'blocked' : run.state,
            recoveryRequired: true, controlRevision: asControlRevision(run.controlRevision + 1) })
        }
      }
      return store
    } catch (error) { await dispatches?.close(); await domain.close(); throw error }
  }

  get(runId: RunId): BrowserRunRecord | undefined {
    this.assertOpen()
    const run = this.domain.table('runs').get(runId)
    return run === undefined ? undefined : snapshot(run)
  }

  list(sessionId?: SessionId): BrowserRunRecord[] {
    this.assertOpen()
    return [...this.domain.table('runs').entries()].map(([, run]) => run)
      .filter(run => sessionId === undefined || run.sessionId === sessionId).map(snapshot)
  }

  /** Await all work inside this trusted scope; detached children lose authority. */
  async withExecution<T>(runId: RunId, controlRevision: number, work: () => T | Promise<T>): Promise<T> {
    const run = this.executionRun(runId, controlRevision, 'all')
    const controller = new AbortController()
    const context: ExecutionContext = { owner: this, controller, active: true,
      execution: Object.freeze({ runId: run.runId, sessionId: run.sessionId, controlRevision, signal: controller.signal }) }
    this.executions.add(context)
    try { return await executionContext.run(context, work) }
    finally {
      context.active = false
      this.executions.delete(context)
      controller.abort(new BrowserRunStoreError('execution-context-expired'))
    }
  }

  /** Resolve the calling async chain, not the latest run belonging to a session. */
  executionFor(sessionId?: string): BrowserRunExecution | undefined {
    this.assertOpen()
    if (this.writeFaulted) throw new BrowserRunStoreError('storage-unavailable')
    const context = executionContext.getStore()
    if (context !== undefined) {
      if (context.owner !== this || !context.active || context.controller.signal.aborted) throw new BrowserRunStoreError('execution-context-expired')
      const execution = context.execution
      try { this.executionRun(execution.runId, execution.controlRevision) }
      catch (error) { context.controller.abort(error); throw error }
      if (sessionId !== undefined && execution.sessionId !== sessionId) throw new BrowserRunStoreError('execution-session-mismatch')
      return execution
    }
    for (const [, run] of this.domain.table('runs').entries()) {
      if (sessionId !== undefined && sessionId !== run.sessionId) continue
      this.assertTransportReconciled(run.sessionId, 'managed')
      if (run.recoveryRequired || summarizeActionFacts(run.facts).pendingReconciliation.length > 0) throw new BrowserRunStoreError('reconciliation-required')
      if (!isTerminal(run.state) && run.state !== 'queued') throw new BrowserRunStoreError('execution-context-required')
    }
    return undefined
  }

  private executionRun(runId: RunId, controlRevision: number, pending: 'all' | 'managed' | 'none' = 'none'): BrowserRunRecord {
    this.assertOpen()
    if (this.writeFaulted) throw new BrowserRunStoreError('storage-unavailable')
    const run = this.require(runId)
    this.assertReconciled(run, pending)
    this.assertSessionAvailable(run)
    const decision = dispatchGate(run.state, run.controlRevision, asControlRevision(controlRevision))
    if (decision !== 'allowed') throw new BrowserRunStoreError(decision)
    return run
  }

  private invalidateExecutions(): void {
    for (const context of [...this.executions]) {
      try { this.executionRun(context.execution.runId, context.execution.controlRevision) }
      catch (error) { context.controller.abort(error) }
    }
  }

  create(input: { sessionId: SessionId; requiredCriteriaIds: readonly string[]; parentRunId?: RunId }): Promise<BrowserRunRecord> {
    // Copy before queueing: callers must not mutate queued authority material.
    const parsed = z.strictObject({ sessionId: id.transform(asSessionId), requiredCriteriaIds: criteria,
      parentRunId: id.transform(asRunId).optional() }).parse(JSON.parse(canonicalize(input)))
    return this.exclusive(async () => {
      if (parsed.parentRunId !== undefined) {
        const parent = this.require(parsed.parentRunId)
        if (parent.sessionId !== parsed.sessionId || !isTerminal(parent.state)) throw new BrowserRunStoreError('invalid-state')
        this.assertReconciled(parent)
      }
      const now = Date.now()
      const run = runSchema.parse({ ...parsed, runId: `run_${randomUUID()}`, state: 'queued',
        controlRevision: 0, version: 0, createdAt: now, updatedAt: now, recoveryRequired: false, facts: [] })
      await this.persist(run)
      return snapshot(run)
    })
  }

  /** Executor reports state only; user pause/resume/stop use control(). */
  transition(runId: RunId, expectedVersion: number, state: 'running' | 'blocked' | 'stopped' | 'completed' | 'failed'): Promise<BrowserRunRecord> {
    return this.exclusive(async () => {
      const run = this.current(runId, expectedVersion)
      assertTransition(run.state, state)
      if ((state === 'running' && run.state !== 'queued') || (state === 'stopped' && run.state !== 'stopping')) throw new BrowserRunStoreError('invalid-state')
      if (state === 'running') { this.assertReconciled(run); this.assertSessionAvailable(run) }
      if (state === 'completed') {
        this.assertReconciled(run)
        if (decideCompletion({ requiredCriteriaIds: run.requiredCriteriaIds, ...summarizeActionFacts(run.facts) }).status !== 'complete') throw new BrowserRunStoreError('invalid-state')
      }
      return this.save({ ...run, state })
    })
  }

  control(runId: RunId, expectedVersion: number, control: 'pause' | 'resume' | 'stop'): Promise<BrowserRunRecord> {
    z.enum(['pause', 'resume', 'stop']).parse(control)
    return this.exclusive(async () => {
      const run = this.current(runId, expectedVersion)
      const state = control === 'pause' ? requestPause(run.state) : control === 'resume' ? requestResume(run.state) : requestStop(run.state)
      if (state === run.state) return snapshot(run)
      if (state === 'running') { this.assertReconciled(run); this.assertSessionAvailable(run) }
      return this.save({ ...run, state, controlRevision: asControlRevision(nextControlRevision(run.controlRevision, control)) })
    })
  }

  /** Trusted Host facts only. Tool text must never be converted to verified. */
  recordFact(runId: RunId, expectedVersion: number, fact: ActionFact): Promise<BrowserRunRecord> {
    const parsed = factSchema.parse(JSON.parse(canonicalize(fact)))
    return this.exclusive(async () => {
      const run = this.current(runId, expectedVersion)
      const existing = run.facts.find(item => item.actionId === parsed.actionId)
      if (existing !== undefined) {
        if (canonicalize(existing) !== canonicalize(parsed)) throw new BrowserRunStoreError('action-conflict')
        return snapshot(run)
      }
      // Late outcomes after stopping/failure remain evidence. They do not
      // reopen the run or authorize further dispatch.
      if (run.state === 'queued' || run.state === 'completed' || parsed.controlRevision > run.controlRevision) throw new BrowserRunStoreError('invalid-state')
      return this.save({ ...run, facts: [...run.facts, parsed] })
    })
  }

  /** Serialize deletion with run controls; pausing does not release ownership. */
  purgeSession(sessionId: string, purgeStorage: () => Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      if ([...this.domain.table('runs').entries()].some(([, run]) => run.sessionId === sessionId && !isTerminal(run.state))) {
        throw new BrowserRunStoreError('session-busy')
      }
      await this.dispatches.purgeSession(sessionId, purgeStorage)
    })
  }

  close(): Promise<void> {
    this.closing = true
    for (const context of this.executions) context.controller.abort(new BrowserRunStoreError('closed'))
    return this.disposal ??= this.tail.then(async () => {
      try { await this.dispatches.close() } finally { await this.domain.close() }
    })
  }

  private assertOpen(): void { if (this.closing) throw new BrowserRunStoreError('closed') }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const result = this.tail.then(() => {
      if (this.writeFaulted) throw new BrowserRunStoreError('storage-unavailable')
      return work()
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
  private require(runId: RunId): BrowserRunRecord {
    const run = this.domain.table('runs').get(runId)
    if (run === undefined) throw new BrowserRunStoreError('not-found')
    return run
  }
  private current(runId: RunId, expectedVersion: number): BrowserRunRecord {
    const run = this.require(runId)
    if (!Number.isSafeInteger(expectedVersion) || run.version !== expectedVersion) throw new BrowserRunStoreError('stale-version')
    return run
  }
  private assertSessionAvailable(run: BrowserRunRecord): void {
    const others = [...this.domain.table('runs').entries()].map(([, other]) => other)
      .filter(other => other.runId !== run.runId && other.sessionId === run.sessionId)
    if (others.some(other => other.recoveryRequired || summarizeActionFacts(other.facts).pendingReconciliation.length > 0)) throw new BrowserRunStoreError('reconciliation-required')
    if (others.some(other => other.state === 'running' || other.state === 'stopping')) throw new BrowserRunStoreError('session-busy')
  }
  private assertReconciled(run: BrowserRunRecord, pending: 'all' | 'managed' | 'none' = 'all'): void {
    this.assertTransportReconciled(run.sessionId, pending)
    let current: BrowserRunRecord | undefined = run
    while (current !== undefined) {
      if (current.recoveryRequired || summarizeActionFacts(current.facts).pendingReconciliation.length > 0) throw new BrowserRunStoreError('reconciliation-required')
      current = current.parentRunId === undefined ? undefined : this.require(current.parentRunId)
    }
  }
  private assertTransportReconciled(sessionId: SessionId, pending: 'all' | 'managed' | 'none'): void {
    const unsettled = this.dispatches.list(sessionId).some(row => row.effect === 'write' && (
      row.state === 'unresolved' || (row.state === 'returned' && row.receipt?.ok === false)
      || ((row.state === 'prepared' || row.state === 'sent_unconfirmed') && (pending === 'all' || (pending === 'managed' && row.runId !== undefined)))
    ))
    if (unsettled) throw new BrowserRunStoreError('reconciliation-required')
  }
  private async save(run: BrowserRunRecord): Promise<BrowserRunRecord> {
    const next = runSchema.parse({ ...run, version: run.version + 1, updatedAt: Math.max(Date.now(), run.updatedAt) })
    await this.persist(next)
    return snapshot(next)
  }
  private async persist(run: BrowserRunRecord): Promise<void> {
    try {
      await this.domain.table('runs').put(run.runId, run)
      this.invalidateExecutions()
    }
    catch (error) {
      // A backend error can leave the commit point unknown (e.g. rename
      // succeeded but directory fsync failed). Reopen and validate disk before
      // allowing another write; never overwrite it from a possibly stale cache.
      this.writeFaulted = true
      this.invalidateExecutions()
      throw error
    }
  }
}
