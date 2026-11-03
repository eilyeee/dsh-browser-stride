import { BRIDGE_PROTOCOL_VERSION, BRIDGE_TASK_TARGET_LOST_METHOD } from '../src/protocol.ts'
import { createServer, type Server } from 'node:http'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { BridgeServer, BridgeToolError, isLoopbackAddress, messageToText, payloadCode, payloadMessage } from '../src/server.ts'
import { isPageBrowserTool, BRIDGE_CONFIRM_TOOL_METHOD, BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, BRIDGE_SESSION_PURGE_METHOD, BRIDGE_RUN_LIST_METHOD, BRIDGE_RUN_CONTROL_METHOD, BRIDGE_RUN_RETARGET_METHOD, BRIDGE_TASK_START_METHOD, BRIDGE_TASK_APPROVAL_METHOD, type BridgeFrame } from '../src/protocol.ts'
import { SessionPurgeError } from '../src/session-purge.ts'
import type { BrowserHostApi, HostEventFrame } from '../src/host-api.ts'
import { createRunStorage } from './helpers/run-storage.ts'
import { newBrowserTask } from '../src/task-contract.ts'
import { asSessionId } from '../src/contracts/ids.ts'
import { BRIDGE_TASK_PAGE_PREPARE_METHOD, BRIDGE_TASK_PAGE_CANCEL_METHOD } from '../src/protocol.ts'

const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'

/** A browser-looking Origin is not proof of identity. */
const EXT_ORIGIN = 'chrome-extension://test-extension-id'
const FIREFOX_EXT_ORIGIN = 'moz-extension://per-install-uuid'

/** Extension caps used by every hello in this suite. */
const CAPS = { textOnly: true as const, snapshotMaxChars: 12_000, maxInteractiveItems: 60, taskTargetLoss: true }

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

function connect(url: string, origin?: string, autoConfirm = true): Promise<{ ws: WebSocket; frames: BridgeFrame[]; done: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin !== undefined ? { headers: { origin } } : undefined)
    const frames: BridgeFrame[] = []
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as BridgeFrame
      frames.push(frame)
      if (autoConfirm && frame.t === 'tool.call') {
        const { id, action, execution, sessionId } = frame
        const targetBinding = execution.kind === 'run' && isPageBrowserTool(frame.name)
          ? frame.targetBinding ?? `page_synthetic_${execution.runId}_${execution.controlRevision}` : undefined
        ws.send(JSON.stringify({ t: 'rpc', id: `confirm-${id}`, method: BRIDGE_CONFIRM_TOOL_METHOD,
          payload: { id, action, execution, ...(targetBinding === undefined ? {} : { targetBinding }), ...(sessionId === undefined ? {} : { sessionId }) } }))
      }
    })
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
  const start = performance.now()
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await delay(10)
  }
}

const harnesses: Harness[] = []
const storageFixtures: Awaited<ReturnType<typeof createRunStorage>>[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const h of harnesses.splice(0)) {
    await h.bridge.close()
    await new Promise<void>((resolve) => { h.server.close(() => resolve()) })
  }
  for (const fixture of storageFixtures.splice(0)) await fixture.close()
})

async function connectedLedger(scoped = false, autoConfirm = true, overrides: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}) {
  const storage = await createRunStorage()
  storageFixtures.push(storage)
  const ledger = storage.store.dispatches
  const h = await startBridge({ dispatches: ledger, toolTimeoutMs: 2_000, ...(scoped ? { runs: storage.store } : {}), ...overrides })
  harnesses.push(h)
  const client = await connect(h.url, undefined, autoConfirm)
  send(client.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
  await waitFor(() => h.bridge.hasConnection())
  return { ...h, ...client, storage, ledger }
}

async function taskRpc(h: { ws: WebSocket; frames: BridgeFrame[] }, method: string, payload: unknown) {
  const id = crypto.randomUUID()
  send(h.ws, { t: 'rpc', id, method, payload })
  await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === id))
  return h.frames.find((frame): frame is Extract<BridgeFrame, { t: 'rpc.result' }> => frame.t === 'rpc.result' && frame.id === id)!
}

