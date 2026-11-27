// An isolated DSH Host and real Chrome, on synthetic sites only.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const benchmarkRoot = join(repoRoot, 'benchmark')
const root = await mkdtemp(join(tmpdir(), 'stride-iframe-access-'))
const trigger = join(root, 'command.json'), reply = join(root, 'reply.json')
const sessionId = randomUUID()
const credential = randomBytes(32).toString('hex')
let host, browser, sequence = 0

const site = createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture.test').pathname
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (path === '/portal') {
    res.end(`<!doctype html><title>Portal fixture</title><main>Portal marker</main>
      <iframe name="same-site" src="${sameSite}/same-site"></iframe>
      <iframe name="cross-site" src="${crossSite}/widget?session=synthetic-frame-secret#details"></iframe>
      <iframe name="denied" src="${denied}/denied"></iframe>
      <iframe name="opaque" sandbox src="${crossSite}/opaque"></iframe>`)
  } else if (path === '/denied') {
    res.end(`<!doctype html><title>Denied sibling</title><main>Denied sibling marker</main>
      <iframe src="${crossSite}/nested"></iframe>`)
  } else if (path === '/widget' || path === '/replacement') {
    res.end(`<!doctype html><title>Widget fixture</title><main id="status">Widget ${path.slice(1)} clicks: 0</main>
      <button onclick="document.querySelector('#status').textContent = 'Widget ${path.slice(1)} clicks: ' + ++window.clicks">Run widget query</button>
      <script>window.clicks = 0</script>`)
  } else {
    res.end(`<!doctype html><main>${path.slice(1)} fixture marker</main>`)
  }
})
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', done))
const close = server => new Promise(done => server.close(done))
await listen(site)
const port = site.address().port
const portal = `http://portal.frame.test:${port}`
const sameSite = `http://app.frame.test:${port}`
const crossSite = `http://app.other.test:${port}`
const denied = `http://denied.test:${port}`
const expectedUrl = portal + '/portal'

