// Real Host restart and extension transport acceptance. No model or user profile.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { startTaskSite } from './fixtures/task-site.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repoRoot, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const WebSocket = createRequire(join(repoRoot, 'packages/browser/bridge-browser/package.json'))('ws')
const { BRIDGE_PROTOCOL_VERSION, BRIDGE_RUN_LIST_METHOD } = await import(pathToFileURL(join(repoRoot, 'packages/browser/bridge-browser/lib/protocol.js')).href)
const root = await mkdtemp(join(tmpdir(), 'stride-host-reconnect-'))
const home = join(root, 'home')
const artifacts = join(repoRoot, '.stride-private/validation/host-reconnect')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
let host, browser, site, peer
let phase = 'setup'
async function credentialDigest() {
  return browser.worker.evaluate(async () => {
    const db = await new Promise((resolveDb, rejectDb) => {
      const request = indexedDB.open('dsh-browser-private', 1)
      request.onsuccess = () => resolveDb(request.result)
      request.onerror = () => rejectDb(new Error('Credential database unavailable'))
    })
    try {
      const value = await new Promise((resolveValue, rejectValue) => {
        const request = db.transaction('credentials', 'readonly').objectStore('credentials').get('bridge')
        request.onsuccess = () => resolveValue(request.result)
        request.onerror = () => rejectValue(new Error('Credential read failed'))
      })
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Saved credential unavailable')
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    } finally { db.close() }
  })
}
async function runs(sessionId) {
  const reply = await browser.panel.evaluate(({ method, sessionId }) => new Promise((resolveReply, rejectReply) => {
    const port = window.__dshBenchmarkPort, id = crypto.randomUUID()
    const timer = setTimeout(() => { port.onMessage.removeListener(receive); rejectReply(new Error('Task metadata timed out')) }, 5000)
    function receive(message) {
      if (message?.type !== 'rpc.result' || message.id !== id) return
      clearTimeout(timer); port.onMessage.removeListener(receive); resolveReply(message)
    }
    port.onMessage.addListener(receive)
    port.postMessage({ type: 'rpc', id, method, payload: { sessionId } })
  }), { method: BRIDGE_RUN_LIST_METHOD, sessionId })
  assert.equal(reply.ok, true)
  assert.equal(reply.result.result.ok, true)
  return reply.result.result.value.items
}
try {
  await mkdir(home, { recursive: true })
  const install = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', `@eilyeee/dsh-browser-stride@link:${join(repoRoot, 'packages/browser/bridge-browser')}`], { cwd: repoRoot, env, stdio: 'ignore' })
  const [code] = await once(install, 'exit'); assert.equal(code, 0, 'Temporary plugin install failed')
  process.env.DSH_HOME = home
  for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete process.env[key]
  site = await startTaskSite()
  const listener = createServer(); await new Promise(resolveListen => listener.listen(0, '127.0.0.1', resolveListen))
  const port = listener.address().port; await new Promise(resolveClose => listener.close(resolveClose))
  const config = { backend: 'extension', port, repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), runtimeRoot: join(root, 'runtime'), startUrl: site.url }
  host = await startDshBackend(config)
  browser = await startExtensionBrowser({ repoRoot, benchmarkRoot: config.benchmarkRoot, bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`, pairingCode: await host.issuePairingCode(), trustedOrigin: site.origin })
  const connected = browser.panel.locator('.connection .dot.connected')
  await connected.waitFor({ state: 'visible' })
  // Configure the visible form too: the helper's bootstrap port does not
  // update a form that was mounted before its background settings changed.
  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  await browser.panel.locator('.settings-panel input').first().fill(`ws://127.0.0.1:${port}/ext/bridge`)
  await browser.panel.getByRole('button', { name: '保存并连接', exact: true }).click()
  await connected.waitFor({ state: 'visible' })
  const digest = await credentialDigest()
  const installations = await host.listInstallations()
  const session = await host.client.rpc('session.create', { cwd: root })
  const response = await fetch(`${host.baseUrl}/api/commands/execute`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: host.client.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'commands/execute', payload: { args: {
      agentId: session.sessionId, line: '/browser Verify the synthetic setting without starting automatically.', submittedAttachments: [] } } }) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).result.value.result.kind, 'success')
  const [before] = await runs(session.sessionId)
  assert.equal(before.state, 'queued'); assert.equal(before.task.modelRequests, 0); assert.equal(before.task.toolCalls, 0)
  phase = 'normal-restart'
  await host.close(); host = undefined
  await connected.waitFor({ state: 'hidden' })
  host = await startDshBackend(config)
  await connected.waitFor({ state: 'visible', timeout: 30000 })
  assert.equal(await credentialDigest(), digest, 'Restart must reuse the saved browser credential')
  assert.deepEqual((await host.listInstallations()).map(row => row.installationId).sort(), installations.map(row => row.installationId).sort())
  const inventory = await fetch(`${host.baseUrl}/api/session/list`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: host.client.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }) })
  assert.equal(inventory.status, 200)
  const sessions = await inventory.json()
  assert.equal(sessions.result.ok, true)
  assert.ok(sessions.result.value.items.some(row => row.sessionId === session.sessionId))
  const [after] = await runs(session.sessionId)
  assert.equal(after.runId, before.runId); assert.equal(after.state, 'queued')
  assert.equal(after.controlRevision, before.controlRevision); assert.deepEqual(after.task, before.task)
  assert.equal(await browser.worker.evaluate(async () => (await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants?.length ?? 0), 0)
  phase = 'replacement'
  const pairingCode = await host.issuePairingCode()
  peer = new WebSocket(`ws://127.0.0.1:${port}/ext/bridge`)
  await new Promise((resolvePeer, rejectPeer) => {
    const timer = setTimeout(() => rejectPeer(new Error('Replacement peer timed out')), 5000)
    peer.once('open', () => peer.send(JSON.stringify({ t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, token: pairingCode,
      installationId: 'synthetic-reconnect-replacement', caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })))
    peer.once('error', () => { clearTimeout(timer); rejectPeer(new Error('Replacement peer failed')) })
    peer.on('message', bytes => { if (JSON.parse(bytes.toString()).t === 'hello.ok') { clearTimeout(timer); resolvePeer() } })
  })
  await connected.waitFor({ state: 'hidden' }); await delay(1500)
  assert.equal(await connected.count(), 0, 'A replaced browser must not automatically reclaim the connection')
  peer.terminate(); peer = undefined
  await delay(500); assert.equal(await connected.count(), 0)
  phase = 'manual-reconnect'
  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  await browser.panel.getByRole('button', { name: '保存并连接', exact: true }).click()
  await connected.waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await credentialDigest(), digest)
  const [finalRun] = await runs(session.sessionId)
  assert.equal(finalRun.state, 'queued'); assert.deepEqual(finalRun.task, before.task)
  const summary = { passed: true, realHost: true, isolatedChrome: true, modelRequests: 0,
    normalRestartReconnected: true, credentialPreserved: true, queuedTaskRemainedIdle: true,
    noPageAuthorityAdded: true, replacementDidNotReconnect: true, nativeSaveAndConnectWorked: true }
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary))
} catch (error) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false, phase, errorName: error.name }), { mode: 0o600 })
  throw error
} finally {
  peer?.terminate()
  await browser?.close().catch(() => {})
  await host?.close().catch(() => {})
  await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
