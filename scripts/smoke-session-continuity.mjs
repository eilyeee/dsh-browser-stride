// Real Host + isolated Chrome. The default is a deterministic local adapter;
// STRIDE_REAL_MODEL=1 opts into the user's existing default model on synthetic data.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { within } from '../benchmark/lib/extension-connection.mjs'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { startTaskSite } from './fixtures/task-site.mjs'

const repoRoot = resolve(import.meta.dirname, '..'), realModel = process.env.STRIDE_REAL_MODEL === '1'
const setupOnly = process.argv.includes('--setup-only')
const version = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version
const require = createRequire(join(repoRoot, 'package.json')), bridgeRequire = createRequire(join(repoRoot, 'packages/browser/bridge-browser/package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'stride-continuity-')), home = join(root, 'home'), fixture = join(root, 'fixture.mjs')
const artifacts = join(repoRoot, '.stride-private/validation/session-continuity', version)
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
let host, browser, site, sessionId, config, phase = 'setup'
const startedAt = performance.now()
function advance(value) { phase = value; console.log(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - startedAt) })) }
async function wait(check, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await delay(100) }
  throw new Error('Timed out: ' + label)
}
async function affinity() { return browser.worker.evaluate(async () => (await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity) }
async function rawRpc(method, payload) {
  const answer = await browser.panel.evaluate(({ method, payload }) => new Promise((resolveReply, rejectReply) => {
    const port = window.__strideContinuityPort ??= chrome.runtime.connect({ name: 'dsh-panel' }), id = crypto.randomUUID()
    const timer = setTimeout(() => { port.onMessage.removeListener(receive); rejectReply(new Error('Continuity RPC timed out')) }, 10000)
    function receive(message) {
      if (message.type !== 'rpc.result' || message.id !== id) return
      clearTimeout(timer); port.onMessage.removeListener(receive); resolveReply(message)
    }
    port.onMessage.addListener(receive); port.postMessage({ type: 'rpc', id, method, payload })
  }), { method, payload })
  return answer
}
async function rpc(method, payload) {
  const answer = await rawRpc(method, payload)
  assert.equal(answer.ok, true); assert.equal(answer.result.result.ok, true)
  return answer.result.result.value
}
async function send(text, expected) {
  await browser.panel.bringToFront()
  const input = browser.panel.locator('.composer textarea')
  await wait(() => input.isEnabled(), 'composer ready')
  await host.client.followSession(sessionId)
  let started = false, finish
  const terminal = new Promise(resolve => { finish = resolve })
  const off = host.client.onFrame(frame => {
    if (frame.type !== 'session/event' || frame.sessionId !== sessionId) return
    const event = frame.event?.event ?? frame.event
    if (event.type === 'turn/start') started = true
    if (started && event.type === 'turn/end') finish(event.data.reason.kind)
  })
  const failed = terminal.then(kind => {
    if (kind !== 'completed') throw new Error(`Synthetic conversation ended with ${kind}`)
    return new Promise(() => {})
  })
  void failed.catch(() => {}) // A very early failure can precede native input acknowledgement.
  try {
    await input.fill(text); await input.press('Enter')
    await Promise.race([failed, browser.panel.locator('.row.assistant').filter({ hasText: expected })
      .waitFor({ state: 'visible', timeout: realModel ? 180000 : 20000 })])
    assert.equal(await within(terminal, 15000, 'synthetic turn completion'), 'completed')
    await wait(async () => await browser.panel.locator('.stop-button').count() === 0, 'turn settled')
  } finally { off() }
}
async function failureMetadata() {
  if (sessionId === undefined || host === undefined) return undefined
  try {
    const history = await host.client.rpc('session.history', { sessionId }, { timeoutMs: 5000 })
    const events = history.events.map(entry => entry.event ?? entry)
    const starts = events.map((event, index) => event.type === 'turn/start' ? index : -1).filter(index => index >= 0)
    const ends = events.map((event, index) => event.type === 'turn/end' ? index : -1).filter(index => index >= 0)
    const counts = type => events.filter(event => event.type === type).length
    const errors = ends.filter(index => events[index].data.reason.kind === 'error')
      .map(index => JSON.stringify(events[index].data.reason.error)).join('\n')
    return { turnsStarted: starts.length, turnsEnded: ends.length, modelRequests: counts('request/header'),
      assistantMessages: counts('assistant/message'), pendingTurn: (starts.at(-1) ?? -1) > (ends.at(-1) ?? -1),
      authenticationFailure: /unauthorized|authentication|credential|\b401\b/i.test(errors),
      capacityFailure: /rate.?limit|overload|\b429\b|\b503\b/i.test(errors),
      networkFailure: /network|timeout|fetch failed|ECONN/i.test(errors),
      terminalKinds: ends.map(index => events[index].data.reason.kind).filter(kind => ['completed', 'error', 'aborted'].includes(kind)),
      lastEventTypes: events.slice(-12).map(event => /^[a-z][a-z/-]{0,63}$/.test(event.type) ? event.type : 'other') }
  } catch { return { historyUnavailable: true } }
}
async function chat(marker) {
  await send(`只回复 ${marker}。本轮仅聊天，不读取或操作网页、不修改文件，也不更新任务资料。`, marker)
  const history = await host.client.rpc('session.history', { sessionId })
  assert.ok(history.events.some(entry => {
    const event = entry.event ?? entry
    return event.type === 'user/message' && event.data?.source?.kind === 'user'
      && event.data.content?.some(block => block.type === 'text' && block.text.includes(marker))
  }), 'The message must belong to the original conversation')
}
async function restoreHistory() {
  await browser.panel.bringToFront()
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: 30000 })
  const entry = (await rpc('session.list', {})).items.find(item => item.sessionId === sessionId)
  assert.ok(entry, 'Original session is still listed')
  await browser.panel.locator('.session-menu-trigger').click()
  await browser.panel.locator(`.session-list button[data-session-id="${sessionId}"]`).click()
  await wait(async () => (await affinity())?.focusedSessionId === sessionId, 'history restored')
}
async function main() {
try {
  await mkdir(home); await mkdir(artifacts, { recursive: true })
  const adapter = realModel ? '' : `import {LlmAdapter} from ${JSON.stringify(pathToFileURL(bridgeRequire.resolve('@deepseek-ai/dsh-llm')).href)};
class Echo extends LlmAdapter {
 async listModels(provider){return [{provider,id:'echo',name:'Synthetic echo',contextWindow:128000}];}
 async *stream(options){options.signal?.throwIfAborted();const text=[...options.messages].reverse().flatMap(message=>message.content.filter(block=>block.type==='text').map(block=>block.text)).map(text=>text.match(/STRIDE_[A-Z_]+/)?.[0]).find(Boolean)||'Synthetic chat reply';
 yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};
 yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};}
}
`
  await writeFile(fixture, adapter + `export const inject=${JSON.stringify(realModel ? ['tools'] : ['llm', 'tools'])};
export function apply(ctx){
 ${realModel ? '' : "ctx.effect(()=>ctx.llm.registerAdapter(['stride-chat-fixture'],new Echo()));"}
 let requests=0,calls=0;
 ctx.on('agent/request',(_payload,next)=>{if(++requests>24)throw Error('synthetic-session-model-budget');return next();});
 const allowed=new Set(['run_code','browser_task_notes','browser_list_tabs','browser_follow_tab','browser_snapshot','browser_get_text']);
 ctx.effect(()=>ctx.tools.guard(exec=>++calls>40?'Synthetic tool budget exhausted':allowed.has(exec.name)?undefined:'This acceptance permits only synthetic read-only browser work and task notes.'));
}
`, { mode: 0o600 })
  const install = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', '@eilyeee/dsh-browser-stride@link:' + join(repoRoot, 'packages/browser/bridge-browser')], { cwd: repoRoot, env, stdio: 'ignore' })
  const timer = setTimeout(() => install.kill('SIGKILL'), 120000)
  try { assert.equal((await once(install, 'exit'))[0], 0) } finally { clearTimeout(timer) }
  if (realModel && process.env.STRIDE_MODEL_CREDENTIALS) { await copyFile(process.env.STRIDE_MODEL_CREDENTIALS, join(home, '.credentials.yaml')); await chmod(join(home, '.credentials.yaml'), 0o600) }
  const modelPatch = realModel && process.env.STRIDE_MODEL_PATCH ? await readFile(process.env.STRIDE_MODEL_PATCH, 'utf8') : ''
  process.env.DSH_HOME = home
  for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete process.env[key]
  site = await startTaskSite()
  const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port; await new Promise(done => listener.close(done))
  config = { backend: 'extension', port, repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), runtimeRoot: join(root, 'runtime'), startUrl: site.url, deferSessionCreate: true,
    extraPatch: modelPatch + '\n- insert:\n    - id: session-continuity-fixture\n      name: ' + JSON.stringify(pathToFileURL(fixture).href) + '\n' }
  host = await startDshBackend(config)
  browser = await startExtensionBrowser({ repoRoot, benchmarkRoot: config.benchmarkRoot, bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`,
    issuePairingCode: () => host.issuePairingCode(), trustedOrigin: site.origin, onPhase: stage => advance(`setup/${stage}`) })
  if (setupOnly) {
    assert.ok(Array.isArray((await rpc('session.list', {})).items))
    assert.equal((await host.listInstallations()).length, 1)
    const summary = { passed: true, version, browserVersion: browser.browserVersion, setupOnly: true, realHost: true, isolatedChrome: true,
      freshPairingAfterPanelReady: true, expectedHostAuthenticated: true, modelRequests: 0, originalHostUntouched: true }
    await writeFile(join(artifacts, realModel ? 'real-model-setup.json' : 'setup.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(summary)); return
  }
  advance('new-chat-without-page')
  await browser.panel.bringToFront()
  await wait(async () => typeof (await affinity())?.focusedSessionId === 'string', 'initial session')
  sessionId = (await affinity()).focusedSessionId
  assert.equal((await affinity()).controlledTabId, undefined)
  if (!realModel) await rpc('session.selectModel', { sessionId, provider: 'stride-chat-fixture', model: 'echo' })
  assert.equal((await rpc('session.list', {})).items.some(item => item.sessionId === sessionId), false, 'An unused provisional Session leaves no history')
  advance('save-notes-before-first-prompt')
  await browser.panel.locator('.task-brief-panel > summary').click()
  const goal = browser.panel.getByRole('textbox', { name: '本轮目标', exact: true })
  await goal.fill('Synthetic notes saved before the first prompt')
  await browser.panel.getByRole('button', { name: '保存资料', exact: true }).click()
  await wait(async () => (await rpc('bridge.taskBrief.get', { sessionId })).version === 1, 'unprompted notes saved')
  const savedOnly = (await rpc('session.list', {})).items.find(item => item.sessionId === sessionId)
  assert.equal(savedOnly.blank, false); assert.equal(savedOnly.notesOnly, true)
  const unprompted = await rpc('session.history', { sessionId })
  assert.equal(unprompted.events.some(entry => ['turn/start', 'request/header', 'assistant/message'].includes((entry.event ?? entry).type)), false)
  advance('unsaved-draft-across-host-restart')
  await goal.fill('Synthetic retained unsaved draft')
  await host.close(); host = await startDshBackend(config)
  await restoreHistory()
  const draftPanel = browser.panel.locator('.task-brief-panel')
  if (!await draftPanel.evaluate(element => element.open)) await draftPanel.locator(':scope > summary').click()
  await goal.waitFor({ state: 'visible' })
  assert.equal(await goal.inputValue(), 'Synthetic retained unsaved draft')
  assert.equal((await rpc('bridge.taskBrief.get', { sessionId })).goal, 'Synthetic notes saved before the first prompt')
  await browser.panel.getByRole('button', { name: '重新载入（放弃未保存修改）', exact: true }).click()
  await wait(async () => await goal.inputValue() === 'Synthetic notes saved before the first prompt', 'explicit draft discard')
  advance('new-chat-without-page')
  await chat('STRIDE_NEW_CHAT_OK')
  advance('chat-after-tab-close')
  await browser.bindSession(sessionId); await browser.target.close()
  await wait(async () => (await affinity())?.controlledTabId === undefined, 'closed binding removed')
  await chat('STRIDE_CLOSED_TAB_OK')
  advance('history-chat-without-page')
  await browser.panel.reload(); await restoreHistory(); await chat('STRIDE_HISTORY_OK')
  advance('notes-and-evidence')
  const materialPage = await browser.context.newPage(); await materialPage.goto(site.url)
  await browser.panel.evaluate(() => { window.__dshBenchmarkPort ??= chrome.runtime.connect({ name: 'dsh-panel' }) })
  await browser.bindSession(sessionId, materialPage)
  const input = { goal: 'Read the synthetic page title and report the observed evidence without edits', projectPath: root,
    materials: [{ url: site.url, label: 'Synthetic task material', role: 'unknown' }], criteria: [{ id: 'title', text: 'Read the synthetic page title' }] }
  const saved = await rpc('bridge.taskBrief.save', { sessionId, version: (await rpc('bridge.taskBrief.get', { sessionId })).version, input: { ...input, materials: [] } })
  assert.equal(saved.userEdited, true)
  await browser.panel.bringToFront()
  const notesDisclosure = browser.panel.locator('.task-brief-panel')
  if (!await notesDisclosure.evaluate(element => element.open)) await notesDisclosure.locator(':scope > summary').click()
  await wait(async () => await notesDisclosure.getByRole('textbox', { name: '本轮目标', exact: true }).inputValue() === input.goal, 'saved notes displayed')
  const picker = browser.panel.locator('.task-material-picker')
  await picker.locator('summary').click()
  await picker.getByRole('button', { name: '添加页面: 本地设置测试', exact: true }).click()
  assert.equal((await rpc('bridge.taskBrief.get', { sessionId })).materials.length, 0, 'Importing metadata does not auto-save')
  assert.equal(await notesDisclosure.locator('.task-material select').inputValue(), 'unknown')
  await notesDisclosure.getByRole('button', { name: '保存资料', exact: true }).click()
  await wait(async () => (await rpc('bridge.taskBrief.get', { sessionId })).materials[0]?.url === site.url, 'material imported through UI')
  const otherPage = await browser.context.newPage(); await otherPage.goto(site.url + '?other=1')
  await otherPage.evaluate(() => { document.title = 'Other synthetic reference' })
  await browser.bindSession(sessionId, otherPage)
  const materialTabId = await browser.worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, site.url)
  await materialPage.evaluate(() => { window.__strideMaterialReuseProof = 'same-document' })
  const beforeReuse = await browser.worker.evaluate(async () => ({ tabs: (await chrome.tabs.query({})).length,
    grants: (await chrome.storage.session.get('dshPageAccess')).dshPageAccess.grants.map(grant => ({ tabId: grant.tabId, nonce: grant.nonce })) }))
  await browser.panel.bringToFront()
  await notesDisclosure.getByRole('button', { name: '使用已有页面', exact: true }).click()
  await wait(async () => (await affinity()).controlledTabId === materialTabId, 'native material selection')
  assert.equal(await materialPage.evaluate(() => window.__strideMaterialReuseProof), 'same-document', 'Selecting a material does not reload it')
  const afterReuse = await browser.worker.evaluate(async () => ({ tabs: (await chrome.tabs.query({})).length,
    grants: (await chrome.storage.session.get('dshPageAccess')).dshPageAccess.grants.map(grant => ({ tabId: grant.tabId, nonce: grant.nonce })) }))
  assert.deepEqual(afterReuse, beforeReuse, 'Selecting materials creates no tab and grants no new access')
  await otherPage.close()
  let reportVerified = false
  if (realModel) {
    await send('继续本轮需求。先读取 browser_task_notes，观察已授权的合成页面标题，再用 browser_task_notes 的 report 记录 title 条件，提供实际读回依据。不要修改页面、文件或已保存资料；报告不等于用户核验。完成后回复 STRIDE_REPORT_OK。', 'STRIDE_REPORT_OK')
    const reported = await rpc('bridge.taskBrief.get', { sessionId })
    assert.equal(reported.progress[0]?.criterionId, 'title'); assert.equal(reported.progress[0]?.observation, 'observed')
    assert.equal(reported.progress[0]?.userConfirmed, false)
    assert.ok(reported.progress[0]?.evidence.some(value => value.includes('本地设置测试')))
    await browser.panel.bringToFront()
    if (!await notesDisclosure.evaluate(element => element.open)) await notesDisclosure.locator(':scope > summary').click()
    await browser.panel.getByRole('button', { name: '确认核验通过', exact: true }).waitFor({ state: 'visible' })
    const downloadReady = browser.panel.waitForEvent('download')
    await browser.panel.getByRole('button', { name: '下载验收记录', exact: true }).click()
    const download = await downloadReady
    await download.saveAs(join(root, 'acceptance.md'))
    assert.match(await readFile(join(root, 'acceptance.md'), 'utf8'), /模型已观察到/)
    await browser.panel.getByRole('button', { name: '确认核验通过', exact: true }).click()
    await wait(async () => (await rpc('bridge.taskBrief.get', { sessionId })).progress[0]?.userConfirmed === true, 'native user review')
    await browser.panel.screenshot({ path: join(artifacts, 'task-notes.png'), fullPage: true })
    reportVerified = true
  }
  advance('worker-restart')
  Object.assign(browser, await browser.restartWorker())
  await restoreHistory(); await chat('STRIDE_WORKER_RESTART_OK')
  assert.equal((await rpc('bridge.taskBrief.get', { sessionId })).goal, input.goal)
  advance('host-restart')
  await host.close(); host = await startDshBackend(config)
  await restoreHistory(); await chat('STRIDE_HOST_RESTART_OK')
  const reopened = await rpc('bridge.taskBrief.get', { sessionId })
  assert.equal(reopened.goal, input.goal)
  if (realModel) assert.equal(reopened.progress[0]?.userConfirmed, true)
  assert.ok(await host.client.rpc('session.history', { sessionId }))
  advance('explicit-project-conversation')
  const disclosure = browser.panel.locator('.task-brief-panel')
  if (!await disclosure.evaluate(element => element.open)) await disclosure.locator(':scope > summary').click()
  await browser.panel.getByRole('button', { name: '从此项目新建对话', exact: true }).click()
  await wait(async () => { const focused = (await affinity())?.focusedSessionId; return typeof focused === 'string' && focused !== sessionId }, 'new project conversation')
  const projectSession = (await affinity()).focusedSessionId
  await wait(async () => (await rpc('bridge.taskBrief.get', { sessionId: projectSession })).goal === input.goal, 'copied project materials')
  const projectHistory = await rpc('session.history', { sessionId: projectSession })
  assert.equal(projectHistory.events.some(entry => (entry.event ?? entry).type === 'turn/start'), false)
  assert.equal((await rpc('session.list', {})).items.find(item => item.sessionId === projectSession)?.cwd, root)
  assert.equal((await rpc('bridge.taskBrief.get', { sessionId: projectSession })).progress.length, 0)
  await browser.panel.setViewportSize({ width: 400, height: 800 })
  assert.equal(await browser.panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const composer = await browser.panel.locator('.composer').boundingBox()
  assert.ok(composer && composer.y >= 0 && composer.y + composer.height <= 800, 'The composer stays visible in a narrow panel')
  await browser.panel.screenshot({ path: join(artifacts, realModel ? 'narrow-real-model.png' : 'narrow.png') })
  await browser.panel.getByRole('button', { name: '打开设置', exact: true }).click()
  assert.ok((await browser.panel.locator('.version-status').innerText()).includes(`Host ${version}`))
  await browser.panel.getByRole('button', { name: '返回对话', exact: true }).click()
  await restoreHistory()
  advance('notes-storage-write-failure')
  const notesFile = join(root, 'runtime/extension/storages/browser_briefs_776562.json')
  const notesBackup = notesFile + '.audit-backup'
  const lastNotes = await rpc('bridge.taskBrief.get', { sessionId })
  const validNotes = await readFile(notesFile)
  await rename(notesFile, notesBackup); await mkdir(notesFile)
  let rejected
  try {
    rejected = await rawRpc('bridge.taskBrief.save', { sessionId, version: lastNotes.version,
      input: { goal: 'Synthetic rejected note write', projectPath: lastNotes.projectPath, materials: lastNotes.materials, criteria: lastNotes.criteria } })
  } finally { await rm(notesFile, { recursive: true, force: true }); await rename(notesBackup, notesFile) }
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'storage-unavailable')
  await chat('STRIDE_NOTES_FAULT_CHAT_OK')
  advance('notes-storage-startup-failure')
  await host.close()
  await writeFile(notesFile, '{ synthetic invalid note-storage JSON', { mode: 0o600 })
  host = await startDshBackend(config)
  await restoreHistory()
  const failureNotice = browser.panel.locator('.task-brief-panel')
  if (!await failureNotice.evaluate(element => element.open)) await failureNotice.locator(':scope > summary').click()
  await failureNotice.getByText('任务资料暂不可用，聊天可以继续。', { exact: false }).waitFor({ state: 'visible' })
  const deletion = await rawRpc('bridge.session.purge', { sessionId })
  assert.equal(deletion.ok, false); assert.equal(deletion.error.code, 'storage-unavailable')
  assert.ok(await host.client.rpc('session.history', { sessionId }))
  await chat('STRIDE_NOTES_STARTUP_FAULT_OK')
  advance('notes-storage-repaired')
  await host.close(); await writeFile(notesFile, validNotes, { mode: 0o600 }); host = await startDshBackend(config)
  await restoreHistory()
  assert.equal((await rpc('bridge.taskBrief.get', { sessionId })).goal, input.goal)
  await chat('STRIDE_NOTES_REPAIRED_OK')
  assert.deepEqual(site.state(), { enabled: false, saved: false })
  const summary = { passed: true, version, browserVersion: browser.browserVersion, realHost: true, isolatedChrome: true, realModel, syntheticOnly: true, defaultSessionDeferral: true,
    savedBeforeFirstPrompt: true, unpromptedSessionVisibleAfterRestart: true, noModelStartedBySaving: true, unsavedDraftSurvivesRestart: true,
    notesWriteFailureDoesNotBlockChat: true, notesStartupFailureDoesNotBlockBridge: true, unavailableNotesPreventPartialDeletion: true, repairedNotesReadable: true,
    chatWithoutPage: true, chatAfterTabClose: true, historicalChat: true, workerRestart: true, hostRestart: true,
    notesSurviveHostRestart: true, modelReportAndNativeReview: reportVerified, acceptanceExport: reportVerified,
    explicitProjectConversation: true, installedVersionsShown: true, narrowPanel: true, groupPageImportedAsUnknownDraft: true,
    nativeMaterialSelectionWithoutNewTabOrGrantOrReload: true, syntheticPageUnchanged: true, userHostUntouched: true }
  await writeFile(join(artifacts, realModel ? 'real-model.json' : 'result.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(summary))
} catch (error) {
  await writeFile(join(artifacts, setupOnly ? 'setup-failure.json' : realModel ? 'real-model-failure.json' : 'failure.json'), JSON.stringify({
    phase, body: await browser?.panel.locator('body').innerText().catch(() => undefined),
    affinity: await affinity().catch(() => undefined), sessionId, hostMetadata: await failureMetadata(),
  }, null, 2), { mode: 0o600 })
  await writeFile(join(artifacts, setupOnly ? 'setup-result.json' : realModel ? 'real-model.json' : 'result.json'), JSON.stringify({ passed: false, phase, errorName: error.name }, null, 2) + '\n', { mode: 0o600 })
  console.error(JSON.stringify({ phase, error: error.message })); process.exitCode = 1
} finally {
  if (sessionId) await host?.client.rpc('session.cancel', { sessionId }).catch(() => {})
  await browser?.close().catch(() => {}); await host?.close().catch(() => {}); await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
}
await main()
