import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairingStore, PAIRING_CODE_TTL_MS } from '../src/pairing.ts'
import { PairingRequests, MAX_PAIRING_REQUESTS } from '../src/pairing-requests.ts'
import { createPairingOwnerRoute } from '../src/pairing-http.ts'

const installation = 'synthetic-installation-1111'
const proof = 'a'.repeat(64)
const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function fixture(now?: () => number) {
  const dir = await mkdtemp(join(tmpdir(), 'stride-owner-pairing-'))
  directories.push(dir)
  const file = join(dir, 'pairings.json')
  const store = new PairingStore(file)
  const revoke = vi.fn()
  return { file, store, revoke, requests: new PairingRequests(store, revoke, now) }
}

describe('owner-confirmed browser pairing', () => {
  it('requires the matching owner decision and requesting proof, then issues once and persists only a hash', async () => {
    const { requests, store, file, revoke } = await fixture()
    const request = requests.request(installation, proof)
    expect(JSON.stringify(requests.list())).not.toContain(proof)
    expect(await requests.claim(request.requestId, proof)).toEqual({ status: 'pending' })
    expect(requests.decide(request.requestId, 'WRONG', 'approve')).toBe(false)
    await expect(requests.claim(request.requestId, 'b'.repeat(64))).rejects.toThrow('pairing-unavailable')
    expect(await store.list()).toEqual([])
    expect(requests.decide(request.requestId, request.verificationCode, 'approve')).toBe(true)
    const results = await Promise.allSettled([requests.claim(request.requestId, proof), requests.claim(request.requestId, proof)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const paired = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ status: 'paired'; credential: string }>).value
    expect(paired.status).toBe('paired')
    expect(await new PairingStore(file).authenticate(installation, paired.credential)).toEqual({})
    expect(await store.authenticate('synthetic-other-installation', paired.credential)).toBeUndefined()
    const persisted = await readFile(file, 'utf8')
    expect(persisted).not.toContain(paired.credential)
    expect(persisted).not.toContain(proof)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(installation)
  })

  it('enforces denial, cancellation, expiry, request capacity and restart fencing', async () => {
    let now = 1_000
    const { requests, store } = await fixture(() => now)
    const denied = requests.request(installation, proof)
    requests.decide(denied.requestId, denied.verificationCode, 'deny')
    expect(await requests.claim(denied.requestId, proof)).toEqual({ status: 'denied' })
    expect(requests.decide(denied.requestId, denied.verificationCode, 'approve')).toBe(false)
    requests.cancel(denied.requestId, proof)
    await expect(requests.claim(denied.requestId, proof)).rejects.toThrow('pairing-unavailable')
    for (let i = 0; i < MAX_PAIRING_REQUESTS; i++) requests.request(`synthetic-installation-${i}`, proof)
    expect(() => requests.request(installation, proof)).toThrow('pairing-busy')
    now += PAIRING_CODE_TTL_MS
    expect(requests.list()).toEqual([])
    const pending = requests.request(installation, proof)
    requests.decide(pending.requestId, pending.verificationCode, 'approve')
    await requests.close()
    await expect(requests.claim(pending.requestId, proof)).rejects.toThrow('pairing-unavailable')
    expect(() => requests.request(installation, proof)).toThrow('pairing-unavailable')
    expect(await store.list()).toEqual([])
  })

  it('refuses duplicate installation requests and drains enrollment before a new owner can reopen', async () => {
    const { requests, store } = await fixture()
    const request = requests.request(installation, proof)
    expect(() => requests.request(installation, 'b'.repeat(64))).toThrow('pairing-busy')
    let release!: () => void
    vi.spyOn(store, 'enroll').mockImplementation(async () => new Promise<string>(resolve => { release = () => resolve('c'.repeat(64)) }))
    requests.decide(request.requestId, request.verificationCode, 'approve')
    const claim = requests.claim(request.requestId, proof)
    let closed = false
    const closing = requests.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await claim
    await closing
    expect(closed).toBe(true)
  })

  it('does not erase an existing enrollment if credential persistence fails', async () => {
    const { requests, store } = await fixture()
    const existing = await store.enroll(installation)
    const request = requests.request(installation, proof)
    requests.decide(request.requestId, request.verificationCode, 'approve')
    vi.spyOn(store, 'enroll').mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(requests.claim(request.requestId, proof)).rejects.toThrow('storage unavailable')
    await expect(requests.claim(request.requestId, proof)).rejects.toThrow('pairing-unavailable')
    expect(await store.authenticate(installation, existing)).toEqual({})
  })

  it('invalidates approved but unclaimed requests when their installation is revoked', async () => {
    const { requests, store } = await fixture()
    const request = requests.request(installation, proof)
    requests.decide(request.requestId, request.verificationCode, 'approve')
    requests.revokeInstallation(installation)
    await expect(requests.claim(request.requestId, proof)).rejects.toThrow('pairing-unavailable')
    expect(await store.list()).toEqual([])
  })

  it('requires a same-origin JSON decision and rejects stale confirmation', async () => {
    const { requests } = await fixture()
    const request = requests.request(installation, proof)
    const route = createPairingOwnerRoute(requests)
    expect(route.path).toBe('/api/stride-browser-pairing')
    const decision = JSON.stringify({ requestId: request.requestId, verificationCode: request.verificationCode, decision: 'approve' })
    const make = (origin: string, contentType = 'application/json') => new Request('http://dsh.internal/api/stride-browser-pairing', {
      method: 'POST', headers: { host: '127.0.0.1:3080', origin, 'content-type': contentType }, body: decision,
    })
    expect((await route.fetch(make('https://untrusted.example'))).status).toBe(403)
    expect((await route.fetch(make('http://127.0.0.1:3080', 'text/plain'))).status).toBe(415)
    expect((await route.fetch(make('http://127.0.0.1:3080'))).status).toBe(200)
    expect((await route.fetch(make('http://127.0.0.1:3080'))).status).toBe(409)
  })
})
