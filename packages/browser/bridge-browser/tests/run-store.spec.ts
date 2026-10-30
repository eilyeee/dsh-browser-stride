import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRunStore, type BrowserRunRecord } from '../src/run-store.ts'
import { asActionId, asControlRevision, asSessionId, type RequestDigest } from '../src/contracts/ids.ts'
import type { ActionFact } from '../src/contracts/outcome.ts'

const contexts: Context[] = []
const stores: BrowserRunStore[] = []
const roots: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stride-run-store-'))
  roots.push(root)
  const storageRoot = join(root, 'storage')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const open = async () => {
    const store = await BrowserRunStore.open(ctx.storageDomain, 'test')
    stores.push(store)
    return store
  }
  const store = await open()
  const file = join(storageRoot, `browser_runs_${Buffer.from('test').toString('hex')}.json`)
  return { ctx, root, storageRoot, file, store, open }
}

const input = () => ({ sessionId: asSessionId('synthetic-session'), requiredCriteriaIds: ['saved'] })
function fact(run: BrowserRunRecord, patch: Partial<ActionFact> = {}): ActionFact {
  return { actionId: asActionId('synthetic-action'), requestDigest: 'a'.repeat(64) as RequestDigest,
    controlRevision: run.controlRevision, dispatchState: 'accepted', outcome: 'verified',
    verifiedCriteriaIds: ['saved'], evidence: { observedText: ['Synthetic save confirmed'] }, ...patch }
}
async function running(store: BrowserRunStore) {
  const run = await store.create(input())
  return store.transition(run.runId, run.version, 'running')
}

