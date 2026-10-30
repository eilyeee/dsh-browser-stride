// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { requestBrowserPairing, type BrowserPairingStatus } from '../src/background/pairing-client.ts'

const bridge = 'ws://127.0.0.1:3080/ext/bridge'
const installation = 'synthetic-installation-1111'
const requestId = '11111111-1111-4111-8111-111111111111'
const pending = () => ({ requestId, verificationCode: 'AABBCCDD', expiresAt: Date.now() + 60_000 })

describe('background pairing client', () => {
  it('keeps proof and credentials out of panel status and never uses browser cookies', async () => {
    const messages: BrowserPairingStatus[] = []
    const payloads: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:3080/ext/bridge-pairing-request')
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
      const payload = JSON.parse(init!.body as string)
      payloads.push(payload)
      return Response.json(payload.action === 'request' ? pending() : { status: 'paired', credential: 'c'.repeat(64) })
    })
    const credential = await requestBrowserPairing(bridge, installation, new AbortController().signal, value => messages.push(value), fetchImpl, async () => {})
    expect(credential).toBe('c'.repeat(64))
    expect(payloads[0].proofKey).toMatch(/^[a-f0-9]{64}$/)
    expect(payloads[1].proofKey).toBe(payloads[0].proofKey)
    expect(JSON.stringify(messages)).not.toContain(payloads[0].proofKey)
    expect(JSON.stringify(messages)).not.toContain(credential)
    expect(messages).toEqual([{ phase: 'pending', verificationCode: 'AABBCCDD', hostUrl: 'http://127.0.0.1:3080/' }])
  })

  it('rejects non-local destinations before any credential or proof is sent', async () => {
    const fetchImpl = vi.fn()
    await expect(requestBrowserPairing('ws://evil.example/ext/bridge', installation, new AbortController().signal, vi.fn(), fetchImpl)).rejects.toThrow('invalid-host')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('cancels pending requests when their panel lease ends', async () => {
    const controller = new AbortController()
    const payloads: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(init!.body as string)
      payloads.push(payload)
      return Response.json(payload.action === 'request' ? pending() : { cancelled: true })
    })
    await expect(requestBrowserPairing(bridge, installation, controller.signal, () => controller.abort(), fetchImpl,
      async signal => { signal.throwIfAborted() })).rejects.toThrow()
    expect(payloads.map(payload => payload.action)).toEqual(['request', 'cancel'])
  })

  it.each(['pairing-denied', 'invalid-response'])('does not accept %s as permission to connect', async code => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(init!.body as string)
      return Response.json(payload.action === 'request' ? pending() : { status: code === 'pairing-denied' ? 'denied' : 'paired', credential: 'invalid' })
    })
    await expect(requestBrowserPairing(bridge, installation, new AbortController().signal, vi.fn(), fetchImpl, async () => {})).rejects.toThrow(code)
  })

  it('reports a protocol mismatch instead of silently falling back to unauthenticated pairing', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'protocol-upgrade-host' }, { status: 409 }))
    await expect(requestBrowserPairing(bridge, installation, new AbortController().signal, vi.fn(), fetchImpl, async () => {})).rejects.toThrow('protocol-upgrade-host')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
