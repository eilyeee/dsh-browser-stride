import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { asActionId, asControlRevision, asSessionId, type RequestDigest } from '../src/contracts/ids.ts'
import { createRunStorage } from './helpers/run-storage.ts'

const fixtures: Awaited<ReturnType<typeof createRunStorage>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
async function setup() {
  const fixture = await createRunStorage()
  fixtures.push(fixture)
  const queued = await fixture.store.create({ sessionId: asSessionId('synthetic-session'), requiredCriteriaIds: ['saved'] })
  const run = await fixture.store.transition(queued.runId, queued.version, 'running')
  return { ...fixture, run }
}

describe('trusted Host run execution scopes', () => {
  it('revokes a new run when a late uncertain fact arrives for an older run in the same session', async () => {
    const { store, run } = await setup()
    const stopping = await store.control(run.runId, run.version, 'stop')
    const stopped = await store.transition(run.runId, stopping.version, 'stopped')
    const queued = await store.create({ sessionId: run.sessionId, requiredCriteriaIds: ['saved'] })
    const next = await store.transition(queued.runId, queued.version, 'running')
    await store.withExecution(next.runId, 0, async () => {
      const execution = store.executionFor()!
      await store.recordFact(stopped.runId, stopped.version, {
        actionId: asActionId('late-uncertain'), requestDigest: 'a'.repeat(64) as RequestDigest,
        controlRevision: asControlRevision(0), dispatchState: 'sent_unconfirmed', outcome: 'uncertain',
      })
      expect(execution.signal.aborted).toBe(true)
      expect(() => store.executionFor()).toThrow('execution-context-expired')
    })
  })

  it('keeps unfinished runs from being purged, including paused runs without pending dispatches', async () => {
    const { store, run } = await setup()
    let deleted = false
    const purge = () => store.purgeSession(run.sessionId, async () => { deleted = true })
    await expect(purge()).rejects.toMatchObject({ code: 'session-busy' })
    const paused = await store.control(run.runId, run.version, 'pause')
    await expect(purge()).rejects.toMatchObject({ code: 'session-busy' })
    expect(deleted).toBe(false)
    const stopping = await store.control(run.runId, paused.version, 'stop')
    await store.transition(run.runId, stopping.version, 'stopped')
    await purge()
    expect(deleted).toBe(true)
  })

  it('serializes new run creation behind a session purge', async () => {
    const { store } = await setup()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const sessionId = asSessionId('independent-session')
    const purging = store.purgeSession(sessionId, async () => { entered(); await gate })
    await ready
    const creating = store.create({ sessionId, requiredCriteriaIds: ['saved'] })
    expect(store.list(sessionId)).toEqual([])
    release()
    await purging
    expect((await creating).state).toBe('queued')
  })

  it('blocks resume until the prior write receipt arrives, without reviving the old context', async () => {
    const { store, run } = await setup()
    await store.withExecution(run.runId, 0, async () => {
      await store.dispatches.prepare({ requestId: 'pending-write', connectionId: 'synthetic-connection', sessionId: run.sessionId,
        runId: run.runId, controlRevision: 0, name: 'browser_click', args: {}, expiresAt: Date.now() + 60_000 })
      await store.dispatches.markSent('pending-write')
      const paused = await store.control(run.runId, run.version, 'pause')
      await expect(store.control(run.runId, paused.version, 'resume')).rejects.toMatchObject({ code: 'reconciliation-required' })
      await store.dispatches.settle('pending-write', { state: 'unresolved', reason: 'cancelled' })
      await expect(store.control(run.runId, paused.version, 'resume')).rejects.toMatchObject({ code: 'reconciliation-required' })
      await store.dispatches.settle('pending-write', { state: 'returned', receipt: { ok: true } })
      const resumed = await store.control(run.runId, paused.version, 'resume')
      expect(() => store.executionFor()).toThrow('execution-context-expired')
      await store.withExecution(run.runId, resumed.controlRevision, () => { expect(store.executionFor()?.controlRevision).toBe(2) })
    })
  })

  it('does not treat failed writes or pending managed writes as permission for legacy dispatch', async () => {
    const { store, run } = await setup()
    await store.withExecution(run.runId, 0, async () => {
      await store.dispatches.prepare({ requestId: 'failed-write', connectionId: 'synthetic-connection', sessionId: run.sessionId,
        runId: run.runId, controlRevision: 0, name: 'browser_type', args: {}, expiresAt: Date.now() + 60_000 })
      const stopping = await store.control(run.runId, run.version, 'stop')
      await store.transition(run.runId, stopping.version, 'stopped')
    })
    expect(() => store.executionFor(run.sessionId)).toThrow('reconciliation-required')
    await store.dispatches.markSent('failed-write')
    await store.dispatches.settle('failed-write', { state: 'returned', receipt: { ok: false, errorCode: 'action-failed' } })
    expect(() => store.executionFor(run.sessionId)).toThrow('reconciliation-required')
  })
  it('does not confuse a fact record version with the execution control revision', async () => {
    const { store, run } = await setup()
    await store.withExecution(run.runId, 0, async () => {
      const execution = store.executionFor()!
      const recorded = await store.recordFact(run.runId, run.version, {
        actionId: asActionId('synthetic-verified'), requestDigest: 'a'.repeat(64) as RequestDigest,
        controlRevision: asControlRevision(0), dispatchState: 'accepted', outcome: 'verified', verifiedCriteriaIds: ['saved'],
        evidence: { observedText: ['Synthetic save confirmed'] },
      })
      expect(recorded.version).toBe(run.version + 1)
      expect(store.executionFor()).toBe(execution)
      expect(execution.signal.aborted).toBe(false)
    })
  })
  it('requires a scope for a managed session, while preserving independent legacy sessions', async () => {
    const { store, run } = await setup()
    expect(() => store.executionFor(run.sessionId)).toThrow('execution-context-required')
    expect(() => store.executionFor()).toThrow('execution-context-required')
    expect(store.executionFor('independent-session')).toBeUndefined()
    await expect(store.withExecution(run.runId, 1, () => {})).rejects.toMatchObject({ code: 'stale-control-revision' })
    await store.withExecution(run.runId, 0, () => {
      expect(store.executionFor(run.sessionId)).toMatchObject({ runId: run.runId, sessionId: run.sessionId, controlRevision: 0 })
      expect(() => store.executionFor('other-session')).toThrow('execution-session-mismatch')
    })
  })

  it('revokes old scopes on pause and never revives them on resume', async () => {
    const { store, run } = await setup()
    await store.withExecution(run.runId, 0, async () => {
      const first = store.executionFor()!
      const paused = await store.control(run.runId, run.version, 'pause')
      expect(first.signal.aborted).toBe(true)
      expect(() => store.executionFor()).toThrow('execution-context-expired')
      const resumed = await store.control(run.runId, paused.version, 'resume')
      expect(() => store.executionFor()).toThrow('execution-context-expired')
      await store.withExecution(run.runId, resumed.controlRevision, () => {
        expect(store.executionFor()?.controlRevision).toBe(2)
        expect(store.executionFor()?.signal.aborted).toBe(false)
      })
      expect(() => store.executionFor()).toThrow('execution-context-expired')
    })
  })

  it('does not let detached children fall back to legacy dispatch after the callback ends', async () => {
    const { store, run } = await setup()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let detached!: Promise<unknown>
    await store.withExecution(run.runId, 0, () => {
      detached = (async () => { await gate; return store.executionFor('independent-session') })()
    })
    release()
    await expect(detached).rejects.toMatchObject({ code: 'execution-context-expired' })
  })

  it('isolates owners and fences old contexts across reopening', async () => {
    const { store, run, open } = await setup()
    const other = await createRunStorage()
    fixtures.push(other)
    await store.withExecution(run.runId, 0, async () => {
      expect(() => other.store.executionFor()).toThrow('execution-context-expired')
      await store.close()
      const reopened = await open()
      expect(() => reopened.executionFor(run.sessionId)).toThrow('execution-context-expired')
      await expect(reopened.withExecution(run.runId, reopened.get(run.runId)!.controlRevision, () => {})).rejects.toMatchObject({ code: 'reconciliation-required' })
    })
  })

  it('revokes current execution when an uncertain fact requires reconciliation', async () => {
    const { store, run } = await setup()
    await store.withExecution(run.runId, 0, async () => {
      const execution = store.executionFor()!
      await store.recordFact(run.runId, run.version, {
        actionId: asActionId('synthetic-uncertain'), requestDigest: 'a'.repeat(64) as RequestDigest,
        controlRevision: asControlRevision(0), dispatchState: 'sent_unconfirmed', outcome: 'uncertain',
      })
      expect(execution.signal.aborted).toBe(true)
      expect(() => store.executionFor()).toThrow('execution-context-expired')
    })
    expect(() => store.executionFor(run.sessionId)).toThrow('reconciliation-required')
  })

  it('revokes scopes and fails closed if a lifecycle write cannot be committed', async () => {
    const { store, run, storageRoot, root } = await setup()
    const moved = join(root, 'retired')
    await store.withExecution(run.runId, 0, async () => {
      const execution = store.executionFor()!
      await rename(storageRoot, moved)
      await writeFile(storageRoot, 'not a directory')
      try {
        await expect(store.control(run.runId, run.version, 'stop')).rejects.toThrow()
        expect(execution.signal.aborted).toBe(true)
        expect(() => store.executionFor()).toThrow('storage-unavailable')
      } finally {
        await rm(storageRoot, { force: true })
        await rename(moved, storageRoot)
      }
    })
  })
})
