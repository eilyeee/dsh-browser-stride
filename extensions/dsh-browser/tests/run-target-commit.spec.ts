// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { commitRunTarget } from '../src/background/run-target-commit.ts'
import { BridgeRpcError } from '../src/background/rpc.ts'
import { RunTargetRegistry } from '../src/background/run-targets.ts'
import { TargetLeaseRegistry } from '../src/background/target-leases.ts'
import { BRIDGE_RUN_RETARGET_METHOD, BRIDGE_TASK_START_METHOD } from '@eilyeee/dsh-browser-stride/src/protocol.ts'

function fixture(start = false) {
  const method = start ? BRIDGE_TASK_START_METHOD : BRIDGE_RUN_RETARGET_METHOD
  const payload = { runId: 'run_synthetic', sessionId: 'synthetic-session', controlRevision: start ? 0 : 1, expectedVersion: 2, targetBinding: 'page_synthetic' }
  const prepared = { current: () => true, discard: vi.fn() }
  const controller = new AbortController()
  const request = vi.fn(async () => ({ ...payload, state: 'running', controlRevision: start ? 0 : 3 }))
  return { method, payload, prepared, controller, request, commit: () => commitRunTarget(request, method, payload, prepared, controller.signal) }
}
describe('native selected-page target commit', () => {
  it.each([false, true])('accepts only the exact native target receipt, start=%s', async start => {
    const h = fixture(start)
    await h.commit()
    expect(h.request).toHaveBeenCalledOnce()
    expect(h.prepared.discard).not.toHaveBeenCalled()
  })
  it('discards an unused pin only on a confirmed Host refusal, enabling another native attempt', async () => {
    const runs = new RunTargetRegistry(), targets = new TargetLeaseRegistry()
    const scope = { kind: 'run' as const, runId: 'run_synthetic', controlRevision: 3 }
    const native = { tabId: 7, windowId: 1, url: 'https://synthetic.test/' }
    const capture = () => targets.capture('synthetic-session', native, () => native)
    const pin = runs.prepare(scope, 'synthetic-session', capture())!
    const request = vi.fn(async () => { throw new BridgeRpcError('stale-version', 'Refresh', 'unchanged') })
    await expect(commitRunTarget(request, BRIDGE_RUN_RETARGET_METHOD, { runId: scope.runId, sessionId: 'synthetic-session',
      expectedVersion: 2, controlRevision: 1, targetBinding: pin.id }, { current: pin.current, discard: () => runs.discardPrepared(pin.id) }, new AbortController().signal)).rejects.toThrow()
    expect(runs.join(scope, 'synthetic-session', capture(), pin.id)).toBeUndefined()
    expect(runs.prepare(scope, 'synthetic-session', capture())).toBeDefined()
  })
  it.each([
    new BridgeRpcError('internal', 'Storage commit unconfirmed', 'uncertain'),
    new BridgeRpcError('stale-version', 'Old Host without commit metadata'),
    new BridgeRpcError('cancelled', 'Cancelled after sending'),
    new Error('Transport response lost'),
  ])('keeps its pin on uncertainty or legacy Host errors without retry: %s', async error => {
    const h = fixture()
    h.request.mockRejectedValue(error)
    await expect(h.commit()).rejects.toBe(error)
    expect(h.prepared.discard).not.toHaveBeenCalled()
    expect(h.request).toHaveBeenCalledOnce()
  })
  it.each(['foreign pin', 'foreign revision', 'missing reply'])('keeps the pin after an unconfirmed success receipt: %s', async failure => {
    const h = fixture()
    h.request.mockResolvedValue(failure === 'missing reply' ? null as never : { ...h.payload, state: 'running',
      controlRevision: failure === 'foreign revision' ? 4 : 3, targetBinding: failure === 'foreign pin' ? 'page_foreign' : h.payload.targetBinding })
    await expect(h.commit()).rejects.toThrow()
    expect(h.prepared.discard).not.toHaveBeenCalled()
  })
  it.each([false, true])('discards a pin invalidated before send, aborted=%s', async aborted => {
    const h = fixture()
    if (aborted) h.controller.abort()
    else h.prepared.current = () => false
    await expect(h.commit()).rejects.toThrow()
    expect(h.request).not.toHaveBeenCalled()
    expect(h.prepared.discard).toHaveBeenCalledOnce()
  })
})