describe('recorded tool dispatch', () => {
  it('omits the new persisted pause reason for an older compatible panel', async () => {
    const h = await connectedLedger(true, true, { tasks: { selectTarget: vi.fn(), approval: vi.fn() } })
    const run = await h.storage.store.create({ sessionId: asSessionId('legacy-pause-reason'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    const target = { runId: run.runId, sessionId: run.sessionId, controlRevision: 0, targetBinding: 'page_legacy_reason' }
    await taskRpc(h, BRIDGE_TASK_START_METHOD, { ...target, expectedVersion: run.version, targetUrl: 'https://synthetic.test/' })
    await taskRpc(h, BRIDGE_TASK_TARGET_LOST_METHOD, target)
    expect(h.storage.store.get(run.runId)?.pauseReason).toBe('page-unavailable')
    const older = await connect(h.url)
    send(older.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN,
      caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => older.frames.some(frame => frame.t === 'hello.ok'))
    expect(older.frames.find(frame => frame.t === 'hello.ok')).not.toHaveProperty('caps.taskTargetLoss')
    const response = await taskRpc(older, BRIDGE_RUN_LIST_METHOD, { sessionId: run.sessionId })
    expect(response).toMatchObject({ ok: true, result: { result: { value: { items: [{ state: 'paused' }] } } } })
    expect(JSON.stringify(response)).not.toContain('page-unavailable')
    expect(h.storage.store.get(run.runId)?.pauseReason).toBe('page-unavailable')
  })

  it.each([true, false])('remembers page loss before native start=%s commits without revoking a fresh pin', async start => {
    const selectTarget = vi.fn()
    const h = await connectedLedger(true, true, { tasks: { selectTarget, approval: vi.fn() } })
    let run = await h.storage.store.create({ sessionId: asSessionId('early-page-loss'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    if (!start) {
      await taskRpc(h, BRIDGE_TASK_START_METHOD, { runId: run.runId, sessionId: run.sessionId, controlRevision: 0,
        expectedVersion: run.version, targetBinding: 'page_before_pause', targetUrl: 'https://synthetic.test/' })
      const running = h.storage.store.get(run.runId)!
      run = await h.storage.store.control(run.runId, running.version, 'pause')
    }
    const target = { runId: run.runId, sessionId: run.sessionId, controlRevision: run.controlRevision + (start ? 0 : 2), targetBinding: 'page_revoked' }
    expect(await taskRpc(h, BRIDGE_TASK_TARGET_LOST_METHOD, target)).toMatchObject({ ok: true, result: { accepted: true } })
    const callsBefore = selectTarget.mock.calls.length
    const payload = { ...target, controlRevision: run.controlRevision, expectedVersion: run.version, targetUrl: 'https://synthetic.test/' }
    const method = start ? BRIDGE_TASK_START_METHOD : BRIDGE_RUN_RETARGET_METHOD
    expect(await taskRpc(h, method, payload)).toMatchObject({ ok: false, error: { targetState: 'unchanged' } })
    expect(h.storage.store.get(run.runId)).toEqual(run)
    expect(selectTarget).toHaveBeenCalledTimes(callsBefore)
    expect(await taskRpc(h, method, { ...payload, targetBinding: 'page_fresh' })).toMatchObject({ ok: true })
    const fresh = h.storage.store.get(run.runId)!
    expect(fresh.state).toBe('running')
    await taskRpc(h, BRIDGE_TASK_TARGET_LOST_METHOD, target)
    expect(h.storage.store.get(run.runId)).toEqual(fresh)
  })

  it('ignores stale, foreign and mismatched loss notices after an explicit continuation', async () => {
    const h = await connectedLedger(true, true, { tasks: { selectTarget: vi.fn(), approval: vi.fn() } })
    const run = await h.storage.store.create({ sessionId: asSessionId('stale-page-loss'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    const target = { runId: run.runId, sessionId: run.sessionId, controlRevision: 0, targetBinding: 'page_original' }
    await taskRpc(h, BRIDGE_TASK_START_METHOD, { ...target, expectedVersion: run.version, targetUrl: 'https://synthetic.test/' })
    const active = h.storage.store.get(run.runId)!
    const paused = await h.storage.store.control(run.runId, active.version, 'pause')
    await taskRpc(h, BRIDGE_RUN_RETARGET_METHOD, { ...target, controlRevision: paused.controlRevision, expectedVersion: paused.version,
      targetBinding: 'page_successor', targetUrl: 'https://synthetic.test/' })
    const continued = h.storage.store.get(run.runId)!
    for (const payload of [target, { ...target, controlRevision: 3 }, { ...target, controlRevision: 3, targetBinding: 'page_successor', sessionId: 'foreign' }]) {
      await taskRpc(h, BRIDGE_TASK_TARGET_LOST_METHOD, payload)
      expect(h.storage.store.get(run.runId)).toEqual(continued)
    }
    expect(h.bridge.hasConnection()).toBe(true)
  })

  it('retains unanswered writes as unresolved after page loss and blocks continuation without replay', async () => {
    const h = await connectedLedger(true, true, { tasks: { selectTarget: vi.fn(), approval: vi.fn() } })
    const run = await h.storage.store.create({ sessionId: asSessionId('page-loss-write'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    const target = { runId: run.runId, sessionId: run.sessionId, controlRevision: 0, targetBinding: 'page_write' }
    await taskRpc(h, BRIDGE_TASK_START_METHOD, { ...target, expectedVersion: run.version, targetUrl: 'https://synthetic.test/' })
    await h.storage.store.withExecution(run.runId, 0, async () => {
      const pending = h.bridge.requestTool('browser_click', { ref: 'synthetic' }, new AbortController().signal).catch(error => error)
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      const call = h.frames.find((frame): frame is Extract<BridgeFrame, { t: 'tool.call' }> => frame.t === 'tool.call')!
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === `confirm-${call.id}`))
      await taskRpc(h, BRIDGE_TASK_TARGET_LOST_METHOD, target)
      expect(await pending).toBeInstanceOf(BridgeToolError)
      expect(h.ledger.get(call.id)).toMatchObject({ state: 'unresolved', interruption: { reason: 'cancelled' } })
    })
    const paused = h.storage.store.get(run.runId)!
    await expect(h.storage.store.retargetPaused(run.runId, paused.version, paused.controlRevision, () => {})).rejects.toMatchObject({ code: 'reconciliation-required' })
    expect(h.frames.filter(frame => frame.t === 'tool.call')).toHaveLength(1)
    expect(h.bridge.hasConnection()).toBe(true)
  })

  it('pauses an exact native task target after page access is lost without disconnecting', async () => {
    const h = await connectedLedger(true, true, { tasks: { selectTarget: vi.fn(), approval: vi.fn() } })
    const queued = await h.storage.store.create({ sessionId: asSessionId('page-loss-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    const target = { runId: queued.runId, sessionId: queued.sessionId, controlRevision: 0, targetBinding: 'page_original' }
    send(h.ws, { t: 'rpc', id: 'start-page-loss', method: BRIDGE_TASK_START_METHOD,
      payload: { ...target, expectedVersion: queued.version, targetUrl: 'https://synthetic.test/' } })
    await waitFor(() => h.storage.store.get(queued.runId)?.state === 'running')
    await h.storage.store.withExecution(queued.runId, 0, async () => {
      const execution = h.storage.store.executionFor()!
      send(h.ws, { t: 'rpc', id: 'lose-page', method: BRIDGE_TASK_TARGET_LOST_METHOD, payload: target })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'lose-page'))
      expect(h.storage.store.get(queued.runId)).toMatchObject({ state: 'paused', controlRevision: 1, pauseReason: 'page-unavailable' })
      expect(execution.signal.aborted).toBe(true)
      expect(() => h.storage.store.assertDispatchAuthority(execution)).toThrow()
      expect(h.bridge.hasConnection()).toBe(true)
    })
  })

  it.each(['close', 'replace'] as const)('pauses only the task owned by a lost native connection on %s and permits explicit fresh handoff', async loss => {
    const h = await connectedLedger(true, true, { tasks: { selectTarget: vi.fn(), approval: vi.fn() } })
    const queued = await h.storage.store.create({ sessionId: asSessionId('disconnect-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    const scope = { runId: queued.runId, sessionId: queued.sessionId, expectedVersion: queued.version, controlRevision: 0 }
    send(h.ws, { t: 'rpc', id: 'native-start-before-loss', method: BRIDGE_TASK_START_METHOD,
      payload: { ...scope, targetBinding: 'page_original', targetUrl: 'https://synthetic.test/' } })
    await waitFor(() => h.storage.store.get(queued.runId)?.state === 'running')
    const unrelated = await h.storage.store.create({ sessionId: asSessionId('unrelated-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Unrelated task') })
    let replacement: Awaited<ReturnType<typeof connect>> | undefined
    await h.storage.store.withExecution(queued.runId, 0, async () => {
      const execution = h.storage.store.executionFor()!
      if (loss === 'close') { h.ws.close(); await h.done }
      else {
        replacement = await connect(h.url)
        send(replacement.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
        await waitFor(() => replacement!.frames.some(frame => frame.t === 'hello.ok'))
      }
      await waitFor(() => h.storage.store.get(queued.runId)?.state === 'paused')
      expect(execution.signal.aborted).toBe(true)
      expect(() => h.storage.store.assertDispatchAuthority(execution)).toThrow()
    })
    expect(h.storage.store.get(unrelated.runId)).toEqual(unrelated)
    const paused = h.storage.store.get(queued.runId)!
    expect(paused).toMatchObject({ pauseReason: 'browser-disconnected', controlRevision: 1 })
    if (replacement === undefined) {
      replacement = await connect(h.url)
      send(replacement.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
      await waitFor(() => replacement!.frames.some(frame => frame.t === 'hello.ok'))
    }
    expect(h.storage.store.get(queued.runId)?.state).toBe('paused') // Reconnect is not continuation.
    send(replacement.ws, { t: 'rpc', id: 'explicit-after-loss', method: BRIDGE_RUN_RETARGET_METHOD, payload: { ...scope,
      expectedVersion: paused.version, controlRevision: paused.controlRevision, targetBinding: 'page_fresh', targetUrl: 'https://synthetic.test/' } })
    await waitFor(() => replacement!.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'explicit-after-loss'))
    expect(replacement.frames).toContainEqual(expect.objectContaining({ id: 'explicit-after-loss', ok: true, result: expect.objectContaining({ state: 'running', controlRevision: 3 }) }))
    expect(h.storage.store.get(queued.runId)).not.toHaveProperty('pauseReason')
    // Closing the old socket again cannot pause the successor's revision.
    h.ws.terminate()
    await h.done
    expect(h.storage.store.get(queued.runId)?.state).toBe('running')
  })

  it('keeps an unanswered write unresolved and refuses continuation after connection loss', async () => {
    const h = await connectedLedger(true, true, { tasks: { selectTarget: vi.fn(), approval: vi.fn() } })
    const queued = await h.storage.store.create({ sessionId: asSessionId('disconnect-write-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    send(h.ws, { t: 'rpc', id: 'start-write-loss', method: BRIDGE_TASK_START_METHOD, payload: { runId: queued.runId, sessionId: queued.sessionId,
      expectedVersion: queued.version, controlRevision: 0, targetBinding: 'page_write_loss', targetUrl: 'https://synthetic.test/' } })
    await waitFor(() => h.storage.store.get(queued.runId)?.state === 'running')
    await h.storage.store.withExecution(queued.runId, 0, async () => {
      const pending = h.bridge.requestTool('browser_click', { ref: 'synthetic' }, new AbortController().signal).catch(error => error)
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      const call = h.frames.find((frame): frame is Extract<BridgeFrame, { t: 'tool.call' }> => frame.t === 'tool.call')!
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === `confirm-${call.id}`))
      h.ws.close(); await h.done
      expect(await pending).toBeInstanceOf(BridgeToolError)
      expect(h.ledger.get(call.id)).toMatchObject({ state: 'unresolved', interruption: { reason: 'connection-closed' } })
    })
    await waitFor(() => h.storage.store.get(queued.runId)?.state === 'paused')
    const paused = h.storage.store.get(queued.runId)!
    await expect(h.storage.store.retargetPaused(queued.runId, paused.version, paused.controlRevision, () => {})).rejects.toMatchObject({ code: 'reconciliation-required' })
    expect(h.frames.filter(frame => frame.t === 'tool.call')).toHaveLength(1)
  })
  it('reserves a native new page without starting, then consumes its exact startup once', async () => {
    const selectTarget = vi.fn(), validateTarget = vi.fn()
    const h = await connectedLedger(true, true, { tasks: { selectTarget, validateTarget, approval: vi.fn() } })
    const run = await h.storage.store.create({ sessionId: asSessionId('native-page-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    let next = 0
    const request = async (method: string, payload: unknown) => {
      const id = `native_${++next}`
      send(h.ws, { t: 'rpc', id, method, payload })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === id))
      return h.frames.find((frame): frame is Extract<BridgeFrame, { t: 'rpc.result' }> => frame.t === 'rpc.result' && frame.id === id)!
    }
    const scope = { runId: run.runId, sessionId: run.sessionId, expectedVersion: run.version, controlRevision: 0 }
    const url = 'https://synthetic.test/settings'
    const prepared = await request(BRIDGE_TASK_PAGE_PREPARE_METHOD, { ...scope, url })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('reservation failed')
    const { startTicket, launchUrl } = prepared.result as { startTicket: string; launchUrl: string }
    const ticket = { startTicket, launchUrl }
    expect(validateTarget).toHaveBeenCalledWith(run.runId, url)
    expect(selectTarget).not.toHaveBeenCalled()
    expect(h.storage.store.get(run.runId)?.state).toBe('queued')
    expect((await request(BRIDGE_TASK_PAGE_PREPARE_METHOD, { ...scope, url })).ok).toBe(false)
    const target = { ...scope, targetBinding: 'page_native_new', targetUrl: url }
    expect((await request(BRIDGE_TASK_START_METHOD, target)).ok).toBe(false)
    expect(await request(BRIDGE_TASK_START_METHOD, { ...target, ...ticket, launchUrl: 'https://foreign.test/' })).toMatchObject({ ok: false, error: { code: 'start-rejected' } })
    expect(await request(BRIDGE_TASK_START_METHOD, { ...target, ...ticket })).toMatchObject({ ok: true, result: { state: 'running', targetBinding: target.targetBinding } })
    expect(selectTarget).toHaveBeenCalledOnce()
    // A duplicate commit can never tell the extension to close a possibly active page.
    expect(await request(BRIDGE_TASK_START_METHOD, { ...target, ...ticket })).toMatchObject({ ok: false, error: { code: 'start-uncertain' } })
    expect(await request(BRIDGE_TASK_PAGE_CANCEL_METHOD, { runId: run.runId, sessionId: run.sessionId, startTicket: ticket.startTicket })).toMatchObject({ ok: true, result: { cancelled: false } })
  })

  it('keeps consumed startup uncertainty locked against both new-page and selected-page retries', async () => {
    const h = await connectedLedger(true, true, { tasks: { selectTarget: vi.fn(), validateTarget: vi.fn(), approval: vi.fn() } })
    const run = await h.storage.store.create({ sessionId: asSessionId('uncertain-page-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    const scope = { runId: run.runId, sessionId: run.sessionId, expectedVersion: run.version, controlRevision: 0 }
    const url = 'https://synthetic.test/settings'
    send(h.ws, { t: 'rpc', id: 'reserve-uncertain', method: BRIDGE_TASK_PAGE_PREPARE_METHOD, payload: { ...scope, url } })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'reserve-uncertain'))
    const response = h.frames.find((frame): frame is Extract<BridgeFrame, { t: 'rpc.result'; ok: true }> => frame.t === 'rpc.result' && frame.id === 'reserve-uncertain' && frame.ok)!
    const { startTicket, launchUrl } = response.result as { startTicket: string; launchUrl: string }
    const admission = { startTicket, launchUrl }
    vi.spyOn(h.storage.store, 'startTask').mockRejectedValue(new Error('synthetic storage uncertainty'))
    const payload = { ...scope, ...admission, targetBinding: 'page_uncertain', targetUrl: url }
    send(h.ws, { t: 'rpc', id: 'commit-uncertain', method: BRIDGE_TASK_START_METHOD, payload })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'commit-uncertain'))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'commit-uncertain', ok: false, error: expect.objectContaining({ code: 'start-uncertain' }) }))
    send(h.ws, { t: 'rpc', id: 'retry-uncertain', method: BRIDGE_TASK_START_METHOD, payload })
    send(h.ws, { t: 'rpc', id: 're-reserve-uncertain', method: BRIDGE_TASK_PAGE_PREPARE_METHOD, payload: { ...scope, url } })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'retry-uncertain') && h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 're-reserve-uncertain'))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'retry-uncertain', ok: false, error: expect.objectContaining({ code: 'start-uncertain' }) }))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 're-reserve-uncertain', ok: false }))
    expect(h.storage.store.startTask).toHaveBeenCalledOnce()
  })

  it('does not let a replacement connection consume or cancel an old native reservation', async () => {
    const h = await connectedLedger(true, true, { tasks: { selectTarget: vi.fn(), validateTarget: vi.fn(), approval: vi.fn() } })
    const run = await h.storage.store.create({ sessionId: asSessionId('replacement-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    const scope = { runId: run.runId, sessionId: run.sessionId, expectedVersion: run.version, controlRevision: 0 }, url = 'https://synthetic.test/'
    send(h.ws, { t: 'rpc', id: 'old-reserve', method: BRIDGE_TASK_PAGE_PREPARE_METHOD, payload: { ...scope, url } })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'old-reserve'))
    const { startTicket, launchUrl } = h.frames.find((frame): frame is Extract<BridgeFrame, { t: 'rpc.result'; ok: true }> => frame.t === 'rpc.result' && frame.id === 'old-reserve' && frame.ok)!.result as { startTicket: string; launchUrl: string }
    const result = { startTicket, launchUrl }
    const replacement = await connect(h.url)
    send(replacement.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => replacement.frames.some(frame => frame.t === 'hello.ok'))
    send(replacement.ws, { t: 'rpc', id: 'foreign-commit', method: BRIDGE_TASK_START_METHOD,
      payload: { ...scope, ...result, targetBinding: 'page_foreign', targetUrl: url } })
    send(replacement.ws, { t: 'rpc', id: 'foreign-cancel', method: BRIDGE_TASK_PAGE_CANCEL_METHOD,
      payload: { runId: run.runId, sessionId: run.sessionId, startTicket: result.startTicket } })
    await waitFor(() => replacement.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'foreign-cancel'))
    expect(replacement.frames).toContainEqual(expect.objectContaining({ id: 'foreign-commit', ok: false, error: expect.objectContaining({ code: 'start-rejected' }) }))
    expect(replacement.frames).toContainEqual(expect.objectContaining({ id: 'foreign-cancel', ok: true, result: { cancelled: false } }))
    expect(h.storage.store.get(run.runId)?.state).toBe('queued')
  })
  it('accepts budget waits only for the original live pending task call', async () => {
    const approval = vi.fn()
    const h = await connectedLedger(true, true, { tasks: { selectTarget: vi.fn(), approval } })
    const queued = await h.storage.store.create({ sessionId: asSessionId('approval-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic goal') })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    await h.storage.store.withExecution(run.runId, 0, async () => {
      const result = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      const call = h.frames.find((frame): frame is Extract<BridgeFrame, { t: 'tool.call' }> => frame.t === 'tool.call')!
      expect(call.taskBudget).toBe(true)
      for (const [id, requestId] of [['real-wait', call.id], ['foreign-wait', 'foreign-request']]) {
        send(h.ws, { t: 'rpc', id, method: BRIDGE_TASK_APPROVAL_METHOD, payload: { requestId, waiting: true } })
        await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === id))
      }
      expect(approval).toHaveBeenCalledExactlyOnceWith(run.runId, call.id, true)
      send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: {} })
      await result
      expect(approval).toHaveBeenLastCalledWith(run.runId, call.id, false)
      send(h.ws, { t: 'rpc', id: 'late-wait', method: BRIDGE_TASK_APPROVAL_METHOD, payload: { requestId: call.id, waiting: false } })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'late-wait'))
      expect(approval).toHaveBeenCalledTimes(2)
    })
  })

  it.each(['expired', 'cancelled', 'connection-closed'] as const)('clears an approval wait when its read request ends as %s', async reason => {
    const approval = vi.fn()
    const h = await connectedLedger(true, true, { toolTimeoutMs: reason === 'expired' ? 500 : 2000,
      tasks: { selectTarget: vi.fn(), approval } })
    const queued = await h.storage.store.create({ sessionId: asSessionId('approval-cleanup-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic goal') })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    // This case tests expiry after approval began, not time spent on durable
    // admission. Advance the deadline only after the real socket accepted it.
    if (reason === 'expired') vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await h.storage.store.withExecution(run.runId, 0, async () => {
      const controller = new AbortController()
      const result = h.bridge.requestTool('browser_snapshot', {}, controller.signal).catch(error => error)
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      const call = h.frames.find((frame): frame is Extract<BridgeFrame, { t: 'tool.call' }> => frame.t === 'tool.call')!
      send(h.ws, { t: 'rpc', id: 'wait-for-read', method: BRIDGE_TASK_APPROVAL_METHOD, payload: { requestId: call.id, waiting: true } })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'wait-for-read'))
      expect(approval).toHaveBeenCalledExactlyOnceWith(run.runId, call.id, true)
      if (reason === 'expired') await vi.advanceTimersByTimeAsync(500)
      if (reason === 'cancelled') controller.abort()
      if (reason === 'connection-closed') { h.ws.close(); await h.done }
      expect(await result).toBeInstanceOf(BridgeToolError)
      expect(h.ledger.get(call.id)).toMatchObject({ state: 'unresolved', interruption: { reason } })
      expect(approval).toHaveBeenCalledTimes(2)
      expect(approval).toHaveBeenLastCalledWith(run.runId, call.id, false)
      if (reason === 'connection-closed') {
        expect(() => h.storage.store.executionFor(String(run.sessionId))).toThrow()
        await waitFor(() => h.storage.store.get(run.runId)?.state === 'paused')
      } else {
        // A read error alone keeps the scope live; its approval wait still ends.
        expect(h.storage.store.executionFor(String(run.sessionId))?.runId).toBe(run.runId)
      }
    })
  })

  it('starts a queued task on a reserved native target and exposes its blank session in the picker', async () => {
    const selectTarget = vi.fn()
    const h = await connectedLedger(true, true, { tasks: { selectTarget, approval: vi.fn() } })
    const run = await h.storage.store.create({ sessionId: asSessionId('waiting-task'), requiredCriteriaIds: ['task-goal'], task: newBrowserTask('Synthetic task') })
    h.callMock.mockResolvedValueOnce({ ok: true, value: { items: [{ sessionId: run.sessionId, blank: true }, { sessionId: 'other', blank: true }] } })
    send(h.ws, { t: 'rpc', id: 'catalog', method: 'session.list', payload: {} })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'catalog'))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'catalog', ok: true, result: expect.objectContaining({ result: { ok: true, value: {
      items: [{ sessionId: run.sessionId, blank: false }, { sessionId: 'other', blank: true }] } } }) }))
    const payload = { sessionId: run.sessionId, runId: run.runId, expectedVersion: run.version, controlRevision: 0,
      targetBinding: 'page_native_start', targetUrl: 'https://synthetic.test/settings' }
    send(h.ws, { t: 'rpc', id: 'task-start', method: BRIDGE_TASK_START_METHOD, payload })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'task-start'))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'task-start', ok: true, result: expect.objectContaining({ state: 'running', controlRevision: 0 }) }))
    expect(selectTarget).toHaveBeenCalledWith(run.runId, payload.targetUrl)
    send(h.ws, { t: 'rpc', id: 'task-duplicate', method: BRIDGE_TASK_START_METHOD, payload })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'task-duplicate'))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'task-duplicate', ok: false }))
    expect(selectTarget).toHaveBeenCalledTimes(1)
    await h.storage.store.withExecution(run.runId, 0, async () => {
      const result = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      const call = h.frames.find((frame): frame is Extract<BridgeFrame, { t: 'tool.call' }> => frame.t === 'tool.call')!
      expect(call.targetBinding).toBe(payload.targetBinding)
      send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: {} })
      await result
    })
  })

  it('reserves a selected target before paused handoff publishes its running revision', async () => {
    const h = await connectedLedger(true)
    const queued = await h.storage.store.create({ sessionId: asSessionId('handoff-session'), requiredCriteriaIds: ['saved'] })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    const paused = await h.storage.store.control(run.runId, run.version, 'pause')
    const payload = { sessionId: run.sessionId, runId: run.runId, expectedVersion: paused.version, controlRevision: paused.controlRevision, targetBinding: 'page_user_selected' }
    send(h.ws, { t: 'rpc', id: 'handoff', method: BRIDGE_RUN_RETARGET_METHOD, payload })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'handoff'))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'handoff', ok: true,
      result: expect.objectContaining({ state: 'running', controlRevision: 3, targetBinding: 'page_user_selected' }) }))
    const resumed = h.storage.store.get(run.runId)!
    await h.storage.store.withExecution(run.runId, resumed.controlRevision, async () => {
      const result = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      const call = h.frames.find(frame => frame.t === 'tool.call')! as Extract<BridgeFrame, { t: 'tool.call' }>
      expect(call.targetBinding).toBe('page_user_selected')
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === `confirm-${call.id}`))
      send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: {} })
      await result
    })
    send(h.ws, { t: 'rpc', id: 'duplicate-handoff', method: BRIDGE_RUN_RETARGET_METHOD, payload })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'duplicate-handoff'))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'duplicate-handoff', ok: false }))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'duplicate-handoff', error: expect.objectContaining({ targetState: 'uncertain' }) }))
    expect(h.storage.store.get(run.runId)).toEqual(resumed)
    expect(h.callMock).not.toHaveBeenCalled()
  })

  it('refuses foreign, stale or uncertain handoffs without changing the task', async () => {
    const h = await connectedLedger(true)
    const queued = await h.storage.store.create({ sessionId: asSessionId('handoff-refused'), requiredCriteriaIds: ['saved'] })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    const paused = await h.storage.store.control(run.runId, run.version, 'pause')
    await h.ledger.prepare({ requestId: 'handoff-unknown', connectionId: 'synthetic', sessionId: run.sessionId, name: 'browser_press', args: {}, expiresAt: Date.now() + 60000 })
    const base = { sessionId: run.sessionId, runId: run.runId, expectedVersion: paused.version, controlRevision: paused.controlRevision, targetBinding: 'page_selected' }
    for (const [index, payload] of [{ ...base, sessionId: 'foreign' }, { ...base, expectedVersion: 0 }, base].entries()) {
      const id = `handoff-refused-${index}`
      send(h.ws, { t: 'rpc', id, method: BRIDGE_RUN_RETARGET_METHOD, payload })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === id))
      expect(h.frames).toContainEqual(expect.objectContaining({ id, ok: false, error: expect.objectContaining({ targetState: 'unchanged' }) }))
    }
    expect(h.storage.store.get(run.runId)).toEqual(paused)
  })
  it('cannot declare a selected target unchanged after entering attachment or on duplicate use of that pin', async () => {
    const h = await connectedLedger(true)
    const queued = await h.storage.store.create({ sessionId: asSessionId('uncertain-selected-target'), requiredCriteriaIds: ['saved'] })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    const paused = await h.storage.store.control(run.runId, run.version, 'pause')
    vi.spyOn(h.storage.store, 'retargetPaused').mockImplementation(async (_id, _version, revision, attach) => {
      attach(revision + 2)
      throw new Error('Synthetic commit uncertainty')
    })
    const payload = { sessionId: run.sessionId, runId: run.runId, expectedVersion: paused.version, controlRevision: paused.controlRevision, targetBinding: 'page_uncertain_selected' }
    for (const id of ['uncertain-selected', 'duplicate-selected']) {
      send(h.ws, { t: 'rpc', id, method: BRIDGE_RUN_RETARGET_METHOD, payload })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === id))
      expect(h.frames).toContainEqual(expect.objectContaining({ id, ok: false, error: expect.objectContaining({ targetState: 'uncertain' }) }))
    }
  })
  it('pins the first native target across calls, permits a new revision, and refuses borrowing across connections', async () => {
    const h = await connectedLedger(true, false)
    const queued = await h.storage.store.create({ sessionId: asSessionId('target-session'), requiredCriteriaIds: ['saved'] })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    const calls = () => h.frames.filter(frame => frame.t === 'tool.call') as Array<Extract<BridgeFrame, { t: 'tool.call' }>>
    const confirm = async (call: ReturnType<typeof calls>[number], targetBinding: string | undefined, id: string) => {
      send(h.ws, { t: 'rpc', id, method: BRIDGE_CONFIRM_TOOL_METHOD,
        payload: { id: call.id, action: call.action, execution: call.execution, sessionId: call.sessionId,
          ...(targetBinding === undefined ? {} : { targetBinding }) } })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === id))
      return (h.frames.find(frame => frame.t === 'rpc.result' && frame.id === id) as Extract<BridgeFrame, { t: 'rpc.result' }>).ok
    }
    const reply = (call: ReturnType<typeof calls>[number]) => send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: {} })
    await h.storage.store.withExecution(run.runId, 0, async () => {
      const first = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)
      await waitFor(() => calls().length === 1)
      expect(calls()[0].targetBinding).toBeUndefined()
      expect(await confirm(calls()[0], undefined, 'missing-pin')).toBe(false)
      expect(await confirm(calls()[0], 'page_a', 'first-pin')).toBe(true)
      reply(calls()[0]); await first
      const next = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)
      await waitFor(() => calls().length === 2)
      expect(calls()[1].targetBinding).toBe('page_a')
      expect(await confirm(calls()[1], 'page_b', 'foreign-pin')).toBe(false)
      expect(await confirm(calls()[1], 'page_a', 'same-pin')).toBe(true)
      reply(calls()[1]); await next
      expect(h.ledger.get(calls()[1].id)).toMatchObject({ identityVersion: 4, targetBinding: 'page_a' })
      const paused = await h.storage.store.control(run.runId, h.storage.store.get(run.runId)!.version, 'pause')
      const resumed = await h.storage.store.control(run.runId, paused.version, 'resume')
      await h.storage.store.withExecution(run.runId, resumed.controlRevision, async () => {
        const fresh = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)
        await waitFor(() => calls().length === 3)
        expect(calls()[2].targetBinding).toBeUndefined()
        expect(await confirm(calls()[2], 'page_b', 'new-revision')).toBe(true)
        reply(calls()[2]); await fresh
        const replacement = await connect(h.url, undefined, false)
        send(replacement.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
        await waitFor(() => replacement.frames.some(frame => frame.t === 'hello.ok'))
        expect(() => h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)).toThrow('older connection')
        expect(h.ledger.list()).toHaveLength(3)
      })
    })
  })

  it('cannot race two first confirmations into different run targets', async () => {
    const h = await connectedLedger(true, false)
    const queued = await h.storage.store.create({ sessionId: asSessionId('target-race'), requiredCriteriaIds: ['saved'] })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    await h.storage.store.withExecution(run.runId, 0, async () => {
      const first = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)
      const second = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal).catch(error => error)
      await waitFor(() => h.frames.filter(frame => frame.t === 'tool.call').length === 2)
      const calls = h.frames.filter(frame => frame.t === 'tool.call') as Array<Extract<BridgeFrame, { t: 'tool.call' }>>
      for (const [index, call] of calls.entries()) {
        expect(call.targetBinding).toBeUndefined()
        send(h.ws, { t: 'rpc', id: `race-${index}`, method: BRIDGE_CONFIRM_TOOL_METHOD,
          payload: { id: call.id, action: call.action, execution: call.execution, sessionId: call.sessionId, targetBinding: index === 0 ? 'page_a' : 'page_b' } })
        await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === `race-${index}`))
        expect(h.frames).toContainEqual(expect.objectContaining({ id: `race-${index}`, ok: index === 0 }))
      }
      send(h.ws, { t: 'tool.result', id: calls[0].id, action: calls[0].action, ok: true, result: {} })
      send(h.ws, { t: 'tool.result', id: calls[1].id, action: calls[1].action, ok: false, error: { code: 'execution-denied', message: 'refused' } })
      await first; expect(await second).toBeInstanceOf(BridgeToolError)
    })
  })

  it.each(['browser_open_tab', 'browser_follow_tab', 'browser_close_tab'])('refuses managed %s before recording a possible write', async name => {
    const h = await connectedLedger(true)
    const queued = await h.storage.store.create({ sessionId: asSessionId('target-tab-tools'), requiredCriteriaIds: ['saved'] })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    await h.storage.store.withExecution(run.runId, 0, () => {
      expect(() => h.bridge.requestTool(name, {}, new AbortController().signal)).toThrow(BridgeToolError)
      expect(h.ledger.list()).toEqual([])
      expect(h.frames.some(frame => frame.t === 'tool.call')).toBe(false)
    })
  })
  it.each(['run', 'revision', 'session', 'action', 'digest', 'mode'])('confirms only the original pending managed command: rejects forged %s', async field => {
    const h = await connectedLedger(true, false)
    const queued = await h.storage.store.create({ sessionId: asSessionId('confirmation-session'), requiredCriteriaIds: ['saved'] })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    await h.storage.store.withExecution(run.runId, 0, async () => {
      const result = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      const call = h.frames.find(frame => frame.t === 'tool.call')! as Extract<BridgeFrame, { t: 'tool.call' }>
      const payload = { id: call.id, action: call.action, execution: call.execution, sessionId: call.sessionId, targetBinding: 'page_synthetic_scope' }
      const forged = { ...payload, ...(field === 'run' ? { execution: { kind: 'run', runId: 'other', controlRevision: 0 } }
        : field === 'revision' ? { execution: { kind: 'run', runId: run.runId, controlRevision: 1 } }
        : field === 'session' ? { sessionId: 'other-session' }
        : field === 'mode' ? { execution: { kind: 'legacy' } }
        : { action: { ...call.action, ...(field === 'action' ? { actionId: 'other' } : { requestDigest: 'b'.repeat(64) }) } }) }
      send(h.ws, { t: 'rpc', id: 'forged', method: BRIDGE_CONFIRM_TOOL_METHOD, payload: forged })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'forged'))
      expect(h.frames).toContainEqual(expect.objectContaining({ id: 'forged', ok: false, error: expect.objectContaining({ code: 'execution-denied' }) }))
      send(h.ws, { t: 'rpc', id: 'valid', method: BRIDGE_CONFIRM_TOOL_METHOD, payload })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'valid'))
      expect(h.frames).toContainEqual(expect.objectContaining({ id: 'valid', ok: true, result: { ...payload, confirmed: true } }))
      send(h.ws, { t: 'rpc', id: 'renew', method: BRIDGE_CONFIRM_TOOL_METHOD, payload })
      await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'renew'))
      expect(h.frames).toContainEqual(expect.objectContaining({ id: 'renew', ok: false }))
      send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: { text: 'confirmed' } })
      await expect(result).resolves.toEqual({ text: 'confirmed' })
      expect(h.callMock).not.toHaveBeenCalled()
    })
  })

  it('cannot promote a pending legacy command into a newly started run', async () => {
    const h = await connectedLedger(true, false)
    const result = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 2000, 'confirmation-legacy').catch(error => error)
    await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
    const call = h.frames.find(frame => frame.t === 'tool.call')! as Extract<BridgeFrame, { t: 'tool.call' }>
    const queued = await h.storage.store.create({ sessionId: asSessionId('confirmation-legacy'), requiredCriteriaIds: ['saved'] })
    await h.storage.store.transition(queued.runId, queued.version, 'running')
    send(h.ws, { t: 'rpc', id: 'legacy', method: BRIDGE_CONFIRM_TOOL_METHOD,
      payload: { id: call.id, action: call.action, execution: call.execution, sessionId: call.sessionId } })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'legacy'))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'legacy', ok: false }))
    send(h.ws, { t: 'tool.result', id: call.id, action: call.action, ok: true, result: {} })
    expect(await result).toMatchObject({ code: 'execution-denied' })
  })

  it('refuses confirmation after the captured context ends or the connection is replaced', async () => {
    const h = await connectedLedger(true, false)
    const queued = await h.storage.store.create({ sessionId: asSessionId('confirmation-ended'), requiredCriteriaIds: ['saved'] })
    const run = await h.storage.store.transition(queued.runId, queued.version, 'running')
    let call!: Extract<BridgeFrame, { t: 'tool.call' }>
    let result!: Promise<unknown>
    await h.storage.store.withExecution(run.runId, 0, async () => {
      result = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal).catch(error => error)
      await waitFor(() => h.frames.some(frame => frame.t === 'tool.call'))
      call = h.frames.find(frame => frame.t === 'tool.call')! as typeof call
    })
    const payload = { id: call.id, action: call.action, execution: call.execution, sessionId: call.sessionId }
    send(h.ws, { t: 'rpc', id: 'ended', method: BRIDGE_CONFIRM_TOOL_METHOD, payload })
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'ended'))
    expect(h.frames).toContainEqual(expect.objectContaining({ id: 'ended', ok: false }))
    const replacement = await connect(h.url, undefined, false)
    send(replacement.ws, { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: TOKEN, caps: CAPS })
    await waitFor(() => replacement.frames.some(frame => frame.t === 'hello.ok'))
    send(replacement.ws, { t: 'rpc', id: 'stolen', method: BRIDGE_CONFIRM_TOOL_METHOD, payload })
    await waitFor(() => replacement.frames.some(frame => frame.t === 'rpc.result' && frame.id === 'stolen'))
    expect(replacement.frames).toContainEqual(expect.objectContaining({ id: 'stolen', ok: false }))
    expect(await result).toBeInstanceOf(BridgeToolError)
  })
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
    await waitFor(() => h.frames.some(frame => frame.t === 'rpc.result' && frame.id === `confirm-${call.id}` && frame.ok))
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
