// Opt-in ordinary DSH chat acceptance. Temporary homes, synthetic page, existing default model.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, copyFile, chmod, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { startTaskSite } from './fixtures/task-site.mjs'
import { MODEL_REQUEST_LIMIT, BROWSER_CALL_LIMIT } from './fixtures/auto-tab-model-probe.mjs'

assert.equal(process.env.STRIDE_REAL_MODEL, '1', 'Set STRIDE_REAL_MODEL=1 to enable real-model acceptance.')
const repoRoot = resolve(import.meta.dirname, '..')
const require = createRequire(join(repoRoot, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'stride-auto-tab-model-'))
const home = join(root, 'home'), trigger = join(root, 'start.json'), result = join(root, 'result.json')
const artifacts = join(repoRoot, '.stride-private/validation/auto-tab-model')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
let site, host, browser, sessionId
async function snapshot() { try { return JSON.parse(await readFile(result, 'utf8')) } catch { return undefined } }
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
try {
  await mkdir(home, { recursive: true })
  await mkdir(artifacts, { recursive: true })
  const install = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', `@eilyeee/dsh-browser-stride@link:${join(repoRoot, 'packages/browser/bridge-browser')}`], { cwd: repoRoot, env, stdio: 'ignore' })
  const installTimer = setTimeout(() => install.kill('SIGKILL'), 120000)
  try {
    const [code] = await once(install, 'exit')
    assert.equal(code, 0, 'Isolated plugin installation failed')
  } finally { clearTimeout(installTimer) }
  if (process.env.STRIDE_MODEL_CREDENTIALS !== undefined) {
    await copyFile(process.env.STRIDE_MODEL_CREDENTIALS, join(home, '.credentials.yaml'))
    await chmod(join(home, '.credentials.yaml'), 0o600)
  }
  const extraPatch = process.env.STRIDE_MODEL_PATCH === undefined ? undefined : await readFile(process.env.STRIDE_MODEL_PATCH, 'utf8')
  process.env.DSH_HOME = home
  site = await startTaskSite({ hostname: 'stride-model.test' })
  const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port; await new Promise(done => listener.close(done))
  host = await startDshBackend({ backend: 'extension', port, repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), runtimeRoot: join(root, 'runtime'), startUrl: site.url,
    toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/auto-tab-model-probe.mjs'), trigger, result }, extraPatch })
  browser = await startExtensionBrowser({ repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`,
    pairingCode: await host.issuePairingCode(), trustedOrigin: site.origin,
    chromiumArgs: ['--no-proxy-server', '--host-resolver-rules=MAP stride-model.test 127.0.0.1'] })
  // Read back fixture settings before editing them. Never let stale initial UI
  // defaults replace the explicit isolated Host address with auto-discovery.
  await browser.panel.reload()
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15000 })
  // No authorizePage/prepare/bindSession: the model must create and acquire its own tab.
  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  await browser.panel.locator('.settings-panel input').first().fill(`ws://127.0.0.1:${port}/ext/bridge`)
  await browser.panel.getByRole('checkbox', { name: '自动控制 DSH 新建页面', exact: false }).check()
  await browser.panel.getByRole('button', { name: '保存并连接', exact: true }).click()
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15000 })
  const workspace = join(root, 'ordinary-chat-workspace'); await mkdir(workspace)
  sessionId = (await host.client.rpc('session.create', { cwd: workspace })).sessionId
  const catalog = await host.client.rpc('session.modelCatalog')
  // The ordinary Host conversation intentionally lives outside the extension's
  // history workspace. Its tool calls must bind it without panel selection.
  const opening = await host.client.followSession(sessionId)
  const model = opening.projections?.values?.modelSelection?.next ?? catalog.default
  const selectedModel = { provider: model.provider, model: model.model, reasoningEffort: model.reasoningEffort }
  assert.ok(catalog.routableProviders.includes(model.provider), 'The existing default model route must be available')
  assert.equal(await browser.worker.evaluate(async () => (await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants?.length ?? 0), 0)
  await writeFile(trigger, JSON.stringify({ sessionId, url: site.url }), { mode: 0o600 })
  await wait(async () => { try { await readFile(`${result}.ready`); return true } catch { return false } }, 'test guard registration')
  console.log(JSON.stringify({ stage: 'ordinary-chat', defaultModel: selectedModel, toolbarPageGrants: 0 }))
  await host.client.rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: `打开网页：${site.url}，将“测试开关”设为开启，点击“保存设置”，确认页面显示已保存。` }], clientTimeZone: 'Asia/Shanghai' })
  await wait(async () => (await snapshot())?.terminal === true, 'ordinary real-model chat completion', 360000)
  const outcome = await snapshot()
  assert.equal(outcome.reason, 'completed', 'The model turn must complete')
  assert.equal(outcome.managedRuns, 0, 'Ordinary chat must not implicitly create a managed task')
  assert.ok(outcome.modelRequests > 0 && outcome.modelRequests <= MODEL_REQUEST_LIMIT)
  assert.ok(outcome.ptcCalls <= MODEL_REQUEST_LIMIT && outcome.browserCalls.length <= BROWSER_CALL_LIMIT)
  assert.ok(outcome.browserCalls.includes('browser_open_tab'))
  assert.ok(outcome.browserCalls.some(name => ['browser_click', 'browser_press', 'browser_type', 'browser_select'].includes(name)))
  assert.equal(outcome.model?.provider, model.provider)
  assert.equal(outcome.model?.model, model.model)
  assert.deepEqual(outcome.blockedTools, [])
  assert.deepEqual(site.state(), { enabled: true, saved: true }, 'Independent server state must confirm the save')
  const controlled = await browser.worker.evaluate(async ({ url, sessionId }) => {
    const [tab] = await chrome.tabs.query({ url })
    const state = await chrome.storage.session.get(['dshPageAccess', 'dshTabAffinity'])
    const grant = state.dshPageAccess?.grants.find(row => row.tabId === tab?.id)
    let nativePageAccess = false
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.title }); nativePageAccess = true } catch {}
    const attached = tab !== undefined && await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getFrameTree').then(() => true, () => false)
    return { created: tab !== undefined, bound: state.dshTabAffinity?.sessionTabs?.[sessionId]?.tabId === tab?.id,
      grouped: tab?.groupId >= 0, mode: grant?.mode, nativePageAccess, attached }
  }, { url: site.url, sessionId })
  assert.deepEqual(controlled, { created: true, bound: true, grouped: true, mode: 'debugger', nativePageAccess: false, attached: true })
  const page = browser.context.pages().find(page => page.url() === site.url)
  assert.ok(page)
  assert.equal(await page.getByRole('checkbox', { name: '测试开关', exact: true }).isChecked(), true)
  assert.equal(await page.locator('#status').innerText(), '设置已保存')
  const evidence = { ...outcome, passed: true, selectedModel, controlled, independentState: site.state(), realBrowser: true, realModel: true, ordinaryChat: true }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ passed: true, model: outcome.model, modelRequests: outcome.modelRequests,
    browserCalls: outcome.browserCalls, ptcCalls: outcome.ptcCalls, ordinaryChat: true, independentState: true, automaticTabControl: true }))
} catch (error) {
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ ...(await snapshot()), passed: false, errorName: error.name, independentState: site?.state() }, null, 2), { mode: 0o600 }).catch(() => {})
  throw error
} finally {
  if (host !== undefined && sessionId !== undefined) await host.client.rpc('session.cancel', { sessionId }, { timeoutMs: 5000 }).catch(() => {})
  await browser?.close().catch(() => {})
  await host?.close().catch(() => {})
  await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
