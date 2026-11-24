/** One-use native review offers. No model verdict or receipt becomes business proof. */
import { createHash, randomUUID } from 'node:crypto'
import { canonicalize, asSessionId } from './contracts/ids.ts'
import { requiresDispatchReview } from './dispatch-ledger.ts'
import { RECOVERY_OFFER_LIMIT, recoveryWriteLabel } from './recovery-context.ts'
import { BrowserRunStoreError, summarizeReviewedFacts, type BrowserRunStore, type BrowserRunRecord } from './run-store.ts'
import { recoveryDecisionsSchema, recoveryOfferSchema, type RecoveryOffer, type RecoveryDecisions, type RecoveryStatus } from './native-review.ts'

export type RecoveryStore = Pick<BrowserRunStore, 'list' | 'dispatches' | 'assertObservationAuthority' | 'reviewSession'>
export class NativeRecoveryError extends Error {
  constructor(readonly code: 'review-unavailable' | 'review-busy' | 'review-read-required' | 'review-read-denied' | 'review-read-failed' | 'review-stale' | 'review-too-large') { super(code) }
}
interface Snapshot {
  signature: string; observationRequestId: string; offerItems: RecoveryOffer['items']
  runs: BrowserRunRecord[]; writes: ReturnType<BrowserRunStore['dispatches']['list']>
}
interface Offer { owner: object; connectionId: string; offer: RecoveryOffer; snapshot: Snapshot; partial: boolean }
export class NativeRecovery {
  private offers = new Map<string, Offer>()
  constructor(private store: RecoveryStore, private idle: (sessionId: string) => boolean) {}
  private pending(sessionId: string) {
    const runs = this.store.list(asSessionId(sessionId))
    const all = this.store.dispatches.list(sessionId)
    const writes = all.filter(requiresDispatchReview)
    const items: RecoveryOffer['items'] = writes.map(row => ({ key: `w:${row.requestId}`, kind: 'write', label: recoveryWriteLabel(row) }))
    for (const run of runs) {
      for (const actionId of summarizeReviewedFacts(run).pendingReconciliation) items.push({ key: `f:${run.runId}:${actionId}`, kind: 'fact', label: actionId })
      if (run.recoveryRequired) items.push({ key: `r:${run.runId}`, kind: 'recovery', label: run.runId })
    }
    return { runs, all, writes, items }
  }
  status(sessionId: string): RecoveryStatus {
    return { pending: this.pending(sessionId).items.length }
  }
  private assertIdle(sessionId: string, { runs, all }: ReturnType<NativeRecovery['pending']>): void {
    if (!this.idle(sessionId) || runs.some(run => run.state === 'running' || run.state === 'stopping')
      || all.some(row => row.effect === 'write' && (row.state === 'prepared' || row.state === 'sent_unconfirmed'))) throw new NativeRecoveryError('review-busy')
  }
  assertCanInspect(sessionId: string): void {
    try { this.store.assertObservationAuthority(undefined, sessionId) }
    catch (error) {
      if (error instanceof BrowserRunStoreError && error.code === 'session-busy') throw new NativeRecoveryError('review-busy')
      throw error
    }
    this.assertIdle(sessionId, this.pending(sessionId))
  }
  private snapshot(sessionId: string, connectionId: string, partial: boolean): Snapshot {
    const pending = this.pending(sessionId)
    this.assertIdle(sessionId, pending)
    const { runs, all, writes, items } = pending
    if (!partial && items.length > RECOVERY_OFFER_LIMIT) throw new NativeRecoveryError('review-too-large')
    const changedAt = Math.max(0, ...writes.map(row => row.settledAt ?? row.preparedAt), ...runs.map(run => run.updatedAt))
    const observation = all.filter(row => row.connectionId === connectionId && ['browser_snapshot', 'browser_get_text'].includes(row.name)
      && row.state === 'returned' && row.receipt?.ok === true && row.preparedAt > changedAt
      && row.settledAt !== undefined && row.settledAt >= Date.now() - 300_000).sort((a, b) => b.settledAt! - a.settledAt!)[0]
    if (items.length > 0 && observation === undefined) throw new NativeRecoveryError('review-read-required')
    const observationRequestId = observation?.requestId ?? 'none'
    const material = { observationRequestId, runs: runs.map(run => ({ id: run.runId, version: run.version })).sort((a, b) => a.id.localeCompare(b.id)),
      writes: writes.map(row => ({ id: row.requestId, digest: row.requestDigest, name: row.name, preparedAt: row.preparedAt,
        settledAt: row.settledAt ?? null, state: row.state, receipt: row.receipt ?? null, nativeReview: row.nativeReview ?? null, invalidated: row.nativeReviewInvalidated ?? null })) }
    return { signature: createHash('sha256').update(canonicalize(material)).digest('hex'), observationRequestId, offerItems: items.slice(0, RECOVERY_OFFER_LIMIT), runs, writes }
  }
  prepare(sessionId: string, connectionId: string, owner: object, partial = false): RecoveryOffer {
    this.store.assertObservationAuthority(undefined, sessionId)
    this.offers.delete(sessionId)
    const snapshot = this.snapshot(sessionId, connectionId, partial)
    const offer = recoveryOfferSchema.parse({ reviewId: `review_${randomUUID()}`, expiresAt: Date.now() + 300_000,
      observationRequestId: snapshot.observationRequestId, items: snapshot.offerItems })
    for (const [key, value] of this.offers) if (value.offer.expiresAt < Date.now() || value.owner !== owner) this.offers.delete(key)
    if (this.offers.size >= 128 && !this.offers.has(sessionId)) throw new NativeRecoveryError('review-unavailable')
    if (offer.items.length > 0) this.offers.set(sessionId, { owner, connectionId, offer, snapshot, partial })
    return structuredClone(offer)
  }
  async confirm(sessionId: string, reviewId: string, values: RecoveryDecisions, connectionId: string, owner: object, signal: AbortSignal): Promise<void> {
    const permit = this.offers.get(sessionId)
    if (permit === undefined || permit.owner !== owner || permit.connectionId !== connectionId || permit.offer.reviewId !== reviewId
      || permit.offer.expiresAt <= Date.now() || signal.aborted) throw new NativeRecoveryError('review-stale')
    // Consume even a refused/uncertain commit. The caller must refresh and review anew.
    this.offers.delete(sessionId)
    const decisions = recoveryDecisionsSchema.parse(values)
    const chosen = new Map(decisions.map(item => [item.key, item.decision]))
    const offered = new Map(permit.offer.items.map(item => [item.key, item.kind]))
    if (chosen.size === 0 || chosen.size !== decisions.length || !permit.partial && chosen.size !== offered.size
      || decisions.some(({ key, decision }) => !offered.has(key) || (offered.get(key) === 'recovery') !== (decision === 'checked'))) throw new NativeRecoveryError('review-stale')

    const snapshot = permit.snapshot
    const writes = snapshot.writes.flatMap(row => {
      const decision = chosen.get(`w:${row.requestId}`)
      return decision === 'applied' || decision === 'not-applied' ? [{ requestId: row.requestId, digest: row.requestDigest, decision }] : []
    })
    const reviewedRuns = new Set(snapshot.writes.filter(row => chosen.has(`w:${row.requestId}`)).map(row => row.runId))
    const runs = snapshot.runs.flatMap(run => {
      const acknowledgeRecovery = chosen.get(`r:${run.runId}`) === 'checked'
      const facts = summarizeReviewedFacts(run).pendingReconciliation.flatMap(actionId => {
        const decision = chosen.get(`f:${run.runId}:${actionId}`)
        return decision === 'applied' || decision === 'not-applied' ? [{ actionId, decision }] : []
      })
      return acknowledgeRecovery || facts.length > 0 || reviewedRuns.has(run.runId)
        ? [{ runId: run.runId, expectedVersion: run.version, acknowledgeRecovery, facts }] : []
    })
    await this.store.reviewSession({ sessionId,
      review: { source: 'native-user', reviewId, observationRequestId: snapshot.observationRequestId, reviewedAt: Date.now() }, writes,
      runs,
    }, () => {
      if (signal.aborted || permit.offer.expiresAt <= Date.now() || this.snapshot(sessionId, connectionId, permit.partial).signature !== snapshot.signature) throw new NativeRecoveryError('review-stale')
    }, signal)
  }
}
