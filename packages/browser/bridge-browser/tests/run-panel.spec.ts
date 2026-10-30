import { afterEach, describe, expect, it } from 'vitest'
import { browserRunPanelRpc, browserRunPanelFailure, type RunPanelStore } from '../src/run-panel.ts'
import { BROWSER_RUN_LIST_LIMIT, BRIDGE_RUN_LIST_METHOD, BRIDGE_RUN_CONTROL_METHOD, type BrowserRunList } from '../src/protocol.ts'
import { asActionId, asSessionId, type RequestDigest } from '../src/contracts/ids.ts'
import { createRunStorage } from './helpers/run-storage.ts'

const fixtures: Awaited<ReturnType<typeof createRunStorage>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
const sessionId = asSessionId('synthetic-session')
const signal = () => new AbortController().signal
async function setup() {
  const fixture = await createRunStorage()
  fixtures.push(fixture)
  const queued = await fixture.store.create({ sessionId, requiredCriteriaIds: ['saved'] })
  const run = await fixture.store.transition(queued.runId, queued.version, 'running')
  return { ...fixture, run }
}

describe('panel browser-run metadata and controls', () => {
  it('projects only bounded metadata for the requested session, without criteria or page evidence', async () => {
    const { store, run } = await setup()
    await store.recordFact(run.runId, run.version, { actionId: asActionId('synthetic-fact'), requestDigest: 'a'.repeat(64) as RequestDigest,
      controlRevision: run.controlRevision, dispatchState: 'accepted', outcome: 'verified', verifiedCriteriaIds: ['saved'],
      evidence: { observedText: ['synthetic-private-page-value'] } })
    await store.create({ sessionId: asSessionId('other-session'), requiredCriteriaIds: ['other-private-criterion'] })
    const result = await browserRunPanelRpc(store, BRIDGE_RUN_LIST_METHOD, { sessionId }, signal()) as BrowserRunList
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ runId: run.runId, controls: ['pause', 'stop'], state: 'running', version: 2 })
    expect(Object.keys(result.items[0]).sort()).toEqual(['runId', 'sessionId', 'state', 'version', 'controlRevision', 'updatedAt', 'recoveryRequired', 'requiresReconciliation', 'controls'].sort())
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|criterion|evidence|requestDigest/)
  })

  it('preserves version checks, session ownership, and the distinction between stopping and stopped', async () => {
    const { store, run } = await setup()
    const payload = { sessionId, runId: run.runId, expectedVersion: run.version, control: 'pause' }
    await expect(browserRunPanelRpc(store, BRIDGE_RUN_CONTROL_METHOD, { ...payload, sessionId: 'other-session' }, signal())).rejects.toMatchObject({ code: 'not-found' })
    await store.withExecution(run.runId, 0, async () => {
      const execution = store.executionFor()!
      await browserRunPanelRpc(store, BRIDGE_RUN_CONTROL_METHOD, payload, signal())
      expect(execution.signal.aborted).toBe(true)
    })
    await expect(browserRunPanelRpc(store, BRIDGE_RUN_CONTROL_METHOD, payload, signal())).rejects.toMatchObject({ code: 'stale-version' })
    const paused = store.get(run.runId)!
    const result = await browserRunPanelRpc(store, BRIDGE_RUN_CONTROL_METHOD, { ...payload, expectedVersion: paused.version, control: 'stop' }, signal())
    expect(result).toMatchObject({ item: { state: 'stopping', controls: [] } })
    expect(store.get(run.runId)?.state).toBe('stopping')
  })

  it.each([
    { sessionId, runId: 'missing', expectedVersion: 0, control: 'resume' },
    { sessionId, runId: 'missing', expectedVersion: -1, control: 'stop' },
    { sessionId, runId: 'missing', expectedVersion: 0.5, control: 'stop' },
    { sessionId, runId: 'missing', expectedVersion: 0, control: 'stop', facts: [] },
  ])('refuses unsupported authority or malformed control material: %j', async payload => {
    const { store } = await setup()
    await expect(browserRunPanelRpc(store, BRIDGE_RUN_CONTROL_METHOD, payload, signal())).rejects.toMatchObject({ code: 'bad-request' })
    await expect(browserRunPanelRpc(store, 'bridge.browserRuns.create', { sessionId }, signal())).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('keeps executing work visible ahead of a larger queued backlog and terminal history', async () => {
    const { store, run } = await setup()
    // Projection limits need many records, not dozens of unrelated disk commits.
    const projection: RunPanelStore = { get: store.get.bind(store), control: store.control.bind(store), dispatches: store.dispatches,
      list: () => [run, ...Array.from({ length: BROWSER_RUN_LIST_LIMIT }, (_, index) => ({ ...run,
        runId: `run_backlog_${index}` as typeof run.runId, state: index === BROWSER_RUN_LIST_LIMIT - 1 ? 'stopped' as const : 'queued' as const,
        updatedAt: run.updatedAt + index + 1 }))] }
    const result = await browserRunPanelRpc(projection, BRIDGE_RUN_LIST_METHOD, { sessionId }, signal()) as BrowserRunList
    expect(result.total).toBe(BROWSER_RUN_LIST_LIMIT + 1)
    expect(result.items).toHaveLength(BROWSER_RUN_LIST_LIMIT)
    expect(result.items[0].runId).toBe(run.runId)
    expect(result.items.some(item => item.state === 'stopped')).toBe(false)
  })

  it('marks unresolved transport effects even when no business fact was recorded', async () => {
    const { store } = await setup()
    await store.dispatches.prepare({ requestId: 'uncertain-write', connectionId: 'synthetic', sessionId, name: 'browser_click', args: {}, expiresAt: Date.now() + 60_000 })
    await store.dispatches.markSent('uncertain-write')
    await store.dispatches.settle('uncertain-write', { state: 'unresolved', reason: 'cancelled' })
    expect(await browserRunPanelRpc(store, BRIDGE_RUN_LIST_METHOD, { sessionId }, signal())).toMatchObject({ items: [{ requiresReconciliation: true }] })
    expect(browserRunPanelFailure(new Error('synthetic-private-storage-path'))).toEqual({ code: 'internal', message: expect.not.stringContaining('synthetic-private') })
  })
})