describe('durable Host browser run records', () => {
  it('isolates case and punctuation in profile namespaces without allowing a second owner', async () => {
    const { ctx } = await setup()
    await expect(BrowserRunStore.open(ctx.storageDomain, 'test')).rejects.toMatchObject({ code: 'already-open' })
    for (const profile of ['Test', 'test-1', 'test_1']) {
      const isolated = await BrowserRunStore.open(ctx.storageDomain, profile)
      stores.push(isolated)
      expect(isolated.list()).toEqual([])
      await isolated.create(input())
    }
    expect(ctx.storageDomain.get(`browser_runs_${Buffer.from('test').toString('hex')}`)?.table('runs').size).toBe(0)
  })

  it('serializes competing starts per session and admits another session independently', async () => {
    const { store } = await setup()
    const a = await store.create(input())
    const b = await store.create(input())
    const starts = await Promise.allSettled([store.transition(a.runId, 0, 'running'), store.transition(b.runId, 0, 'running')])
    expect(starts.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(starts[1]).toMatchObject({ reason: { code: 'session-busy' } })
    const other = await store.create({ ...input(), sessionId: asSessionId('another-session') })
    expect((await store.transition(other.runId, 0, 'running')).state).toBe('running')
    expect(store.list(input().sessionId)).toHaveLength(2)
  })

  it('rejects stale controls and only advances control revisions for meaningful controls', async () => {
    const { store } = await setup()
    const run = await running(store)
    const changes = await Promise.allSettled([store.control(run.runId, run.version, 'pause'), store.control(run.runId, run.version, 'stop')])
    expect(changes[1]).toMatchObject({ reason: { code: 'stale-version' } })
    const paused = store.get(run.runId)!
    expect(paused).toMatchObject({ state: 'paused', controlRevision: 1 })
    expect(await store.control(run.runId, paused.version, 'pause')).toEqual(paused)
    const resumed = await store.control(run.runId, paused.version, 'resume')
    expect(resumed).toMatchObject({ state: 'running', controlRevision: 2 })
  })

  it('keeps stopping distinct from stopped and retains late facts without reopening', async () => {
    const { store } = await setup()
    const run = await running(store)
    const stopping = await store.control(run.runId, run.version, 'stop')
    expect(stopping.state).toBe('stopping')
    const stopped = await store.transition(run.runId, stopping.version, 'stopped')
    const recorded = await store.recordFact(run.runId, stopped.version, fact(run, {
      outcome: 'uncertain', dispatchState: 'sent_unconfirmed', verifiedCriteriaIds: [], evidence: undefined,
    }))
    expect(recorded.state).toBe('stopped')
    expect(recorded.facts[0]?.controlRevision).toBe(0)
    expect(await store.control(run.runId, recorded.version, 'resume')).toEqual(recorded)
    await expect(store.create({ ...input(), parentRunId: run.runId })).rejects.toMatchObject({ code: 'reconciliation-required' })
    const unrelated = await store.create(input())
    await expect(store.transition(unrelated.runId, unrelated.version, 'running')).rejects.toMatchObject({ code: 'reconciliation-required' })
  })

  it('requires complete criteria and admissible evidence, not a successful tool string', async () => {
    const { store } = await setup()
    const run = await running(store)
    await expect(store.transition(run.runId, run.version, 'completed')).rejects.toMatchObject({ code: 'invalid-state' })
    expect(() => store.recordFact(run.runId, run.version, fact(run, { evidence: { url: 'https://example.test/saved' } }))).toThrow()
    expect(() => store.recordFact(run.runId, run.version, fact(run, { dispatchState: 'sent_unconfirmed' }))).toThrow()
    const recorded = await store.recordFact(run.runId, run.version, fact(run))
    const completed = await store.transition(run.runId, recorded.version, 'completed')
    expect(completed.state).toBe('completed')
    await expect(store.transition(run.runId, completed.version, 'running')).rejects.toThrow(/illegal run transition/)
    expect((await store.create({ ...input(), parentRunId: run.runId })).parentRunId).toBe(run.runId)
  })

  it('preserves immutable facts and treats an exact repeated fact as a no-op', async () => {
    const { store } = await setup()
    const run = await running(store)
    const recorded = await store.recordFact(run.runId, run.version, fact(run))
    expect(await store.recordFact(run.runId, recorded.version, fact(run))).toEqual(recorded)
    await expect(store.recordFact(run.runId, recorded.version, fact(run, { requestDigest: 'b'.repeat(64) as RequestDigest }))).rejects.toMatchObject({ code: 'action-conflict' })
    await expect(store.recordFact(run.runId, recorded.version, fact(run, { evidence: { observedText: ['different evidence'] } }))).rejects.toMatchObject({ code: 'action-conflict' })
    expect(store.get(run.runId)).toEqual(recorded)
  })

  it('keeps uncertain effects from being completed or resumed', async () => {
    const { store } = await setup()
    const run = await running(store)
    const recorded = await store.recordFact(run.runId, run.version, fact(run, { outcome: 'uncertain', verifiedCriteriaIds: [] }))
    await expect(store.transition(run.runId, recorded.version, 'completed')).rejects.toMatchObject({ code: 'reconciliation-required' })
    const paused = await store.control(run.runId, recorded.version, 'pause')
    await expect(store.control(run.runId, paused.version, 'resume')).rejects.toMatchObject({ code: 'reconciliation-required' })
  })

  it('checks parent facts again when a queued rerun starts after a late outcome', async () => {
    const { store } = await setup()
    const parent = await store.create(input())
    const stopped = await store.control(parent.runId, parent.version, 'stop')
    const child = await store.create({ ...input(), parentRunId: parent.runId })
    await store.recordFact(parent.runId, stopped.version, fact(parent, { outcome: 'uncertain', verifiedCriteriaIds: [] }))
    await expect(store.transition(child.runId, child.version, 'running')).rejects.toMatchObject({ code: 'reconciliation-required' })
    expect(store.get(child.runId)?.state).toBe('queued')
  })

  it('fences interrupted contexts on reopen and preserves facts and terminal state', async () => {
    const { store, file, open } = await setup()
    const run = await running(store)
    const recorded = await store.recordFact(run.runId, run.version, fact(run))
    const queued = await store.create(input())
    const stopped = await store.control(queued.runId, queued.version, 'stop')
    await store.close()
    const reopened = await open()
    expect(reopened.get(run.runId)).toMatchObject({ state: 'blocked', recoveryRequired: true,
      controlRevision: recorded.controlRevision + 1, version: recorded.version + 1, facts: recorded.facts })
    expect(reopened.get(stopped.runId)).toEqual(stopped)
    const recovered = reopened.get(run.runId)!
    await expect(reopened.control(run.runId, recovered.version, 'resume')).rejects.toMatchObject({ code: 'reconciliation-required' })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('does not relabel an interrupted stop as an acknowledged stop', async () => {
    const { store, open } = await setup()
    const run = await running(store)
    await store.control(run.runId, run.version, 'stop')
    await store.close()
    const reopened = await open()
    expect(reopened.get(run.runId)).toMatchObject({ state: 'stopping', recoveryRequired: true })
  })

  it('copies queued inputs and read results instead of exposing mutable authority', async () => {
    const { store } = await setup()
    const args = input()
    const pending = store.create(args)
    args.requiredCriteriaIds[0] = 'mutated'
    const run = await pending
    run.requiredCriteriaIds[0] = 'also-mutated'
    expect(store.get(run.runId)?.requiredCriteriaIds).toEqual(['saved'])
    const active = await store.transition(run.runId, run.version, 'running')
    const candidate = fact(active)
    const recording = store.recordFact(active.runId, active.version, candidate)
    candidate.evidence = { observedText: ['mutated'] }
    await recording
    const read = store.list()[0]!
    read.facts.length = 0
    expect(store.get(active.runId)?.facts[0]?.evidence?.observedText).toEqual(['Synthetic save confirmed'])
  })

  it('refuses further writes after a storage failure until the medium is reopened', async () => {
    const { store, storageRoot, open } = await setup()
    const run = await running(store)
    await rename(storageRoot, storageRoot + '-backup')
    await writeFile(storageRoot, 'synthetic write obstacle')
    await expect(store.control(run.runId, run.version, 'pause')).rejects.toThrow()
    expect(store.get(run.runId)).toEqual(run)
    await rm(storageRoot)
    await rename(storageRoot + '-backup', storageRoot)
    await expect(store.control(run.runId, run.version, 'pause')).rejects.toMatchObject({ code: 'storage-unavailable' })
    await store.close()
    expect((await open()).get(run.runId)).toMatchObject({ state: 'blocked', recoveryRequired: true })
  })

  it.each(['invalid-state', 'key-mismatch', 'invalid-fact', 'future-version'])('fails closed on corrupt persisted data (%s)', async kind => {
    const { store, file, open } = await setup()
    const run = await running(store)
    await store.recordFact(run.runId, run.version, fact(run))
    await store.close()
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (kind === 'invalid-state') data.tables.runs[run.runId].state = 'invented'
    if (kind === 'key-mismatch') data.tables.runs[run.runId].runId = 'different-id'
    if (kind === 'invalid-fact') data.tables.runs[run.runId].facts[0].evidence = undefined
    if (kind === 'future-version') data.unit.version += 1
    const corrupt = JSON.stringify(data)
    await writeFile(file, corrupt)
    await expect(open()).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(corrupt)
  })

  it('drains admitted writes on close, rejects new work, and releases the domain', async () => {
    const { store, open } = await setup()
    const creating = store.create(input())
    const closing = store.close()
    expect(store.close()).toBe(closing)
    expect(() => store.create(input())).toThrow(/closed/)
    const run = await creating
    await closing
    expect(() => store.get(run.runId)).toThrow(/closed/)
    expect((await open()).get(run.runId)).toEqual(run)
  })

  it('rejects invalid identities, unknown state controls and future fact revisions', async () => {
    const { store } = await setup()
    expect(() => store.create({ ...input(), requiredCriteriaIds: ['saved', 'saved'] })).toThrow()
    expect(() => store.create({ ...input(), sessionId: ' ' as ReturnType<typeof asSessionId> })).toThrow()
    const run = await running(store)
    expect(() => store.control(run.runId, run.version, 'invented' as 'stop')).toThrow()
    await expect(store.recordFact(run.runId, run.version, fact(run, { controlRevision: asControlRevision(9) }))).rejects.toMatchObject({ code: 'invalid-state' })
  })
})
