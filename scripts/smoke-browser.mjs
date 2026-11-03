// Opt-in infrastructure smoke: real DSH Host + built extension + a synthetic
// local site. No model is called and no user's DSH or browser profile is used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { makeTaskInstance } from '../benchmark/lib/tasks.mjs'
import { startBenchmarkSite } from '../benchmark/site/server.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const benchmarkRoot = join(repoRoot, 'benchmark')
const require = createRequire(join(repoRoot, 'package.json'))
const bridgeRequire = createRequire(join(repoRoot, 'packages/browser/bridge-browser/package.json'))
const { WebSocketServer } = bridgeRequire('ws')
const { BRIDGE_PROTOCOL_VERSION, BRIDGE_CONFIRM_TOOL_METHOD, isToolDispatchConfirmation, sameToolConfirmation, isPageBrowserTool } = await import(pathToFileURL(join(repoRoot, 'packages/browser/bridge-browser/lib/protocol.js')).href)
const { computeToolCommandDigest } = await import(pathToFileURL(join(repoRoot, 'packages/browser/bridge-browser/lib/index.js')).href)
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'stride-browser-smoke-'))
const home = join(root, 'home')
const runtimeRoot = join(root, 'runtime')
const trigger = join(root, 'start')
const result = join(root, 'result.json')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
delete env.DSH_EXT_TOKEN
delete env.DSH_BROWSER_SESSION_WORKSPACE
delete env.DSH_BRIDGE_ADMIN_TOKEN
process.env.DSH_HOME = home
delete process.env.DSH_EXT_TOKEN
delete process.env.DSH_BROWSER_SESSION_WORKSPACE
delete process.env.DSH_BRIDGE_ADMIN_TOKEN
let site
let host
let browser

async function command(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output)
  } finally { clearTimeout(timer) }
}

async function freePort() {
  const socket = createServer()
  await new Promise((resolveListen, reject) => {
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', resolveListen)
  })
  const port = socket.address().port
  await new Promise((resolveClose) => socket.close(resolveClose))
  return port
}

async function waitForResult() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (host.child.exitCode !== null) throw new Error('DSH exited during the browser smoke')
    try { return JSON.parse(await readFile(result, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await delay(100)
  }
  throw new Error('timed out waiting for the Host browser tools')
}

async function waitForPhase(phase) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const outcome = await readFile(result, 'utf8').then(JSON.parse).catch(() => undefined)
      if (outcome?.ok === false) throw new Error(`Browser probe failed: ${outcome.error}`)
      const progress = JSON.parse(await readFile(`${result}.phase`, 'utf8'))
      if (progress.phase === phase) return progress
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await delay(100)
  }
  throw new Error(`timed out waiting for browser probe phase ${phase}`)
}

function confirmSyntheticTool(socket, frame, commands, pins) {
  if (frame.t !== 'rpc' || frame.method !== BRIDGE_CONFIRM_TOOL_METHOD) return
  const original = commands.get(frame.payload?.id)
  const page = original?.execution.kind === 'run' && isPageBrowserTool(original.name)
  const key = page ? JSON.stringify([original.sessionId, original.execution.runId, original.execution.controlRevision]) : undefined
  const proposed = page ? frame.payload?.targetBinding : undefined
  const expected = original === undefined ? undefined : { id: original.id, action: original.action, execution: original.execution,
    ...(original.sessionId === undefined ? {} : { sessionId: original.sessionId }),
    ...(page ? { targetBinding: original.targetBinding ?? proposed } : {}) }
  const ok = expected !== undefined && isToolDispatchConfirmation(frame.payload) && sameToolConfirmation(expected, frame.payload)
    && (!page || (typeof proposed === 'string' && (pins.get(key) === undefined || pins.get(key) === proposed)))
  if (ok && page) pins.set(key, proposed)
  socket.send(JSON.stringify({ t: 'rpc.result', id: frame.id, ok,
    ...(ok ? { result: { ...expected, confirmed: true } } : { error: { code: 'execution-denied', message: 'Synthetic request is not pending' } }) }))
}

async function verifyIncompatibleHost(protocolVersion, expectedState) {
  const args = { url: `${site.origin}/health` }
  const actionId = 'act_synthetic_incompatible'
  const action = { actionId, requestDigest: await computeToolCommandDigest({ actionId, name: 'browser_navigate', args }) }
  let connections = 0
  let toolResults = 0
  let url
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ wsUrl: url }))
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', socket => {
    connections += 1
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      if (frame.t === 'tool.result') toolResults += 1
      if (frame.t !== 'hello') return
      socket.send(JSON.stringify({ t: 'hello.ok', caps: frame.caps,
        ...(protocolVersion === undefined ? {} : { protocolVersion }) }))
      socket.send(JSON.stringify({ t: 'tool.call', execution: { kind: 'legacy' }, id: 'rejected-navigation', action, name: 'browser_navigate',
        args, expiresAt: Date.now() + 10000 }))
    })
  })
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    url = `ws://127.0.0.1:${server.address().port}/ext/bridge`
    const originalTarget = browser.target.url()
    await browser.panel.evaluate(({ bridgeUrl, state }) => new Promise((resolveStatus, reject) => {
      const port = window.__dshBenchmarkPort
      const finish = (error) => {
        clearTimeout(timer)
        port.onMessage.removeListener(onMessage)
        error ? reject(error) : resolveStatus()
      }
      const onMessage = message => {
        if (message?.type === 'status' && message.state === state) finish()
      }
      const timer = setTimeout(() => finish(new Error('compatibility status did not arrive')), 10000)
      port.onMessage.addListener(onMessage)
      port.postMessage({ type: 'settings', settings: { bridgeUrl, token: 'synthetic-compatibility-token' } })
    }), { bridgeUrl: url, state: expectedState })
    await browser.panel.waitForFunction(() => /更新|Update/u.test(document.querySelector('.connection-label')?.textContent ?? ''))
    assert.match(await browser.panel.locator('.connection-label').textContent(), /更新|Update/u)
    await delay(1200)
    assert.equal(connections, 1, 'incompatible peers must not reconnect automatically')
    assert.equal(toolResults, 0, 'an incompatible peer must not dispatch tools')
    assert.equal(browser.target.url(), originalTarget, 'rejected tools must not navigate the page')
  } finally {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise(resolveClose => sockets.close(resolveClose))
    await new Promise(resolveClose => server.close(resolveClose))
  }
}

