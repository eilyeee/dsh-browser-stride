// Isolated Host and Chrome; optional existing default model. Never touches port 3080.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, copyFile, chmod, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { startLayoutSite } from './fixtures/layout-site.mjs'

const repoRoot = resolve(import.meta.dirname, '..'), require = createRequire(join(repoRoot, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'stride-layout-')), home = join(root, 'home')
const trigger = join(root, 'command.json'), result = join(root, 'result.json')
const realModel = process.env.STRIDE_REAL_MODEL === '1'
const artifacts = join(repoRoot, '.stride-private/validation/layout')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
let browser, host, site, modelSessionId, sequence = 0, phase = 'setup'
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined } }
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(`Layout acceptance timed out: ${label}`)
}
async function command(sessionId, name, args = {}) {
  const id = ++sequence
  console.log(JSON.stringify({ phase, sequence: id, tool: name }))
  await writeFile(trigger, JSON.stringify({ sequence: id, sessionId, name, args }), { mode: 0o600 })
  await wait(async () => (await readJson(result))?.sequence === id, name, 105000)
  const answer = await readJson(result)
  assert.equal(answer.probeError, undefined, 'Host layout probe failed')
  return answer
}
async function measure(sessionId, selector, referenceSelector) {
  const answer = await command(sessionId, 'browser_measure_layout', { selector, ...(referenceSelector ? { referenceSelector } : {}) })
  assert.equal(answer.ok, true, answer.text)
  assert.ok(answer.text.includes('UNTRUSTED_PAGE_CONTENT'))
  assert.equal(answer.text.includes('synthetic-private-value'), false)
  return JSON.parse(answer.text.slice(answer.text.indexOf('{'), answer.text.lastIndexOf('}') + 1))
}
async function actualGap() {
  return browser.target.evaluate(() => document.querySelector('.customer-card').getBoundingClientRect().top - document.querySelector('.hero').getBoundingClientRect().bottom)
}
try {
  await mkdir(home); await mkdir(artifacts, { recursive: true })
  const install = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', `@eilyeee/dsh-browser-stride@link:${join(repoRoot, 'packages/browser/bridge-browser')}`], { cwd: repoRoot, env, stdio: 'ignore' })
  const timer = setTimeout(() => install.kill('SIGKILL'), 120000)
  try { assert.equal((await once(install, 'exit'))[0], 0, 'Temporary Host plugin installation failed') } finally { clearTimeout(timer) }
  if (realModel && process.env.STRIDE_MODEL_CREDENTIALS !== undefined) {
    await copyFile(process.env.STRIDE_MODEL_CREDENTIALS, join(home, '.credentials.yaml')); await chmod(join(home, '.credentials.yaml'), 0o600)
  }
  const extraPatch = !realModel || process.env.STRIDE_MODEL_PATCH === undefined ? undefined : await readFile(process.env.STRIDE_MODEL_PATCH, 'utf8')
  process.env.DSH_HOME = home
  site = await startLayoutSite()
  const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port; await new Promise(done => listener.close(done))
  host = await startDshBackend({ backend: 'extension', port, repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), runtimeRoot: join(root, 'runtime'), startUrl: site.url,
    toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/visual-probe.mjs'), trigger, result }, extraPatch })
  browser = await startExtensionBrowser({ repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`, pairingCode: await host.issuePairingCode(), trustedOrigin: site.origin,
    chromiumArgs: ['--no-proxy-server', '--host-resolver-rules=MAP stride-layout.test 127.0.0.1'] })
  await browser.prepare(site.url)
  const sessionId = (await host.client.rpc('session.create', { cwd: root })).sessionId
  await browser.bindSession(sessionId)
  const human = await browser.context.newPage(); await human.goto(`${site.origin}/personal`); await human.bringToFront()
  phase = 'rendered-layout'
  const broken = await measure(sessionId, '.customer-card', '.hero')
  assert.equal(broken.comparison.verticalGap, 0)
  assert.equal(broken.target.css.margin.top, '0px')
  assert.equal(await actualGap(), 0)
  for (const selector of ['.card:first-of-type', '.card', '#hidden', 'section[']) {
    const failure = await command(sessionId, 'browser_measure_layout', { selector })
    assert.equal(failure.ok, false, `Selector must not produce a measurement: ${selector}`)
  }
  assert.equal((await measure(sessionId, '.next-card', '.customer-card')).comparison.verticalGap, 24)
  assert.equal((await measure(sessionId, '.customer-card h2', '.customer-card')).comparison.insetsFromReferenceBorder.top, 20)
  assert.equal((await measure(sessionId, '.customer-card h2', '.customer-card')).comparison.verticalGap, null)
  await browser.target.goto(site.fixed)
  await browser.bindSession(sessionId)
  const fixed = await measure(sessionId, '.customer-card', '.hero')
  assert.equal(fixed.comparison.verticalGap, 50)
  assert.equal(fixed.target.css.margin.top, '50px')
  assert.equal(await actualGap(), 50)
  await browser.target.setViewportSize({ width: 1920, height: 1080 })
  assert.equal((await measure(sessionId, '.customer-card', '.hero')).comparison.verticalGap, 50)
  assert.equal(await actualGap(), 50)
  assert.equal(await browser.target.evaluate(() => window.syntheticWrites), 0)
  assert.equal(await human.evaluate(() => window.syntheticWrites), 0)
  assert.ok(await host.client.rpc('session.history', { sessionId }))
  phase = 'revocation'
  await browser.panel.getByRole('button', { name: '停止控制此页', exact: true }).click()
  assert.equal((await command(sessionId, 'browser_measure_layout', { selector: '.customer-card' })).ok, false)
  let modelEvidence
  if (realModel) {
    phase = 'real-model'
    await browser.target.goto(site.url)
    await mkdir(join(root, 'model'))
    modelSessionId = (await host.client.rpc('session.create', { cwd: join(root, 'model') })).sessionId
    await browser.bindSession(modelSessionId)
    const id = ++sequence
    await writeFile(trigger, JSON.stringify({ sequence: id, mode: 'model', reportKind: 'layout', sessionId: modelSessionId, allowedUrls: [site.url, site.fixed] }), { mode: 0o600 })
    await wait(async () => (await readJson(result))?.sequence === id, 'model guard')
    assert.equal((await readJson(result)).modelReady, true)
    await host.client.rpc('session.prompt', { sessionId: modelSessionId, mode: 'queue', content: [{ type: 'text', text: `当前合成页面已绑定。期望 .hero 与 .customer-card 之间留出 50px，但怀疑 .card:first-of-type 选择器未命中。请用 browser_measure_layout 读取当前两块的真实间距与 customer-card 的 computed margin-top，并检查旧选择器是否唯一命中。随后只导航到同源修复示例 ${site.fixed}，再次测量两块的实际间距和 margin-top。只读，不修改页面。最终只返回 JSON：{"before":{"verticalGap":数字,"marginTop":"CSS值","oldSelectorMatched":布尔值},"after":{"verticalGap":数字,"marginTop":"CSS值"}}。没有测量结果不得填 0，不要访问其他页面。` }], clientTimeZone: 'Asia/Shanghai' })
    await wait(async () => (await readJson(`${result}.model`))?.terminal === true, 'default-model layout turn', 360000)
    modelEvidence = await readJson(`${result}.model`)
    assert.equal(modelEvidence.reason, 'completed')
    assert.deepEqual(modelEvidence.blocked, [])
    assert.ok(modelEvidence.results.filter(row => row.name === 'browser_measure_layout' && row.ok).length >= 2)
    assert.equal(modelEvidence.finalLayoutReportCorrect, true)
    assert.equal(await actualGap(), 50)
    assert.equal(await browser.target.evaluate(() => window.syntheticWrites), 0)
    assert.ok(await host.client.rpc('session.history', { sessionId: modelSessionId }))
  }
  const summary = { passed: true, realHost: true, isolatedChrome: true, realModel,
    brokenActualGap: 0, fixedActualGap: 50, nextCardGap: 24, borderInset: 20,
    invalidAndAmbiguousSelectorsDenied: true, hiddenBoxDenied: true, unalignedGapNull: true,
    viewportResizeVerified: true, inputValuesExcluded: true, nativeRevocationDenied: true,
    humanTabUntouched: true, historyReadable: true, ...(modelEvidence ? { modelEvidence } : {}) }
  await writeFile(join(artifacts, realModel ? 'real-model.json' : 'result.json'), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary))
} catch (error) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, realModel ? 'real-model.json' : 'result.json'), JSON.stringify({ passed: false, realModel, phase, errorName: error.name }), { mode: 0o600 })
  console.error(JSON.stringify({ phase })); throw error
} finally {
  if (modelSessionId !== undefined) await host?.client.rpc('session.cancel', { sessionId: modelSessionId }).catch(() => {})
  await browser?.close().catch(() => {}); await host?.close().catch(() => {}); await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
