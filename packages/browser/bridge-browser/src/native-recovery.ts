/** One-use native review offers. No model verdict or receipt becomes business proof. */
import { createHash, randomUUID } from 'node:crypto'
import { canonicalize, asSessionId } from './contracts/ids.ts'
import { requiresDispatchReview } from './dispatch-ledger.ts'
import { recoveryWriteLabel } from './recovery-context.ts'
import { summarizeReviewedFacts, type BrowserRunStore, type BrowserRunRecord } from './run-store.ts'
import { recoveryDecisionsSchema, recoveryOfferSchema, type RecoveryOffer, type RecoveryDecisions } from './native-review.ts'

export type RecoveryStore = Pick<BrowserRunStore, 'list' | 'dispatches' | 'assertObservationAuthority' | 'reviewSession'>
export class NativeRecoveryError extends Error {
  constructor(readonly code: 'review-unavailable' | 'review-busy' | 'review-read-required' | 'review-stale' | 'review-too-large') { super(code) }
}
interface Snapshot {
  signature: string; observationRequestId: string; offerItems: RecoveryOffer['items']
  runs: BrowserRunRecord[]; writes: ReturnType<BrowserRunStore['dispatches']['list']>
}
interface Offer { sessionId: string; owner: object; connectionId: string; offer: RecoveryOffer; snapshot: Snapshot }
export class NativeRecovery {
  private offers = new Map<string, Offer>()
  constructor(private store: RecoveryStore, private idle: (sessionId: string) => boolean) {}
  private snapshot(sessionId: string, connectionId: string): Snapshot {
    if (!this.idle(sessionId)) throw new NativeRecoveryError('review-busy')
    const runs = this.store.list(asSessionId(sessionId))
    if (runs.some(run => run.state === 'running' || run.state === 'stopping')) throw new NativeRecoveryError('review-busy')
    const all = this.store.dispatches.list(sessionId)
    if (all.some(row => row.effect === 'write' && (row.state === 'prepared' || row.state === 'sent_unconfirmed'))) throw new NativeRecoveryError('review-busy')
    const writes = all.filter(requiresDispatchReview)
    const items: RecoveryOffer['items'] = writes.map(row => ({ key: `w:${row.requestId}`, kind: 'write', label: recoveryWriteLabel(row) }))
    for (const run of runs) {
      for (const actionId of summarizeReviewedFacts(run).pendingReconciliation) items.push({ key: `f:${run.runId}:${actionId}`, kind: 'fact', label: actionId })
      if (run.recoveryRequired) items.push({ key: `r:${run.runId}`, kind: 'recovery', label: run.runId })
    }
    if (items.length > 64) throw new NativeRecoveryError('review-too-large')
    const changedAt = Math.max(0, ...writes.map(row => row.settledAt ?? row.preparedAt), ...runs.map(run => run.updatedAt))
    const observation = all.filter(row => row.connectionId === connectionId && ['browser_snapshot', 'browser_get_text'].includes(row.name)
      && row.state === 'returned' && row.receipt?.ok === true && row.preparedAt > changedAt
      && row.settledAt !== undefined && row.settledAt >= Date.now() - 300_000).sort((a, b) => b.settledAt! - a.settledAt!)[0]
    if (items.length > 0 && observation === undefined) throw new NativeRecoveryError('review-read-required')
    const observationRequestId = observation?.requestId ?? 'none'
    const material = { observationRequestId, runs: runs.map(run => ({ id: run.runId, version: run.version })).sort((a, b) => a.id.localeCompare(b.id)),
      writes: writes.map(row => ({ id: row.requestId, digest: row.requestDigest, name: row.name, preparedAt: row.preparedAt,
        settledAt: row.settledAt ?? null, state: row.state, receipt: row.receipt ?? null, nativeReview: row.nativeReview ?? null, invalidated: row.nativeReviewInvalidated ?? null })) }
    return { signature: createHash('sha256').update(canonicalize(material)).digest('hex'), observationRequestId, offerItems: items, runs, writes }
  }
  prepare(sessionId: string, connectionId: string, owner: object): RecoveryOffer {
    this.store.assertObservationAuthority(undefined, sessionId)
    this.offers.delete(sessionId)
    const snapshot = this.snapshot(sessionId, connectionId)
    const offer = recoveryOfferSchema.parse({ reviewId: `review_${randomUUID()}`, expiresAt: Date.now() + 300_000,
      observationRequestId: snapshot.observationRequestId, items: snapshot.offerItems })
    for (const [key, value] of this.offers) if (value.offer.expiresAt < Date.now() || value.owner !== owner) this.offers.delete(key)
    if (this.offers.size >= 128 && !this.offers.has(sessionId)) throw new NativeRecoveryError('review-unavailable')
    if (offer.items.length > 0) this.offers.set(sessionId, { sessionId, owner, connectionId, offer, snapshot })
    return structuredClone(offer)
  }
  async confirm(sessionId: string, reviewId: string, values: RecoveryDecisions, connectionId: string, owner: object, signal: AbortSignal): Promise<void> {
    const permit = this.offers.get(sessionId)
    if (permit === undefined || permit.owner !== owner || permit.connectionId !== connectionId || permit.offer.reviewId !== reviewId
      || permit.offer.expiresAt <= Date.now() || signal.aborted) throw new NativeRecoveryError('review-stale')
    // Consume even a refused/uncertain commit. The caller must refresh and review anew.
    this.offers.delete(sessionId)
    const decisions = recoveryDecisionsSchema.parse(values)
    if (decisions.length !== permit.offer.items.length || new Set(decisions.map(value => value.key)).size !== decisions.length
      || permit.offer.items.some(item => !decisions.some(value => value.key === item.key && (item.kind === 'recovery' ? value.decision === 'checked' : value.decision !== 'checked')))) throw new NativeRecoveryError('review-stale')
    const decision = (key: string): 'applied' | 'not-applied' => {
      const value = decisions.find(item => item.key === key)!.decision
      if (value === 'checked') throw new NativeRecoveryError('review-stale')
      return value
    }
    const snapshot = permit.snapshot
    const writes = snapshot.writes.map(row => ({ requestId: row.requestId, digest: row.requestDigest, decision: decision(`w:${row.requestId}`) }))
    const affected = snapshot.runs.filter(run => run.recoveryRequired || summarizeReviewedFacts(run).pendingReconciliation.length > 0 || snapshot.writes.some(row => row.runId === run.runId))
    await this.store.reviewSession({ sessionId,
      review: { source: 'native-user', reviewId, observationRequestId: snapshot.observationRequestId, reviewedAt: Date.now() }, writes,
      runs: affected.map(run => ({ runId: run.runId, expectedVersion: run.version, acknowledgeRecovery: run.recoveryRequired,
        facts: summarizeReviewedFacts(run).pendingReconciliation.map(actionId => ({ actionId, decision: decision(`f:${run.runId}:${actionId}`) })) })),
    }, () => {
      if (signal.aborted || permit.offer.expiresAt <= Date.now() || this.snapshot(sessionId, connectionId).signature !== snapshot.signature) throw new NativeRecoveryError('review-stale')
    }, signal)
  }
}
