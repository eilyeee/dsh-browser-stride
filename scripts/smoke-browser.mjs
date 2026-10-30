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
const { BRIDGE_PROTOCOL_VERSION } = await import(pathToFileURL(join(repoRoot, 'packages/browser/bridge-browser/lib/protocol.js')).href)
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
      const progress = JSON.parse(await readFile(`${result}.phase`, 'utf8'))
      if (progress.phase === phase) return progress
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await delay(100)
  }
  throw new Error(`timed out waiting for browser probe phase ${phase}`)
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
      socket.send(JSON.stringify({ t: 'tool.call', id: 'rejected-navigation', action, name: 'browser_navigate',
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
    })
  })
  const destination = `${site.origin}/health?execution-fence=synthetic`
  let navigations = 0
  const countNavigation = request => { if (request.isNavigationRequest() && request.url() === destination) navigations += 1 }
  browser.target.on('request', countNavigation)
  async function connectPanel() {
    await browser.panel.evaluate(bridgeUrl => new Promise((resolveStatus, reject) => {
      const port = window.__dshBenchmarkPort ??= chrome.runtime.connect({ name: 'dsh-panel' })
      const timer = setTimeout(() => { port.onMessage.removeListener(onMessage); reject(new Error('synthetic Host connection timed out')) }, 10000)
      const onMessage = message => {
        if (message?.type !== 'status' || message.state !== 'connected') return
        clearTimeout(timer)
        port.onMessage.removeListener(onMessage)
        resolveStatus()
      }
      port.onMessage.addListener(onMessage)
      port.postMessage({ type: 'settings', settings: { bridgeUrl, token: 'synthetic-execution-token' } })
    }), url)
  }
  const actionId = 'act_synthetic_persistent_execution'
  async function command(id, args) {
    const action = { actionId, requestDigest: await computeToolCommandDigest({ actionId, name: 'browser_navigate', args }) }
    activeSocket.send(JSON.stringify({ t: 'tool.call', id, action, name: 'browser_navigate', args, expiresAt: Date.now() + 15000 }))
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
    assert.equal((await command('synthetic-first-attempt', args)).ok, true)
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

try {
  await mkdir(home, { recursive: true })
  await command(['plugin', '--profile', 'web', 'add', '-w', `@yuxianglin/dsh-bridge-browser@link:${join(repoRoot, 'packages/browser/bridge-browser')}`])
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
  await writeFile(`${trigger}.resume`, '', { mode: 0o600 })
  await waitForPhase('stop-ready')
  await card.getByText('运行中', { exact: true }).waitFor()
  await card.getByRole('button', { name: '停止任务', exact: true }).click()
  await card.getByText('停止中', { exact: true }).waitFor()
  assert.equal(await card.locator('.browser-run-actions').count(), 0)
  await writeFile(`${trigger}.ack-stop`, '', { mode: 0o600 })
  const outcome = await waitForResult()
  assert.equal(outcome.ok, true, outcome.error)
  assert.equal(outcome.calls, 4)
  assert.equal(outcome.blocked, 2)
  assert.equal(outcome.recorded, 4)
  await card.getByText('已停止', { exact: true }).waitFor()
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
  await verifyPersistentExecutionFence()
  await verifyIncompatibleHost(undefined, 'update-host')
  await verifyIncompatibleHost(BRIDGE_PROTOCOL_VERSION - 1, 'update-host')
  await verifyIncompatibleHost(BRIDGE_PROTOCOL_VERSION + 1, 'update-extension')
  console.log('Browser smoke passed: owner-confirmed pairing UI, authentication fence, reconnect after reload, real DSH tools, panel pause/stop and executor acknowledgement, run/revision dispatch metadata, revoked old contexts, durable v2 identities, persistent replay/conflict rejection across worker restart, origin isolation, revocation and independent site state (no model)')
} finally {
  await browser?.close().catch(() => {})
  await host?.close().catch(() => {})
  await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
