// Two independent panel conversations, synthetic pages and a disposable Host.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID, randomInt, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'
import { parseMarkedModelReport } from '../benchmark/lib/model-report.mjs'
const repo = resolve(process.env.STRIDE_ACCEPTANCE_REPO ?? resolve(import.meta.dirname, '..')), reconnect = process.argv.includes('--reconnect'), realModel = process.env.STRIDE_REAL_MODEL === '1'
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
const base = join(repo, reconnect ? '.stride-private/validation/panel-reconnect' : '.stride-private/validation/session-selection', version)
await mkdir(base, { recursive: true })
const label = realModel ? 'real-model' : 'scripted', artifacts = await mkdtemp(join(base, label + '-'))
const token = randomUUID(), otherToken = randomUUID(), min = randomInt(2, 17), max = randomInt(30, 61)
let h, phase = 'setup', writes = 0
const site = createServer((req, res) => {
  if (req.method !== 'GET') { writes++; res.writeHead(405).end(); return }
  const selected = req.url === '/selected'
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>' + (selected ? 'Selected fixture' : 'Other fixture') + '</title><h1>' + (selected ? token : otherToken) + '</h1><label>Count<input type="number" min="' + min + '" max="' + max + '"></label><script>window.inputEvents=0;document.querySelector("input").addEventListener("input",()=>window.inputEvents++)</script>')
})
try {
  await new Promise(done => site.listen(0, '127.0.0.1', done))
  const origin = 'http://127.0.0.1:' + site.address().port
  // Fault injection is confined to a copied extension in this temporary
  // browser. Production bundles never contain this port observer.
  let extensionDir
  if (reconnect) {
    extensionDir = join(artifacts, 'extension-with-port-observer')
    await cp(join(repo, 'extensions/dsh-browser/dist'), extensionDir, { recursive: true })
    const background = join(extensionDir, 'background.js')
    const observer = `globalThis.__strideReconnectPorts=[];chrome.runtime.onConnect.addListener(port=>{if(port.name!=='dsh-panel')return;const entry={port,sessionId:null,windowId:null,closed:false,restored:false,hasHistory:false};globalThis.__strideReconnectPorts.push(entry);port.onMessage.addListener(m=>{if(m.type==='rpc'&&m.method==='session.history')entry.hasHistory=true;if(m.type==='panel.window')entry.windowId=m.windowId;if(m.type==='session.active'){entry.sessionId=m.sessionId;entry.restored=m.restore===true}});port.onDisconnect.addListener(()=>{entry.closed=true})});\n`
    const production = await readFile(background, 'utf8')
    await writeFile(background, observer + production)
    assert.equal((await readFile(background, 'utf8')).slice(observer.length), production)
  }
  h = await startIsolatedModelRun({ repo, origin, startUrl: origin + '/initial', artifacts, extensionDir,
    goal: 'Read only the page explicitly selected for this conversation', promptViaRpc: true, startupTimeoutMs: 120000,
    programs: { inspect: 'console.log(await tools.browser_snapshot({}));' },
    guardSource: "ctx.effect(()=>ctx.tools.guard(exec=>['run_code','browser_snapshot'].includes(exec.name)?undefined:'Only the current selected-page snapshot is permitted'));" })
  await h.browser.prepare(origin + '/initial'); await h.browser.bindSession(h.sessionId)
  const target = await h.browser.context.newPage(); await target.goto(origin + '/selected'); await h.browser.authorizePage(target)
  const otherPage = await h.browser.context.newPage(); await otherPage.goto(origin + '/other'); await h.browser.authorizePage(otherPage)
  const ids = await h.browser.worker.evaluate(async origin => {
    const tabs = await chrome.tabs.query({})
    return { selected: tabs.find(t => t.url === origin + '/selected')?.id, other: tabs.find(t => t.url === origin + '/other')?.id }
  }, origin)
  assert.equal(typeof ids.selected, 'number'); assert.equal(typeof ids.other, 'number')
  // Closing the original tab deliberately leaves the original conversation
  // without a target; authorizing two more pages must not silently bind it.
  await h.browser.target.close()
  const first = h.browser.panel
  const second = await h.browser.context.newPage(); await second.goto(first.url())
  await second.locator('header.topbar').waitFor()
  await second.locator('.new-session-trigger').click()
  await second.waitForFunction(sid => { const value = document.querySelector('.app')?.getAttribute('data-session-id'); return !!value && value !== sid }, h.sessionId)
  const secondId = await second.locator('.app').getAttribute('data-session-id')
  await second.locator('.control-group-pages button[data-tab-id="' + ids.other + '"]').click()
  await second.locator('.control-group-pages button[data-tab-id="' + ids.other + '"][aria-pressed="true"]').waitFor()
  async function disconnectOriginalPanel() {
    phase = 'panel-port-loss'
    const beforeCount = await h.browser.worker.evaluate(sid => {
      const entries = globalThis.__strideReconnectPorts
      const entry = entries.find(e => !e.closed && e.sessionId === sid && typeof e.windowId === 'number' && (e.hasHistory || e.restored))
      if (!entry) throw Error('The original fixture UI port is not registered')
      const before = entries.length
      entry.closed = true
      entry.port.disconnect() // Actual onDisconnect reaches the original panel.
      return before
    }, h.sessionId)
    let restored = false
    const restoreDeadline = Date.now() + 10000
    while (Date.now() < restoreDeadline && !restored) {
      restored = await h.browser.worker.evaluate(({ sid, beforeCount }) =>
        globalThis.__strideReconnectPorts.slice(beforeCount).some(e => !e.closed && e.sessionId === sid && typeof e.windowId === 'number' && e.restored),
        { sid: h.sessionId, beforeCount })
      if (!restored) await new Promise(done => setTimeout(done, 50))
    }
    assert.equal(restored, true, 'The replacement UI port must restore the original conversation/window without a new-session binding')
  }
  if (reconnect) await disconnectOriginalPanel()
  assert.equal(await first.locator('.control-group-pages button[aria-pressed="true"]').count(), 0)
  assert.ok((await first.locator('.control-group').textContent()).includes('尚未选择已授权页面'))
  phase = 'native-selection'
  // Do not send session.active again. Another panel most recently focused its
  // own conversation, and this native choice must still belong to the first.
  await first.bringToFront()
  await first.locator('.control-group-pages button[data-tab-id="' + ids.selected + '"]').click()
  await first.locator('.control-group-pages button[data-tab-id="' + ids.selected + '"][aria-pressed="true"]').waitFor()
  await second.locator('.control-group-pages button[data-tab-id="' + ids.other + '"][aria-pressed="true"]').waitFor()
  const bindings = await h.browser.worker.evaluate(async ({ first, second }) => {
    const state = (await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity
    return { first: state?.sessionTabs?.[first]?.tabId, second: state?.sessionTabs?.[second]?.tabId }
  }, { first: h.sessionId, second: secondId })
  assert.deepEqual(bindings, { first: ids.selected, second: ids.other })
  if (reconnect) {
    // A second reconnect must preserve an existing target as well as restore
    // an unbound view. No explicit session.active or selection is resent.
    await disconnectOriginalPanel()
    await first.locator('.control-group-pages button[data-tab-id="' + ids.selected + '"][aria-pressed="true"]').waitFor()
    await second.locator('.control-group-pages button[data-tab-id="' + ids.other + '"][aria-pressed="true"]').waitFor()
  }
  phase = 'model-read'
  const events = await h.turn('inspect', '只用browser_snapshot读取当前对话已绑定页面，禁止跟随、切换、列表、导航、输入、写入、文件、shell或网络。最终只返回JSON：marker=SESSION_SELECTION_MODEL_DONE；pageToken为当前页面标题下显示的随机标记；min和max为Count字段本次快照中的数值声明；businessSaved=false。不要从历史猜测，缺失写unknown，读取后停止。', realModel ? 240000 : 60000)
  const calls = events.filter(e => e.type === 'tool/ptc-dispatch')
  assert.ok(calls.some(e => e.data.name === 'browser_snapshot' && !e.data.isError))
  assert.ok(calls.every(e => ['run_code', 'browser_snapshot'].includes(e.data.name) && !e.data.isError))
  const text = calls.filter(e => e.data.name === 'browser_snapshot').flatMap(e => e.data.content.filter(b => b.type === 'text').map(b => b.text)).join('\n')
  assert.ok(text.includes(token)); assert.ok(!text.includes(otherToken))
  if (realModel) {
    const last = events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message?.content?.filter(b => b.type === 'text').map(b => b.text) ?? []).at(-1)
    const report = parseMarkedModelReport(last, 'SESSION_SELECTION_MODEL_DONE')
    assert.equal(report.pageToken, token); assert.equal(report.min, min); assert.equal(report.max, max); assert.equal(report.businessSaved, false)
  }
  assert.equal(await target.evaluate(() => window.inputEvents), 0); assert.equal(writes, 0)
  await first.screenshot({ path: join(artifacts, 'first-panel.png') }); await second.screenshot({ path: join(artifacts, 'second-panel.png') })
  const result = { passed: true, version, realModel, scriptedModel: !realModel, isolatedHost: true, isolatedChrome: true,
    startupTimeoutMs: 120000, separatePanelTargets: true, originalUnboundShownCorrectly: true,
    panelPortLossInjected: reconnect, viewContextRestored: reconnect, boundTargetSurvivedSecondReconnect: reconnect,
    extensionObserverCopy: reconnect, nativeSelectionWhileOtherPanelFocused: true,
    modelReadCorrectTarget: true, businessWrites: writes, inputEvents: 0, originalHostUntouched: true,
    hostBundleSha256: createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex'),
    contentBundleSha256: createHash('sha256').update(await readFile(join(repo, 'extensions/dsh-browser/dist/content.js'))).digest('hex'),
    backgroundBundleSha256: createHash('sha256').update(await readFile(join(repo, 'extensions/dsh-browser/dist/background.js'))).digest('hex'), evidenceDirectory: artifacts.slice(base.length + 1) }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  await writeFile(join(base, label + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result))
} catch (error) { await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ passed: false, phase, errorName: error.name }), { mode: 0o600 }); throw error }
finally { await h?.close(); await new Promise(done => site.close(done)) }
