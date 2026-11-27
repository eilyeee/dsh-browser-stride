// Real Host and extension, with a disposable profile, synthetic Wiki and no model calls.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const benchmarkRoot = join(repoRoot, 'benchmark')
const root = await mkdtemp(join(tmpdir(), 'stride-local-browser-'))
const trigger = join(root, 'document-command.json')
const reply = join(root, 'document-reply.json')
const sessionId = randomUUID()
const otherDocumentSession = randomUUID()
const autonomousWikiSession = randomUUID()
const credential = randomBytes(32).toString('hex')
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJxkAAAAASUVORK5CYII=', 'base64')
let revision = '30'
let wikiReply = 'document'
let sequence = 0
let host, browser
const pageHtml = () => `<!doctype html><meta charset="utf-8"><meta name="ajs-page-version" content="${revision}">
<title>Fixture Wiki</title><h1>Project directory</h1><main id="wiki">Catalog with visible project repository and permission links.
<table><tr><th>项目名</th><th>Git地址</th><th>权限</th></tr>
<tr><td>Fixture App</td><td><a href="https://git.example.invalid/apps/fixture.git?token=fixture-private">Repository</a>
<a hidden href="https://git.example.invalid/hidden.git">Hidden entry</a></td><td><a href="/permissions?pageId=17&amp;token=fixture-private">Permissions</a></td></tr></table>
<img src="/fixture.png" width="1" height="1" alt="Synthetic requirement material">
<label>Note<input id="note"></label><label>Mode<select id="mode"><option>One</option><option>Two</option></select></label>
<button id="count" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Count clicks</button></main>`
const site = createServer((req, res) => {
  assert.equal(req.method, 'GET')
  if (req.url === '/pages/viewpage.action?pageId=404') {
    res.writeHead(302, { Location: '/login' }).end()
    return
  }
  if (req.url === '/fixture.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pixel.length }).end(pixel)
    return
  }
  if (wikiReply === 'unauthorized') {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }).end('Sign in to the fixture')
    return
  }
  if (wikiReply === 'login-form') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<form id="loginform"><input type="password"></form>')
    return
  }
  const send = () => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pageHtml())
  if (revision === '32' && req.url === '/pages/viewpage.action?pageId=42') setTimeout(send, 550)
  else send()
})
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', done))
const close = server => new Promise(done => server.close(done))
const status = async (response, code) => {
  assert.equal(response.status, code, await response.clone().text())
  return response.json()
}
const ref = (snapshot, label) => {
  const line = snapshot.result.text.split('\n').find(line => line.includes(label) && line.includes('ref='))
  const value = /ref=([^\s"\]]+)/.exec(line ?? '')?.[1]
  assert.ok(value, `Missing element reference for ${label}`)
  return value
}
async function readInConversation(document) {
  const id = ++sequence
  await writeFile(trigger, JSON.stringify({ sequence: id, sessionId, name: 'browser_get_text', args: { document } }), { mode: 0o600 })
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const result = await readFile(reply, 'utf8').then(JSON.parse).catch(() => undefined)
    if (result?.sequence === id) {
      assert.equal(result.probeError, undefined)
      return result
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for the conversation document read')
}

try {
  process.env.DSH_HOME = join(root, 'home')
  process.env.STRIDE_SMOKE_LOCAL_CREDENTIAL = credential
  await mkdir(process.env.DSH_HOME)
  await listen(site)
  const origin = `http://127.0.0.1:${site.address().port}`
  const expectedUrl = `${origin}/health`
  const reservation = createServer()
  await listen(reservation)
  const port = reservation.address().port
  await close(reservation)
  const endpoint = `http://127.0.0.1:${port}/ext/local-browser`
  const startHost = () => startDshBackend({ backend: 'extension', repoRoot, benchmarkRoot, port,
    runtimeRoot: join(root, 'runtime'), startUrl: expectedUrl,
    toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/visual-probe.mjs'), trigger, result: reply }, extraPatch: `
- id: benchmark-extension-bridge
  config:
    token: !!js process.env.DSH_EXT_TOKEN
    sessionWorkspacePath: !!js process.env.DSH_BROWSER_SESSION_WORKSPACE
    deferSessionCreate: false
    localBrowser:
      credentialEnv: STRIDE_SMOKE_LOCAL_CREDENTIAL
      sessionId: ${JSON.stringify(sessionId)}
      documentSessionIds: [${JSON.stringify(otherDocumentSession)}]
      allowedOrigins: [${JSON.stringify(origin)}]
      autonomousWiki:
        sessionId: ${JSON.stringify(autonomousWikiSession)}
        origins: [${JSON.stringify(origin)}]
      allowActions: true
` })
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }
  const command = (value, overrides) => fetch(endpoint, { method: 'POST', redirect: 'error',
    headers: { ...headers, ...overrides }, body: JSON.stringify({ expectedUrl, ...value }), signal: AbortSignal.timeout(35_000) })
    .catch(cause => { throw new Error(`Fixture request ${value.action}${value.autoOpen ? ' (autonomous)' : ''} failed`, { cause }) })
  const receipt = async operationId => status(await fetch(endpoint + '?operationId=' + operationId, { headers }), 200)
  host = await startHost()
  await host.client.rpc('session.create', { sessionId, cwd: root })
  await host.client.rpc('session.create', { sessionId: otherDocumentSession, cwd: root })
  await host.client.rpc('session.create', { sessionId: autonomousWikiSession, cwd: root })
  browser = await startExtensionBrowser({ repoRoot, benchmarkRoot, bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`,
    issuePairingCode: () => host.issuePairingCode(), trustedOrigin: origin,
    chromiumArgs: ['--proxy-server=http://127.0.0.1:1', `--proxy-bypass-list=<-loopback>;127.0.0.1:${port};127.0.0.1:${site.address().port}`] })
  await status(await command({ action: 'snapshot' }, { Authorization: '' }), 401)
  await status(await command({ action: 'snapshot' }, { Origin: 'https://other.example.invalid' }), 403)
  await status(await command({ action: 'navigate', operationId: randomUUID(), url: 'https://other.example.invalid' }), 403)
  await status(await command({ action: 'snapshot' }), 409)
  await browser.bindSession(sessionId)
  await status(await command({ action: 'snapshot', expectedUrl: `${origin}/other` }), 409)

  const document = { action: 'document', document: { titleSelector: 'h1', contentSelector: '#wiki',
    versionSelector: 'meta[name="ajs-page-version"]', includeProjectEntries: true } }
  const documentRequest = { expectedUrl, ...document.document }
  const autonomous = { ...document, expectedUrl: `${origin}/pages/viewpage.action?pageId=42`, autoOpen: true }
  const forbidden = await status(await command({ ...autonomous, expectedUrl: `${origin}/logout?pageId=42` }), 403)
  assert.equal(forbidden.error, 'autonomous-wiki-not-allowed')
  const unavailable = await status(await command(autonomous), 409)
  assert.equal(unavailable.error, 'approval-unavailable')
  let result = (await status(await command(document), 200)).result
  assert.equal(result.version, '30')
  assert.deepEqual(result.projectEntries, [{ name: 'Fixture App', repositoryUrl: 'https://git.example.invalid/apps/fixture.git',
    permissionUrls: [`${origin}/permissions?pageId=17`] }])
  const secondUrl = `${origin}/second-document`
  const secondPage = await browser.context.newPage()
  await secondPage.goto(secondUrl)
  await browser.bindSession(otherDocumentSession, secondPage)
  const { includeProjectEntries: _include, ...selectors } = document.document
  const secondDocument = (await status(await command({ action: 'document', expectedUrl: secondUrl, document: selectors }), 200)).result
  assert.equal(secondDocument.version, '30')
  assert.equal(secondDocument.materials[0].base64, pixel.toString('base64'))
  await status(await command({ action: 'snapshot', expectedUrl: secondUrl }), 409)
  const tabCount = browser.context.pages().length
  const conversationRead = await readInConversation(documentRequest)
  assert.equal(conversationRead.ok, true, conversationRead.text)
  assert.match(conversationRead.text, /UNTRUSTED_PAGE_CONTENT/)
  assert.match(conversationRead.text, /"title":"Project directory"/)
  assert.match(conversationRead.text, /"version":"30"/)
  assert.match(conversationRead.text, /Catalog with visible project repository/)
  assert.doesNotMatch(conversationRead.text, /fixture-private|base64/)
  const differentTarget = await readInConversation({ ...documentRequest, expectedUrl: secondUrl })
  assert.equal(differentTarget.ok, false)
  assert.match(differentTarget.text, /"code":"navigated"/)
  for (const loginReply of ['unauthorized', 'login-form']) {
    wikiReply = loginReply
    const login = await readInConversation(documentRequest)
    assert.equal(login.ok, false)
    assert.match(login.text, /Sign in to the selected document/)
  }
  wikiReply = 'document'
  revision = '31'
  const stale = await readInConversation(documentRequest)
  assert.equal(stale.ok, false)
  assert.match(stale.text, /Reload the selected document/)
  assert.equal((await status(await command(document), 409)).error, 'document-version-stale')
  assert.equal(browser.context.pages().length, tabCount)
  assert.equal(browser.target.url(), expectedUrl)
  await browser.target.reload({ waitUntil: 'load' })
  result = (await status(await command(document), 200)).result
  assert.equal(result.version, '31')
  const updated = await readInConversation(documentRequest)
  assert.equal(updated.ok, true, updated.text)
  assert.match(updated.text, /"version":"31"/)

  let snapshot = await status(await command({ action: 'snapshot' }), 200)
  const note = ref(snapshot, 'Note')
  const typeId = randomUUID()
  assert.equal((await status(await command({ action: 'type', operationId: typeId, elementRef: note, text: 'intentional' }), 200)).status, 'returned')
  assert.equal(await browser.target.locator('#note').inputValue(), 'intentional')
  snapshot = await status(await command({ action: 'snapshot' }), 200)
  assert.equal((await status(await command({ action: 'select', operationId: randomUUID(), elementRef: ref(snapshot, 'Mode'), optionIndex: 1 }), 200)).status, 'returned')
  assert.equal(await browser.target.locator('#mode').inputValue(), 'Two')

  snapshot = await status(await command({ action: 'snapshot' }), 200)
  const click = { action: 'click', operationId: randomUUID(), elementRef: ref(snapshot, 'Count clicks') }
  await Promise.all([command(click).then(response => status(response, 200)), command(click).then(response => status(response, 200))])
  assert.equal(await browser.target.locator('#count').getAttribute('data-clicks'), '1')
  assert.equal((await receipt(click.operationId)).status, 'returned')
  assert.equal((await receipt(click.operationId.toUpperCase())).status, 'returned')
  assert.equal((await status(await command({ ...click, elementRef: 'different-ref' }), 409)).error, 'operation-id-conflict')
  await host.close()
  host = await startHost()
  assert.equal((await receipt(click.operationId)).status, 'returned')
  assert.equal((await status(await command(click), 200)).status, 'returned')
  assert.equal((await status(await command({ ...click, elementRef: 'different-ref' }), 409)).error, 'operation-id-conflict')
  assert.equal(await browser.target.locator('#count').getAttribute('data-clicks'), '1')
  await browser.panel.locator('.connection .dot.connected').waitFor({ timeout: 15_000 })
  const destination = `${origin}/next`
  assert.equal((await status(await command({ action: 'navigate', operationId: randomUUID(), url: destination }), 200)).status, 'returned')
  await browser.target.waitForURL(destination)
  assert.match((await status(await command({ action: 'text', expectedUrl: destination, selector: 'h1' }), 200)).result.text, /Project directory/)
  await browser.panel.reload()
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15000 })
  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  await browser.panel.locator('.settings-panel input').first().fill(`ws://127.0.0.1:${port}/ext/bridge`)
  await browser.panel.getByRole('checkbox', { name: '自动控制 DSH 新建页面', exact: false }).check()
  await browser.panel.getByRole('button', { name: '保存并连接', exact: true }).click()
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 15000 })
  const autonomousResult = (await status(await command(autonomous), 200)).result
  assert.equal(autonomousResult.version, '31')
  assert.deepEqual(autonomousResult.projectEntries, result.projectEntries)
  const autoTabCount = browser.context.pages().length
  revision = '32'
  assert.equal((await status(await command(autonomous), 200)).result.version, '32')
  assert.equal(browser.context.pages().length, autoTabCount)
  assert.equal((await status(await command({ ...autonomous, expectedUrl: `${origin}/pages/viewpage.action?pageId=404` }), 409)).error, 'target-navigated')
  assert.equal(browser.context.pages().length, autoTabCount)
  console.log(JSON.stringify({ passed: true, realHost: true, isolatedChrome: true, versionedRead: true, conversationDocumentRead: true, autonomousWiki: true, pageActions: true, receiptAfterRestart: true }))
} finally {
  await browser?.close().catch(() => {})
  await host?.close().catch(() => {})
  await close(site)
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
