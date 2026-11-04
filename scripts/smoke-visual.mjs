// Real Host/image storage and isolated Chrome; optional existing-default-model acceptance.
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
import { startVisualSite } from './fixtures/visual-site.mjs'

const repoRoot = resolve(import.meta.dirname, '..'), require = createRequire(join(repoRoot, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'stride-visual-')), home = join(root, 'home')
const trigger = join(root, 'command.json'), result = join(root, 'result.json')
const realModel = process.env.STRIDE_REAL_MODEL === '1'
const artifacts = join(repoRoot, '.stride-private/validation/visual')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
let browser, host, site, sequence = 0, modelSessionId, phase = 'setup'
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined } }
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(`Visual acceptance timed out: ${label}`)
}
async function command(sessionId, name, args = {}) {
  const id = ++sequence
  console.log(JSON.stringify({ phase, sequence: id, tool: name }))
  await writeFile(trigger, JSON.stringify({ sequence: id, sessionId, name, args }), { mode: 0o600 })
  await wait(async () => (await readJson(result))?.sequence === id, name, 105_000)
  const answer = await readJson(result)
  assert.equal(answer.probeError, undefined, 'Host visual probe failed')
  return answer
}
async function setActionTrust(origins) {
  await browser.panel.evaluate(origins => new Promise((resolve, reject) => {
    const port = window.__dshBenchmarkPort, id = crypto.randomUUID()
    const timer = setTimeout(() => { port.onMessage.removeListener(receive); reject(new Error('Synthetic action trust settings timed out')) }, 5000)
    function receive(message) {
      if (message.type !== 'settings.result' || message.id !== id) return
      clearTimeout(timer); port.onMessage.removeListener(receive)
      message.ok ? resolve() : reject(new Error('Synthetic action trust settings failed'))
    }
    port.onMessage.addListener(receive)
    port.postMessage({ type: 'settings', id, settings: { trustedActionOrigins: origins, unrestrictedBrowserAccess: false } })
  }), origins)
}
async function imagePixel(image, point = [.26, .31], rgb = [37, 99, 235]) {
  return browser.worker.evaluate(async ({ image, point, rgb }) => {
    const data = Uint8Array.from(atob(image.data), char => char.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([data], { type: image.mediaType }))
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      const pixel = [...context.getImageData(Math.floor(bitmap.width * point[0]), Math.floor(bitmap.height * point[1]), 1, 1).data]
      return pixel.slice(0, 3).every((value, index) => Math.abs(value - rgb[index]) < 18)
    } finally { bitmap.close() }
  }, { image, point, rgb })
}
try {
  await mkdir(home); await mkdir(artifacts, { recursive: true })
  const install = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', `@eilyeee/dsh-browser-stride@link:${join(repoRoot, 'packages/browser/bridge-browser')}`], { cwd: repoRoot, env, stdio: 'ignore' })
  const timer = setTimeout(() => install.kill('SIGKILL'), 120000)
  try { const [code] = await once(install, 'exit'); assert.equal(code, 0, 'Temporary Host plugin installation failed') } finally { clearTimeout(timer) }
  if (realModel && process.env.STRIDE_MODEL_CREDENTIALS !== undefined) {
    await copyFile(process.env.STRIDE_MODEL_CREDENTIALS, join(home, '.credentials.yaml')); await chmod(join(home, '.credentials.yaml'), 0o600)
  }
  const extraPatch = !realModel || process.env.STRIDE_MODEL_PATCH === undefined ? undefined : await readFile(process.env.STRIDE_MODEL_PATCH, 'utf8')
  process.env.DSH_HOME = home
  site = await startVisualSite()
  const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port; await new Promise(done => listener.close(done))
  host = await startDshBackend({ backend: 'extension', port, repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), runtimeRoot: join(root, 'runtime'), startUrl: site.url,
    toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/visual-probe.mjs'), trigger, result }, extraPatch })
  browser = await startExtensionBrowser({ repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`, pairingCode: await host.issuePairingCode(), trustedOrigin: site.origin,
    chromiumArgs: ['--no-proxy-server', '--host-resolver-rules=MAP stride-visual.test 127.0.0.1'] })
  await browser.prepare(site.url)
  const sessionId = (await host.client.rpc('session.create', { cwd: root })).sessionId
  await browser.bindSession(sessionId)
  // Changing bypass invalidates old visual observations. Select the explicit
  // approval policy before capturing, not between capture and point delivery.
  await setActionTrust([site.origin])
  const targetId = await browser.worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, site.url)
  const human = await browser.context.newPage(); await human.goto(`${site.origin}/personal`); await human.bringToFront()
  phase = 'real-image'
  const textOnly = await command(sessionId, 'browser_snapshot')
  assert.equal(textOnly.ok, true, textOnly.text); assert.equal(textOnly.text.includes(site.layer), false, 'Unselected layer metadata must not be in DOM text')
  const shot = await command(sessionId, 'browser_screenshot')
  assert.equal(shot.ok, true, shot.text); assert.equal(shot.imageBlocks, 1)
  assert.ok(shot.image.width > 0 && shot.image.height > 0)
  assert.equal(await imagePixel(shot.image), true, 'Stored attachment must depict the controlled canvas, not the orange human tab')
  assert.equal(shot.text.includes('/9j/'), false, 'Image bytes must not become model text')
  assert.equal(await human.evaluate(() => window.syntheticClicks), 0)
  // A second legitimate conversation on the same granted page cannot reuse the first ref.
  await mkdir(join(root, 'other'))
  const other = (await host.client.rpc('session.create', { cwd: join(root, 'other') })).sessionId
  await browser.panel.evaluate(sessionId => window.__dshBenchmarkPort.postMessage({ type: 'session.active', sessionId, isNew: true }), other)
  await wait(() => browser.worker.evaluate(async sessionId => !!(await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity?.sessionTabs?.[sessionId], other), 'second conversation binding')
  await setActionTrust([])
  assert.equal((await command(other, 'browser_click_at', { screenshotRef: shot.screenshotRef, x: .26, y: .31 })).ok, false)
  assert.equal(await browser.panel.getByRole('button', { name: '仅允许这一次', exact: true }).count(), 0, 'A foreign screenshot must not ask for action confirmation')
  assert.deepEqual(site.state(), { selection: null, clicks: 0 })
  const [clicked] = await Promise.all([
    command(sessionId, 'browser_click_at', { screenshotRef: shot.screenshotRef, x: .26, y: .31 }),
    browser.panel.getByRole('button', { name: '仅允许这一次', exact: true }).click(),
  ])
  assert.equal(clicked.ok, true, clicked.text)
  await wait(() => site.state().clicks === 1, 'canvas point selection')
  const selected = await command(sessionId, 'browser_snapshot')
  assert.equal(selected.ok, true); assert.ok(selected.text.includes(site.layer)); assert.ok(selected.text.includes(site.color)); assert.ok(selected.text.includes('14px'))
  const readStyles = async (args = { region: '#properties' }) => {
    const result = await command(sessionId, 'browser_read_design_styles', args)
    assert.equal(result.ok, true, result.text)
    return JSON.parse(result.text.slice(result.text.indexOf('{')))
  }
  const backgroundStyles = await readStyles()
  assert.equal(backgroundStyles.layer.value, site.layer)
  for (const [key, value] of Object.entries({ width: '320px', height: '144px', fill: site.color, borderRadius: '14px' })) {
    assert.equal(backgroundStyles.properties[key].value, value)
    assert.ok(backgroundStyles.properties[key].evidence.length > 0)
  }
  assert.ok(backgroundStyles.missing.includes('fontWeight'))
  assert.equal((await command(sessionId, 'browser_click_at', { screenshotRef: shot.screenshotRef, x: .26, y: .31 })).ok, false)
  assert.equal(await browser.panel.getByRole('button', { name: '仅允许这一次', exact: true }).count(), 0, 'A consumed screenshot must not ask for action confirmation')
  assert.equal(site.state().clicks, 1)
  await setActionTrust([site.origin])
  phase = 'scroll-and-zoom'
  const beforeScroll = await command(sessionId, 'browser_screenshot'); assert.equal(beforeScroll.ok, true, beforeScroll.text)
  assert.equal((await command(sessionId, 'browser_scroll', { direction: 'down', amount: 100 })).ok, true)
  assert.equal((await command(sessionId, 'browser_click_at', { screenshotRef: beforeScroll.screenshotRef, x: .26, y: .31 })).ok, false)
  const scrolled = await command(sessionId, 'browser_screenshot'); assert.equal(scrolled.ok, true, scrolled.text)
  assert.equal(await imagePixel(scrolled.image), true, 'Scrolled screenshot must still cover the complete visible viewport')
  await browser.worker.evaluate(id => chrome.tabs.setZoom(id, 1.25), targetId)
  await delay(200)
  assert.equal((await command(sessionId, 'browser_click_at', { screenshotRef: scrolled.screenshotRef, x: .26, y: .31 })).ok, false)
  const zoomed = await command(sessionId, 'browser_screenshot'); assert.equal(zoomed.ok, true, zoomed.text)
  assert.equal(await imagePixel(zoomed.image), true, 'Browser zoom must preserve full-image point fractions')
  phase = 'worker-recovery'
  Object.assign(browser, await browser.restartWorker())
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 30000 })
  await wait(() => browser.worker.evaluate(async () => (await chrome.storage.session.get('dshVisualCaptures')).dshVisualCaptures?.length === 0), 'recorded visual connection cleanup')
  assert.equal(await browser.worker.evaluate(id => chrome.debugger.sendCommand({ tabId: id }, 'Page.getFrameTree').then(() => true, () => false), targetId), false)
  assert.equal((await command(sessionId, 'browser_click_at', { screenshotRef: zoomed.screenshotRef, x: .26, y: .31 })).ok, false)
  assert.equal(site.state().clicks, 1, 'Worker recovery must not replay a canvas selection')
  await browser.bindSession(sessionId)
  const recovered = await command(sessionId, 'browser_screenshot'); assert.equal(recovered.ok, true, recovered.text)
  assert.equal(await imagePixel(recovered.image), true, 'A fresh screenshot must work after explicit binding in the new worker')
  phase = 'separate-layers-and-design-switch'
  assert.equal((await command(sessionId, 'browser_click_at', { screenshotRef: recovered.screenshotRef, x: .26, y: .31 })).ok, true)
  const background = await command(sessionId, 'browser_get_text', { selector: '#properties' })
  assert.ok(background.text.includes(site.layer)); assert.ok(background.text.includes('width: 320px'))
  const textShot = await command(sessionId, 'browser_screenshot'); assert.equal(textShot.ok, true, textShot.text)
  assert.equal((await command(sessionId, 'browser_click_at', { screenshotRef: textShot.screenshotRef, x: .38, y: .37 })).ok, true)
  const lettering = await command(sessionId, 'browser_get_text', { selector: '#properties' })
  for (const value of [site.textLayer, 'font-size: 18px', 'font-weight: 400', 'line-height: 24px', 'width: 126px']) assert.ok(lettering.text.includes(value), value)
  assert.equal(lettering.text.includes('width: 320px'), false)
  const textStyles = await readStyles()
  assert.equal(textStyles.layer.value, site.textLayer)
  for (const [key, value] of Object.entries({ width: '126px', height: '24px', fontSize: '18px', fontWeight: '400', lineHeight: '24px', color: '#ffffff' })) {
    assert.equal(textStyles.properties[key].value, value)
  }
  assert.ok(textStyles.missing.includes('fill'))
  const pageStyles = await readStyles({})
  assert.equal(pageStyles.layer.value, site.textLayer)
  assert.equal(pageStyles.properties.fontWeight.value, '400')
  const beforeSwitch = await command(sessionId, 'browser_screenshot'); assert.equal(beforeSwitch.ok, true, beforeSwitch.text)
  const clicksBeforeSwitch = site.state().clicks
  await browser.target.locator('#design-b').click()
  await browser.target.locator('#current-design').filter({ hasText: 'Design B' }).waitFor()
  assert.equal((await command(sessionId, 'browser_click_at', { screenshotRef: beforeSwitch.screenshotRef, x: .26, y: .31 })).ok, false)
  assert.equal(site.state().clicks, clicksBeforeSwitch, 'Old-design coordinates must not dispatch a selection')
  assert.equal(await browser.target.locator('#properties').textContent(), 'Select a design layer')
  assert.equal((await readStyles()).status, 'unrecognized', 'A switched design must not reuse old layer styles')
  const newDesign = await command(sessionId, 'browser_screenshot'); assert.equal(newDesign.ok, true, newDesign.text)
  assert.equal(await imagePixel(newDesign.image, site.designs.b.sample, [22, 163, 74]), true, 'Fresh screenshot must show the new green design at its new position')
  assert.equal((await command(sessionId, 'browser_click_at', { screenshotRef: newDesign.screenshotRef, x: .53, y: .59 })).ok, true)
  const newProperties = await command(sessionId, 'browser_get_text', { selector: '#properties' })
  for (const value of [site.designs.b.layer, site.designs.b.color, '22px', 'width: 260px']) assert.ok(newProperties.text.includes(value), value)
  const switchedStyles = await readStyles()
  assert.equal(switchedStyles.layer.value, site.designs.b.layer)
  assert.equal(switchedStyles.properties.width.value, '260px')
  assert.equal(switchedStyles.properties.fill.value, site.designs.b.color)
  await wait(() => site.state().selection === site.designs.b.layer, 'new-design server readback')
  await browser.target.locator('#design-a').click()
  await browser.target.locator('#current-design').filter({ hasText: 'Design A' }).waitFor()
  phase = 'native-revocation'
  await browser.panel.getByRole('button', { name: '停止控制此页', exact: true }).click()
  await wait(() => browser.worker.evaluate(async id => !(await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants?.some(row => row.tabId === id), targetId), 'native group revocation')
  assert.equal((await command(sessionId, 'browser_click_at', { screenshotRef: recovered.screenshotRef, x: .26, y: .31 })).ok, false)
  assert.equal((await command(sessionId, 'browser_read_design_styles', { region: '#properties' })).ok, false, 'Style reads must respect native page revocation')
  assert.equal(await browser.worker.evaluate(id => chrome.debugger.sendCommand({ tabId: id }, 'Page.getFrameTree').then(() => true, () => false), targetId), false)
  assert.equal(await human.evaluate(() => window.syntheticClicks), 0)
  assert.ok(await host.client.rpc('session.history', { sessionId }), 'Direct preparation must leave a readable test Session')
  let modelEvidence
  if (realModel) {
    phase = 'real-model'
    await browser.worker.evaluate(id => chrome.tabs.setZoom(id, 1), targetId)
    await browser.target.goto(site.url); site.reset()
    await mkdir(join(root, 'model'))
    modelSessionId = (await host.client.rpc('session.create', { cwd: join(root, 'model') })).sessionId
    await browser.bindSession(modelSessionId)
    const id = ++sequence
    await writeFile(trigger, JSON.stringify({ sequence: id, mode: 'model', sessionId: modelSessionId, layer: site.layer, color: site.color, expected: site.designs.a }), { mode: 0o600 })
    await wait(async () => (await readJson(result))?.sequence === id, 'model guard')
    assert.equal((await readJson(result)).modelReady, true)
    await host.client.rpc('session.prompt', { sessionId: modelSessionId, mode: 'queue', content: [{ type: 'text', text: '当前对话已绑定合成画布，不要列出或跟随标签页。画布上有一个蓝色按钮，请用截图确定它的位置，分别选择按钮的背景留白和文字，每次点击都重新截图，每层选中后都用 browser_read_design_styles 回读属性。这个合成站点的属性面板选择器为 #properties。最后只返回 JSON：background 包含 layer、width、height、fill、radius；text 包含 layer、width、height、fontSize、fontWeight、color、lineHeight。尺寸单位为 px，字重以面板显式值为准。不要修改设计属性或访问其他页面，完成后停止。' }], clientTimeZone: 'Asia/Shanghai' })
    await wait(async () => (await readJson(`${result}.model`))?.terminal === true, 'default-model visual turn', 360000)
    modelEvidence = await readJson(`${result}.model`)
    assert.equal(modelEvidence.reason, 'completed')
    assert.deepEqual(modelEvidence.blocked, [])
    assert.ok(modelEvidence.results.some(row => row.name === 'browser_screenshot' && row.ok && row.imageBlocks === 1))
    assert.ok(modelEvidence.results.some(row => row.name === 'browser_click_at' && row.ok))
    assert.ok(modelEvidence.results.filter(row => row.name === 'browser_read_design_styles' && row.ok).length >= 2,
      'Model must use structured inspector reads for both selected layers')
    assert.equal(modelEvidence.finalLayerReported, true); assert.equal(modelEvidence.finalColorReported, true)
    assert.equal(modelEvidence.finalStyleReportCorrect, true, 'Model must distinguish exact container and text metrics')
    assert.ok(site.history().some(row => row.layer === site.layer))
    assert.ok(site.history().some(row => row.layer === site.textLayer))
    assert.ok(site.state().clicks >= 2)
  }
  const summary = { passed: true, realHost: true, isolatedChrome: true, realModel,
    storedImageBlock: true, controlledPagePixelsVerified: true, imageBytesExcludedFromText: true,
    canvasLayerSelected: true, exactDomPropertiesRead: true, separateBackgroundAndTextRead: true,
    structuredInspectorStyles: true, structuredStyleReadRevoked: true, switchedDesignStylesFresh: true,
    oldDesignRefRejected: true, newDesignPixelsAndPropertiesVerified: true, crossSessionRefDenied: true, repeatedPointDenied: true,
    staleScrollAndZoomDenied: true, scrolledAndZoomedPixelsVerified: true, nativeStopDetachedVisualControl: true,
    workerRestartDetachedVisualControl: true, workerRestartRefDenied: true, workerRestartFreshCapture: true,
    invalidRefSkippedApproval: true, validPointApprovedNatively: true,
    humanTabUntouched: true, directProbeHistoryReadable: true, ...(modelEvidence === undefined ? {} : { modelEvidence }) }
  await writeFile(join(artifacts, realModel ? 'real-model.json' : 'result.json'), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary))
} catch (error) {
  await mkdir(artifacts, { recursive: true })
  const diagnostics = await browser?.panel.evaluate(() => ({
    connected: !!document.querySelector('.connection .dot.connected'),
    approvalVisible: document.body.innerText.includes('仅允许这一次'),
  })).catch(() => undefined)
  await writeFile(join(artifacts, realModel ? 'real-model.json' : 'result.json'), JSON.stringify({ passed: false, realModel, phase, errorName: error.name }), { mode: 0o600 })
  console.error(JSON.stringify({ phase, diagnostics }))
  throw error
} finally {
  if (modelSessionId !== undefined) await host?.client.rpc('session.cancel', { sessionId: modelSessionId }).catch(() => {})
  await browser?.close().catch(() => {}); await host?.close().catch(() => {}); await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