async function verifyPersistentExecutionFence() {
  let url
  let activeSocket
  let connections = 0
  const replies = new Map()
  const commands = new Map()
  const pins = new Map()
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ wsUrl: url }))
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', socket => {
    connections += 1
    activeSocket = socket
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      if (frame.t === 'hello') socket.send(JSON.stringify({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: frame.caps }))
      if (frame.t === 'tool.result') replies.set(frame.id, frame)
      confirmSyntheticTool(socket, frame, commands, pins)
    })
  })
  const destination = `${site.origin}/health?execution-fence=synthetic`
  let navigations = 0
  const countNavigation = request => { if (request.isNavigationRequest() && request.url() === destination) navigations += 1 }
  browser.target.on('request', countNavigation)
  async function connectPanel() {
    await browser.panel.evaluate(({ bridgeUrl, trustedOrigin }) => new Promise((resolveStatus, reject) => {
      const port = window.__dshBenchmarkPort ??= chrome.runtime.connect({ name: 'dsh-panel' })
      const timer = setTimeout(() => { port.onMessage.removeListener(onMessage); reject(new Error('synthetic Host connection timed out')) }, 10000)
      const onMessage = message => {
        if (message?.type !== 'status' || message.state !== 'connected') return
        clearTimeout(timer)
        port.onMessage.removeListener(onMessage)
        resolveStatus()
      }
      port.onMessage.addListener(onMessage)
      port.postMessage({ type: 'settings', settings: { bridgeUrl, token: 'synthetic-execution-token', trustedActionOrigins: [trustedOrigin] } })
    }), { bridgeUrl: url, trustedOrigin: site.origin })
  }
  const actionId = 'act_synthetic_persistent_execution'
  async function command(id, args) {
    const action = { actionId, requestDigest: await computeToolCommandDigest({ actionId, name: 'browser_navigate', args }) }
    const call = { t: 'tool.call', id, action, execution: { kind: 'legacy' }, name: 'browser_navigate', args, expiresAt: Date.now() + 15000 }
    commands.set(id, call)
    activeSocket.send(JSON.stringify(call))
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !replies.has(id)) await delay(50)
    const reply = replies.get(id)
    assert.ok(reply, 'synthetic command did not produce a receipt')
    assert.deepEqual(reply.action, action)
    return reply
  }
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
    url = `ws://127.0.0.1:${server.address().port}/ext/bridge`
    await connectPanel()
    const args = { url: destination }
    const first = await command('synthetic-first-attempt', args)
    assert.equal(first.ok, true, JSON.stringify(first.error))
    assert.equal(navigations, 1)
    assert.equal((await command('synthetic-retransmission', args)).error?.code, 'action-duplicate')
    assert.equal((await command('synthetic-conflict', { url: `${site.origin}/health?changed=synthetic` })).error?.code, 'action-conflict')
    assert.equal(navigations, 1)
    const stored = await browser.panel.evaluate(id => new Promise((resolveRow, reject) => {
      const open = indexedDB.open('dsh-browser-execution', 1)
      open.onsuccess = () => {
        const db = open.result
        const transaction = db.transaction('receipts', 'readonly')
        const get = transaction.objectStore('receipts').get(id)
        transaction.oncomplete = () => { db.close(); resolveRow(get.result) }
        transaction.onerror = () => { db.close(); reject(new Error('receipt read failed')) }
      }
      open.onerror = () => reject(new Error('receipt database failed'))
    }), actionId)
    assert.equal(stored.phase, 'finished')
    assert.deepEqual(Object.keys(stored).sort(), ['actionId', 'createdAt', 'finishedAt', 'phase', 'requestDigest'])
    const pageStores = await browser.target.evaluate(() => new Promise((resolveStores, reject) => {
      const open = indexedDB.open('dsh-browser-execution', 1)
      open.onsuccess = () => { const db = open.result; const names = [...db.objectStoreNames]; db.close(); resolveStores(names) }
      open.onerror = () => reject(new Error('synthetic page database failed'))
    }))
    assert.deepEqual(pageStores, [], 'webpage origin must not see extension execution receipts')
    // Stop the actual extension worker and wake a fresh one from the panel.
    // This retains the same disposable browser profile and IndexedDB.
    const cdp = await browser.context.newCDPSession(browser.panel)
    const versions = new Map()
    const stopped = new Set()
    cdp.on('ServiceWorker.workerVersionUpdated', event => {
      for (const version of event.versions) {
        versions.set(version.versionId, version)
        if (version.runningStatus === 'stopped') stopped.add(version.versionId)
      }
    })
    await cdp.send('ServiceWorker.enable')
    const workerUrl = browser.worker.url()
    let version
    let deadline = Date.now() + 10000
    while (Date.now() < deadline && version === undefined) {
      version = [...versions.values()].find(item => item.scriptURL === workerUrl && item.runningStatus === 'running')
      if (version === undefined) await delay(50)
    }
    assert.ok(version, 'running extension worker must appear in CDP service-worker state')
    stopped.delete(version.versionId)
    const previousConnections = connections
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId })
    deadline = Date.now() + 10000
    while (Date.now() < deadline && !stopped.has(version.versionId)) await delay(50)
    assert.ok(stopped.has(version.versionId), 'CDP must confirm the extension worker stopped')
    await browser.panel.reload()
    await browser.panel.waitForSelector('header.topbar')
    await connectPanel()
    assert.ok(connections > previousConnections, 'fresh worker must establish a new connection')
    await cdp.detach()
    assert.equal((await command('synthetic-after-worker-reload', args)).error?.code, 'action-duplicate')
    assert.equal(navigations, 1, 'worker restart must not replay a recorded navigation')
  } finally {
    browser.target.off('request', countNavigation)
    for (const socket of sockets.clients) socket.terminate()
    await new Promise(resolveClose => sockets.close(resolveClose))
    await new Promise(resolveClose => server.close(resolveClose))
  }
}

