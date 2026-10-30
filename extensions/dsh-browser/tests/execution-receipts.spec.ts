// @vitest-environment jsdom
import { IDBObjectStore } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { admitExecution, executeRecordedTool, finishExecution } from '../src/background/execution-receipts.ts'
import { wireToolCall } from './wire-tool-call.ts'

type Call = Extract<ServerFrame, { t: 'tool.call' }>
function call(patch: Partial<Call> = {}): Call {
  return wireToolCall({ t: 'tool.call', id: 'synthetic-attempt', name: 'browser_type',
    args: { text: 'synthetic-private-input', elementRef: 'obs_synthetic:1' }, expiresAt: Date.now() + 60_000, ...patch }) as Call
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const signal = () => new AbortController().signal

async function records(): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('dsh-browser-execution', 1)
    open.onsuccess = () => {
      const db = open.result
      const transaction = db.transaction('receipts', 'readonly')
      const get = transaction.objectStore('receipts').getAll()
      transaction.oncomplete = () => { db.close(); resolve(get.result) }
      transaction.onerror = () => { db.close(); reject(new Error('synthetic read failed')) }
    }
    open.onerror = () => reject(new Error('synthetic open failed'))
  })
}

describe('persistent execution admission', () => {
  it('commits one admission atomically across concurrent database connections', async () => {
    const action = call().action
    const results = await Promise.all(Array.from({ length: 8 }, () => admitExecution(action)))
    expect(results.filter(value => value === 'admitted')).toHaveLength(1)
    expect(results.filter(value => value === 'duplicate')).toHaveLength(7)
    await finishExecution(action)
    await finishExecution(action)
    expect(await admitExecution(action)).toBe('duplicate')
    expect(await admitExecution({ ...action, requestDigest: 'b'.repeat(64) })).toBe('conflict')
  })

  it('executes a concurrent retransmission once and keeps only identity/phase metadata', async () => {
    const original = call()
    const work = vi.fn(async () => ({ ok: true, result: { text: 'synthetic-private-page-result' } }))
    const replies = await Promise.all([executeRecordedTool(original, signal(), work), executeRecordedTool({ ...original, id: 'another-attempt' }, signal(), work)])
    expect(work).toHaveBeenCalledTimes(1)
    expect(replies.filter(reply => reply.ok)).toHaveLength(1)
    expect(replies.find(reply => !reply.ok)?.error?.code).toBe('action-duplicate')
    const stored = await records()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ ...original.action, phase: 'finished' })
    expect(Object.keys(stored[0]!).sort()).toEqual(['actionId', 'createdAt', 'finishedAt', 'phase', 'requestDigest'])
    expect(JSON.stringify(stored)).not.toMatch(/synthetic-private-input|synthetic-private-page-result/)
  })

  it('refuses a valid different command using an already bound action id', async () => {
    const original = call()
    await executeRecordedTool(original, signal(), async () => ({ ok: true }))
    const changed = call({ args: { text: 'changed' } })
    expect(changed.action.actionId).toBe(original.action.actionId)
    const work = vi.fn(async () => ({ ok: true }))
    expect((await executeRecordedTool(changed, signal(), work)).error?.code).toBe('action-conflict')
    expect(work).not.toHaveBeenCalled()
  })

  it('rejects tampered arguments before admitting an id or touching the page', async () => {
    const original = call()
    const work = vi.fn(async () => ({ ok: true }))
    expect((await executeRecordedTool({ ...original, args: { text: 'tampered' } }, signal(), work)).error?.code).toBe('action-conflict')
    expect(work).not.toHaveBeenCalled()
    expect((await executeRecordedTool(original, signal(), work)).ok).toBe(true)
    expect(work).toHaveBeenCalledTimes(1)
  })

  it.each(['admitted', 'finished'] as const)('refuses replay after module/worker state is rebuilt (%s)', async phase => {
    const original = call()
    await admitExecution(original.action)
    if (phase === 'finished') await finishExecution(original.action)
    vi.resetModules()
    const rebuilt = await import('../src/background/execution-receipts.ts')
    const work = vi.fn(async () => ({ ok: true }))
    const reply = await rebuilt.executeRecordedTool({ ...original, id: 'after-restart' }, signal(), work)
    expect(reply.error?.code).toBe('action-duplicate')
    expect(work).not.toHaveBeenCalled()
  })

  it('never dispatches when admission storage aborts and does not invent an in-memory fallback', async () => {
    const originalAdd = IDBObjectStore.prototype.add
    const write = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      const request = originalAdd.apply(this, args)
      this.transaction.abort()
      return request
    })
    const work = vi.fn(async () => ({ ok: true }))
    expect((await executeRecordedTool(call(), signal(), work)).error?.code).toBe('receipt-unavailable')
    expect(work).not.toHaveBeenCalled()
    write.mockRestore()
    expect((await executeRecordedTool(call(), signal(), work)).ok).toBe(true)
  })

  it('retains the admission fence if completion storage aborts after execution', async () => {
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      const request = originalPut.apply(this, args)
      this.transaction.abort()
      return request
    })
    const original = call()
    const work = vi.fn(async () => ({ ok: true, result: { text: 'synthetic result' } }))
    expect((await executeRecordedTool(original, signal(), work)).error?.code).toBe('receipt-unavailable')
    expect(work).toHaveBeenCalledTimes(1)
    expect((await records())[0]?.phase).toBe('admitted')
    expect((await executeRecordedTool({ ...original, id: 'retry' }, signal(), work)).error?.code).toBe('action-duplicate')
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('checks cancellation and expiry after digest verification and before side effects', async () => {
    const abort = new AbortController()
    abort.abort()
    const work = vi.fn(async () => ({ ok: true }))
    expect((await executeRecordedTool(call(), abort.signal, work)).ok).toBe(false)
    expect((await executeRecordedTool(call({ expiresAt: Date.now() - 1 }), signal(), work)).ok).toBe(false)
    expect(work).not.toHaveBeenCalled()
  })

  it('rechecks cancellation after the admission transaction has started', async () => {
    const abort = new AbortController()
    const originalAdd = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      const request = originalAdd.apply(this, args)
      abort.abort()
      return request
    })
    const original = call()
    const work = vi.fn(async () => ({ ok: true }))
    expect((await executeRecordedTool(original, abort.signal, work)).ok).toBe(false)
    expect(work).not.toHaveBeenCalled()
    expect((await records())[0]?.phase).toBe('finished')
    expect((await executeRecordedTool(original, signal(), work)).error?.code).toBe('action-duplicate')
  })

  it('fails closed on unavailable IndexedDB', async () => {
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('synthetic unavailable storage') } })
    const work = vi.fn(async () => ({ ok: true }))
    expect((await executeRecordedTool(call(), signal(), work)).error?.code).toBe('receipt-unavailable')
    expect(work).not.toHaveBeenCalled()
  })

  it('preserves a corrupt fence and refuses execution instead of deleting or repairing it', async () => {
    const original = call()
    await admitExecution(original.action)
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('dsh-browser-execution', 1)
      open.onsuccess = () => {
        const db = open.result
        const transaction = db.transaction('receipts', 'readwrite')
        transaction.objectStore('receipts').put({ ...original.action, phase: 'invented', createdAt: 1 })
        transaction.oncomplete = () => { db.close(); resolve() }
        transaction.onerror = () => { db.close(); reject(new Error('synthetic corruption failed')) }
      }
    })
    const work = vi.fn(async () => ({ ok: true }))
    expect((await executeRecordedTool(original, signal(), work)).error?.code).toBe('receipt-unavailable')
    expect(work).not.toHaveBeenCalled()
    expect((await records())[0]?.phase).toBe('invented')
  })

  it('refuses new actions at capacity without evicting existing replay fences', async () => {
    const original = call()
    await admitExecution(original.action)
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('dsh-browser-execution', 1)
      open.onsuccess = () => {
        const db = open.result
        const transaction = db.transaction('receipts', 'readwrite')
        const store = transaction.objectStore('receipts')
        for (let i = 1; i < 5000; i += 1) store.add({ actionId: `synthetic-capacity-${i}`, requestDigest: 'a'.repeat(64), phase: 'admitted', createdAt: 1 })
        transaction.oncomplete = () => { db.close(); resolve() }
        transaction.onerror = () => { db.close(); reject(new Error('synthetic capacity setup failed')) }
      }
    })
    const work = vi.fn(async () => ({ ok: true }))
    expect((await executeRecordedTool(call({ id: 'new-action' }), signal(), work)).error?.code).toBe('receipt-unavailable')
    expect(work).not.toHaveBeenCalled()
    expect(await admitExecution(original.action)).toBe('duplicate')
    expect(await records()).toHaveLength(5000)
  })
})
