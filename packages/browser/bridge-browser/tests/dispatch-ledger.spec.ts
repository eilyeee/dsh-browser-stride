import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunStorage } from './helpers/run-storage.ts'
import { transportReceipt } from '../src/dispatch-ledger.ts'

const fixtures: Awaited<ReturnType<typeof createRunStorage>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
async function setup() {
  const fixture = await createRunStorage()
  fixtures.push(fixture)
  return { ...fixture, ledger: fixture.store.dispatches }
}
const input = (requestId = 'synthetic-request') => ({ requestId, connectionId: 'synthetic-connection',
  installationId: 'synthetic-installation', sessionId: 'synthetic-session', name: 'browser_type',
  args: { elementRef: 'synthetic-observation:1', text: 'synthetic-private-field-value' }, expiresAt: Date.now() + 60_000 })

describe('durable browser dispatch ledger', () => {
  it('binds trusted run metadata into the immutable transport record without adding it to the wire digest', async () => {
    const { ledger } = await setup()
    const request = { ...input(), runId: 'synthetic-run', controlRevision: 2 }
    const row = await ledger.prepare(request)
    expect(row).toMatchObject({ runId: request.runId, controlRevision: 2, sessionId: request.sessionId })
    await expect(ledger.prepare({ ...request, controlRevision: 3 })).rejects.toMatchObject({ code: 'request-conflict' })
    await expect(ledger.prepare({ ...input('partial-scope'), runId: 'synthetic-run' })).rejects.toThrow()
    await expect(ledger.prepare({ ...input('missing-session'), sessionId: undefined, runId: 'synthetic-run', controlRevision: 0 })).rejects.toThrow()
  })
  it('stores immutable identities and a digest without arguments or page results', async () => {
    const { ledger, dispatchFile } = await setup()
    const material = input()
    const pending = ledger.prepare(material)
    material.args.text = 'mutated-input'
    const row = await pending
    expect(row).toMatchObject({ state: 'prepared', effect: 'write', name: 'browser_type' })
    expect(row.actionId).not.toBe(row.requestId)
    expect(row.requestDigest).toMatch(/^[a-f0-9]{64}$/)
    row.name = 'mutated-name'
    expect(ledger.get(row.requestId)?.name).toBe('browser_type')
    const disk = await readFile(dispatchFile, 'utf8')
    expect(disk).not.toContain('synthetic-private-field-value')
    expect(disk).not.toContain('mutated-input')
    expect(disk).not.toContain('"args"')
    expect((await stat(dispatchFile)).mode & 0o777).toBe(0o600)
  })

  it('recognizes canonical duplicate requests but refuses changed request material', async () => {
    const { ledger } = await setup()
    const request = input()
    const row = await ledger.prepare(request)
    expect(await ledger.prepare({ ...request, args: { text: request.args.text, elementRef: request.args.elementRef } })).toEqual(row)
    for (const changed of [{ name: 'browser_click' }, { connectionId: 'other-connection' }, { sessionId: 'other-session' },
      { installationId: 'other-installation' }, { expiresAt: request.expiresAt + 1 }, { args: { text: 'changed' } }]) {
      await expect(ledger.prepare({ ...request, ...changed })).rejects.toMatchObject({ code: 'request-conflict' })
    }
    expect(ledger.list()).toHaveLength(1)
  })

  it.each(['browser_snapshot', 'browser_get_text', 'browser_wait', 'browser_list_tabs', 'browser_future_write'])('classifies %s with the shared extension policy', async name => {
    const { ledger } = await setup()
    expect((await ledger.prepare({ ...input(), name })).effect).toBe(name === 'browser_future_write' ? 'write' : 'read')
  })

  it('requires a dispatch marker before a receipt, and never turns a receipt into verified success', async () => {
    const { ledger } = await setup()
    const row = await ledger.prepare(input())
    await expect(ledger.settle(row.requestId, { state: 'returned', receipt: { ok: true } })).rejects.toMatchObject({ code: 'invalid-state' })
    await ledger.markSent(row.requestId)
    const returned = await ledger.settle(row.requestId, { state: 'returned', receipt: { ok: true } })
    expect(returned.state).toBe('returned')
    expect(returned).not.toHaveProperty('outcome')
    expect(await ledger.settle(row.requestId, { state: 'returned', receipt: { ok: true } })).toEqual(returned)
    await expect(ledger.markSent(row.requestId)).rejects.toMatchObject({ code: 'invalid-state' })
    await expect(ledger.settle(row.requestId, { state: 'returned', receipt: { ok: false, errorCode: 'internal' } })).rejects.toMatchObject({ code: 'request-conflict' })
  })

  it('retains the interruption when a late receipt resolves transport uncertainty', async () => {
    const { ledger } = await setup()
    const row = await ledger.prepare(input())
    await ledger.markSent(row.requestId)
    const unresolved = await ledger.settle(row.requestId, { state: 'unresolved', reason: 'cancelled' })
    const returned = await ledger.settle(row.requestId, { state: 'returned', receipt: { ok: false, errorCode: 'action-failed' } })
    expect(returned.interruption).toEqual(unresolved.interruption)
    expect(returned.state).toBe('returned')
    expect(await ledger.settle(row.requestId, { state: 'unresolved', reason: 'expired' })).toEqual(returned)
  })

  it('classifies pre-send cancellation accurately even after the conservative marker', async () => {
    const { ledger } = await setup()
    const row = await ledger.prepare(input())
    await ledger.markSent(row.requestId)
    const cancelled = await ledger.settle(row.requestId, { state: 'not_sent', reason: 'cancelled' })
    expect(cancelled.state).toBe('not_sent')
    await expect(ledger.settle(row.requestId, { state: 'returned', receipt: { ok: true } })).rejects.toMatchObject({ code: 'invalid-state' })
  })

  it('reopens prepared records as not sent and marked records as unresolved without replay', async () => {
    const { ledger, store, open } = await setup()
    await ledger.prepare(input('prepared'))
    await ledger.prepare(input('marked'))
    await ledger.markSent('marked')
    await ledger.prepare(input('returned'))
    await ledger.markSent('returned')
    const returned = await ledger.settle('returned', { state: 'returned', receipt: { ok: true } })
    await store.close()
    const reopened = (await open()).dispatches
    expect(reopened.get('prepared')).toMatchObject({ state: 'not_sent', interruption: { reason: 'interrupted' } })
    expect(reopened.get('marked')).toMatchObject({ state: 'unresolved', interruption: { reason: 'interrupted' } })
    expect(reopened.get('returned')).toEqual(returned)
  })

  it('preserves historical transport-only rows without inventing a v2 action identity', async () => {
    const { ledger, store, open, dispatchFile } = await setup()
    await ledger.prepare(input())
    await store.close()
    const data = JSON.parse(await readFile(dispatchFile, 'utf8'))
    const row = data.tables.dispatches['synthetic-request']
    row.requestDigest = row.transportDigest
    delete row.transportDigest
    delete row.identityVersion
    await writeFile(dispatchFile, JSON.stringify(data))
    const historical = (await open()).dispatches.get('synthetic-request')!
    expect(historical.identityVersion).toBeUndefined()
    expect(historical.transportDigest).toBeUndefined()
    expect(historical.requestDigest).toBe(row.requestDigest)
    expect(historical.state).toBe('not_sent')
  })

  it('stops later writes after a storage failure until disk is reopened', async () => {
    const { ledger, storageRoot, store, open } = await setup()
    const row = await ledger.prepare(input())
    await rename(storageRoot, storageRoot + '-backup')
    await writeFile(storageRoot, 'synthetic-obstacle')
    await expect(ledger.markSent(row.requestId)).rejects.toThrow()
    expect(ledger.get(row.requestId)?.state).toBe('prepared')
    await rm(storageRoot)
    await rename(storageRoot + '-backup', storageRoot)
    await expect(ledger.markSent(row.requestId)).rejects.toMatchObject({ code: 'storage-unavailable' })
    await store.close()
    expect((await open()).dispatches.get(row.requestId)?.state).toBe('not_sent')
  })

  it('purges only the owning session, after session storage deletion succeeds', async () => {
    const { ledger } = await setup()
    await ledger.prepare(input())
    await ledger.settle('synthetic-request', { state: 'not_sent', reason: 'cancelled' })
    await ledger.prepare({ ...input('other-request'), sessionId: 'another-session' })
    await expect(ledger.purgeSession('synthetic-session', async () => { throw new Error('synthetic deletion failed') })).rejects.toThrow()
    expect(ledger.get('synthetic-request')).toBeDefined()
    await ledger.purgeSession('synthetic-session', async () => { expect(ledger.get('synthetic-request')).toBeDefined() })
    expect(ledger.list('synthetic-session')).toEqual([])
    expect(ledger.get('other-request')).toBeDefined()
  })

  it('refuses to delete a session with an active dispatch before touching its storage', async () => {
    const { ledger } = await setup()
    await ledger.prepare(input())
    let deleted = false
    await expect(ledger.purgeSession('synthetic-session', async () => { deleted = true })).rejects.toMatchObject({ code: 'session-busy' })
    expect(deleted).toBe(false)
  })

  it.each(['invalid-state', 'key-mismatch', 'invalid-receipt', 'future-version'])('preserves corrupt storage and fails closed (%s)', async kind => {
    const { ledger, store, open, dispatchFile } = await setup()
    await ledger.prepare(input())
    await ledger.markSent('synthetic-request')
    await ledger.settle('synthetic-request', { state: 'returned', receipt: { ok: true } })
    await store.close()
    const data = JSON.parse(await readFile(dispatchFile, 'utf8'))
    const row = data.tables.dispatches['synthetic-request']
    if (kind === 'invalid-state') row.state = 'verified'
    if (kind === 'key-mismatch') row.requestId = 'different-request'
    if (kind === 'invalid-receipt') row.receipt = { ok: false }
    if (kind === 'future-version') data.unit.version += 1
    const corrupt = JSON.stringify(data)
    await writeFile(dispatchFile, corrupt)
    await expect(open()).rejects.toThrow()
    expect(await readFile(dispatchFile, 'utf8')).toBe(corrupt)
  })

  it('sanitizes unknown error codes instead of persisting peer-provided text', () => {
    expect(transportReceipt(false, 'synthetic-private-peer-string')).toEqual({ ok: false, errorCode: 'unknown' })
    expect(transportReceipt(true, 'internal')).toEqual({ ok: true })
  })
})
