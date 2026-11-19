// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsNotEnabledError, PageDiagnostics } from '../src/background/diagnostics.ts'
import type { DebuggerPages, ReadDebugLease } from '../src/background/debugger-pages.ts'
import { diagnosticRoute, diagnosticsSchema } from '@eilyeee/dsh-browser-stride/src/diagnostics.ts'

function fixture() {
  let receive: (method: string, params?: Record<string, unknown>) => void = () => {}
  let loader = 'a', allowed = true
  const release = vi.fn(async () => {})
  const command = vi.fn(async (method: string) => method === 'Page.getFrameTree'
    ? { frameTree: { frame: { id: 'main', loaderId: loader, url: 'https://example.test/app' } } } : {})
  const lease: ReadDebugLease = { current: () => allowed, command: command as ReadDebugLease['command'], release, detachIfExclusive: async () => false,
    contexts: () => [{ id: 7, frameId: 'main', uniqueId: 'main-a' }], subscribe: listener => { receive = listener; return () => { receive = () => {} } } }
  const acquireReadLease = vi.fn(async () => lease)
  const diagnostics = new PageDiagnostics({ acquireReadLease } as unknown as DebuggerPages)
  const emit = (method: string, params: Record<string, unknown> = {}) => receive(method, params)
  const error = (executionContextId = 7, extra = {}) => emit('Runtime.consoleAPICalled', { type: 'error', timestamp: Date.now(), executionContextId,
    args: [{ className: 'TypeError', value: 'PRIVATE-MESSAGE', description: 'PRIVATE-STACK' }], stackTrace: { callFrames: [{ url: 'https://example.test/api/customer/private-name?token=PRIVATE-QUERY', lineNumber: 4 }] }, ...extra })
  return { diagnostics, command, release, acquireReadLease, emit, error, current: () => allowed, revoke: () => { allowed = false }, navigate: () => { loader = 'b' } }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('native-owned page diagnostics', () => {
  it('releases the native lease when its selected purpose ends, even without another event', async () => {
    const h = fixture(); let selected = true
    await h.diagnostics.start(42, () => selected, h.current, 's')
    selected = false
    expect(h.diagnostics.status(42).enabled).toBe(false)
    await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce())
  })
  it('cannot activate through a read, or read another native session capture', async () => {
    const h = fixture()
    await expect(h.diagnostics.read(42, h.current, 's')).rejects.toBeInstanceOf(DiagnosticsNotEnabledError)
    await expect(h.diagnostics.read(42, () => false, 's')).rejects.toThrow('diagnostics-document-changed')
    expect(h.acquireReadLease).not.toHaveBeenCalled()
    await expect(h.diagnostics.start(42, h.current, h.current, '')).rejects.toThrow('session-required')
    await h.diagnostics.start(42, h.current, h.current, 's')
    await expect(h.diagnostics.read(42, h.current, 'another')).rejects.toBeInstanceOf(DiagnosticsNotEnabledError)
    await h.diagnostics.stop(42)
  })
  it('returns only bounded main-document metadata, excluding secret messages, queries, bodies and headers', async () => {
    const h = fixture(); await h.diagnostics.start(42, h.current, h.current, 's')
    h.error(); h.error(8); h.error(7, { timestamp: 0 }); h.error(7, { type: 'log' })
    h.emit('Network.requestWillBeSent', { requestId: 'r', frameId: 'main', loaderId: 'a', wallTime: Date.now() / 1000, type: 'Fetch',
      request: { method: 'GET', url: 'https://example.test/api/customer/PRIVATE-PATH?token=PRIVATE-QUERY', headers: { Authorization: 'PRIVATE-AUTH' }, postData: 'PRIVATE-BODY' } })
    h.emit('Network.responseReceived', { requestId: 'r', frameId: 'main', response: { status: 500, headers: { 'Set-Cookie': 'PRIVATE-COOKIE' } } })
    h.emit('Network.loadingFinished', { requestId: 'r' })
    const value = await h.diagnostics.read(42, h.current, 's')
    expect(value).toMatchObject({ complete: false, scope: 'authorized-top-document', entries: [
      { kind: 'console', errorType: 'TypeError', route: '/api/customer/[segment]', line: 4 },
      { kind: 'network', status: 500, failure: 'http-error', route: '/api/customer/[segment]' },
    ] })
    expect(JSON.stringify(value)).not.toContain('PRIVATE-')
    expect(diagnosticsSchema.safeParse({ ...value, complete: true }).success).toBe(false)
    expect(diagnosticsSchema.safeParse({ ...value, entries: [{ ...value.entries[0], message: 'secret' }] }).success).toBe(false)
    await h.diagnostics.stop(42)
  })
  it('rejects reused context IDs from child frames and ignores stale destroy events', async () => {
    const h = fixture(); await h.diagnostics.start(42, h.current, h.current, 's')
    h.emit('Runtime.executionContextCreated', { context: { id: 7, uniqueId: 'child', auxData: { frameId: 'child', isDefault: true } } }); h.error()
    h.emit('Runtime.executionContextCreated', { context: { id: 7, uniqueId: 'new', auxData: { frameId: 'main', isDefault: true } } })
    h.emit('Runtime.executionContextDestroyed', { executionContextId: 7, executionContextUniqueId: 'old' }); h.error()
    expect((await h.diagnostics.read(42, h.current, 's')).entries).toHaveLength(1)
    await h.diagnostics.stop(42)
  })
  it.each(['child', 'old-loader', 'past'])('does not include %s network events', async reason => {
    const h = fixture(); await h.diagnostics.start(42, h.current, h.current, 's')
    h.emit('Network.requestWillBeSent', { requestId: 'r', frameId: reason === 'child' ? 'child' : 'main', loaderId: reason === 'old-loader' ? 'old' : 'a',
      wallTime: reason === 'past' ? 1 : Date.now() / 1000, request: { method: 'GET', url: 'https://example.test/api' } })
    h.emit('Network.loadingFailed', { requestId: 'r', errorText: 'PRIVATE-ERROR' })
    expect((await h.diagnostics.read(42, h.current, 's')).entries).toHaveLength(0)
    await h.diagnostics.stop(42)
  })
  it('bounds retention, expires natively, and cannot be prolonged by model reads', async () => {
    vi.useFakeTimers(); const h = fixture(); await h.diagnostics.start(42, h.current, h.current, 's')
    for (let i = 0; i < 205; i++) h.error()
    const value = await h.diagnostics.read(42, h.current, 's', 500)
    expect(value.entries).toHaveLength(200); expect(value.dropped).toBe(5); expect(value.omitted).toContain('buffer-overflow')
    await vi.advanceTimersByTimeAsync(600_000)
    await expect(h.diagnostics.read(42, h.current, 's')).rejects.toThrow('not-enabled')
    expect(h.release).toHaveBeenCalledOnce()
  })
  it.each(['revoke', 'navigate', 'event'])('clears a capture on %s without returning old metadata', async reason => {
    const h = fixture(); await h.diagnostics.start(42, h.current, h.current, 's'); h.error()
    if (reason === 'revoke') h.revoke()
    if (reason === 'navigate') h.navigate()
    if (reason === 'event') h.emit('Page.frameNavigated', { frame: { id: 'main' } })
    await expect(h.diagnostics.read(42, h.current, 's')).rejects.toThrow()
    expect(h.diagnostics.status(42).enabled).toBe(false)
    await h.diagnostics.stop(42)
  })
  it('cleans partial enables and refuses a stale stop against a successor', async () => {
    const h = fixture(); h.command.mockRejectedValueOnce(Error('synthetic enable failure'))
    await expect(h.diagnostics.start(42, h.current, h.current, 's')).rejects.toThrow('synthetic')
    expect(h.release).toHaveBeenCalledOnce()
    const previous = await h.diagnostics.start(42, h.current, h.current, 's')
    await h.diagnostics.start(42, h.current, h.current, 's')
    await expect(h.diagnostics.stop(42, previous.captureId)).rejects.toThrow('stale')
    expect(h.diagnostics.status(42).enabled).toBe(true)
    await h.diagnostics.stop(42)
  })
  it('masks arbitrary path words and credential-bearing route segments', () => {
    expect(diagnosticRoute('https://name:secret@host/api/token/users?secret=key#private')).toBe('/api/[segment]/[segment]')
    expect(diagnosticRoute('https://host/api/customer/张三')).toBe('/api/customer/[segment]')
    expect(diagnosticRoute('https://host/' + 'x'.repeat(5000))).toBe('/[segment]')
  })
})
