import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskBriefStore } from '../src/task-brief.ts'
import { briefSessionItems, openSessionBrief, saveSessionBrief } from '../src/task-brief-sessions.ts'
import { withSessionDeferral } from '../src/session-deferral.ts'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../src/host-api.ts'
import { createRunStorage } from './helpers/run-storage.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const input = { goal: 'Synthetic saved notes', projectPath: '/reference/project', materials: [], criteria: [] }
const signal = () => new AbortController().signal
const call = (method: string, payload: unknown): HostRpcCall => ({ rpcId: crypto.randomUUID(), method, payload, signal: signal() })
async function setup() {
  const fixture = await createRunStorage(); cleanup.push(fixture.close)
  const open = async () => { const store = await TaskBriefStore.open(fixture.ctx.storageDomain, 'test'); cleanup.push(() => store.close()); return store }
  const store = await open()
  const sessions = new Map<string, { sessionId: string; cwd: string; blank: boolean; running: boolean; updatedAt: number }>()
  const native = vi.fn(async (request: HostRpcCall): Promise<HostRpcResult> => {
    const p = request.payload as { sessionId: string; cwd?: string }
    if (request.method === 'session.create') {
      sessions.set(p.sessionId, { sessionId: p.sessionId, cwd: p.cwd ?? '/default/browser', blank: true, running: false, updatedAt: 1 })
      return { ok: true, value: { sessionId: p.sessionId } }
    }
    if (request.method === 'session.history' && sessions.has(p.sessionId)) return { ok: true, value: { events: [] } }
    return { ok: false, error: { code: 'session/not-found', message: 'Synthetic missing Session', details: {} } }
  })
  const base: BrowserHostApi = { call: native, events: async function* () {}, respond: async () => ({}) }
  return { store, open, native, sessions, base, api: withSessionDeferral(base, true) }
}
describe('saved notes retain their Session without starting a model', () => {
  it('retains an unprompted Session, original cwd and picker visibility across a Host restart', async () => {
    const h = await setup()
    const created = await h.api.call(call('session.create', { cwd: '/chosen/project' }))
    if (!created.ok) throw Error('create failed')
    const sid = (created.value as { sessionId: string }).sessionId
    const saved = await saveSessionBrief(h.api, h.store, sid, 0, input, signal())
    expect(h.sessions.get(sid)?.cwd).toBe('/chosen/project')
    expect(briefSessionItems([...h.sessions.values()], h.store, true)[0]).toMatchObject({ sessionId: sid, blank: false, notesOnly: true })
    await h.store.close()
    const reopened = await h.open(), restarted = withSessionDeferral(h.base, true)
    await openSessionBrief(restarted, reopened, sid, signal())
    expect(reopened.get(sid)).toEqual(saved)
    expect(h.native.mock.calls.filter(([request]) => request.method === 'session.create')).toHaveLength(1)
    expect(h.native.mock.calls.some(([request]) => request.method === 'session.prompt')).toBe(false)
  })
  it('makes legacy orphan notes discoverable and recovers only an idle default-workspace conversation', async () => {
    const h = await setup()
    await h.store.save('legacy-session', 0, input, 'user')
    expect(briefSessionItems([], h.store, true)[0]).toMatchObject({ sessionId: 'legacy-session', notesOnly: true, blank: false })
    expect(briefSessionItems([], h.store, false)).toEqual([])
    await openSessionBrief(h.api, h.store, 'legacy-session', signal())
    const creates = h.native.mock.calls.filter(([request]) => request.method === 'session.create')
    expect(creates[0]![0].payload).toEqual({ sessionId: 'legacy-session' })
    expect(h.sessions.get('legacy-session')?.cwd).toBe('/default/browser')
    expect(h.store.get('legacy-session').projectPath).toBe('/reference/project')
    expect(h.native.mock.calls.some(([request]) => request.method === 'session.prompt')).toBe(false)
  })
  it('shares concurrent retention while admitting only one notes version', async () => {
    const h = await setup()
    const created = await h.api.call(call('session.create', {}))
    if (!created.ok) throw Error('create failed')
    const sid = (created.value as { sessionId: string }).sessionId
    const results = await Promise.allSettled([saveSessionBrief(h.api, h.store, sid, 0, input, signal()), saveSessionBrief(h.api, h.store, sid, 0, input, signal())])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(h.native.mock.calls.filter(([request]) => request.method === 'session.create')).toHaveLength(1)
  })
  it('does not save notes for an unknown Session or restore a Session with no saved notes', async () => {
    const h = await setup()
    await expect(saveSessionBrief(h.api, h.store, 'unknown', 0, input, signal())).rejects.toMatchObject({ code: 'session-unavailable' })
    await expect(openSessionBrief(h.api, h.store, 'unknown', signal())).rejects.toMatchObject({ code: 'not-found' })
    expect(h.store.get('unknown').version).toBe(0)
    expect(h.sessions.size).toBe(0)
  })
  it('preserves ordinary history when task-note listing fails and cancels before creating a Session', async () => {
    const h = await setup()
    const rows = [{ sessionId: 'ordinary-session', blank: false }]
    vi.spyOn(h.store, 'list').mockImplementation(() => { throw Error('Synthetic unavailable notes') })
    expect(briefSessionItems(rows, h.store, true)).toBe(rows)
    const created = await h.api.call(call('session.create', {}))
    if (!created.ok) throw Error('create failed')
    await expect(saveSessionBrief(h.api, h.store, (created.value as { sessionId: string }).sessionId, 0, input, AbortSignal.abort())).rejects.toThrow()
    expect(h.sessions.size).toBe(0)
  })
})