async function verifyTargetFences() {
  const counts = { a: 0, b: 0 }
  const replies = new Map()
  const commands = new Map()
  const pins = new Map()
  let activeSocket
  let other
  let opened
  let wsUrl
  let heldConfirmation
  const sessionId = 'session-synthetic-target-fence'
  const server = createHttpServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/ext/bridge-config') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ wsUrl }))
      return
    }
    const event = path.match(/^\/event\/([ab])$/u)?.[1]
    if (event) {
      counts[event] += 1
      res.writeHead(204).end()
      return
    }
    const page = path.startsWith('/b') ? 'b' : 'a'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>Synthetic target ${page}</title><input autofocus aria-label="Probe"><script>document.addEventListener('keydown',e=>{if(e.key==='Enter')fetch('/event/${page}',{method:'POST'})})</script>`)
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', socket => {
    activeSocket = socket
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      if (frame.t === 'hello') socket.send(JSON.stringify({ t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: frame.caps }))
      if (frame.t === 'tool.result') replies.set(frame.id, frame)
      if (frame.t === 'rpc' && frame.method === BRIDGE_CONFIRM_TOOL_METHOD) {
        if (frame.payload?.id === 'synthetic-authority-denied') {
          socket.send(JSON.stringify({ t: 'rpc.result', id: frame.id, ok: false, error: { code: 'execution-denied', message: 'Synthetic context revoked' } }))
          return
        }
        if (frame.payload?.id === 'synthetic-authority-tampered') {
          socket.send(JSON.stringify({ t: 'rpc.result', id: frame.id, ok: true, result: { ...frame.payload,
            execution: { ...frame.payload.execution, controlRevision: 3 }, confirmed: true } }))
          return
        }
        if (frame.payload?.id === 'synthetic-authority-late') { heldConfirmation = { socket, frame }; return }
      }
      confirmSyntheticTool(socket, frame, commands, pins)
    })
  })
  const wait = async (check, label) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await check()) return
      await delay(50)
    }
    throw new Error(`Queued target smoke timed out: ${label}`)
  }
  const actionFor = async (id, name = 'browser_press', args = { key: 'Enter' }, execution = { kind: 'legacy' }) => {
    const actionId = `act_${id}`
    const targetBinding = execution.kind === 'run' && isPageBrowserTool(name)
      ? pins.get(JSON.stringify([sessionId, execution.runId, execution.controlRevision])) : undefined
    const action = { actionId, requestDigest: await computeToolCommandDigest({ actionId, name, args, sessionId, execution, targetBinding }) }
    const call = { t: 'tool.call', id, action, execution, name, args, sessionId, ...(targetBinding === undefined ? {} : { targetBinding }), expiresAt: Date.now() + 15_000 }
    commands.set(id, call)
    return call
  }
  const receiptPhase = async actionId => await browser.worker.evaluate(id => new Promise((resolveAdmission, reject) => {
    const request = indexedDB.open('dsh-browser-execution', 1)
    request.onerror = () => reject(new Error('receipt read failed'))
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('receipts', 'readonly')
      const read = transaction.objectStore('receipts').get(id)
      read.onsuccess = () => resolveAdmission(read.result?.phase)
      transaction.oncomplete = () => db.close()
    }
  }), actionId)
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
    const origin = `http://127.0.0.1:${server.address().port}`
    wsUrl = `ws://127.0.0.1:${server.address().port}/ext/bridge`
    await browser.panel.evaluate(bridgeUrl => new Promise((resolveConnection, reject) => {
      const port = window.__dshBenchmarkPort
      const timer = setTimeout(() => { port.onMessage.removeListener(onMessage); reject(new Error('target-fence Host did not connect')) }, 10000)
      const onMessage = message => {
        if (message?.type !== 'status' || message.state !== 'connected') return
        clearTimeout(timer); port.onMessage.removeListener(onMessage); resolveConnection()
      }
      port.onMessage.addListener(onMessage)
      port.postMessage({ type: 'settings', settings: { bridgeUrl, token: 'synthetic-target-fence-token', trustedActionOrigins: [new URL(bridgeUrl.replace('ws:', 'http:')).origin] } })
    }), wsUrl)
    await browser.prepare(`${origin}/a`)
    await browser.bindSession(sessionId)
    await browser.worker.evaluate(() => {
      const original = chrome.tabs.sendMessage.bind(chrome.tabs)
      const originalGet = chrome.tabs.get.bind(chrome.tabs)
      const originalSet = chrome.storage.session.set.bind(chrome.storage.session)
      let release
      const gate = new Promise(resolveGate => { release = resolveGate })
      const state = { started: false, sends: [], release, contextWrites: [], checkpoint: undefined,
        armCheckpoint: tabId => {
          let releaseCheckpoint
          const gate = new Promise(resolveGate => { releaseCheckpoint = resolveGate })
          state.checkpoint = { tabId, gets: 0, started: false, release: releaseCheckpoint, gate }
        },
        restore: () => { chrome.tabs.sendMessage = original; chrome.tabs.get = originalGet; chrome.storage.session.set = originalSet } }
      globalThis.__strideTargetFence = state
      chrome.tabs.get = async tabId => {
        const tab = await originalGet(tabId)
        const checkpoint = state.checkpoint
        if (checkpoint?.tabId === tabId && ++checkpoint.gets === 2) {
          checkpoint.started = true
          await checkpoint.gate
        }
        return tab
      }
      chrome.storage.session.set = async items => {
        if (items.dshPageSessionContexts !== undefined) state.contextWrites.push(items.dshPageSessionContexts)
        return originalSet(items)
      }
      chrome.tabs.sendMessage = async (...args) => {
        const message = args[1]
        const first = message?.type === 'DSH_ACTION' && message.action === 'browser_press' && state.sends.length === 0
        if (message?.type === 'DSH_ACTION' && message.action === 'browser_press') state.sends.push(args[0])
        const answer = await original(...args)
        if (first) { state.started = true; await gate }
        return answer
      }
    })
    const first = await actionFor('synthetic-target-first')
    activeSocket.send(JSON.stringify(first))
    await wait(() => browser.worker.evaluate(() => globalThis.__strideTargetFence.started), 'first write committed')
    await wait(() => counts.a === 1, 'first page keyboard effect')
    const queued = await actionFor('synthetic-target-queued')
    activeSocket.send(JSON.stringify(queued))
    await wait(async () => (await receiptPhase(queued.action.actionId)) !== undefined, 'queued write admitted')
    other = await browser.context.newPage()
    await other.goto(`${origin}/b`, { waitUntil: 'domcontentloaded' })
    await browser.bindSession(sessionId, other)
    await wait(() => replies.has(queued.id), 'old queued request withdrawn')
    assert.equal(replies.get(queued.id).ok, false)
    const fresh = await actionFor('synthetic-target-fresh')
    activeSocket.send(JSON.stringify(fresh))
    await wait(async () => (await receiptPhase(fresh.action.actionId)) !== undefined, 'fresh write admitted')
    await delay(150)
    assert.equal(counts.b, 0, 'cancelling a waiter must not release the next write before the committed action settles')
    assert.equal(replies.has(fresh.id), false)
    await browser.worker.evaluate(() => globalThis.__strideTargetFence.release())
    await wait(() => replies.has(first.id) && replies.has(fresh.id), 'committed and fresh requests settle')
    assert.equal(replies.get(fresh.id).ok, true)
    await wait(() => counts.b === 1, 'new page keyboard effect')
    assert.deepEqual(counts, { a: 1, b: 1 }, 'the obsolete request must not write to either page')
    const sends = await browser.worker.evaluate(() => globalThis.__strideTargetFence.sends)
    assert.equal(sends.length, 2, 'only the committed old write and the explicitly fresh write reach content scripts')
    console.log('Queued target fence passed: one committed old-page effect, no obsolete queued effect, one fresh new-page effect, no write overtaking')

    const tabId = sends[1]
    await browser.worker.evaluate(id => globalThis.__strideTargetFence.armCheckpoint(id), tabId)
    const checkpointCall = await actionFor('synthetic-target-checkpoint', 'browser_reload', {})
    activeSocket.send(JSON.stringify(checkpointCall))
    await wait(() => browser.worker.evaluate(() => globalThis.__strideTargetFence.checkpoint.started), 'navigation checkpoint read held')
    await other.goto(`${origin}/b/current`, { waitUntil: 'domcontentloaded' })
    await browser.bindSession(sessionId, other)
    const contextWritesBefore = await browser.worker.evaluate(() => globalThis.__strideTargetFence.contextWrites.length)
    await browser.worker.evaluate(() => globalThis.__strideTargetFence.checkpoint.release())
    await wait(async () => (await receiptPhase(checkpointCall.action.actionId)) === 'finished', 'old checkpoint execution settled')
    await wait(() => replies.has(checkpointCall.id), 'old checkpoint reply returned')
    assert.equal(replies.get(checkpointCall.id).ok, false)
    assert.equal(await browser.worker.evaluate(() => globalThis.__strideTargetFence.contextWrites.length), contextWritesBefore, 'a superseded checkpoint must not persist after a same-tab rebind')
    const recovered = await browser.worker.evaluate(async id => (await chrome.storage.session.get('dshPageSessionContexts')).dshPageSessionContexts?.tabs?.[id]?.urlKey, tabId)
    assert.equal(recovered, `${origin}/b/current`, 'the fresh page-to-conversation checkpoint must survive an old native read')

    const managed = { kind: 'run', runId: 'run_synthetic_receiver', controlRevision: 2 }
    for (const id of ['synthetic-authority-denied', 'synthetic-authority-tampered']) {
      activeSocket.send(JSON.stringify(await actionFor(id, 'browser_press', { key: 'Enter' }, managed)))
      await wait(() => replies.has(id), 'refused managed execution returned')
      assert.equal(replies.get(id).error?.code, 'execution-denied')
    }
    const late = await actionFor('synthetic-authority-late', 'browser_press', { key: 'Enter' }, managed)
    activeSocket.send(JSON.stringify(late))
    await wait(() => heldConfirmation !== undefined, 'managed confirmation held')
    activeSocket.send(JSON.stringify({ t: 'tool.cancel', id: late.id }))
    await wait(() => replies.has(late.id), 'managed request cancelled before confirmation')
    heldConfirmation.socket.send(JSON.stringify({ t: 'rpc.result', id: heldConfirmation.frame.id, ok: true,
      result: { ...heldConfirmation.frame.payload, confirmed: true } }))
    const current = await actionFor('synthetic-authority-current', 'browser_press', { key: 'Enter' }, managed)
    activeSocket.send(JSON.stringify(current))
    await wait(() => replies.has(current.id), 'fresh managed request completed')
    assert.equal(replies.get(current.id).ok, true)
    await wait(() => counts.b === 2, 'exactly one new managed effect')
    assert.deepEqual(counts, { a: 1, b: 2 }, 'refused, forged and late confirmations must have no page effects')
    assert.equal(await browser.worker.evaluate(() => globalThis.__strideTargetFence.sends.length), 3)
    console.log('Receiver execution fence passed: denied and forged revisions have no effect; late confirmation cannot revive cancellation; fresh managed call executes once')

    await browser.bindSession(sessionId, browser.target)
    const rebound = await actionFor('synthetic-run-rebound', 'browser_press', { key: 'Enter' }, managed)
    assert.equal(typeof rebound.targetBinding, 'string', 'the Host carries its previously confirmed target')
    activeSocket.send(JSON.stringify(rebound))
    await wait(() => replies.has(rebound.id), 'same-revision run target refused after rebind')
    assert.equal(replies.get(rebound.id).error?.code, 'execution-denied')
    const newRevision = await actionFor('synthetic-run-new-revision', 'browser_press', { key: 'Enter' }, { ...managed, controlRevision: 4 })
    activeSocket.send(JSON.stringify(newRevision))
    await wait(() => replies.has(newRevision.id), 'fresh revision binds its selected native target')
    assert.equal(replies.get(newRevision.id).ok, true)
    await wait(() => counts.a === 2, 'new revision executes exactly once on its new target')
    assert.deepEqual(counts, { a: 2, b: 2 }, 'the rebound old run must not follow the fresh target')
    assert.equal(await browser.worker.evaluate(() => globalThis.__strideTargetFence.sends.length), 4)
    console.log('Run target fence passed: old revision cannot follow an explicit rebind; new revision binds and executes once on its selected target')

    const openCall = await actionFor('synthetic-target-open', 'browser_open_tab', { url: `${origin}/opened`, active: false })
    activeSocket.send(JSON.stringify(openCall))
    await wait(() => replies.has(openCall.id), 'current owner opens a background tab')
    assert.equal(replies.get(openCall.id).ok, true, JSON.stringify(replies.get(openCall.id).error))
    await wait(() => (opened = browser.context.pages().find(page => page.url() === `${origin}/opened`)) !== undefined, 'current-owner page appears')
    console.log('Checkpoint owner fence passed: late native read withheld after same-tab navigation/rebind; current owner can still open a tab')
  } finally {
    await browser.worker.evaluate(() => { globalThis.__strideTargetFence?.release(); globalThis.__strideTargetFence?.checkpoint?.release(); globalThis.__strideTargetFence?.restore(); delete globalThis.__strideTargetFence }).catch(() => {})
    await opened?.close().catch(() => {})
    await other?.close().catch(() => {})
    await browser.prepare(`${site.origin}/health`).catch(() => {})
    await browser.bindSession('session-synthetic-target-restored').catch(() => {})
    for (const socket of sockets.clients) socket.terminate()
    await new Promise(resolveClose => sockets.close(resolveClose))
    await new Promise(resolveClose => server.close(resolveClose))
  }
}

