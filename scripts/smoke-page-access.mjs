// Real Chromium permission/grouping check. Disposable profile and synthetic sites; no model.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const site = createServer((req, res) => {
  if (req.url.startsWith('/ext/')) { res.writeHead(503); res.end(); return }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>Synthetic page authorization</title><main>synthetic-page-marker</main><input aria-label="Synthetic field"><button>Test action</button>')
})
await new Promise(done => site.listen(0, '127.0.0.1', done))
const port = site.address().port
const origin = `http://stride.test:${port}`
let browser
async function wait(predicate, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { if (await predicate()) return; await delay(50) }
  throw new Error(`Page permission check timed out: ${label}`)
}
async function grantCount() { return browser.worker.evaluate(async () => (await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants?.length ?? 0) }
async function activeId(page) {
  await page.bringToFront()
  return browser.worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id)
}
async function nativeCanRead(id) {
  return browser.worker.evaluate(async tabId => {
    try { const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.title }); return results.length > 0 }
    catch { return false }
  }, id)
}
async function rebind(id = 'permission-bind') {
  return browser.panel.evaluate(id => new Promise(done => {
    const port = window.__dshBenchmarkPort
    const listener = message => { if (message.type === 'tab-affinity.rebind.result' && message.id === id) { clearTimeout(timer); port.onMessage.removeListener(listener); done(message) } }
    const timer = setTimeout(() => { port.onMessage.removeListener(listener); done({ ok: false, error: { code: 'timeout' } }) }, 5000)
    port.onMessage.addListener(listener); port.postMessage({ type: 'tab-affinity.rebind', id })
  }), id)
}
try {
  browser = await startExtensionBrowser({ repoRoot: root, benchmarkRoot: join(root, 'benchmark'),
    bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`, deferPairing: true, trustedOrigin: origin,
    chromiumArgs: ['--no-proxy-server', '--host-resolver-rules=MAP stride.test 127.0.0.1, MAP other.test 127.0.0.1'] })
  const a = browser.target
  await a.goto(`${origin}/a`)
  const aId = await activeId(a)
  const b = await browser.context.newPage(); await b.goto(`${origin}/b`)
  const bId = await activeId(b)
  const unapprovedMetadata = await browser.worker.evaluate(id => chrome.tabs.get(id), bId)
  assert.equal(unapprovedMetadata.url, undefined, 'unapproved tabs do not expose URLs')
  assert.equal(unapprovedMetadata.title, undefined, 'unapproved tabs do not expose titles')
  assert.equal(await nativeCanRead(aId), false, 'native browser permissions deny an unselected tab')
  assert.equal(await nativeCanRead(bId), false)
  assert.equal(await grantCount(), 0)
  const refused = await rebind('before-native-click')
  assert.equal(refused.ok, false, 'a panel message cannot create activeTab access')
  assert.equal(refused.error.code, 'page-access-required')
  await browser.authorizePage(a)
  assert.equal(await nativeCanRead(aId), true)
  assert.equal(await nativeCanRead(bId), false, 'same-origin sibling tabs are not covered by activeTab')
  await browser.panel.getByRole('button', { name: '停止控制此页', exact: true }).waitFor() // Available before task binding.
  await a.bringToFront(); assert.equal((await rebind('authorized-a')).ok, true)
  const snapshot = await browser.worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'DSH_ACTION', action: 'browser_snapshot', args: {} }), aId)
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot))
  assert.match(snapshot.result.text, /synthetic-page-marker/)
  const group = await browser.worker.evaluate(async tabId => (await chrome.tabs.get(tabId)).groupId, aId)
  assert.ok(group >= 0)
  await browser.worker.evaluate(async ({ tabId, groupId }) => { await chrome.tabs.group({ tabIds: tabId, groupId }) }, { tabId: bId, groupId: group })
  await wait(() => browser.worker.evaluate(async id => (await chrome.tabs.get(id)).groupId === -1, bId), 'unapproved group member removed')
  assert.equal(await nativeCanRead(bId), false, 'group membership cannot grant native permission')
  assert.equal(await grantCount(), 1)
  await browser.authorizePage(b)
  assert.equal(await grantCount(), 2)
  assert.equal(await browser.worker.evaluate(async tabId => (await chrome.tabs.get(tabId)).groupId, bId), group)
  await b.bringToFront(); assert.equal((await rebind('authorized-b')).ok, true)
  const stop = browser.panel.getByRole('button', { name: '停止控制此页', exact: true })
  await stop.waitFor(); await stop.evaluate(button => button.click()); await delay(150)
  assert.equal(await grantCount(), 2, 'synthetic clicks cannot revoke the selected page')
  await stop.click()
  await wait(async () => (await grantCount()) === 1, 'stop control')
  await wait(() => browser.worker.evaluate(async id => (await chrome.tabs.get(id)).groupId === -1, bId), 'stopped page leaves control group')
  await b.bringToFront(); assert.equal((await rebind('after-stop')).ok, false)
  assert.equal(b.isClosed(), false)
  await a.goto(`http://other.test:${port}/cross-origin`)
  await wait(async () => (await grantCount()) === 0, 'cross-origin revocation')
  assert.equal(await nativeCanRead(aId), false)
  await browser.authorizePage(a)
  await a.reload()
  await wait(async () => (await grantCount()) === 1, 'same-origin reload retains Chrome grant')
  assert.equal(await nativeCanRead(aId), true)
  // A pinned tab has no group to remove. This isolates durable revocation from
  // group-based restoration checks when the replaceable session cache fails.
  await browser.worker.evaluate(id => chrome.tabs.update(id, { pinned: true }), aId)
  await wait(async () => (await grantCount()) === 0, 'pinning removes the controlled group grant')
  await browser.authorizePage(a)
  const pinned = await browser.worker.evaluate(id => chrome.tabs.get(id), aId)
  assert.equal(pinned.pinned, true, 'page authorization preserves pinning')
  assert.equal(pinned.groupId, -1)
  await a.bringToFront(); assert.equal((await rebind('before-cache-fault')).ok, true)
  await browser.worker.evaluate(() => {
    const save = chrome.storage.session.set.bind(chrome.storage.session)
    let failed = false
    chrome.storage.session.set = async value => {
      if (!failed && Object.hasOwn(value, 'dshPageAccess')) { failed = true; throw new Error('Synthetic session-cache failure') }
      return save(value)
    }
  })
  await browser.panel.getByRole('button', { name: '停止控制此页', exact: true }).click()
  await browser.panel.getByText('停止控制的结果尚未确认，请重新加载扩展后核对页面授权。', { exact: true }).waitFor()
  assert.equal((await rebind('after-cache-fault')).ok, false)
  assert.equal(await grantCount(), 1, 'the test must retain the stale cache')
  Object.assign(browser, await browser.restartWorker())
  assert.equal(await nativeCanRead(aId), true, 'native activeTab must survive this worker-only restart')
  assert.equal((await rebind('stale-cache-cannot-restore')).ok, false, 'the private revocation must override the stale session cache')
  await browser.authorizePage(a)
  await a.bringToFront(); assert.equal((await rebind('explicit-grant-after-fault')).ok, true)
  await browser.worker.evaluate(id => chrome.tabs.update(id, { pinned: false }), aId)
  await browser.authorizePage(a)
  const artifacts = join(root, '.stride-private/validation/page-access')
  await mkdir(artifacts, { recursive: true })
  await browser.panel.screenshot({ path: join(artifacts, 'authorized-page-and-control-group.png') })
  Object.assign(browser, await browser.restart({ connected: false }))
  await delay(250)
  assert.equal(await grantCount(), 0, 'browser restart does not restore page grants')
  assert.equal(await nativeCanRead(await activeId(browser.target)), false)
  assert.equal((await browser.worker.evaluate(() => chrome.tabGroups.query({ title: 'DSH 控制' }))).length, 0)
  console.log('Page permission smoke passed: native activeTab grant, same-origin sibling isolation, visible control group, no authorization by dragging, trusted stop, cross-origin revocation, Chrome reload, stale-cache revocation after worker restart and browser restart. No model called.')
} finally {
  await browser?.close().catch(() => {})
  await new Promise(done => site.close(done))
}
