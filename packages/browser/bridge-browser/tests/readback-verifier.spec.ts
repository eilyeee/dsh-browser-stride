import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReadbackVerifier } from '../src/readback-verifier.ts'
import type { BrowserRunRecord } from '../src/run-store.ts'

afterEach(() => vi.useRealTimers())
const run = { runId: 'synthetic-run', controlRevision: 2 } as BrowserRunRecord
const url = 'https://synthetic.test/settings#edit'
function setup() {
  const data = { version: 8, record: { enabled: true, count: 4 } }
  const result = { body: JSON.stringify(data), contextKey: 'synthetic-tenant-record', observedAt: Date.now(), artifactRef: 'readback_fixture_8' }
  const read = vi.fn(async () => ({ ...result, observedAt: Date.now() }))
  const config = { targetUrl: url, contextKey: result.contextKey, versionPath: ['version'], baselineVersion: 7,
    checks: [{ path: ['record', 'enabled'], equals: true }, { path: ['record', 'count'], equals: 4 }], read }
  const verifier = createReadbackVerifier(config)
  const controller = new AbortController()
  const verify = () => verifier.verify({ run, url, signal: controller.signal })
  return { config, read, result, data, verifier, controller, verify }
}
describe('independent versioned readback', () => {
  it('reads once in the captured scope and records only artifact identity and a body digest', async () => {
    const h = setup(), evidence = await h.verify()
    expect(h.read).toHaveBeenCalledExactlyOnceWith({ runId: run.runId, controlRevision: 2, targetUrl: url, signal: expect.any(AbortSignal) })
    expect(evidence).toEqual({ url, artifactRefs: ['readback_fixture_8', expect.stringMatching(/^readback-sha256:[a-f0-9]{64}$/)] })
    expect(JSON.stringify(evidence)).not.toContain('enabled')
  })
  it.each(['context', 'unchanged', 'older', 'mismatch', 'missing', 'wrong-type', 'malformed', 'oversize', 'stale', 'future', 'artifact'])('does not verify a %s result or retry it', async reason => {
    const h = setup()
    if (reason === 'context') h.result.contextKey = 'different-tenant'
    if (reason === 'unchanged') h.data.version = 7
    if (reason === 'older') h.data.version = 6
    if (reason === 'mismatch') h.data.record.count = 5
    if (reason === 'missing') delete (h.data.record as { count?: number }).count
    h.result.body = reason === 'wrong-type' ? JSON.stringify({ version: '8', record: h.data.record })
      : reason === 'malformed' ? '{' : reason === 'oversize' ? 'x'.repeat(262145) : JSON.stringify(h.data)
    if (reason === 'artifact') h.result.artifactRef = 'https://private.test/secret'
    if (reason === 'stale' || reason === 'future') h.read.mockImplementation(async () => ({ ...h.result, observedAt: Date.now() + (reason === 'stale' ? -1000 : 1000) }))
    expect(await h.verify()).toBeUndefined()
    expect(h.read).toHaveBeenCalledOnce()
  })
  it('pins the exact target and copies configuration before the first asynchronous read', async () => {
    const h = setup()
    h.config.checks[1]!.equals = 999; h.config.versionPath[0] = 'different'; h.config.contextKey = 'different'
    expect(h.verifier.acceptsTarget('https://synthetic.test/settings#other')).toBe(false)
    expect(h.verifier.acceptsTarget('https://synthetic.test.evil/settings#edit')).toBe(false)
    expect(await h.verifier.verify({ run, url: 'https://other.test/', signal: h.controller.signal })).toBeUndefined()
    expect(h.read).not.toHaveBeenCalled()
    expect(await h.verify()).toBeDefined()
  })
  it('does not call a reader after cancellation or accept its late result', async () => {
    const h = setup(); h.controller.abort()
    expect(await h.verify()).toBeUndefined(); expect(h.read).not.toHaveBeenCalled()
    const next = setup()
    next.read.mockImplementation(async () => { next.controller.abort(); return next.result })
    expect(await next.verify()).toBeUndefined(); expect(next.read).toHaveBeenCalledOnce()
  })
  it('bounds a reader that ignores cancellation and never retries it', async () => {
    vi.useFakeTimers()
    const h = setup(); h.read.mockImplementation(() => new Promise(() => {}))
    const result = h.verify(); await vi.advanceTimersByTimeAsync(10001)
    expect(await result).toBeUndefined(); expect(h.read).toHaveBeenCalledOnce()
  })
  it('does not expose reader errors or accept inherited properties', async () => {
    const h = setup(); h.read.mockRejectedValue(Error('private backend error'))
    expect(await h.verify()).toBeUndefined()
    expect(() => createReadbackVerifier({ ...h.config, versionPath: ['__proto__', 'version'] })).toThrow('readback-config-invalid')
    expect(() => createReadbackVerifier({ ...h.config, targetUrl: 'https://name:secret@synthetic.test/' })).toThrow('readback-config-invalid')
  })
})
