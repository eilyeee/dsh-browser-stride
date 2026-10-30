import { BRIDGE_PROTOCOL_VERSION } from '../src/protocol.ts'
import { createServer, type Server } from 'node:http'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { BridgeServer, BridgeToolError, isLoopbackAddress, messageToText, payloadCode, payloadMessage } from '../src/server.ts'
import { BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, BRIDGE_SESSION_PURGE_METHOD, BRIDGE_RUN_LIST_METHOD, BRIDGE_RUN_CONTROL_METHOD, type BridgeFrame } from '../src/protocol.ts'
import { SessionPurgeError } from '../src/session-purge.ts'
import type { BrowserHostApi, HostEventFrame } from '../src/host-api.ts'
import { createRunStorage } from './helpers/run-storage.ts'
import { asSessionId } from '../src/contracts/ids.ts'

const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'

/** A browser-looking Origin is not proof of identity. */
const EXT_ORIGIN = 'chrome-extension://test-extension-id'
const FIREFOX_EXT_ORIGIN = 'moz-extension://per-install-uuid'

/** Extension caps used by every hello in this suite. */
const CAPS = { textOnly: true as const, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }

interface Harness {
  bridge: BridgeServer
  server: Server
  url: string
  callMock: ReturnType<typeof vi.fn>
  respondMock: ReturnType<typeof vi.fn>
}

async function startBridge(overrides: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}): Promise<Harness> {
  const callMock = vi.fn(async () => ({ ok: true as const, value: 'ok' }))
  const respondMock = vi.fn(async () => ({ accepted: true }))
  const events: AsyncIterable<HostEventFrame> = {
    async *[Symbol.asyncIterator]() {
      yield { rpcId: 'e1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } }
      yield { rpcId: 'e2', method: 'session/queue', payload: { type: 'session/queue', sessionId: 's1', items: [] } }
    },
  }
  const api: BrowserHostApi = {
    call: callMock,
    events: () => events,
    respond: respondMock,
  }
  const bridge = new BridgeServer({
    token: TOKEN,
    api,
    toolTimeoutMs: 1_000,
    caps: { textOnly: true, snapshotMaxChars: 12_000, maxInteractiveItems: 60 },
    injectBrowserSnapshot: vi.fn(),
    purgeSession: vi.fn(async () => {}),
    ...overrides,
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return { bridge, server, url: `ws://127.0.0.1:${port}/ext/bridge`, callMock, respondMock }
}

function hostApi(overrides: Partial<BrowserHostApi> = {}): BrowserHostApi {
  return {
    call: async () => ({ ok: true, value: 'ok' }),
    async *events() {},
    respond: async () => ({ accepted: true }),
    ...overrides,
  }
}

function connect(url: string, origin?: string): Promise<{ ws: WebSocket; frames: BridgeFrame[]; done: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin !== undefined ? { headers: { origin } } : undefined)
    const frames: BridgeFrame[] = []
    ws.on('message', (data) => { frames.push(JSON.parse(data.toString()) as BridgeFrame) })
    ws.on('error', reject)
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        done: new Promise<void>((doneResolve) => {
          ws.on('close', () => { doneResolve() })
        }),
      })
    })
  })
}

function send(ws: WebSocket, frame: BridgeFrame): void {
  ws.send(JSON.stringify(frame))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

const harnesses: Harness[] = []
const storageFixtures: Awaited<ReturnType<typeof createRunStorage>>[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.bridge.close()
    await new Promise<void>((resolve) => { h.server.close(() => resolve()) })
  }
  for (const fixture of storageFixtures.splice(0)) await fixture.close()
})