async function tool(name, args = {}, targetSession = sessionId) {
  const id = ++sequence
  await writeFile(trigger, JSON.stringify({ sequence: id, sessionId: targetSession, name, args }), { mode: 0o600 })
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const answer = await readFile(reply, 'utf8').then(JSON.parse).catch(() => undefined)
    if (answer?.sequence === id) {
      assert.equal(answer.probeError, undefined, name)
      return answer
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${name}`)
}
const success = answer => {
  assert.equal(answer.ok, true, answer.text)
  return answer.text
}
function section(snapshot, origin, marker) {
  const child = snapshot.split('--- iframe frame=').slice(1)
    .find(text => text.split('\n', 1)[0].endsWith(`origin=${origin} ---`) && text.includes(marker))
  assert.ok(child, `Missing snapshot section for ${origin}\n${snapshot}`)
  return { frame: Number.parseInt(child, 10), text: child }
}
function control(text, label) {
  const line = text.split('\n').find(line => line.includes(label) && line.includes('ref='))
  const ref = line?.match(/ref=(obs_[a-f0-9-]+:\d+)/)?.[1]
  assert.ok(ref, `Missing reference for ${label}`)
  return ref
}

async function updateSettings(settings) {
  await browser.panel.evaluate(settings => new Promise((done, fail) => {
    const port = window.__dshBenchmarkPort
    const id = crypto.randomUUID()
    const timer = setTimeout(() => { port.onMessage.removeListener(receive); fail(new Error('Fixture settings timed out')) }, 5000)
    function receive(message) {
      if (message.type !== 'settings.result' || message.id !== id) return
      clearTimeout(timer)
      port.onMessage.removeListener(receive)
      if (message.ok) done()
      else fail(new Error('Fixture settings were rejected'))
    }
    port.onMessage.addListener(receive)
    port.postMessage({ type: 'settings', id, settings })
  }), settings)
}

try {
  process.env.DSH_HOME = join(root, 'home')
  process.env.STRIDE_IFRAME_SERVICE_CREDENTIAL = credential
  await mkdir(process.env.DSH_HOME)
  const reservation = createServer()
  await listen(reservation)
  const hostPort = reservation.address().port
  await close(reservation)
  host = await startDshBackend({
    backend: 'extension', repoRoot, benchmarkRoot, port: hostPort,
    runtimeRoot: join(root, 'runtime'), startUrl: expectedUrl, startupTimeoutMs: 90_000,
    toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/visual-probe.mjs'), trigger, result: reply },
    extraPatch: `
- id: benchmark-extension-bridge
  config:
    token: !!js process.env.DSH_EXT_TOKEN
    sessionWorkspacePath: !!js process.env.DSH_BROWSER_SESSION_WORKSPACE
    deferSessionCreate: false
    iframeScopes:
      - parentOrigin: ${JSON.stringify(portal)}
        childOrigin: ${JSON.stringify(sameSite)}
      - parentOrigin: ${JSON.stringify(portal)}
        childOrigin: ${JSON.stringify(crossSite)}
    localBrowser:
      credentialEnv: STRIDE_IFRAME_SERVICE_CREDENTIAL
      sessionId: ${JSON.stringify(sessionId)}
      allowedOrigins: ${JSON.stringify([portal, crossSite, denied])}
      allowActions: true
`,
  })
  const local = async (body, expectedStatus = 200) => {
    const response = await fetch(`http://127.0.0.1:${hostPort}/ext/local-browser`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential },
      body: JSON.stringify({ expectedUrl, ...body }),
    }).catch(cause => { throw new Error(`Local iframe fixture request ${body.action} timed out or disconnected.`, { cause }) })
    const result = await response.json()
    assert.equal(response.status, expectedStatus, JSON.stringify(result))
    return result
  }
  await host.client.rpc('session.create', { sessionId, cwd: root })
  browser = await startExtensionBrowser({
    repoRoot, benchmarkRoot, bridgeUrl: `ws://127.0.0.1:${hostPort}/ext/bridge`, trustedOrigin: portal,
    issuePairingCode: () => host.issuePairingCode(),
    chromiumArgs: ['--no-proxy-server', '--site-per-process', '--host-resolver-rules=MAP *.test 127.0.0.1'],
  })
  await browser.target.goto(expectedUrl)
  assert.equal((await tool('browser_snapshot')).ok, false, 'origin pairs do not grant an existing tab')
  await browser.bindSession(sessionId)

  const snapshot = success(await tool('browser_snapshot'))
  assert.match(snapshot, /Portal marker/)
  assert.doesNotMatch(snapshot, /synthetic-frame-secret|Denied sibling marker|opaque fixture marker|nested fixture marker/)
  const same = section(snapshot, sameSite, 'same-site fixture marker')
  const widget = section(snapshot, crossSite, 'Widget widget clicks: 0')
  assert.match(same.text, /same-site fixture marker/)
  assert.match(widget.text, /Widget widget clicks: 0/)
  const elementRef = control(widget.text, 'Run widget query')
  assert.notEqual(same.frame, widget.frame)
  assert.match(success(await tool('browser_get_text', { frame: widget.frame, selector: '#status' })), /clicks: 0/)
  assert.equal((await tool('browser_click', { frame: same.frame, elementRef })).ok, false, 'references are frame-specific')
  success(await tool('browser_click', { frame: widget.frame, elementRef }))
  assert.match(success(await tool('browser_get_text', { frame: widget.frame, selector: '#status' })), /clicks: 1/)

  assert.doesNotMatch((await local({ action: 'snapshot' })).result.text, /--- iframe frame=/)
  assert.equal((await local({ action: 'snapshot', iframe: { origin: denied } }, 403)).error, 'iframe-origin-not-allowed')
  assert.equal((await local({ action: 'snapshot', iframe: { origin: sameSite } }, 403)).error, 'iframe-origin-not-allowed')
  await local({ action: 'snapshot', expectedUrl: portal + '/other', iframe: { origin: crossSite } }, 409)
  const localView = await local({ action: 'snapshot', iframe: { origin: crossSite } })
  const localWidget = section(localView.result.text, crossSite, 'Run widget query')
  const iframe = { origin: crossSite, frame: localWidget.frame }
  await local({ action: 'text', iframe: { ...iframe, frame: same.frame }, selector: '#status' }, 409)
  // Local clients retain the browser's explicit action approval policy.
  await updateSettings({ trustedActionOrigins: [portal, crossSite] })
  const operation = { action: 'click', iframe, elementRef: control(localWidget.text, 'Run widget query'), operationId: randomUUID() }
  assert.equal((await local(operation)).status, 'returned')
  assert.equal((await local(operation)).status, 'returned', 'receipt replay must not click a second time')
  assert.match((await local({ action: 'text', iframe, selector: '#status' })).result.text, /clicks: 2/)

  async function loadWidget(url, expected) {
    await browser.target.locator('iframe[name="cross-site"]').evaluate((iframe, url) => { iframe.src = url }, url)
    await browser.target.frameLocator('iframe[name="cross-site"]').locator('main').filter({ hasText: expected }).waitFor()
  }
  const current = section(success(await tool('browser_snapshot')), crossSite, 'Run widget query')
  await loadWidget(crossSite + '/replacement', 'Widget replacement')
  assert.equal((await tool('browser_click', { frame: current.frame, elementRef: control(current.text, 'Run widget query') })).ok, false)
  const replacement = section(success(await tool('browser_snapshot')), crossSite, 'Widget replacement clicks: 0')
  assert.notEqual(replacement.frame, current.frame)
  assert.match(replacement.text, /Widget replacement clicks: 0/)
  await loadWidget(denied + '/denied', 'Denied sibling marker')
  assert.equal((await tool('browser_get_text', { frame: replacement.frame, selector: 'main' })).ok, false)
  const navigated = success(await tool('browser_snapshot'))
  assert.doesNotMatch(navigated, /Denied sibling marker|opaque fixture marker|nested fixture marker|Run widget query/)
  await local({ action: 'snapshot', iframe: { origin: crossSite } }, 409)

  // A DSH-created page shares its own debugger attachment with iframe tools.
  await updateSettings({ autoControlNewTabs: true })
  assert.equal(await browser.worker.evaluate(async () => (await chrome.storage.local.get('dshSettings')).dshSettings?.autoControlNewTabs), true)
  const automaticSession = randomUUID()
  await host.client.rpc('session.create', { sessionId: automaticSession, cwd: root })
  const automaticUrl = expectedUrl + '?automatic=1'
  success(await tool('browser_open_tab', { url: automaticUrl, active: false }, automaticSession))
  const automaticPage = browser.context.pages().find(page => page.url() === automaticUrl)
  assert.ok(automaticPage)
  await automaticPage.frameLocator('iframe[name="cross-site"]').getByRole('button', { name: 'Run widget query' }).waitFor()
  const automatic = section(success(await tool('browser_snapshot', {}, automaticSession)), crossSite, 'Widget widget clicks: 0')
  assert.match(success(await tool('browser_get_text', { frame: automatic.frame, selector: '#status' }, automaticSession)), /clicks: 0/)
  console.log(`Iframe access smoke passed on Chrome ${browser.browserVersion}. Conversation and loopback tools, toolbar-authorized and automatically opened pages, same-site and out-of-process iframe access, denied sibling, sandboxed and nested frame isolation, private URL metadata, navigation with stale references, and duplicate action receipts. No model called.`)
} finally {
  await browser?.close().catch(() => {})
  await host?.close().catch(() => {})
  site.closeAllConnections()
  await close(site)
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
