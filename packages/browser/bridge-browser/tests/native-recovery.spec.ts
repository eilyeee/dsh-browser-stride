import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunStorage } from './helpers/run-storage.ts'
import { NativeRecovery } from '../src/native-recovery.ts'
import { requiresDispatchReview, transportReceipt } from '../src/dispatch-ledger.ts'
import { summarizeReviewedFacts } from '../src/run-store.ts'
import { asActionId, asSessionId, type RequestDigest } from '../src/contracts/ids.ts'
import { newBrowserTask } from '../src/task-contract.ts'

const fixtures: Awaited<ReturnType<typeof createRunStorage>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); vi.restoreAllMocks() })
async function setup() {
  let now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => ++now)
  const fixture = await createRunStorage(); fixtures.push(fixture)
  const { store } = fixture, owner = {}, sessionId = 'review-session', connectionId = 'connection'
  let idle = true
  const recovery = new NativeRecovery(store, () => idle)
  const base = (requestId: string, name: string) => ({ requestId, name, sessionId, connectionId, args: {}, expiresAt: Date.now() + 60000 })
  async function uncertain(requestId = 'write') {
    const row = await store.dispatches.prepare(base(requestId, 'browser_click'))
    await store.dispatches.markSent(requestId); await store.dispatches.settle(requestId, { state: 'unresolved', reason: 'expired' })
    return row
  }
  async function read(requestId = 'observation') {
    await store.dispatches.prepare(base(requestId, 'browser_snapshot')); await store.dispatches.markSent(requestId)
    await store.dispatches.settle(requestId, { state: 'returned', receipt: { ok: true } })
  }
  const prepare = () => recovery.prepare(sessionId, connectionId, owner)
  return { ...fixture, store, owner, sessionId, connectionId, recovery, base, uncertain, read, prepare,
    idle: (value: boolean) => { idle = value }, advance: (value: number) => { now += value } }
}
describe('native reviewed continuation', () => {
  it('requires a fresh read after an uncertain legacy write, preserves transport identity and never replays it', async () => {
    const h = await setup(); const row = await h.uncertain()
    expect(() => h.store.executionFor(h.sessionId)).toThrow('reconciliation-required') // Even without managed runs.
    expect(() => h.prepare()).toThrow('review-read-required')
    await h.read(); const offer = h.prepare()
    expect(offer.items).toEqual([{ key: 'w:write', kind: 'write', label: 'browser_click' }])
    await h.recovery.confirm(h.sessionId, offer.reviewId, [{ key: 'w:write', decision: 'applied' }], h.connectionId, h.owner, new AbortController().signal)
    const reviewed = h.store.dispatches.get('write')!
    expect(reviewed).toMatchObject({ state: 'unresolved', actionId: row.actionId, requestDigest: row.requestDigest,
      nativeReview: { source: 'native-user', decision: 'applied', observationRequestId: 'observation' } })
    expect(reviewed).not.toHaveProperty('outcome'); expect(reviewed.receipt).toBeUndefined()
    expect(requiresDispatchReview(reviewed)).toBe(false)
    expect(h.store.executionFor(h.sessionId)).toBeUndefined()
    expect(h.store.dispatches.list(h.sessionId)).toHaveLength(2)
    await expect(h.recovery.confirm(h.sessionId, offer.reviewId, [{ key: 'w:write', decision: 'applied' }], h.connectionId, h.owner, new AbortController().signal)).rejects.toThrow('review-stale')
  })
  it.each(['wrong-owner', 'wrong-connection', 'expired', 'incomplete', 'wrong-kind', 'changed'])('refuses a %s confirmation without removing the write fence', async reason => {
    const h = await setup(); await h.uncertain(); await h.read(); const offer = h.prepare()
    if (reason === 'expired') h.advance(300001)
    if (reason === 'changed') await h.uncertain('second-write')
    const decisions = reason === 'incomplete' ? [] : [{ key: 'w:write', decision: reason === 'wrong-kind' ? 'checked' as const : 'not-applied' as const }]
    await expect(h.recovery.confirm(h.sessionId, offer.reviewId, decisions, reason === 'wrong-connection' ? 'different' : h.connectionId,
      reason === 'wrong-owner' ? {} : h.owner, new AbortController().signal)).rejects.toThrow(reason === 'changed' ? 'review-read-required' : 'review-stale')
    expect(h.store.dispatches.get('write')?.nativeReview).toBeUndefined()
    expect(() => h.store.executionFor(h.sessionId)).toThrow('reconciliation-required')
  })
  it('rejects old reads from before the uncertainty, or from a replaced connection', async () => {
    const h = await setup(); await h.read(); await h.uncertain()
    expect(() => h.prepare()).toThrow('review-read-required')
    await h.read('current'); expect(h.prepare().items).toHaveLength(1)
    expect(() => h.recovery.prepare(h.sessionId, 'replacement', {})).toThrow('review-read-required')
    h.advance(300001); expect(() => h.prepare()).toThrow('review-read-required')
  })
  it('refuses running conversations and pending writes, rather than treating a pause request as drained', async () => {
    const h = await setup(); h.idle(false)
    expect(() => h.prepare()).toThrow('review-busy')
    h.idle(true)
    await h.store.dispatches.prepare(h.base('pending', 'browser_click'))
    expect(() => h.prepare()).toThrow('review-busy')
  })
  it('records fact acknowledgements separately, rotates authority, preserves budget, and leaves the task paused/unverified', async () => {
    const h = await setup()
    const queued = await h.store.create({ sessionId: asSessionId(h.sessionId), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Original goal') })
    let run = await h.store.startTask(queued.runId, queued.version, () => {})
    run = await h.store.updateTask(run.runId, task => ({ ...task, modelRequests: 2, toolCalls: 3, activeMs: 500 }))
    const unknown = { actionId: asActionId('unknown-action'), requestDigest: 'a'.repeat(64) as RequestDigest, controlRevision: run.controlRevision,
      dispatchState: 'sent_unconfirmed' as const, outcome: 'uncertain' as const }
    run = await h.store.recordFact(run.runId, run.version, unknown)
    run = await h.store.control(run.runId, run.version, 'pause')
    await h.read(); const offer = h.prepare()
    await h.recovery.confirm(h.sessionId, offer.reviewId, offer.items.map(item => ({ key: item.key, decision: 'applied' })), h.connectionId, h.owner, new AbortController().signal)
    const reviewed = h.store.get(run.runId)!
    expect(reviewed).toMatchObject({ state: 'paused', controlRevision: run.controlRevision + 1,
      task: { goal: 'Original goal', modelRequests: 2, toolCalls: 3, activeMs: 500 }, facts: [unknown] })
    expect(summarizeReviewedFacts(reviewed)).toMatchObject({ uncertain: 1, verifiedCriteriaIds: [], pendingReconciliation: [] })
    const continued = await h.store.retargetPaused(reviewed.runId, reviewed.version, reviewed.controlRevision, () => {})
    await expect(h.store.transition(continued.runId, continued.version, 'completed')).rejects.toMatchObject({ code: 'invalid-state' })
  })
  it('persists the unconfirmed-readback marker and invalidates manual review if a later receipt arrives', async () => {
    const h = await setup(); await h.uncertain(); await h.read(); const offer = h.prepare()
    await h.recovery.confirm(h.sessionId, offer.reviewId, [{ key: 'w:write', decision: 'not-applied' }], h.connectionId, h.owner, new AbortController().signal)
    await h.store.dispatches.settle('write', { state: 'returned', receipt: { ok: true } })
    expect(h.store.dispatches.get('write')).toMatchObject({ state: 'returned', nativeReviewInvalidated: true })
    expect(() => h.store.executionFor(h.sessionId)).toThrow('reconciliation-required')
    await h.read('new-read'); const next = h.prepare()
    await h.recovery.confirm(h.sessionId, next.reviewId, [{ key: 'w:write', decision: 'applied' }], h.connectionId, h.owner, new AbortController().signal)
    expect(h.store.dispatches.get('write')).toMatchObject({ nativeReview: { decision: 'applied' }, previousNativeReview: { decision: 'not-applied' }, nativeReviewInvalidated: false })
    await h.store.dispatches.prepare(h.base('readback-unknown', 'browser_type')); await h.store.dispatches.markSent('readback-unknown')
    await h.store.dispatches.settle('readback-unknown', { state: 'returned', receipt: transportReceipt(true, undefined, true) })
    expect(requiresDispatchReview(h.store.dispatches.get('readback-unknown')!)).toBe(true)
    await h.store.close(); const reopened = await h.open()
    expect(reopened.dispatches.get('readback-unknown')?.receipt).toEqual({ ok: true, readbackUnconfirmed: true })
    expect(() => reopened.executionFor(h.sessionId)).toThrow('reconciliation-required')
  })
  it('rejects cancelled confirmation and returns an empty list without creating execution authority', async () => {
    const h = await setup(); expect(h.prepare().items).toEqual([])
    await h.uncertain(); await h.read(); const offer = h.prepare(); const controller = new AbortController(); controller.abort()
    await expect(h.recovery.confirm(h.sessionId, offer.reviewId, [{ key: 'w:write', decision: 'applied' }], h.connectionId, h.owner, controller.signal)).rejects.toThrow('review-stale')
    expect(h.store.dispatches.get('write')?.nativeReview).toBeUndefined()
  })
  it.each(['field-readonly', 'design-zoom-not-selected', 'element-stale', 'bad-args'])('preserves bounded recovery from the packaged no-business-effect error %s', async code => {
    const h = await setup()
    await h.store.dispatches.prepare(h.base('safe-error', 'browser_click')); await h.store.dispatches.markSent('safe-error')
    await h.store.dispatches.settle('safe-error', { state: 'returned', receipt: transportReceipt(false, code) })
    expect(h.store.dispatches.get('safe-error')?.receipt?.notApplied).toBe(true)
    expect(requiresDispatchReview(h.store.dispatches.get('safe-error')!)).toBe(false)
    expect(h.store.executionFor(h.sessionId)).toBeUndefined()
    expect(h.prepare().items).toHaveLength(0)
  })
})