async function connectedLedger(scoped = false) {
  const storage = await createRunStorage()
  storageFixtures.push(storage)
  const ledger = storage.store.dispatches
  const h = await startBridge({ dispatches: ledger, toolTimeoutMs: 2_000, ...(scoped ? { runs: storage.store } : {}) })
  harnesses.push(h)
  const client = await connect(h.url)
  send(client.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
  await waitFor(() => h.bridge.hasConnection())
  return { ...h, ...client, storage, ledger }
}

describe('recorded tool dispatch', () => {
  it('handles run metadata internally and refuses control before authentication', async () => {
    const h = await connectedLedger(true)
    const store = h.storage.store
    const queued = await store.create({ sessionId: asSessionId('managed-session'), requiredCriteriaIds: ['saved'] })
    const unauthenticated = await connect(h.url)
    send(unauthenticated.ws, { t: 'rpc', id: 'unauth-control', method: BRIDGE_RUN_CONTROL_METHOD,
      payload: { sessionId: queued.sessionId, runId: queued.runId, expectedVersion: 0, control: 'stop' } })
    await unauthenticated.done
    expect(store.get(queued.runId)?.state).toBe('queued')
    send(h.ws, { t: 'rpc', id: 'panel-list', method: BRIDGE_RUN_LIST_METHOD, payload: { sessionId: queued.sessionId } })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'panel-list'))
    expect(h.frames).toContainEqual(expect.objectContaining({ t: 'rpc.result', id: 'panel-list', ok: true,
      result: expect.objectContaining({ result: { ok: true, value: expect.objectContaining({ total: 1 }) } }) }))
    expect(h.callMock).not.toHaveBeenCalled()
  })

  it('does not execute a queued control after its connection is replaced', async () => {
    const h = await connectedLedger(true)
    const store = h.storage.store
    const queued = await store.create({ sessionId: asSessionId('managed-session'), requiredCriteriaIds: ['saved'] })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const holding = store.purgeSession('independent-session', async () => { entered(); await gate })
    await ready
    const control = vi.spyOn(store, 'control')
    send(h.ws, { t: 'rpc', id: 'queued-control', method: BRIDGE_RUN_CONTROL_METHOD,
      payload: { sessionId: queued.sessionId, runId: queued.runId, expectedVersion: 0, control: 'stop' } })
    let replacement: Awaited<ReturnType<typeof connect>> | undefined
    try {
      await waitFor(() => control.mock.calls.length === 1)
      replacement = await connect(h.url)
      send(replacement.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
      await waitFor(() => replacement!.frames.some(frame => frame.t === 'hello.ok'))
    } finally { release() }
    await holding
    await expect(control.mock.results[0].value).rejects.toMatchObject({ code: 'cancelled' })
    expect(store.get(queued.runId)?.state).toBe('queued')
    replacement?.ws.close()
  })

  it('refuses an unscoped call if a managed run takes over while its ledger write is pending', async () => {
    const h = await connectedLedger(true)
    const sessionId = asSessionId('managed-session')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.ledger.prepare.bind(h.ledger)
    vi.spyOn(h.ledger, 'prepare').mockImplementationOnce(async input => { const row = await original(input); await gate; return row })
    const pending = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1000, sessionId).catch(error => error)
    try {
      await waitFor(() => h.ledger.list().length === 1)
      const queued = await h.storage.store.create({ sessionId, requiredCriteriaIds: ['saved'] })
      await h.storage.store.transition(queued.runId, queued.version, 'running')
    } finally { release() }
    expect(await pending).toMatchObject({ code: 'action-failed' })
    expect(h.ledger.list()[0].state).toBe('not_sent')
    expect(h.frames.some(frame => frame.t === 'tool.call')).toBe(false)
  })

  it('does not accept model arguments in place of a trusted run execution scope', async () => {
    const h = await connectedLedger(true)
    const queued = await h.storage.store.create({ sessionId: asSessionId('managed-session'), requiredCriteriaIds: ['saved'] })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    expect(() => h.bridge.requestTool('browser_click', { runId: run.runId, controlRevision: 0 }, new AbortController().signal, 1000, run.sessionId)).toThrow(BridgeToolError)
    expect(h.ledger.list()).toEqual([])
  })

  it('cancels an in-flight managed action on pause and records its late receipt without resuming', async () => {
    const h = await connectedLedger(true)
    const store = h.storage.store
    const queued = await store.create({ sessionId: asSessionId('managed-session'), requiredCriteriaIds: ['saved'] })
    const run = await store.transition(queued.runId, queued.version, 'running')
    await store.withExecution(run.runId, run.controlRevision, async () => {
      const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal).catch(error => error)
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      const call = h.frames.find(frame => frame.t === 'tool.call')! as Extract<BridgeFrame, { t: 'tool.call' }>
      expect(call.sessionId).toBe(run.sessionId)
      send(h.ws, { t: 'rpc', id: 'panel-pause', method: BRIDGE_RUN_CONTROL_METHOD,
        payload: { sessionId: run.sessionId, runId: run.runId, expectedVersion: run.version, control: 'pause' } })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'panel-pause'))
      expect(h.callMock).not.toHaveBeenCalled()
      expect(await pending).toMatchObject({ code: 'bridge-closed' })
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.cancel' && frame.id === call.id))
      expect(h.ledger.get(call.id)).toMatchObject({ state: 'unresolved', runId: run.runId, controlRevision: 0 })
      send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: { text: 'late' } })
      await waitFor(() => h.ledger.get(call.id)?.state === 'returned')
      expect(store.get(run.runId)).toMatchObject({ state: 'paused', controlRevision: 1, facts: [] })
      expect(h.ledger.get(call.id)).toMatchObject({ runId: run.runId, controlRevision: 0, interruption: { reason: 'cancelled' } })
    })
  })

  it.each(['prepare', 'markSent'] as const)('fences a stop committed while %s is pending', async method => {
    const h = await connectedLedger(true)
    const store = h.storage.store
    const queued = await store.create({ sessionId: asSessionId('managed-session'), requiredCriteriaIds: ['saved'] })
    const run = await store.transition(queued.runId, queued.version, 'running')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.ledger[method].bind(h.ledger) as (...args: any[]) => Promise<any>
    vi.spyOn(h.ledger, method).mockImplementationOnce(async (...args: any[]) => { const row = await original(...args); await gate; return row })
    await store.withExecution(run.runId, 0, async () => {
      const caller = new AbortController()
      const pending = h.bridge.requestTool('browser_click', {}, caller.signal).catch(error => error)
      try {
        await waitFor(() => h.ledger.list()[0]?.state === (method === 'prepare' ? 'prepared' : 'sent_unconfirmed'))
        await store.control(run.runId, run.version, 'stop')
      } finally { release() }
      expect(await pending).toMatchObject({ code: 'bridge-closed' })
      expect(caller.signal.aborted).toBe(false)
      expect(h.ledger.list()[0]).toMatchObject({ state: 'not_sent', runId: run.runId, controlRevision: 0 })
      expect(h.frames.some(frame => frame.t === 'tool.call')).toBe(false)
    })
  })

  it.each(['actionId', 'requestDigest'] as const)('ignores a receipt with the wrong %s', async field => {
    const h = await connectedLedger()
    let delivered = false
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal).then(value => { delivered = true; return value })
    await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
    const call = h.frames.find(frame => frame.t === 'tool.call')! as Extract<BridgeFrame, { t: 'tool.call' }>
    const wrong = { ...call.action, [field]: field === 'actionId' ? 'act_forged' : 'b'.repeat(64) }
    send(h.ws, { t: 'tool.result', id: call.id, action: wrong, ok: true, result: { text: 'forged' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(delivered).toBe(false)
    expect(h.ledger.get(call.id)?.state).toBe('sent_unconfirmed')
    send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: { text: 'matching' } })
    await expect(pending).resolves.toEqual({ text: 'matching' })
  })
  it('commits before sending and before returning a receipt, without storing arguments or results', async () => {
    const h = await connectedLedger()
    let releaseSend!: () => void
    let releaseReceipt!: () => void
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve })
    const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve })
    const mark = h.ledger.markSent.bind(h.ledger)
    vi.spyOn(h.ledger, 'markSent').mockImplementationOnce(async id => { const row = await mark(id); await sendGate; return row })
    let settling = false
    const settle = h.ledger.settle.bind(h.ledger)
    vi.spyOn(h.ledger, 'settle').mockImplementationOnce(async (id, result) => { settling = true; await receiptGate; return settle(id, result) })
    const args = { text: 'synthetic-private-input' }
    let delivered = false
    const pending = h.bridge.requestTool('browser_type', args, new AbortController().signal)
    void pending.then(() => { delivered = true })
    args.text = 'mutated-input'
    try {
      await waitFor(() => h.ledger.list()[0]?.state === 'sent_unconfirmed')
      expect(h.frames.some(frame => frame.t === 'tool.call')).toBe(false)
      expect(await readFile(h.storage.dispatchFile, 'utf8')).toContain('sent_unconfirmed')
      releaseSend()
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      const call = h.frames.find(frame => frame.t === 'tool.call')! as Extract<BridgeFrame, { t: 'tool.call' }>
      expect(call.args.text).toBe('synthetic-private-input')
      send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: { text: 'synthetic-private-page-result' } })
      await waitFor(() => settling)
      expect(delivered).toBe(false)
      expect(h.ledger.get(call.id)?.state).toBe('sent_unconfirmed')
      releaseReceipt()
      await expect(pending).resolves.toEqual({ text: 'synthetic-private-page-result' })
      expect(h.ledger.get(call.id)).toMatchObject({ state: 'returned', receipt: { ok: true } })
      const disk = await readFile(h.storage.dispatchFile, 'utf8')
      expect(disk).not.toContain('synthetic-private-input')
      expect(disk).not.toContain('synthetic-private-page-result')
    } finally { releaseSend(); releaseReceipt() }
  })

  it.each(['prepare', 'markSent'] as const)('does not send when %s fails', async method => {
    const h = await connectedLedger()
    vi.spyOn(h.ledger, method).mockRejectedValueOnce(new Error('synthetic storage failure'))
    await expect(h.bridge.requestTool('browser_click', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'internal' })
    expect(h.frames.some(frame => frame.t === 'tool.call')).toBe(false)
  })

  it.each(['prepare', 'markSent'] as const)('rechecks cancellation after %s commits', async method => {
    const h = await connectedLedger()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    const original = h.ledger[method].bind(h.ledger) as (...args: any[]) => Promise<any>
    vi.spyOn(h.ledger, method).mockImplementationOnce(async (...args: any[]) => {
      const row = await original(...args); entered = true; await gate; return row
    })
    const abort = new AbortController()
    const pending = h.bridge.requestTool('browser_click', {}, abort.signal).catch(error => error)
    try {
      await waitFor(() => entered)
      abort.abort()
      release()
      expect(await pending).toMatchObject({ code: 'bridge-closed' })
      expect(h.ledger.list()[0]).toMatchObject({ state: 'not_sent', interruption: { reason: 'cancelled' } })
      expect(h.frames.some(frame => frame.t === 'tool.call')).toBe(false)
    } finally { release() }
  })

  it('does not redirect a prepared call into a replacement connection', async () => {
    const h = await connectedLedger()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const mark = h.ledger.markSent.bind(h.ledger)
    vi.spyOn(h.ledger, 'markSent').mockImplementationOnce(async id => { const row = await mark(id); await gate; return row })
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal).catch(error => error)
    try {
      await waitFor(() => h.ledger.list()[0]?.state === 'sent_unconfirmed')
      const replacement = await connect(h.url)
      send(replacement.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
      await waitFor(() => replacement.frames.some(frame => frame.t === 'hello.ok'))
      release()
      expect(await pending).toMatchObject({ code: 'bridge-closed' })
      expect(h.ledger.list()[0]?.state).toBe('not_sent')
      expect(replacement.frames.some(frame => frame.t === 'tool.call')).toBe(false)
    } finally { release() }
  })

  it('expires a call whose persistence finishes after its deadline without sending it', async () => {
    const h = await connectedLedger()
    const prepare = h.ledger.prepare.bind(h.ledger)
    vi.spyOn(h.ledger, 'prepare').mockImplementationOnce(async input => {
      const row = await prepare(input)
      await new Promise(resolve => setTimeout(resolve, 60))
      return row
    })
    await expect(h.bridge.requestTool('browser_click', {}, new AbortController().signal, 30)).rejects.toMatchObject({ code: 'timeout' })
    expect(h.ledger.list()[0]).toMatchObject({ state: 'not_sent', interruption: { reason: 'expired' } })
    expect(h.frames.some(frame => frame.t === 'tool.call')).toBe(false)
  })

  it('records post-send cancellation and a late receipt without retrying the action', async () => {
    const h = await connectedLedger()
    const abort = new AbortController()
    const pending = h.bridge.requestTool('browser_click', {}, abort.signal).catch(error => error)
    await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
    const call = h.frames.find(frame => frame.t === 'tool.call')!
    abort.abort()
    expect(await pending).toMatchObject({ code: 'bridge-closed', message: expect.stringContaining('may have started') })
    expect(h.ledger.get(call.id)?.state).toBe('unresolved')
    send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: { text: 'synthetic late result' } })
    await waitFor(() => h.ledger.get(call.id)?.state === 'returned')
    expect(h.ledger.get(call.id)?.interruption?.reason).toBe('cancelled')
    expect(h.frames.filter(frame => frame.t === 'tool.call')).toHaveLength(1)
  })

  it('drains unresolved receipt writes before server shutdown completes', async () => {
    const h = await connectedLedger()
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal).catch(error => error)
    await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
    await h.bridge.close()
    expect(await pending).toMatchObject({ code: 'bridge-closed' })
    expect(h.ledger.list()[0]?.state).toBe('unresolved')
    expect(await readFile(h.storage.dispatchFile, 'utf8')).toContain('connection-closed')
  })

  it('refuses to deliver a result or send another action after receipt persistence fails', async () => {
    const h = await connectedLedger()
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal).catch(error => error)
    await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
    const call = h.frames.find(frame => frame.t === 'tool.call')!
    const root = h.storage.storageRoot
    await rename(root, root + '-backup')
    await writeFile(root, 'synthetic-obstacle')
    try {
      send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: { text: 'synthetic result' } })
      expect(await pending).toMatchObject({ code: 'internal', message: expect.stringContaining('may be unknown') })
      await expect(h.bridge.requestTool('browser_click', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'internal' })
      expect(h.frames.filter(frame => frame.t === 'tool.call')).toHaveLength(1)
    } finally { await rm(root); await rename(root + '-backup', root) }
  })
})

