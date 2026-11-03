// Opt-in real-model acceptance, using disposable Host/browser homes and a local fixture.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, copyFile, chmod, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { startTaskSite } from './fixtures/task-site.mjs'

assert.equal(process.env.STRIDE_REAL_MODEL, '1', 'Set STRIDE_REAL_MODEL=1 to authorize real-model requests for this smoke.')
const disconnectOnce = process.env.STRIDE_TASK_DISCONNECT === '1'
const targetLossOnce = process.env.STRIDE_TASK_TARGET_LOSS === '1'
assert.ok(!(disconnectOnce && targetLossOnce), 'Use one task-interruption scenario per smoke.')
const newPageStart = process.env.STRIDE_TASK_NEW_PAGE === '1' || disconnectOnce || targetLossOnce
const artifactName = targetLossOnce ? 'target-loss-real-model-result.json' : disconnectOnce ? 'disconnect-real-model-result.json' : newPageStart ? 'new-page-real-model-result.json' : 'real-model-result.json'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repoRoot, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'stride-task-model-'))
const home = join(root, 'home')
const trigger = join(root, 'start.json'), result = join(root, 'result.json')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
let site, host, browser, interruption
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(`timed out: ${label}`)
}
async function snapshot() { try { return JSON.parse(await readFile(result, 'utf8')) } catch { return undefined } }
async function interruptBrowser(url) {
  const WebSocket = createRequire(join(repoRoot, 'packages/browser/bridge-browser/package.json'))('ws')
  const { BRIDGE_PROTOCOL_VERSION } = await import(pathToFileURL(join(repoRoot, 'packages/browser/bridge-browser/lib/protocol.js')).href)
  const code = await host.issuePairingCode()
  const peer = new WebSocket(url)
  try {
    await new Promise((resolvePeer, rejectPeer) => {
      const timer = setTimeout(() => rejectPeer(new Error('Synthetic connection replacement timed out')), 5000)
      peer.once('error', () => { clearTimeout(timer); rejectPeer(new Error('Synthetic connection replacement failed')) })
      peer.once('open', () => peer.send(JSON.stringify({ t: 'hello', token: code, installationId: 'synthetic-disconnect-probe',
        protocolVersion: BRIDGE_PROTOCOL_VERSION, caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })))
      peer.on('message', bytes => {
        if (JSON.parse(bytes.toString()).t === 'hello.ok') { clearTimeout(timer); resolvePeer() }
      })
    })
  } finally { peer.terminate() }
}
try {
  await mkdir(home, { recursive: true })
  const child = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', `@eilyeee/dsh-browser-stride@link:${join(repoRoot, 'packages/browser/bridge-browser')}`], { cwd: repoRoot, env, stdio: 'ignore' })
  const [code] = await once(child, 'exit'); assert.equal(code, 0, 'isolated plugin install failed')
  if (process.env.STRIDE_MODEL_CREDENTIALS !== undefined) {
    await copyFile(process.env.STRIDE_MODEL_CREDENTIALS, join(home, '.credentials.yaml'))
    await chmod(join(home, '.credentials.yaml'), 0o600)
  }
  const extraPatch = process.env.STRIDE_MODEL_PATCH === undefined ? undefined : await readFile(process.env.STRIDE_MODEL_PATCH, 'utf8')
  process.env.DSH_HOME = home
  site = await startTaskSite(newPageStart ? { hostname: 'stride-task.test' } : {})
  const socket = createServer(); await new Promise(resolveListen => socket.listen(0, '127.0.0.1', resolveListen))
  const port = socket.address().port; await new Promise(resolveClose => socket.close(resolveClose))
  host = await startDshBackend({ backend: 'extension', port, repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'),
    runtimeRoot: join(root, 'runtime'), startUrl: site.url,
    toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/task-runtime-probe.mjs'), trigger, result }, extraPatch })
  browser = await startExtensionBrowser({ repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`,
    pairingCode: await host.issuePairingCode(), trustedOrigin: site.origin,
    ...(newPageStart ? { chromiumArgs: ['--no-proxy-server', '--host-resolver-rules=MAP stride-task.test 127.0.0.1'] } : {}) })
  if (newPageStart) {
    // No toolbar grant or prepare/bind helper: startup itself must create the page.
    await browser.panel.reload()
    await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15000 })
    await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
    await browser.panel.locator('.settings-panel input').first().fill(`ws://127.0.0.1:${port}/ext/bridge`)
    await browser.panel.getByRole('checkbox', { name: '自动控制 DSH 新建页面', exact: false }).check()
    await browser.panel.getByRole('button', { name: '保存并连接', exact: true }).click()
    await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await browser.worker.evaluate(async () => (await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants?.length ?? 0), 0)
  } else await browser.prepare(site.url)
  const taskWorkspace = join(root, 'task-workspace')
  await mkdir(taskWorkspace)
  const session = await host.client.rpc('session.create', { cwd: taskWorkspace })
  const verificationUrl = new URL('/state', site.url)
  verificationUrl.hostname = '127.0.0.1' // Chromium's test-domain resolver does not configure Node DNS.
  await writeFile(trigger, JSON.stringify({ sessionId: session.sessionId, url: site.url, verificationUrl: verificationUrl.href, disconnectOnce, targetLossOnce }), { mode: 0o600 })
  await wait(async () => { try { await readFile(`${result}.ready`); return true } catch { return false } }, 'probe registration')
  const rpcId = crypto.randomUUID()
  const response = await fetch(`${host.baseUrl}/api/commands/execute`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: host.client.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'commands/execute', payload: { args: {
      agentId: session.sessionId, line: '/browser 将测试开关设为开启，然后保存设置。', submittedAttachments: [] } } }) })
  assert.equal(response.status, 200)
  const command = await response.json()
  assert.equal(command.result?.ok, true, 'authenticated DSH Web command admission')
  assert.equal(command.result.value.result.kind, 'success', 'registered browser command')
  await wait(async () => (await snapshot())?.state === 'queued', 'queued task')
  assert.equal((await snapshot()).task.modelRequests, 0)
  await delay(200)
  assert.equal((await snapshot()).task.modelRequests, 0, 'waiting must not start the Agent')
  console.log('DSH command created a queued task without waking the model')
  await browser.panel.getByRole('button', { name: '历史会话', exact: true }).click()
  await browser.panel.locator('.session-list li').filter({ hasText: 'task-workspace' }).locator('button').first().click()
  await browser.panel.waitForFunction(id => document.querySelector('.app')?.getAttribute('data-session-id') === id, session.sessionId)
  const card = browser.panel.locator('.browser-runs li').filter({ hasText: '将测试开关设为开启' })
  const start = card.getByRole('button', { name: newPageStart ? '新建页面并开始' : '绑定并开始', exact: true })
  await start.waitFor()
  if (newPageStart) await card.getByRole('textbox', { name: '新页面网址', exact: true }).fill(site.url)
  const initialTabs = await browser.worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id))
  await start.evaluate(button => button.click())
  await delay(200)
  assert.equal((await snapshot()).task.modelRequests, 0, 'synthetic clicks cannot start tasks')
  if (newPageStart) assert.deepEqual(await browser.worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id)), initialTabs, 'synthetic startup must not create a tab')
  await browser.target.bringToFront()
  await start.click()
  await wait(async () => (await snapshot())?.state !== 'queued', 'native startup commit')
  console.log('Trusted native start submitted; waiting for the default model')
  if (targetLossOnce) {
    await wait(async () => { try { await readFile(`${result}.target-loss-ready`); return true } catch { return false } }, 'completed read before page revocation', 120000)
    assert.deepEqual(site.state(), { enabled: false, saved: false })
    await browser.panel.getByRole('button', { name: '停止控制此页', exact: true }).click()
    await wait(async () => { const value = await snapshot(); return value?.state === 'paused' && value.agentIdle }, 'page-loss task and Agent pause')
    const paused = await snapshot()
    assert.equal(paused.pauseReason, 'page-unavailable')
    assert.equal(paused.controlRevision, 1)
    await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible' })
    await card.getByText('页面控制或绑定已失效', { exact: false }).waitFor()
    await delay(2400)
    const stable = await snapshot()
    assert.equal(stable.state, 'paused')
    assert.equal(stable.task.modelRequests, paused.task.modelRequests)
    assert.equal(stable.task.toolCalls, paused.task.toolCalls)
    assert.deepEqual(site.state(), { enabled: false, saved: false })
    assert.ok(browser.context.pages().some(page => page.url() === site.url), 'revocation keeps the native page open')
    assert.equal(await browser.worker.evaluate(async () => (await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants?.length ?? 0), 0)
    await card.getByRole('button', { name: '停止任务', exact: true }).click()
    await wait(async () => (await snapshot())?.state === 'stopped', 'explicit task stop after page revocation')
    await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible' })
    const outcome = await snapshot()
    assert.equal(outcome.facts, 0)
    assert.equal(outcome.runBound, true)
    assert.deepEqual(outcome.dispatchRevisions, [0])
    interruption = { pausedRevision: paused.controlRevision, pageRevocationPaused: true, keptConnected: true,
      keptPageOpen: true, countersStable: true, writeBeforeInterruption: false, explicitStopAcknowledged: true }
    const artifacts = join(repoRoot, '.stride-private/validation/task-runtime')
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, artifactName), JSON.stringify({ ...outcome, passed: true, newPageStart,
      targetLossOnce, interruption, independentState: site.state() }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ passed: true, state: outcome.state, modelRequests: outcome.task.modelRequests,
      browserCalls: outcome.task.toolCalls, realBrowser: true, independentSiteState: true, ...interruption }))
  } else {
    if (disconnectOnce) {
      await wait(async () => { try { await readFile(`${result}.disconnect-ready`); return true } catch { return false } }, 'completed read before disconnection', 120000)
      assert.deepEqual(site.state(), { enabled: false, saved: false }, 'interruption occurs before a business write')
      await interruptBrowser(`ws://127.0.0.1:${port}/ext/bridge`)
      await wait(async () => { const value = await snapshot(); return value?.state === 'paused' && value.agentIdle }, 'disconnected task and Agent pause')
      const paused = await snapshot()
      assert.equal(paused.pauseReason, 'browser-disconnected')
      assert.equal(paused.controlRevision, 1)
      // Replacement deliberately yields the bridge slot; native Save and connect
      // must reclaim it without editing the existing address or credential.
      await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
      await browser.panel.getByRole('button', { name: '保存并连接', exact: true }).click()
      await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15000 })
      await browser.panel.getByRole('button', { name: '历史会话', exact: true }).click()
      await browser.panel.locator('.session-list li').filter({ hasText: 'task-workspace' }).locator('button').first().click()
      await browser.panel.waitForFunction(id => document.querySelector('.app')?.getAttribute('data-session-id') === id, session.sessionId)
      const continuation = card.getByRole('button', { name: '在已绑定页面继续', exact: true })
      await continuation.waitFor()
      await continuation.evaluate(button => button.click())
      await delay(300)
      const stillPaused = await snapshot()
      assert.equal(stillPaused.state, 'paused', 'neither reconnect nor a synthetic click resumes a task')
      assert.equal(stillPaused.task.modelRequests, paused.task.modelRequests)
      assert.equal(stillPaused.task.toolCalls, paused.task.toolCalls)
      assert.deepEqual(site.state(), { enabled: false, saved: false })
      const controlledPage = browser.context.pages().find(page => page.url() === site.url)
      assert.ok(controlledPage)
      await controlledPage.bringToFront()
      await continuation.click()
      await wait(async () => (await snapshot())?.controlRevision === 3, 'explicit continued revision')
      interruption = { pausedRevision: paused.controlRevision, originalModelRequests: paused.task.modelRequests,
        originalBrowserCalls: paused.task.toolCalls, reconnectDidNotResume: true, syntheticContinueRefused: true, writeBeforeInterruption: false }
      console.log('Connection loss paused the Agent; trusted continuation selected a fresh revision')
    }
    await wait(async () => (await snapshot())?.terminal === true, 'real model task completion', 360000)
    const outcome = await snapshot()
    assert.equal(outcome.state, 'completed', JSON.stringify(outcome))
    assert.equal(outcome.task.outcome, 'verified')
    assert.ok(outcome.task.modelRequests > 0 && outcome.task.modelRequests <= 10)
    assert.ok(outcome.task.toolCalls > 0 && outcome.task.toolCalls <= 20)
    assert.equal(outcome.task.toolCalls, outcome.nestedBrowserCalls + outcome.directBrowserCalls)
    assert.equal(outcome.verified, true)
    assert.equal(outcome.runBound, true)
    assert.equal(outcome.dispatches, outcome.returned)
    if (disconnectOnce) assert.deepEqual(outcome.dispatchRevisions, [0, 3])
    assert.deepEqual(site.state(), { enabled: true, saved: true })
    let nativePage
    if (newPageStart) {
      nativePage = await browser.worker.evaluate(async ({ url, sessionId, initialTabs }) => {
        const [tab] = await chrome.tabs.query({ url })
        const state = await chrome.storage.session.get(['dshPageAccess', 'dshTabAffinity'])
        const grants = state.dshPageAccess?.grants ?? []
        const grant = grants.find(row => row.tabId === tab?.id)
        const group = tab?.groupId >= 0 ? await chrome.tabGroups.get(tab.groupId) : undefined
        let scriptingAllowed = false
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.title }); scriptingAllowed = true } catch {}
        return { newTab: tab !== undefined && !initialTabs.includes(tab.id), bound: state.dshTabAffinity?.sessionTabs?.[sessionId]?.tabId === tab?.id,
          grouped: group?.title === 'DSH 控制' && group?.color === 'blue' && grant?.groupId === tab?.groupId && grant?.windowId === tab?.windowId,
          authorizedPages: grants.length, mode: grant?.mode, scriptingAllowed,
          attached: tab !== undefined && await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getFrameTree').then(() => true, () => false) }
      }, { url: site.url, sessionId: session.sessionId, initialTabs })
      assert.deepEqual(nativePage, { newTab: true, bound: true, grouped: true, authorizedPages: 1, mode: 'debugger', scriptingAllowed: false, attached: true })
    }
    const artifacts = join(repoRoot, '.stride-private/validation/task-runtime')
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, artifactName), JSON.stringify({ ...outcome,
      passed: true, newPageStart, nativePage, interruption, independentState: site.state() }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ passed: true, modelRequests: outcome.task.modelRequests, browserCalls: outcome.task.toolCalls,
      ptcCalls: outcome.ptcCalls, nestedBrowserCalls: outcome.nestedBrowserCalls, directBrowserCalls: outcome.directBrowserCalls,
      activeMs: outcome.task.activeMs, verifiedFacts: outcome.facts, realBrowser: true, independentSiteState: true, syntheticStartRefused: true, newPageStart, disconnectOnce }))
  }
} catch (error) {
  const artifacts = join(repoRoot, '.stride-private/validation/task-runtime')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, artifactName), JSON.stringify({ ...(await snapshot()),
    passed: false, newPageStart, disconnectOnce, targetLossOnce, interruption, errorName: error.name, independentState: site?.state() }, null, 2), { mode: 0o600 }).catch(() => {})
  throw error
} finally {
  await browser?.close().catch(() => {})
  await host?.close().catch(() => {})
  await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