try {
  await mkdir(home, { recursive: true })
  await command(['plugin', '--profile', 'web', 'add', '-w', `@eilyeee/dsh-browser-stride@link:${join(repoRoot, 'packages/browser/bridge-browser')}`])
  site = await startBenchmarkSite({ port: 0 })
  const port = await freePort()
  host = await startDshBackend({
    backend: 'extension', port, repoRoot, benchmarkRoot, runtimeRoot,
    startUrl: `${site.origin}/health`,
    toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/browser-tool-probe.mjs'), trigger, result },
  })
  browser = await startExtensionBrowser({
    repoRoot, benchmarkRoot, bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`,
    deferPairing: true, trustedOrigin: site.origin,
    chromiumArgs: ['--no-proxy-server', '--host-resolver-rules=MAP stride-auto.test 127.0.0.1, MAP stride-auto-next.test 127.0.0.1'],
  })
  // Exercise the real extension UI, owner HTTP authentication and Host UI.
  // The process launch URL stays inside this isolated temporary profile.
  const owner = await browser.context.newPage()
  await browser.panel.setViewportSize({ width: 420, height: 900 })
  await owner.goto(host.getAuthenticatedUrl(), { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('Isolated Host browser login failed') })
  const ownerPath = '/api/stride-browser-pairing'
  assert.equal((await fetch(`${host.baseUrl}${ownerPath}`)).status, 401)
  assert.equal((await fetch(`${host.baseUrl}${ownerPath}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
  assert.equal((await fetch(`${host.baseUrl}/ext/bridge-pairing-request`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400)
  const pairingResponses = []
  browser.context.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === host.baseUrl && url.pathname.includes('pairing')) pairingResponses.push({ path: url.pathname, status: response.status() })
  })
  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  await browser.panel.locator('.settings-panel input').first().fill(`ws://127.0.0.1:${port}/ext/bridge`)
  await browser.panel.getByRole('button', { name: '连接本机 DSH', exact: true }).click()
  await browser.panel.locator('.pairing-code').waitFor().catch(async () => {
    const notice = await browser.panel.locator('.pairing-section').innerText()
    throw new Error(`Pairing UI did not enter pending state: ${notice}; HTTP ${JSON.stringify(pairingResponses)}`)
  })
  const verificationCode = await browser.panel.locator('.pairing-code').textContent()
  assert.match(verificationCode, /^[A-F0-9]{8}$/)
  const uiArtifacts = join(repoRoot, '.stride-private/validation/pairing')
  await mkdir(uiArtifacts, { recursive: true })
  await owner.screenshot({ path: join(uiArtifacts, 'host.png') })
  await browser.panel.screenshot({ path: join(uiArtifacts, 'extension.png') })
  const onboarding = owner.getByRole('button', { name: '继续', exact: true })
  await onboarding.waitFor({ timeout: 15_000 })
  await onboarding.click()
  // This smoke uses no account or API key. Dismiss the optional sign-in dialog
  // through its normal UI before opening settings.
  await owner.getByRole('button', { name: '关闭', exact: true }).last().click()
  await owner.getByRole('button', { name: '账号菜单', exact: true }).click({ timeout: 3_000 }).catch(async () => {
    await owner.screenshot({ path: join(uiArtifacts, 'onboarding.png') })
    throw new Error(`Isolated Host setup still open: ${(await owner.locator('body').innerText()).slice(-1600)}`)
  })
  await owner.getByText('设置', { exact: true }).click()
  await owner.getByText(verificationCode, { exact: true }).waitFor()
  await owner.getByText(verificationCode, { exact: true }).scrollIntoViewIfNeeded()
  await owner.screenshot({ path: join(uiArtifacts, 'host.png') })
  // An untrusted script click must not approve the pending request.
  await owner.getByRole('button', { name: /确认配对|Confirm pairing/u }).evaluate(button => button.click())
  await delay(200)
  assert.equal((await host.listInstallations()).length, 0)
  await owner.getByRole('button', { name: /确认配对|Confirm pairing/u }).click()
  await browser.panel.getByText('连接已保存，以后会自动重连。', { exact: true }).waitFor({ timeout: 10_000 }).catch(async () => {
    throw new Error(`Credential was not saved: ${await browser.panel.locator('.pairing-section').innerText()}; HTTP ${JSON.stringify(pairingResponses)}`)
  })
  await browser.panel.getByRole('button', { name: '返回对话', exact: true }).click()
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15_000 })
  await browser.panel.reload()
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15_000 })
  await browser.panel.evaluate(() => { window.__dshBenchmarkPort = chrome.runtime.connect({ name: 'dsh-panel' }) })
  await owner.close()
  const instance = makeTaskInstance('notification_toggle', 1, 'stride-browser-smoke', site.origin)
  await browser.prepare(instance.url)
  // Create the test conversation through the actual panel, so its task card
  // and tool dispatch share the same session. Only disposable storage is read.
  const previousSession = await browser.panel.locator('.app').getAttribute('data-session-id')
  await browser.panel.locator('.new-session-trigger').click()
  await browser.target.bringToFront()
  await browser.panel.waitForFunction(previous => {
    const current = document.querySelector('.app')?.getAttribute('data-session-id')
    return typeof current === 'string' && current !== previous
  }, previousSession)
  const session = { sessionId: await browser.panel.locator('.app').getAttribute('data-session-id') }
  await browser.bindSession(session.sessionId)
  await writeFile(trigger, JSON.stringify({ sessionId: session.sessionId }), { mode: 0o600 })
  const ready = await waitForPhase('pause-ready')
  const card = browser.panel.locator(`.browser-runs [data-run-id="${ready.runId}"]`)
  await card.getByText('运行中', { exact: true }).waitFor().catch(async () => {
    const metadata = await browser.panel.evaluate(sessionId => new Promise(resolveReply => {
      const port = window.__dshBenchmarkPort
      const id = crypto.randomUUID()
      const timer = setTimeout(() => { port.onMessage.removeListener(onMessage); resolveReply({ timedOut: true }) }, 3000)
      const onMessage = message => {
        if (message?.type !== 'rpc.result' || message.id !== id) return
        clearTimeout(timer)
        port.onMessage.removeListener(onMessage)
        resolveReply(message)
      }
      port.onMessage.addListener(onMessage)
      port.postMessage({ type: 'rpc', id, method: 'bridge.browserRuns.list', payload: { sessionId } })
    }), session.sessionId)
    throw new Error(`Task card unavailable: panelSession=${await browser.panel.locator('.app').getAttribute('data-session-id')}; status=${await browser.panel.locator('.browser-runs').allTextContents()}; metadata=${JSON.stringify(metadata)}`)
  })
  await card.getByRole('button', { name: '暂停任务', exact: true }).evaluate(button => button.click())
  await delay(200)
  assert.equal(await card.getByText('运行中', { exact: true }).count(), 1, 'script-generated clicks must not pause a task')
  await card.getByRole('button', { name: '暂停任务', exact: true }).click()
  await card.getByText('已暂停', { exact: true }).waitFor()
  assert.equal(await browser.target.getByRole('checkbox', { name: '邮件通知', exact: true }).isChecked(), true)
  let handoffPage = await browser.context.newPage()
  await handoffPage.goto(instance.url, { waitUntil: 'domcontentloaded' })
  assert.equal(await handoffPage.getByRole('checkbox', { name: '邮件通知', exact: true }).isChecked(), false)
  await browser.bindSession(session.sessionId, handoffPage)
  const retarget = card.getByRole('button', { name: '在已绑定页面继续', exact: true })
  await retarget.waitFor()
  await retarget.evaluate(button => button.click())
  await delay(200)
  assert.equal(await card.getByText('已暂停', { exact: true }).count(), 1, 'synthetic clicks must not transfer target authority')
  await retarget.click()

  await waitForPhase('stop-ready').catch(async error => {
    throw new Error(`${error.message}; task controls: ${await card.innerText()}; panel session matches test: ${await browser.panel.locator('.app').getAttribute('data-session-id') === session.sessionId}`)
  })
  await card.getByText('运行中', { exact: true }).waitFor()
  await card.getByRole('button', { name: '停止任务', exact: true }).click()
  await card.getByText('停止中', { exact: true }).waitFor()
  assert.equal(await card.locator('.browser-run-actions').count(), 0)
  await writeFile(`${trigger}.ack-stop`, '', { mode: 0o600 })
  await waitForPhase('auto-open-ready')
  await card.getByText('已停止', { exact: true }).waitFor()
  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  const automaticToggle = browser.panel.getByRole('checkbox', { name: '自动控制 DSH 新建页面', exact: false })
  assert.equal(await automaticToggle.isChecked(), false, 'upgrades do not silently enable debugger control')
  await automaticToggle.evaluate(input => input.click())
  assert.equal(await automaticToggle.isChecked(), false, 'synthetic clicks cannot enable automatic control')
  await automaticToggle.check()
  await browser.panel.getByRole('button', { name: '保存并连接', exact: true }).click()
  const automaticOrigin = `http://stride-auto.test:${new URL(site.origin).port}`
  const automaticInstance = makeTaskInstance('notification_toggle', 1, 'stride-auto-open-smoke', automaticOrigin)
  const automaticNextUrl = automaticInstance.url.replace('stride-auto.test', 'stride-auto-next.test')
  await writeFile(`${trigger}.auto-open`, JSON.stringify({ url: automaticInstance.url, nextUrl: automaticNextUrl }), { mode: 0o600 })
  await browser.panel.getByRole('button', { name: '仅允许这一次', exact: true }).click({ timeout: 20000 }).catch(async () => {
    const outcome = await readFile(result, 'utf8').then(JSON.parse).catch(() => undefined)
    const debug = await browser.worker.evaluate(async () => {
      const saved = await chrome.storage.session.get(['dshPageAccess', 'dshTabAffinity'])
      return { grants: saved.dshPageAccess?.grants?.map(row => ({ mode: row.mode, grouped: row.groupId !== undefined })),
        settings: (await chrome.storage.local.get('dshSettings')).dshSettings?.autoControlNewTabs }
    })
    throw new Error(`Automatic page action did not request approval: ${JSON.stringify({ outcome, debug })}`)
  })
  await waitForPhase('auto-opened')
  const automaticPage = browser.context.pages().find(page => page.url() === automaticInstance.url)
  assert.ok(automaticPage, 'DSH opened a new tab without a toolbar grant')
  assert.equal(await automaticPage.getByRole('checkbox', { name: '邮件通知', exact: true }).isChecked(), true)
  const automaticGrant = await browser.worker.evaluate(async ({ url, sessionId }) => {
    const [created] = await chrome.tabs.query({ url })
    const cached = await chrome.storage.session.get(['dshPageAccess', 'dshTabAffinity'])
    const grant = cached.dshPageAccess.grants.find(grant => grant.tabId === created.id)
    const binding = cached.dshTabAffinity.sessionTabs[sessionId]
    const group = created.groupId >= 0 ? await chrome.tabGroups.get(created.groupId) : undefined
    let nativeInjection = false
    try { await chrome.scripting.executeScript({ target: { tabId: created.id }, func: () => document.title }); nativeInjection = true } catch {}
    return { mode: grant?.mode,
      grouped: group?.title === 'DSH 控制' && group?.color === 'blue' && group?.windowId === created.windowId
        && grant?.groupId === created.groupId && grant?.windowId === created.windowId,
      bound: binding?.tabId === created.id, nativeInjection }
  }, { url: automaticInstance.url, sessionId: session.sessionId })
  assert.deepEqual(automaticGrant, { mode: 'debugger', grouped: true, bound: true, nativeInjection: false })
  await writeFile(`${trigger}.auto-navigate`, '', { mode: 0o600 })
  await browser.panel.getByRole('button', { name: '仅允许这一次', exact: true }).click()
  await waitForPhase('auto-navigated')
  assert.equal(automaticPage.url(), automaticNextUrl)
  await browser.panel.getByRole('button', { name: '停止控制此页', exact: true }).click()
  await browser.panel.waitForFunction(async url => {
    const [created] = await chrome.tabs.query({ url })
    const cached = (await chrome.storage.session.get('dshPageAccess')).dshPageAccess
    return !cached.grants.some(grant => grant.tabId === created.id)
  }, automaticNextUrl)
  const stoppedAutomatic = await browser.worker.evaluate(async url => {
    const [created] = await chrome.tabs.query({ url })
    const cached = (await chrome.storage.session.get('dshPageAccess')).dshPageAccess
    let debuggerAttached = true
    try { await chrome.debugger.sendCommand({ tabId: created.id }, 'Page.getFrameTree') } catch { debuggerAttached = false }
    return { granted: cached.grants.some(grant => grant.tabId === created.id), grouped: created.groupId >= 0, debuggerAttached }
  }, automaticNextUrl)
  assert.equal(stoppedAutomatic.granted, false)
  assert.equal(stoppedAutomatic.debuggerAttached, false)
  await writeFile(`${trigger}.auto-verified`, '', { mode: 0o600 })
  const failedOpenUrl = `${automaticOrigin}/auto-cleanup-fault`
  await browser.worker.evaluate(url => {
    const get = chrome.tabs.get.bind(chrome.tabs), remove = chrome.tabs.remove.bind(chrome.tabs)
    const fault = { tripped: false, restore: () => { chrome.tabs.get = get; chrome.tabs.remove = remove } }
    globalThis.__strideCleanupFault = fault
    chrome.tabs.get = async id => {
      const tab = await get(id)
      if (tab.url === url && !fault.tripped) {
        const cached = (await chrome.storage.session.get('dshPageAccess')).dshPageAccess
        if (cached?.grants.some(row => row.tabId === id && row.mode === 'debugger' && row.pending !== true && row.groupId !== undefined)) {
          fault.tripped = true
          throw new Error('Synthetic post-authorization metadata failure')
        }
      }
      return tab
    }
    chrome.tabs.remove = async ids => {
      if (typeof ids === 'number' && (await get(ids)).url === url) throw new Error('Synthetic tab close failure')
      return remove(ids)
    }
  }, failedOpenUrl)
  await writeFile(`${trigger}.cleanup-fault`, JSON.stringify({ url: failedOpenUrl }), { mode: 0o600 })
  await waitForPhase('cleanup-failed')
  const failedOpenPage = browser.context.pages().find(page => page.url() === failedOpenUrl)
  assert.ok(failedOpenPage, 'a refused close must leave the synthetic page open')
  const cleanup = await browser.worker.evaluate(async ({ url, sessionId }) => {
    const [tab] = await chrome.tabs.query({ url })
    const cache = await chrome.storage.session.get(['dshPageAccess', 'dshTabAffinity'])
    let debuggerAttached = true
    try { await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getFrameTree') } catch { debuggerAttached = false }
    return { faultInjected: globalThis.__strideCleanupFault.tripped, debuggerAttached,
      granted: cache.dshPageAccess.grants.some(row => row.tabId === tab.id),
      bound: cache.dshTabAffinity?.sessionTabs?.[sessionId]?.tabId === tab.id }
  }, { url: failedOpenUrl, sessionId: session.sessionId })
  assert.deepEqual(cleanup, { faultInjected: true, debuggerAttached: false, granted: false, bound: false })
  await browser.worker.evaluate(() => { globalThis.__strideCleanupFault.restore(); delete globalThis.__strideCleanupFault })
  await failedOpenPage.close()
  await writeFile(`${trigger}.cleanup-verified`, '', { mode: 0o600 })
  const outcome = await waitForResult()
  assert.equal(outcome.ok, true, outcome.error)
  assert.equal(outcome.calls, 11)
  assert.equal(outcome.automaticCalls, 4)
  assert.equal(outcome.cleanupFaults, 1)
  assert.equal(outcome.blocked, 2)
  assert.equal(outcome.recorded, 6)
  console.log('Automatic tab control passed: real Host tools opened, bound, grouped, read and clicked a new page without a toolbar action; trusted stop revoked it')
  console.log('Failed new-tab cleanup passed: post-authorization read failure plus refused close leaves no page grant, debugger or session binding; closure is reported as unconfirmed')
  await card.getByText('已停止', { exact: true }).waitFor()
  assert.equal(await handoffPage.getByRole('checkbox', { name: '邮件通知', exact: true }).isChecked(), true)
  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  const unpair = browser.panel.getByRole('button', { name: '解绑 DSH', exact: true })
  assert.equal(await browser.panel.getByRole('button', { name: '解绑页面', exact: true }).count(), 0)
  await unpair.evaluate(button => button.click())
  await delay(200)
  assert.equal((await host.listInstallations()).length, 1, 'synthetic clicks must not revoke DSH pairing')
  await unpair.click()
  await browser.panel.getByText('已解除此浏览器与 DSH 的配对。', { exact: true }).waitFor()
  assert.equal((await host.listInstallations()).length, 0)
  assert.equal(handoffPage.isClosed(), false, 'DSH unpairing preserves open pages')
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'hidden' })
  Object.assign(browser, await browser.restart({ connected: false }))
  await browser.panel.setViewportSize({ width: 420, height: 900 })
  handoffPage = browser.target
  await delay(1500)
  assert.equal(await browser.panel.locator('.connection .dot.connected').count(), 0, 'unpaired browser must not reconnect after restart')
  assert.equal((await host.listInstallations()).length, 0)
  const unpairArtifacts = join(repoRoot, '.stride-private/validation/unpair-dsh')
  await mkdir(unpairArtifacts, { recursive: true })
  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  await browser.panel.screenshot({ path: join(unpairArtifacts, 'unpaired-after-restart.png') })
  const freshCode = await host.issuePairingCode()
  await browser.panel.locator('.settings-panel input[type="password"]').fill(freshCode)
  await browser.panel.getByRole('button', { name: '保存并连接', exact: true }).click()
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15000 })
  await browser.panel.screenshot({ path: join(unpairArtifacts, 'paired-again.png') })
  console.log('DSH unpairing passed: trusted Settings click, Host revocation, preserved pages, no reconnect after browser restart and explicit re-pairing')
  if (handoffPage !== browser.target) await handoffPage.close()
  const response = await fetch(`${site.origin}/api/state?run=${encodeURIComponent(instance.runId)}`)
  assert.equal(response.ok, true)
  const state = await response.json()
  assert.equal(state.notificationSaved, true)
  assert.equal(state.emailNotifications, true)
  const installations = await host.listInstallations()
  assert.equal(installations.length, 1)
  assert.equal(await host.revokeInstallation(installations[0].installationId), true)
  assert.equal((await host.listInstallations()).length, 0)
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'hidden', timeout: 15_000 })
  await verifyTargetFences()
  await verifyPersistentExecutionFence()
  await verifyIncompatibleHost(undefined, 'update-host')
  await verifyIncompatibleHost(BRIDGE_PROTOCOL_VERSION - 1, 'update-host')
  await verifyIncompatibleHost(BRIDGE_PROTOCOL_VERSION + 1, 'update-extension')
  console.log('Browser smoke passed: owner-confirmed pairing UI, authentication fence, reconnect after reload, real DSH tools, panel pause/selected-page handoff/stop and executor acknowledgement, explicit persistent DSH unpairing, run/revision dispatch metadata, revoked old contexts, queued-target revocation without write overtaking, checkpoint owner fence, receiver execution confirmation/revocation, run target pinning across rebind, current-owner tab creation, durable v4 identities and Host execution confirmation, persistent replay/conflict rejection across worker restart, origin isolation, revocation and independent site state (no model)')
} finally {
  await browser?.close().catch(() => {})
  await host?.close().catch(() => {})
  await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
