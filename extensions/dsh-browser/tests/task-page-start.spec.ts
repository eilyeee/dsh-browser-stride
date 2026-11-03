// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { startTaskPage, cleanupOwnedTaskPage, type PreparedTaskPage } from '../src/background/task-page-start.ts'
import { BridgeRpcError } from '../src/background/rpc.ts'
import { WriteQueue } from '../src/background/write-queue.ts'
import { TargetLeaseRegistry } from '../src/background/target-leases.ts'
import { BRIDGE_TASK_PAGE_PREPARE_METHOD as PREPARE, BRIDGE_TASK_PAGE_CANCEL_METHOD as CANCEL, BRIDGE_TASK_START_METHOD as START } from '@eilyeee/dsh-browser-stride/src/protocol.ts'

function fixture() {
  const input = { runId: 'run_synthetic', sessionId: 'synthetic-session', expectedVersion: 0, controlRevision: 0, url: 'https://synthetic.test/' }
  const order: string[] = []
  let current = true
  const page: PreparedTaskPage = { targetUrl: input.url, targetBinding: 'page_synthetic', current: () => current,
    cleanup: vi.fn(async () => { order.push('cleanup') }), discard: vi.fn(() => { order.push('discard') }) }
  const request = vi.fn(async (method: string) => {
    order.push(method)
    if (method === PREPARE) return { startTicket: 'start_synthetic', launchUrl: input.url, expiresAt: Date.now() + 45000 }
    if (method === START) return { ...input, state: 'running', targetBinding: page.targetBinding }
    return { cancelled: true }
  })
  const queue = new WriteQueue()
  const deps = { current: () => current, request, enqueue: <T>(signal: AbortSignal, work: () => Promise<T>) => queue.run(signal, work),
    create: vi.fn(async () => { order.push('create-authorize-bind-pin'); return page }) }
  return { input, order, page, deps, queue, signal: new AbortController().signal, revoke: () => { current = false } }
}
describe('native new task page startup', () => {
  it.each([false, true])('cleans its own revoked grant but respects a native rebind during cleanup=%s', async rebind => {
    const targets = new TargetLeaseRegistry()
    const identity = { tabId: 7, windowId: 2, url: 'https://synthetic.test/' }
    const bound = targets.capture('synthetic-session', identity, () => identity)
    const session = targets.captureSession('synthetic-session')
    const remove = vi.fn(async () => {})
    const access = { current: () => true, canClose: () => true, release: vi.fn(async () => {
      targets.forgetTab(7) // This attempt's page revocation invalidates the old lifetime.
      if (rebind) targets.invalidateSession('synthetic-session')
    }) }
    await cleanupOwnedTaskPage(access, bound.sameBinding, session, remove)
    expect(access.release).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledTimes(rebind ? 0 : 1)
  })
  it('does not revoke a newer native grant or hide a failed native close', async () => {
    const remove = vi.fn(async () => { throw new Error('close failed') })
    const release = vi.fn(async () => {})
    await cleanupOwnedTaskPage({ current: () => false, canClose: () => false, release }, () => true, () => true, remove)
    expect(release).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    await expect(cleanupOwnedTaskPage({ current: () => true, canClose: () => true, release }, () => true, () => true, remove)).rejects.toThrow('close failed')
    expect(release).toHaveBeenCalledOnce()
  })
  it('reserves before page effects and pins before a single start request', async () => {
    const h = fixture()
    await startTaskPage(h.input, h.deps, h.signal)
    expect(h.order).toEqual([PREPARE, 'create-authorize-bind-pin', START])
    expect(h.deps.request).toHaveBeenLastCalledWith(START, expect.objectContaining({ startTicket: 'start_synthetic', launchUrl: h.input.url,
      targetUrl: h.input.url, targetBinding: h.page.targetBinding }), expect.any(Object))
  })
  it('does not create after revocation during Host preparation', async () => {
    const h = fixture(), original = h.deps.request.getMockImplementation()!
    h.deps.request.mockImplementation(async method => { const result = await original(method); if (method === PREPARE) h.revoke(); return result })
    await expect(startTaskPage(h.input, h.deps, h.signal)).rejects.toThrow()
    expect(h.deps.create).not.toHaveBeenCalled()
    expect(h.order).toEqual([PREPARE, CANCEL])
  })
  it.each(['transport loss', 'start-uncertain', 'malformed reply'])('retains the page and pin after %s, without retry or cancel', async failure => {
    const h = fixture(), original = h.deps.request.getMockImplementation()!
    h.deps.request.mockImplementation(async method => {
      if (method !== START) return original(method)
      h.order.push(START)
      if (failure === 'malformed reply') return {} as never
      throw failure === 'start-uncertain' ? new BridgeRpcError('start-uncertain', 'uncertain') : new Error('connection lost')
    })
    await expect(startTaskPage(h.input, h.deps, h.signal)).rejects.toMatchObject({ code: 'start-uncertain' })
    expect(h.order).toEqual([PREPARE, 'create-authorize-bind-pin', START])
    expect(h.page.cleanup).not.toHaveBeenCalled()
    expect(h.page.discard).not.toHaveBeenCalled()
  })
  it('cleans a confirmed pre-start rejection while retaining the shared write turn', async () => {
    const h = fixture(), original = h.deps.request.getMockImplementation()!
    let next: Promise<void> | undefined
    h.deps.request.mockImplementation(async method => {
      if (method !== START) return original(method)
      next = h.queue.run(h.signal, async () => { h.order.push('next-write') })
      throw new BridgeRpcError('start-rejected', 'rejected before consumption')
    })
    await expect(startTaskPage(h.input, h.deps, h.signal)).rejects.toMatchObject({ code: 'start-rejected' })
    await next
    expect(h.order.indexOf('cleanup')).toBeLessThan(h.order.indexOf('next-write'))
    expect(h.page.discard).toHaveBeenCalledOnce()
  })
  it('reports failed cleanup honestly and still cancels the unused reservation', async () => {
    const h = fixture()
    h.deps.create.mockImplementation(async () => { h.revoke(); return h.page })
    vi.mocked(h.page.cleanup).mockRejectedValue(new Error('close failed'))
    await expect(startTaskPage(h.input, h.deps, h.signal)).rejects.toMatchObject({ code: 'start-cleanup-unconfirmed' })
    expect(h.deps.request.mock.calls.map(call => call[0])).toEqual([PREPARE, CANCEL])
  })
  it('rejects invalid native URL without Host or browser effects', async () => {
    const h = fixture()
    await expect(startTaskPage({ ...h.input, url: 'javascript:alert(1)' }, h.deps, h.signal)).rejects.toMatchObject({ code: 'start-rejected' })
    expect(h.deps.request).not.toHaveBeenCalled()
    expect(h.deps.create).not.toHaveBeenCalled()
  })
})
