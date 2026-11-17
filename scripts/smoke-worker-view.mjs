// Stop the actual isolated worker while retaining the existing panel document.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, cp, copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'

assert.equal(process.env.STRIDE_REAL_MODEL, '1', 'This check uses the existing default DSH model')
const repo = resolve(process.env.STRIDE_ACCEPTANCE_REPO ?? resolve(import.meta.dirname, '..'))
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
const base = join(repo, '.stride-private/validation/worker-view', version)
await mkdir(base, { recursive: true }); const artifacts = await mkdtemp(join(base, 'real-model-'))
let h, writes = 0, phase = 'setup', events = [], stopListening
const site = createServer((req, res) => {
  if (req.method !== 'GET') { writes++; res.writeHead(405).end(); return }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Worker view fixture</title><h1>Synthetic worker restart</h1>')
})
const marker = 'VIEW_' + randomUUID().replaceAll('-', '')
try {
  await new Promise(done => site.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${site.address().port}`, extensionDir = join(artifacts, 'extension-with-traffic-observer')
  await cp(join(repo, 'extensions/dsh-browser/dist'), extensionDir, { recursive: true })
  await copyFile(new URL('./fixtures/panel-traffic.js', import.meta.url), join(extensionDir, 'panel-traffic.js'))
  const panelPath = join(extensionDir, 'panel/index.html'), html = await readFile(panelPath, 'utf8')
  assert.ok(html.includes('<head>')); await writeFile(panelPath, html.replace('<head>', '<head><script src="../panel-traffic.js"></script>'))
  h = await startIsolatedModelRun({ repo, origin, startUrl: origin + '/controlled', artifacts, extensionDir,
    goal: 'Retain the displayed conversation through native worker startup', programs: {},
    guardSource: "ctx.effect(()=>ctx.tools.guard(()=> 'This fixture permits pure chat only; no tools'));" })
  const panel = h.browser.panel, sid = h.sessionId
  await panel.waitForFunction(expected => document.querySelector('.app')?.getAttribute('data-session-id') === expected, sid)
  await h.host.client.followSession(sid)
  stopListening = h.host.client.onFrame(frame => {
    if (frame.type === 'session/event' && frame.sessionId === sid) events.push(frame.event?.event ?? frame.event)
  })
  async function chat(text) {
    const input = panel.locator('.composer textarea')
    await input.fill('仅聊天，不调用工具，只回复 ' + text)
    await input.press('Enter')
    await panel.locator('.row.assistant').filter({ hasText: text }).waitFor({ timeout: 120000 })
    await panel.locator('.stop-button').waitFor({ state: 'hidden' })
  }
  phase = 'seed-chat'; await chat(marker)
  const before = await panel.evaluate(() => window.__stridePanelTraffic())
  const human = await h.browser.context.newPage(); await human.goto(origin + '/uncontrolled')
  phase = 'worker-stop-with-live-panel'
  const restarted = await h.browser.restartWorker({ preservePanel: true })
  assert.equal(restarted.panelPreserved, true)
  await panel.locator('.connection .dot.connected').waitFor({ timeout: 30000 })
  await panel.waitForTimeout(1000)
  phase = 'retained-view'
  const sameConversation = await panel.locator('.app').getAttribute('data-session-id') === sid
  if (sameConversation) await panel.waitForFunction(value => window.__stridePanelTraffic().historySucceeded > value, before.historySucceeded, { timeout: 15000 })
  const after = await panel.evaluate(() => window.__stridePanelTraffic())
  await writeFile(join(artifacts, 'restart-observation.json'), JSON.stringify({ sameConversation, before, after }, null, 2), { mode: 0o600 })
  assert.equal(sameConversation, true, 'Worker bootstrap must retain the displayed conversation')
  assert.equal(after.creates, before.creates, 'No replacement conversation may be created')
  for (const key of ['prompts', 'selections', 'approvals', 'taskControls']) assert.equal(after[key], before[key], 'Reconnect must not replay ' + key)
  assert.ok(after.restoredViews > before.restoredViews)
  await panel.locator('.row.assistant').filter({ hasText: marker }).waitFor()
  phase = 'continued-chat'; await chat(marker + '_AFTER')
  assert.equal(await panel.locator('.app').getAttribute('data-session-id'), sid)
  assert.equal((await panel.evaluate(() => window.__stridePanelTraffic())).prompts, before.prompts + 1)
  const toolCalls = events.filter(event => event.type === 'tool/call' || event.type === 'tool/ptc-dispatch')
  assert.equal(events.filter(event => event.type === 'turn/start').length, 2, 'Both explicit messages must reach the original session')
  assert.equal(events.filter(event => event.type === 'turn/end').length, 2)
  assert.equal(toolCalls.length, 0); assert.equal(writes, 0)
  await panel.screenshot({ path: join(artifacts, 'panel.png') })
  const result = { passed: true, version, realModel: true, isolatedChrome: true, nativeWorkerStop: true,
    samePanelDocument: true, sameConversation: true, historyRestored: true, continuedChat: true, automaticNewConversations: 0,
    replayedPrompts: 0, replayedSelections: 0, replayedApprovals: 0, replayedTasks: 0, modelToolCalls: 0, businessWrites: 0,
    extensionObserverCopy: true, originalHostUntouched: true, browserVersion: h.browser.browserVersion,
    hostBundleSha256: createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex'),
    evidenceDirectory: artifacts.slice(base.length + 1) }
  await writeFile(join(artifacts, 'events.json'), JSON.stringify(events), { mode: 0o600 })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  await writeFile(join(base, 'real-model.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result))
} catch (error) {
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ passed: false, phase, errorName: error.name }, null, 2), { mode: 0o600 }); throw error
} finally { stopListening?.(); await h?.close(); await new Promise(done => site.close(done)) }