describe('BridgeServer', () => {
  it('negotiates snapshot bounds without exceeding either peer offer', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN,
      caps: { textOnly: true, snapshotMaxChars: 8000, maxInteractiveItems: 100 } })
    await waitFor(() => frames.some(frame => frame.t === 'hello.ok'))
    expect(frames.find(frame => frame.t === 'hello.ok')).toMatchObject({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      caps: { textOnly: true, snapshotMaxChars: 8000, maxInteractiveItems: 60 },
    })
    ws.close()
  })

  it.each([undefined, BRIDGE_PROTOCOL_VERSION - 1, BRIDGE_PROTOCOL_VERSION + 1])('rejects version %s without replacing the active connection', async (protocolVersion) => {
    const h = await startBridge()
    harnesses.push(h)
    const active = await connect(h.url)
    send(active.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => h.bridge.hasConnection())
    const rejected = await connect(h.url)
    send(rejected.ws, { t: 'hello', token: TOKEN, caps: CAPS,
      ...(protocolVersion === undefined ? {} : { protocolVersion }) })
    await rejected.done
    expect(rejected.frames).toContainEqual(expect.objectContaining({
      t: 'error', code: protocolVersion === undefined || protocolVersion < BRIDGE_PROTOCOL_VERSION ? 'protocol-upgrade-extension' : 'protocol-upgrade-host',
    }))
    expect(active.ws.readyState).toBe(WebSocket.OPEN)
    send(active.ws, { t: 'rpc', id: 'still-owned', method: 'session.list', payload: {} })
    await waitFor(() => active.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'still-owned'))
    active.ws.close()
  })

  it('decodes every ws message delivery shape', () => {
    expect(messageToText([Buffer.from('a'), Buffer.from('b')])).toBe('ab')
    expect(messageToText(Buffer.from('hi'))).toBe('hi')
    expect(messageToText(new TextEncoder().encode('x').buffer)).toBe('x')
  })

  it('extracts tool error codes and messages with parser-gated fallbacks', () => {
    expect(payloadCode({ code: 'timeout', message: 'm' })).toBe('timeout')
    expect(payloadCode({ code: 42, message: 'm' })).toBe('internal')
    expect(payloadCode('garbage')).toBe('internal')
    expect(payloadCode(null)).toBe('internal')
    expect(payloadMessage({ code: 'x', message: 'm' })).toBe('m')
    expect(payloadMessage({ code: 'x', message: '' })).toBe('browser action failed')
    expect(payloadMessage({ code: 'x', message: 42 })).toBe('browser action failed')
    expect(payloadMessage('garbage')).toBe('browser action failed')
  })

  it('authenticates a valid hello and acknowledges caps', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(frames.find((f) => f.t === 'hello.ok')).toEqual({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    ws.close()
  })

  it('rejects an extension Origin without a token', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, EXT_ORIGIN)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('requires a token from Firefox extension origins because their UUID is not an extension identity', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, FIREFOX_EXT_ORIGIN)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('accepts an authenticated Firefox extension origin', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url, FIREFOX_EXT_ORIGIN)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(frames.find((f) => f.t === 'hello.ok')).toBeDefined()
    ws.close()
  })

  it('rejects loopback connections without a token when Origin is not an extension (malicious page)', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, 'https://evil.example')
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects loopback connections without a token and without any Origin', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects non-loopback remotes before accepting a WebSocket', async () => {
    const h = await startBridge({ remoteAddressOverride: '192.168.1.5' })
    harnesses.push(h)
    await expect(connect(h.url)).rejects.toThrow(/403/)
  })

  it('closes sockets that never present hello', async () => {
    const h = await startBridge({ helloTimeoutMs: 500 })
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects frames before hello', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'pong' })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('passes rpc frames to the Host adapter and relays a server-response envelope', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-1', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result'))
    const result = frames.find((f) => f.t === 'rpc.result')
    expect(result).toMatchObject({ t: 'rpc.result', id: 'rpc-1', ok: true })
    expect(result).toMatchObject({
      result: { type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: 'ok' } },
    })
    expect(h.callMock).toHaveBeenCalledWith({
      rpcId: 'rpc-1', method: 'session.list', payload: {}, signal: expect.any(AbortSignal),
    })
    ws.close()
  })

  it('reports unexpected Host adapter failures as rpc.result errors', async () => {
    const h = await startBridge({ api: hostApi({ call: async () => { throw new Error('boom') } }) })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-2', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-2'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-2'))
      .toMatchObject({ t: 'rpc.result', id: 'rpc-2', ok: false, error: { code: 'internal', message: 'Error: boom' } })
    ws.close()
  })

  it('injects followed-page snapshots without forwarding the internal RPC to the gateway', async () => {
    const injectBrowserSnapshot = vi.fn()
    const h = await startBridge({ injectBrowserSnapshot })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc',
      id: 'snapshot-1',
      method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
      payload: { sessionId: 'session-1', snapshot: 'Page: Other target' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'snapshot-1'))

    expect(injectBrowserSnapshot).toHaveBeenCalledWith('session-1', 'Page: Other target')
    expect(h.callMock).not.toHaveBeenCalled()
    expect(frames).toContainEqual({
      t: 'rpc.result', id: 'snapshot-1', ok: true, result: { accepted: true },
    })

    send(ws, {
      t: 'rpc',
      id: 'snapshot-invalid',
      method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
      payload: { sessionId: '', snapshot: '' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'snapshot-invalid'))
    expect(frames).toContainEqual(expect.objectContaining({
      t: 'rpc.result', id: 'snapshot-invalid', ok: false, error: expect.objectContaining({ code: 'bad-request' }),
    }))
    ws.close()
  })

  it('purges sessions through the internal RPC without forwarding it to the gateway', async () => {
    const purgeSession = vi.fn(async () => {})
    const h = await startBridge({ purgeSession })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc',
      id: 'purge-1',
      method: BRIDGE_SESSION_PURGE_METHOD,
      payload: { sessionId: 'session-82222a77-aab5-4c0b-b33e-6376973ec93d' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'purge-1'))

    expect(purgeSession).toHaveBeenCalledWith('session-82222a77-aab5-4c0b-b33e-6376973ec93d')
    expect(h.callMock).not.toHaveBeenCalled()
    expect(frames).toContainEqual({
      t: 'rpc.result', id: 'purge-1', ok: true, result: { purged: true },
    })

    send(ws, {
      t: 'rpc',
      id: 'purge-invalid',
      method: BRIDGE_SESSION_PURGE_METHOD,
      payload: { sessionId: '' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'purge-invalid'))
    expect(frames).toContainEqual(expect.objectContaining({
      t: 'rpc.result', id: 'purge-invalid', ok: false, error: expect.objectContaining({ code: 'bad-request' }),
    }))

    const failing = vi.fn(async () => { throw new SessionPurgeError('running', 'cancel it first') })
    const failureBridge = await startBridge({ purgeSession: failing })
    harnesses.push(failureBridge)
    const failure = await connect(failureBridge.url)
    send(failure.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => failure.frames.some((frame) => frame.t === 'hello.ok'))
    send(failure.ws, {
      t: 'rpc',
      id: 'purge-running',
      method: BRIDGE_SESSION_PURGE_METHOD,
      payload: { sessionId: 'session-82222a77-aab5-4c0b-b33e-6376973ec93d' },
    })
    await waitFor(() => failure.frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'purge-running'))
    expect(failure.frames).toContainEqual(expect.objectContaining({
      t: 'rpc.result', id: 'purge-running', ok: false, error: { code: 'running', message: 'cancel it first' },
    }))
    ws.close()
    failure.ws.close()
  })

  it('finishes snapshot injection before forwarding a prompt for the same session', async () => {
    let releaseInjection!: () => void
    const injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve })
    const injectBrowserSnapshot = vi.fn(async () => { await injectionGate })
    const h = await startBridge({ injectBrowserSnapshot })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc', id: 'snapshot', method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
      payload: { sessionId: 'session-ordered', snapshot: 'Current page' },
    })
    send(ws, {
      t: 'rpc', id: 'prompt-after-snapshot', method: 'session.prompt',
      payload: { sessionId: 'session-ordered', mode: 'queue', content: [] },
    })

    await waitFor(() => injectBrowserSnapshot.mock.calls.length === 1)
    expect(h.callMock).not.toHaveBeenCalled()
    releaseInjection()
    await waitFor(() => h.callMock.mock.calls.length === 1)
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'prompt-after-snapshot'))
    expect(frames.filter((frame) => frame.t === 'rpc.result').map((frame) => frame.id)).toEqual([
      'snapshot',
      'prompt-after-snapshot',
    ])
    ws.close()
  })

  it('orders prompt before cancel for one session without blocking other sessions', async () => {
    let releasePrompt!: () => void
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve })
    const calls: Array<{ method: string; sessionId: string }> = []
    const call = vi.fn(async (request: Parameters<BrowserHostApi['call']>[0]) => {
      const sessionId = (request.payload as { sessionId: string }).sessionId
      calls.push({ method: request.method, sessionId })
      if (request.method === 'session.prompt' && sessionId === 'provisional') await promptGate
      return { ok: true as const, value: { accepted: true } }
    })
    const h = await startBridge({ api: hostApi({ call }) })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc', id: 'prompt', method: 'session.prompt',
      payload: { sessionId: 'provisional', mode: 'queue', content: [] },
    })
    send(ws, { t: 'rpc', id: 'cancel', method: 'session.cancel', payload: { sessionId: 'provisional' } })
    send(ws, { t: 'rpc', id: 'other-cancel', method: 'session.cancel', payload: { sessionId: 'other' } })

    await waitFor(() => calls.some((call) => call.sessionId === 'other'))
    expect(calls).toContainEqual({ method: 'session.prompt', sessionId: 'provisional' })
    expect(calls).toContainEqual({ method: 'session.cancel', sessionId: 'other' })
    expect(calls).not.toContainEqual({ method: 'session.cancel', sessionId: 'provisional' })

    releasePrompt()
    await waitFor(() => calls.some((call) => call.method === 'session.cancel' && call.sessionId === 'provisional'))
    expect(calls.filter((call) => call.sessionId === 'provisional')).toEqual([
      { method: 'session.prompt', sessionId: 'provisional' },
      { method: 'session.cancel', sessionId: 'provisional' },
    ])
    await waitFor(() => frames.filter((frame) => frame.t === 'rpc.result').length === 3)
    ws.close()
  })

  it('relays interaction responses to the Host adapter with the original rpcId', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))
    send(ws, {
      t: 'respond',
      id: 'response-1',
      rpcId: 'question-1',
      result: { ok: true, value: { sessionId: 'session-1', answer: { answers: [{ id: 'db', selected: ['SQLite'] }] } } },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'respond.result'))

    expect(frames).toContainEqual(expect.objectContaining({
      t: 'respond.result', id: 'response-1', ok: true,
    }))
    expect(h.respondMock).toHaveBeenCalledWith(
      'question-1',
      { ok: true, value: { sessionId: 'session-1', answer: { answers: [{ id: 'db', selected: ['SQLite'] }] } } },
      expect.any(AbortSignal),
    )
    ws.close()
  })

  it('returns Host response failures to the extension', async () => {
    const h = await startBridge({ api: hostApi({ respond: async () => { throw new Error('response rejected') } }) })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))
    send(ws, {
      t: 'respond', id: 'response-2', rpcId: 'question-2',
      result: { ok: false, error: { code: 'cancelled', message: 'user dismissed the question', details: {} } },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'respond.result' && frame.id === 'response-2'))
    expect(frames).toContainEqual({
      t: 'respond.result', id: 'response-2', ok: false,
      error: { code: 'internal', message: 'Error: response rejected' },
    })
    ws.close()
  })

  it('rejects privileged methods from non-loopback remotes', async () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('dispatches tool calls and resolves on tool.result', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const result = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((f) => f.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(call.name).toBe('browser_click')
    expect(call.args).toEqual({ index: 1 })
    send(ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: { text: 'clicked' } })
    await expect(result).resolves.toEqual({ text: 'clicked' })
    ws.close()
  })

  it('rejects tool calls whose signal is already aborted before dispatch', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url, EXT_ORIGIN)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const abort = new AbortController()
    abort.abort()
    expect(() => h.bridge.requestTool('browser_click', {}, abort.signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
    // 没有 tool.call 被发出
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(frames.some((f) => f.t === 'tool.call')).toBe(false)
    ws.close()
  })

  it('rejects tool calls when no extension is connected', async () => {
    const h = await startBridge()
    harnesses.push(h)
    expect(() => h.bridge.requestTool('browser_click', {}, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
  })

  it('times out tool calls that never settle', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    await expect(h.bridge.requestTool('browser_wait', {}, new AbortController().signal, 30))
      .rejects.toMatchObject({ code: 'timeout' })
    await waitFor(() => frames.some((frame) => frame.t === 'tool.cancel'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(frames).toContainEqual({ t: 'tool.cancel', id: call.id })
    ws.close()
  })

  it('propagates extension-reported tool errors', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const result = h.bridge.requestTool('browser_navigate', { url: 'https://x' }, new AbortController().signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((f) => f.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    send(ws, { t: 'tool.result', id: call.id, action: call.action, ok: false, error: { code: 'action-failed', message: 'blocked' } })
    await expect(result).rejects.toBeInstanceOf(BridgeToolError)
    await expect(result).rejects.toMatchObject({ code: 'action-failed', message: 'blocked' })
    ws.close()
  })

  it('settles pending tool calls when a replacement connection arrives', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const first = await connect(h.url)
    send(first.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => first.frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Attach the assertion eagerly: the replacement below settles it before the final await.
    const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await waitFor(() => first.frames.some((f) => f.t === 'tool.call'))

    const second = await connect(h.url)
    send(second.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => second.frames.some((f) => f.t === 'hello.ok'))

    await pendingAssertion
    first.ws.close()
    second.ws.close()
  })

  it('discards old queued RPCs and does not block the replacement connection', async () => {
    let releaseOld: (() => void) | undefined
    let oldReturned = false
    const calls: string[] = []
    const h = await startBridge({ api: hostApi({
      call: async (request) => {
        calls.push(request.rpcId)
        if (request.rpcId === 'old-prompt') {
          await new Promise<void>((resolve) => { releaseOld = resolve })
          oldReturned = true
        }
        return { ok: true, value: 'ok' }
      },
    }) })
    harnesses.push(h)
    const first = await connect(h.url)
    send(first.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => first.frames.some(frame => frame.t === 'hello.ok'))
    send(first.ws, { t: 'rpc', id: 'old-prompt', method: 'session.prompt', payload: { sessionId: 's1' } })
    await waitFor(() => releaseOld !== undefined)
    send(first.ws, { t: 'rpc', id: 'old-cancel', method: 'session.cancel', payload: { sessionId: 's1' } })
    // WebSocket ping is ordered after the preceding RPC on the same socket.
    await new Promise<void>((resolve) => { first.ws.once('pong', () => resolve()); first.ws.ping() })

    const second = await connect(h.url)
    send(second.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => second.frames.some(frame => frame.t === 'hello.ok'))
    send(second.ws, { t: 'rpc', id: 'new-prompt', method: 'session.prompt', payload: { sessionId: 's1' } })
    await waitFor(() => second.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'new-prompt'))
    releaseOld!()
    await waitFor(() => oldReturned)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toEqual(['old-prompt', 'new-prompt'])
    first.ws.close()
    second.ws.close()
  })

  it('aborts tool calls when the caller signal fires', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const abort = new AbortController()
    const pending = h.bridge.requestTool('browser_click', {}, abort.signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await waitFor(() => frames.some((frame) => frame.t === 'tool.cancel'))
    expect(frames).toContainEqual({ t: 'tool.cancel', id: call.id })
    ws.close()
  })

  it('forwards the owning session with a tool call', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool(
      'browser_click',
      {},
      new AbortController().signal,
      1_000,
      'session-browser',
    )
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(call.sessionId).toBe('session-browser')
    send(ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: { text: 'done' } })
    await expect(pending).resolves.toEqual({ text: 'done' })
    ws.close()
  })

  it('pumps event frames to the connected extension', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.filter((f) => f.t === 'event').length >= 2)
    const events = frames.filter((f) => f.t === 'event') as Extract<BridgeFrame, { t: 'event' }>[]
    expect(events.map((e) => e.frame.method)).toEqual(['session/subscribed', 'session/queue'])
    ws.close()
  })

  it('settles pending tool calls when the send fails mid-flight', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Tear the socket down immediately: the in-flight send reports a write
    // failure (or the close path wins — either settles as bridge-closed).
    const assertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    ws.terminate()
    await assertion
  })

  it('closes cleanly twice (second close is a no-op on the acceptor)', async () => {
    const h = await startBridge()
    harnesses.push(h)
    await h.bridge.close()
    await h.bridge.close()
  })

  it('sends protocol pings on the configured cadence and the client answers pong', async () => {
    const h = await startBridge({ pingIntervalMs: 50 })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'ping'))
    send(ws, { t: 'pong' })
    ws.close()
  })

  it('stops the stream-failed arm when the pump fails after the socket closed', async () => {
    const lateFailEvents: AsyncIterable<HostEventFrame> = {
      async *[Symbol.asyncIterator]() {
        yield { rpcId: 'l1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } }
        await new Promise((resolve) => { setTimeout(resolve, 120) })
        throw new Error('late failure')
      },
    }
    const h = await startBridge({ api: hostApi({ events: () => lateFailEvents }) })
    harnesses.push(h)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    ws.close()
    await done
    // The pump fails after the close: the abort flag suppresses the error frame.
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    expect(frames.some((f) => f.t === 'error')).toBe(false)
  })

  it('closes cleanly and rejects pending work', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Attach the assertion eagerly: close() settles it before the final await.
    const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await h.bridge.close()
    await pendingAssertion
    expect(() => h.bridge.requestTool('browser_click', {}, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
    ws.close()
  })

  it('tracks connection state through auth, close, and replacement', async () => {
    const h = await startBridge()
    harnesses.push(h)
    expect(h.bridge.hasConnection()).toBe(false)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.hasConnection()).toBe(true)
    ws.close()
    await done
    // The server processes the close asynchronously; poll for the outcome.
    await expect.poll(() => h.bridge.hasConnection()).toBe(false)
  })

  it('closes sockets on unparseable frames and ignores client-only frames when ready', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    // Client-only shapes after ready are ignored (no error frame, no close).
    send(ws, { t: 'pong' })
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    // Garbage is a protocol violation and closes the socket.
    ws.send('not-json')
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('relays business failures inside the server-response and isolates thrown adapter errors', async () => {
    const h = await startBridge({
      api: hostApi({ call: async () => ({
        ok: false,
        error: { code: 'session-not-found', message: 'missing', details: {} },
      }) }),
    })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-3', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-3'))
    const businessFailure = frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-3')!
    expect(businessFailure).toMatchObject({
      t: 'rpc.result', id: 'rpc-3', ok: true,
      result: { type: 'server-response', result: { ok: false, error: { code: 'session-not-found' } } },
    })
    ws.close()

    const throwing = await startBridge({
      api: hostApi({ call: async () => { throw new Error('boom') } }),
    })
    harnesses.push(throwing)
    const second = await connect(throwing.url)
    send(second.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => second.frames.some((f) => f.t === 'hello.ok'))
    send(second.ws, { t: 'rpc', id: 'rpc-4', method: 'session.list', payload: {} })
    await waitFor(() => second.frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-4'))
    expect(second.frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-4'))
      .toMatchObject({ t: 'rpc.result', id: 'rpc-4', ok: false, error: { code: 'internal', message: 'Error: boom' } })
    second.ws.close()
  })

  it('ignores tool results with unknown ids', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    // Unknown id: ignored, connection stays healthy.
    send(ws, { t: 'tool.result', id: 'nope', action: { actionId: 'act_unknown', requestDigest: 'a'.repeat(64) }, ok: true, result: {} })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('requires a separate Host opt-in for privileged methods', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'priv-1', method: 'settings.describe', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'priv-1'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'priv-1'))
      .toMatchObject({ t: 'rpc.result', id: 'priv-1', ok: false, error: { code: 'forbidden' } })
    // Non-privileged methods still pass for the same connection.
    send(ws, { t: 'rpc', id: 'priv-2', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'priv-2'))
    const allowed = frames.find((f): f is Extract<BridgeFrame, { t: 'rpc.result' }> => f.t === 'rpc.result' && f.id === 'priv-2')!
    expect(allowed.ok).toBe(true)
    ws.close()
  })

  it('allows Host management only when explicitly enabled by the Host', async () => {
    const h = await startBridge({ allowHostManagement: true })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some(frame => frame.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'priv-enabled', method: 'settings.describe', payload: {} })
    await waitFor(() => frames.some(frame => frame.t === 'rpc.result' && frame.id === 'priv-enabled'))
    expect(frames.find(frame => frame.t === 'rpc.result' && frame.id === 'priv-enabled')).toMatchObject({ ok: true })
    ws.close()
  })

  it('reports a failed event stream and closes the generation for reconnect', async () => {
    const failingEvents: AsyncIterable<HostEventFrame> = {
      async *[Symbol.asyncIterator]() {
        yield { rpcId: 'f1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } }
        throw new Error('stream broke')
      },
    }
    const h = await startBridge({ api: hostApi({ events: () => failingEvents }) })
    harnesses.push(h)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'error' && f.code === 'stream-failed'))
    expect(frames.find((f) => f.t === 'error')).toMatchObject({ t: 'error', code: 'stream-failed' })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('stops pumping events once the socket closes mid-stream', async () => {
    const slowEvents: AsyncIterable<HostEventFrame> = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 100; i += 1) {
          yield { rpcId: `s${i}`, method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: i } }
          await new Promise((resolve) => { setTimeout(resolve, 10) })
        }
      },
    }
    const h = await startBridge({ api: hostApi({ events: () => slowEvents }) })
    harnesses.push(h)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => frames.filter((f) => f.t === 'event').length >= 2)
    ws.close()
    await done
    // The pump must stop sending after close instead of writing to a dead socket.
    const countBefore = frames.filter((f) => f.t === 'event').length
    await new Promise((resolve) => { setTimeout(resolve, 80) })
    expect(frames.filter((f) => f.t === 'event').length).toBe(countBefore)
  })
})
