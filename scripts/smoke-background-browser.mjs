// An isolated paired Chrome and Host, with a deterministic model and local pages.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'

const repo = resolve(import.meta.dirname, '..')
const root = await mkdtemp(join(tmpdir(), 'stride-background-browser-'))
const site = createServer((request, response) => {
  const headings = { '/health': 'Existing page', '/ordinary': 'Ordinary chat fixture', '/task': 'Managed task fixture', '/disabled': 'Automation disabled' }
  if (request.method !== 'GET' || !Object.hasOwn(headings, request.url)) return response.writeHead(404).end()
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<h1>${headings[request.url]}</h1><p>Only this synthetic page is in scope.</p>`)
})
let harness
async function waitFor(check, label) {
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`Background browser check timed out: ${label}`)
}

try {
  await new Promise(done => site.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${site.address().port}`
  const ordinary = origin + '/ordinary', managed = origin + '/task'
  harness = await startIsolatedModelRun({
    repo, origin, startUrl: origin + '/health', artifacts: root, goal: 'Synthetic browser startup', promptViaRpc: true,
    programs: {
      ordinary: `console.log((await tools.browser_open_tab({url:${JSON.stringify(ordinary)}})).text)`,
      managed: 'console.log((await tools.browser_snapshot({})).text)',
    },
    guardSource: `ctx.effect(() => ctx.tools.guard(exec => {
      if (['run_code', 'browser_snapshot'].includes(exec.name)) return;
      if (exec.name === 'browser_open_tab' && exec.arguments?.url === ${JSON.stringify(ordinary)}) return;
      return 'Only read or open the local acceptance fixture';
    }));`,
  })
  const { browser, host, sessionId } = harness
  async function command(line, agentId = sessionId) {
    const response = await fetch(host.baseUrl + '/api/commands/execute', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: host.client.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'commands/execute',
        payload: { args: { agentId, line, submittedAttachments: [] } } }),
      signal: AbortSignal.timeout(45_000),
    })
    assert.ok(response.ok)
    const result = (await response.json()).result?.value?.result
    assert.equal(result?.kind, 'success')
    return result.text
  }

  // The explicit URL command leaves a queued task while page automation is disabled.
  const disabled = (await host.client.rpc('session.create', { cwd: root })).sessionId
  const previousPages = browser.context.pages().length
  assert.match(await command(`/browser ${origin}/disabled Report the fixture status`, disabled), /等待启动/)
  assert.equal(browser.context.pages().length, previousPages)
  assert.equal(browser.context.pages().some(page => page.url() === origin + '/disabled'), false)

  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  await browser.panel.locator('.settings-panel input').first().fill(host.baseUrl.replace(/^http:/, 'ws:') + '/ext/bridge')
  assert.equal(await browser.panel.getByRole('checkbox', { name: '后台连接 DSH', exact: false }).isChecked(), true)
  assert.equal(await browser.worker.evaluate(async () => (await chrome.storage.local.get('dshSettings')).dshSettings?.backgroundConnection), true)
  await browser.panel.getByRole('checkbox', { name: '自动控制 DSH 新建页面', exact: false }).check()
  await browser.panel.getByRole('button', { name: '保存并连接', exact: true }).click()
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible' })
  await browser.panel.close()
  const restarted = await browser.restart({ openPanel: false })
  const noPanel = () => !restarted.context.pages().some(page => page.url().startsWith('chrome-extension:'))
  assert.equal(noPanel(), true)
  await waitFor(async () => {
    const response = await fetch(host.baseUrl + '/api/stride-browser-pairing', { headers: { cookie: host.client.cookie } })
    return response.ok && !!(await response.json()).connection
  }, 'authenticated connection after Chrome restart')
  assert.equal(await restarted.worker.evaluate(async () => !!await chrome.alarms.get('bridge-keepalive')), true)
  const existing = restarted.target
  assert.equal(existing.url(), origin + '/health')
  assert.equal(await restarted.worker.evaluate(async () => (await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants?.length ?? 0), 0)

  const opened = await harness.turn('ordinary', `Open ${ordinary}`)
  assert.ok(opened.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'browser_open_tab' && !event.data.isError))
  assert.equal(restarted.context.pages().filter(page => page.url() === ordinary).length, 1)

  const events = []
  await host.client.followSession(sessionId)
  const unsubscribe = host.client.onFrame(frame => {
    if (frame.type === 'session/event' && frame.sessionId === sessionId) events.push(frame.event?.event ?? frame.event)
  })
  try {
    const launched = await command(`/browser ${managed} FIXTURE_CASE=managed`)
    assert.match(launched, /已打开受控页面并启动网页任务/)
    await waitFor(() => events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'browser_snapshot'
      && !event.data.isError && event.data.content?.some(block => block.type === 'text' && block.text.includes('Managed task fixture'))), 'managed task reads its own page')
  } finally { unsubscribe() }

  assert.equal(noPanel(), true)
  assert.equal(restarted.context.pages().filter(page => page.url() === managed).length, 1)
  assert.equal(existing.url(), origin + '/health')
  const managedScope = await restarted.worker.evaluate(async ({ url, sessionId }) => {
    const tabs = await chrome.tabs.query({ url })
    const tab = tabs[0]
    const state = await chrome.storage.session.get(['dshPageAccess', 'dshTabAffinity'])
    const grant = state.dshPageAccess?.grants?.find(grant => grant.tabId === tab?.id)
    const group = tab?.groupId >= 0 ? await chrome.tabGroups.get(tab.groupId) : undefined
    return { authorized: grant?.mode === 'debugger' && grant.groupId === tab.groupId,
      blueGroup: group?.color === 'blue', bound: state.dshTabAffinity?.sessionTabs?.[sessionId]?.tabId === tab?.id }
  }, { url: managed, sessionId })
  assert.deepEqual(managedScope, { authorized: true, blueGroup: true, bound: true })
  console.log(JSON.stringify({ passed: true, isolatedChrome: true, realHost: true, defaultBackgroundConnection: true, noPanelAfterRestart: true,
    ordinaryChatOpenedPage: true, slashCommandStartedAndRead: true, disabledAutomationLeftQueued: true }))
} finally {
  try { await harness?.close() } finally {
    await new Promise(done => site.close(done))
    await rm(root, { recursive: true, force: true })
  }
}
