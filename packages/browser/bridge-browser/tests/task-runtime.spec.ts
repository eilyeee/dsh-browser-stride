import { AsyncResource } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserTaskRuntime } from '../src/task-runtime.ts'
import { createRunStorage } from './helpers/run-storage.ts'

const close: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of close.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function setup() {
  const fixture = await createRunStorage()
  close.push(fixture.close)
  const errors: unknown[] = []
  let idle = Promise.resolve()
  let running = false
  let work: () => Promise<void> = async () => {}
  const followup = vi.fn(() => {
    running = true
    idle = Promise.resolve().then(work).catch(error => { errors.push(error) }).finally(() => { running = false })
  })
  const cancel = vi.fn()
  const agent = { id: 'synthetic-task-session', get status() { return running ? 'running' : 'idle' },
    ctx: { tools: { restrict: () => () => {} } },
    followup, cancel, whenIdle: () => idle } as unknown as Agent
  const runtime = new BrowserTaskRuntime({ agents: { get: (id: string) => id === agent.id ? agent : undefined } } as unknown as Context, fixture.store)
  close.push(() => runtime.close())
  const run = await runtime.create(String(agent.id), 'Update the synthetic setting and save')
  const current = () => fixture.store.get(run.runId)!
  const start = async () => fixture.store.startTask(run.runId, current().version,
    () => runtime.selectTarget(run.runId, 'https://synthetic.test/settings'))
  const settled = async () => {
    await vi.waitFor(() => expect(['running', 'stopping']).not.toContain(current().state), { timeout: 10000 })
    const unexpected = errors.find(error => !(error instanceof Error && error.message === 'task-budget-exhausted'))
    if (unexpected !== undefined) throw unexpected
  }
  return { ...fixture, runtime, agent, run, current, start, settled, followup, cancel, errors, work: (value: () => Promise<void>) => { work = value } }
}
function execution(agent: Agent, name = 'browser_snapshot', parent?: ToolExecutionToken): ToolExecution {
  return { agent, name, token: Symbol(name), callId: name, rootCallId: name, arguments: {}, signal: new AbortController().signal,
    ...(parent === undefined ? {} : { parent }) } as ToolExecution
}

