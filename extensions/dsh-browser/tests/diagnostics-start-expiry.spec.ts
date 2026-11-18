// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageDiagnostics } from '../src/background/diagnostics.ts'
import type { DebuggerPages, ReadDebugLease } from '../src/background/debugger-pages.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const release = vi.fn(async () => {})
  const detachIfExclusive = vi.fn(async () => false)
  const command = vi.fn(async (method: string) => method === 'Page.getFrameTree'
    ? { frameTree: { frame: { id: 'main', loaderId: 'a', url: 'https://example.test/app' } } } : {})
  const lease: ReadDebugLease = { current: () => true, command: command as ReadDebugLease['command'],
    release, detachIfExclusive, contexts: () => [], subscribe: () => () => {} }
  const acquireReadLease = vi.fn(async () => lease)
  const diagnostics = new PageDiagnostics({ acquireReadLease } as unknown as DebuggerPages)
  return { diagnostics, lease, release, detachIfExclusive, command, acquireReadLease }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('diagnostics start expiry', () => {
  it('lets a new explicit start proceed after confirmed detach even when the old reply stays pending', async () => {
    vi.useFakeTimers()
    const h = fixture(), detached = deferred<boolean>(), late = deferred<object>()
    const original = h.command.getMockImplementation()!
    let firstRuntimeEnable = true
    h.command.mockImplementation(async method => {
      if (method === 'Runtime.enable' && firstRuntimeEnable) { firstRuntimeEnable = false; return late.promise }
      return original(method)
    })
    h.detachIfExclusive.mockReturnValueOnce(detached.promise)
    const first = h.diagnostics.start(42, () => true, () => true, 'original').catch(error => error)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await first).toMatchObject({ message: 'diagnostics-start-timeout' })
    expect(h.detachIfExclusive).toHaveBeenCalledOnce()
    const next = h.diagnostics.start(42, () => true, () => true, 'successor')
    await vi.advanceTimersByTimeAsync(100)
    expect(h.acquireReadLease).toHaveBeenCalledOnce()
    expect(h.diagnostics.status(42).enabled).toBe(false)
    detached.resolve(true)
    await expect(next).resolves.toMatchObject({ enabled: true })
    late.resolve({})
    await vi.advanceTimersByTimeAsync(0)
    expect(h.command.mock.calls.filter(([method]) => method === 'Network.enable')).toHaveLength(1)
    expect(h.diagnostics.status(42, 'successor').enabled).toBe(true)
    await h.diagnostics.stop(42)
  })

  it('settles a hung acquisition before the panel deadline and releases a late lease without enabling', async () => {
    vi.useFakeTimers()
    const h = fixture(), late = deferred<ReadDebugLease>()
    h.acquireReadLease.mockReturnValueOnce(late.promise)
    let outcome = 'pending'
    const result = h.diagnostics.start(42, () => true, () => true, 'original')
      .then(() => { outcome = 'enabled' }, () => { outcome = 'rejected' })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(outcome).toBe('rejected')
    expect(h.diagnostics.status(42).enabled).toBe(false)
    late.resolve(h.lease)
    await vi.advanceTimersByTimeAsync(0)
    await result
    expect(h.release).toHaveBeenCalledOnce()
    expect(h.command.mock.calls.some(([method]) => method.endsWith('.enable'))).toBe(false)
    expect(h.diagnostics.status(42).enabled).toBe(false)
    await expect(h.diagnostics.read(42, () => true, 'original')).rejects.toThrow('not-enabled')
  })

  it('does not continue enabling domains after an expired native command eventually replies', async () => {
    vi.useFakeTimers()
    const h = fixture(), late = deferred<object>(), original = h.command.getMockImplementation()!
    h.command.mockImplementation(async method => method === 'Runtime.enable' ? late.promise : original(method))
    let outcome = 'pending'
    const result = h.diagnostics.start(42, () => true, () => true, 'original')
      .then(() => { outcome = 'enabled' }, () => { outcome = 'rejected' })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(outcome).toBe('rejected')
    late.resolve({})
    await vi.advanceTimersByTimeAsync(0)
    await result
    expect(h.command.mock.calls.some(([method]) => method === 'Network.enable')).toBe(false)
    expect(h.release).toHaveBeenCalledOnce()
    expect(h.diagnostics.status(42).enabled).toBe(false)
  })

  it('expires a queued native start without replaying it after previous cleanup finally settles', async () => {
    vi.useFakeTimers()
    const h = fixture(), late = deferred<ReadDebugLease>()
    h.acquireReadLease.mockReturnValueOnce(late.promise)
    const outcomes: string[] = []
    const first = h.diagnostics.start(42, () => true, () => true, 'first')
      .then(() => outcomes.push('first-enabled'), () => outcomes.push('first-rejected'))
    await vi.advanceTimersByTimeAsync(1_000)
    const second = h.diagnostics.start(42, () => true, () => true, 'second')
      .then(() => outcomes.push('second-enabled'), () => outcomes.push('second-rejected'))
    await vi.advanceTimersByTimeAsync(12_000)
    expect(outcomes.sort()).toEqual(['first-rejected', 'second-rejected'])
    late.resolve(h.lease)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([first, second])
    expect(h.acquireReadLease).toHaveBeenCalledOnce()
    expect(h.diagnostics.status(42).enabled).toBe(false)
    // A later, explicit start remains possible once the old native slot is clean.
    await expect(h.diagnostics.start(42, () => true, () => true, 'third')).resolves.toMatchObject({ enabled: true })
    await h.diagnostics.stop(42)
  })
})