describe('Host-owned browser task executor', () => {
  it('refuses provider delivery if connection authority expires during model counter persistence', async () => {
    const h = await setup()
    const original = h.store.updateTask.bind(h.store)
    let armed = true, delivered = 0, denied = false
    vi.spyOn(h.store, 'updateTask').mockImplementation(async (id, update) => {
      const result = await original(id, update)
      if (armed && result.task?.modelRequests === 1) {
        armed = false
        await h.store.pauseDisconnectedTask(id, result.controlRevision)
      }
      return result
    })
    h.work(async () => {
      try { await h.runtime.consume(h.agent, 'modelRequests'); delivered++ }
      catch { denied = true }
    })
    await h.start()
    await vi.waitFor(() => expect(denied || delivered > 0).toBe(true))
    expect(delivered).toBe(0)
    expect(denied).toBe(true)
    expect(h.current()).toMatchObject({ state: 'paused', task: { modelRequests: 1 } })
  })
  it('cancels the owned Agent before its disconnected pause is persisted and waits for explicit continuation', async () => {
    const h = await setup()
    const hold = gate()
    close.push(async () => { hold.release() })
    let entered = false
    h.work(async () => { await h.runtime.consume(h.agent, 'modelRequests'); entered = true; await hold.promise })
    await h.start()
    await vi.waitFor(() => expect(entered).toBe(true))
    const paused = h.store.pauseDisconnectedTask(h.run.runId, 0)
    expect(h.cancel).toHaveBeenCalled()
    await expect(h.runtime.consume(h.agent, 'modelRequests')).rejects.toThrow()
    await paused
    hold.release()
    await vi.waitFor(() => expect(h.current().task?.activeMs).toBeGreaterThan(0))
    expect(h.current()).toMatchObject({ state: 'paused', pauseReason: 'browser-disconnected', task: { modelRequests: 1 } })
    expect(h.followup).toHaveBeenCalledOnce()
    h.work(async () => { await h.runtime.consume(h.agent, 'modelRequests') })
    const current = h.current()
    await h.store.retargetPaused(h.run.runId, current.version, current.controlRevision, () => h.runtime.selectTarget(h.run.runId, 'https://synthetic.test/settings'))
    await h.settled()
    expect(h.followup).toHaveBeenCalledTimes(2)
    expect(h.current().task?.modelRequests).toBe(2)
    expect(h.current()).not.toHaveProperty('pauseReason')
  })
  it('checks a future native target without binding it or waking the Agent', async () => {
    const h = await setup()
    h.runtime.validateTarget(h.run.runId, 'https://synthetic.test/settings')
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.current().state).toBe('queued')
    // Publishing running without selectTarget still cannot make validation into a binding.
    await h.store.startTask(h.run.runId, h.current().version, () => {})
    await Promise.resolve()
    expect(h.followup).not.toHaveBeenCalled()
  })
  it.each([false, true])('cancels owned model activity when a revoked scope is nested=%s', async nested => {
    const h = await setup()
    const hold = gate()
    close.push(async () => { hold.release() })
    let revoked = false
    const pool = new AsyncResource('synthetic-revocation-pool')
    const revoke = async () => {
      await h.store.dispatches.prepare({ requestId: 'authority-failed-write', connectionId: 'synthetic', sessionId: h.run.sessionId,
        runId: h.run.runId, controlRevision: 0, name: 'browser_click', args: {}, expiresAt: Date.now() + 60000 })
      await h.store.dispatches.markSent('authority-failed-write')
      await h.store.dispatches.settle('authority-failed-write', { state: 'unresolved', reason: 'expired' })
      expect(() => h.store.executionFor(String(h.agent.id))).toThrow(/reconciliation-required|execution-context-expired/)
      expect(h.cancel).toHaveBeenCalled()
      await expect(h.runtime.consume(h.agent, 'modelRequests')).rejects.toThrow()
      revoked = true
      await hold.promise
      return { content: [], isError: false }
    }
    h.work(async () => {
      if (nested) {
        const parent = execution(h.agent, 'run_code')
        await h.runtime.aroundTool(parent, () => pool.runInAsyncScope(() => h.runtime.aroundTool(execution(h.agent, 'browser_click', parent.token), revoke)))
      } else await revoke()
    })
    await h.start()
    await vi.waitFor(() => expect(revoked || h.errors.length > 0).toBe(true), { timeout: 1500 })
    if (h.errors[0] !== undefined) throw h.errors[0]
    expect(h.current().task?.modelRequests).toBe(0)
    hold.release()
    await h.settled()
    expect(h.current()).toMatchObject({ state: 'blocked', task: { outcome: 'needs-review' } })
    pool.emitDestroy()
  })

  it('does not steal an Agent activity that starts during the native start commit', async () => {
    const h = await setup()
    const hold = gate()
    close.push(async () => { hold.release() })
    h.work(async () => { await hold.promise })
    await h.store.startTask(h.run.runId, h.current().version, () => {
      h.runtime.selectTarget(h.run.runId, 'https://synthetic.test/settings')
      h.agent.followup({} as Parameters<Agent['followup']>[0])
    })
    await h.settled()
    expect(h.current()).toMatchObject({ state: 'blocked', task: { modelRequests: 0, toolCalls: 0, outcome: 'needs-review' } })
    expect(h.followup).toHaveBeenCalledTimes(1)
    expect(h.cancel).not.toHaveBeenCalled()
    hold.release()
  })

  it('excludes human approval and pause time while retaining counters on a fresh continuation', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const h = await setup()
    const hold = gate()
    close.push(async () => { hold.release() })
    let entered = false
    let round = 0
    h.work(async () => {
      round++
      await h.runtime.consume(h.agent, 'modelRequests')
      await h.runtime.consume(h.agent, 'toolCalls')
      if (round === 1) {
        now = 5000
        h.runtime.approval(h.run.runId, 'synthetic-approval', true)
        now = 105000
        h.runtime.approval(h.run.runId, 'synthetic-approval', false)
        now = 107000
        entered = true
        await hold.promise
      }
    })
    await h.start()
    await vi.waitFor(() => expect(entered).toBe(true))
    const paused = await h.store.control(h.run.runId, h.current().version, 'pause')
    now = 207000
    hold.release()
    await vi.waitFor(() => expect(h.current().version).toBeGreaterThan(paused.version))
    expect(h.current().task?.activeMs).toBe(7000)
    await h.store.retargetPaused(h.run.runId, h.current().version, h.current().controlRevision,
      () => h.runtime.selectTarget(h.run.runId, 'https://synthetic.test/settings'))
    await h.settled()
    expect(h.current()).toMatchObject({ controlRevision: 3, task: { activeMs: 7000, modelRequests: 2, toolCalls: 2 } })
    expect(h.followup).toHaveBeenCalledTimes(2)
  })

  it('connects an explicit DSH user cancellation to stopped after the owned Agent drains', async () => {
    const h = await setup()
    const hold = gate()
    close.push(async () => { hold.release() })
    let entered = false
    h.work(async () => { entered = true; await hold.promise })
    await h.start()
    await vi.waitFor(() => expect(entered).toBe(true))
    h.runtime.userCancelled(String(h.agent.id))
    expect(h.cancel).toHaveBeenCalled()
    hold.release()
    await h.settled()
    expect(h.current().state).toBe('stopped')
  })

  it('rejects in-place goal edits and counter resets', async () => {
    const h = await setup()
    await h.store.updateTask(h.run.runId, task => ({ ...task, modelRequests: 1 }))
    await expect(h.store.updateTask(h.run.runId, task => ({ ...task, modelRequests: 0 }))).rejects.toMatchObject({ code: 'invalid-state' })
    await expect(h.store.updateTask(h.run.runId, task => ({ ...task, goal: 'changed' }))).rejects.toMatchObject({ code: 'invalid-state' })
    expect(h.current().task).toMatchObject({ goal: 'Update the synthetic setting and save', modelRequests: 1 })
  })

  it('keeps queued tasks inert and rejects concurrent task creation', async () => {
    const h = await setup()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.current().task).toMatchObject({ activeMs: 0, modelRequests: 0, toolCalls: 0 })
    expect(h.runtime.guard(execution(h.agent))).toMatch(/waiting or paused/)
    await expect(h.runtime.create(String(h.agent.id), 'another goal')).rejects.toMatchObject({ code: 'session-busy' })
  })
  it('requires trusted verification, independently of model idleness or success prose', async () => {
    const h = await setup()
    h.work(async () => { await h.runtime.consume(h.agent, 'modelRequests') })
    await h.start(); await h.settled()
    expect(h.current()).toMatchObject({ state: 'blocked', facts: [], task: { outcome: 'needs-review', modelRequests: 1 } })
    expect(h.followup).toHaveBeenCalledTimes(1)
  })
  it('completes only from registered Host evidence and rejects a foreign native target', async () => {
    const h = await setup()
    const verify = vi.fn(async () => ({ fieldValues: { savedSetting: 'enabled' } }))
    h.runtime.registerVerifier(h.run.runId, { acceptsTarget: url => url === 'https://synthetic.test/settings', verify })
    expect(() => h.runtime.selectTarget(h.run.runId, 'https://foreign.test/')).toThrow('target-refused')
    await h.start(); await h.settled()
    expect(h.current()).toMatchObject({ state: 'completed', task: { outcome: 'verified' }, facts: [{ outcome: 'verified', verifiedCriteriaIds: ['task-goal'] }] })
    expect(verify).toHaveBeenCalledTimes(1)
  })
  it('reports the active-time limit when it expires during independent verification', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const h = await setup()
    h.runtime.registerVerifier(h.run.runId, { acceptsTarget: () => true, verify: async ({ signal }) => {
      now = 300000
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return { observedText: ['unreachable synthetic proof'] }
    } })
    await h.start(); await h.settled()
    expect(h.current()).toMatchObject({ state: 'blocked', task: { outcome: 'budget-exhausted', activeMs: 300000 }, facts: [] })
    expect(h.cancel).toHaveBeenCalled()
    expect(h.followup).toHaveBeenCalledTimes(1)
  })
  it.each(['pause', 'stop'] as const)('refuses late verifier evidence after %s', async control => {
    const h = await setup()
    const entered = gate()
    const hold = gate()
    let observedAbort = false
    close.push(async () => { hold.release() })
    h.runtime.registerVerifier(h.run.runId, { acceptsTarget: () => true, verify: async ({ signal }) => {
      entered.release()
      await hold.promise
      observedAbort = signal.aborted
      return { observedText: ['late synthetic proof'] }
    } })
    await h.start(); await entered.promise
    const changed = await h.store.control(h.run.runId, h.current().version, control)
    expect(h.cancel).toHaveBeenCalled()
    hold.release()
    await vi.waitFor(() => expect(h.current().version).toBeGreaterThan(changed.version))
    await h.settled()
    if (control === 'stop') await vi.waitFor(() => expect(h.current().state).toBe('stopped'))
    expect(h.current()).toMatchObject({ state: control === 'pause' ? 'paused' : 'stopped', facts: [] })
    expect(observedAbort).toBe(true)
  })
  it('never replays an unresolved write or calls its business verifier', async () => {
    const h = await setup()
    const verify = vi.fn(async () => ({ observedText: ['synthetic result'] }))
    h.runtime.registerVerifier(h.run.runId, { acceptsTarget: () => true, verify })
    h.work(async () => {
      await h.store.dispatches.prepare({ requestId: 'synthetic-write', connectionId: 'synthetic', sessionId: h.run.sessionId,
        runId: h.run.runId, controlRevision: 0, name: 'browser_click', args: {}, expiresAt: Date.now() + 60000 })
      await h.store.dispatches.markSent('synthetic-write')
      await h.store.dispatches.settle('synthetic-write', { state: 'unresolved', reason: 'expired' })
    })
    await h.start(); await h.settled()
    expect(h.current()).toMatchObject({ state: 'blocked', task: { outcome: 'needs-review' }, facts: [] })
    expect(verify).not.toHaveBeenCalled()
    expect(h.followup).toHaveBeenCalledTimes(1)
  })
  it('counts every browser child inside a PTC parent across async resource boundaries', async () => {
    const h = await setup()
    const pool = new AsyncResource('synthetic-ptc-pool')
    h.work(async () => {
      const root = execution(h.agent, 'run_code')
      await h.runtime.aroundTool(root, async () => {
        for (let i = 0; i < 3; i++) {
          const child = execution(h.agent, 'browser_snapshot', root.token)
          await pool.runInAsyncScope(async () => {
            expect(h.runtime.guard(child)).toBeUndefined()
            await h.runtime.aroundTool(child, async () => {
              expect(h.store.executionFor(String(h.agent.id))?.runId).toBe(h.run.runId)
              return { content: [], isError: false }
            })
          })
        }
        return { content: [], isError: false }
      })
      await pool.runInAsyncScope(async () => expect(h.runtime.guard(execution(h.agent, 'browser_snapshot', root.token))).toMatch(/expired/))
    })
    await h.start(); await h.settled()
    expect(h.current().task?.toolCalls).toBe(3)
    pool.emitDestroy()
  })
  it.each(['modelRequests', 'toolCalls'] as const)('enforces cumulative %s without restarting the same revision', async kind => {
    const h = await setup()
    h.work(async () => { for (let i = 0; i < 21; i++) await h.runtime.consume(h.agent, kind) })
    await h.start(); await h.settled()
    expect(h.current()).toMatchObject({ state: 'blocked', task: { outcome: 'budget-exhausted', [kind]: kind === 'modelRequests' ? 10 : 20 } })
    expect(h.followup).toHaveBeenCalledTimes(1)
  })
  it('revokes execution immediately on pause and acknowledges stop only after Agent quiescence', async () => {
    const h = await setup()
    const hold = gate()
    close.push(async () => { hold.release() })
    let entered = false
    h.work(async () => { entered = true; await hold.promise })
    await h.start()
    await vi.waitFor(() => expect(entered).toBe(true))
    const paused = await h.store.control(h.run.runId, h.current().version, 'pause')
    expect(h.cancel).toHaveBeenCalled()
    expect(h.runtime.guard(execution(h.agent))).toMatch(/expired/)
    await h.store.control(h.run.runId, paused.version, 'stop')
    expect(h.current().state).toBe('stopping')
    hold.release()
    await h.settled()
    expect(h.current().state).toBe('stopped')
  })
})
