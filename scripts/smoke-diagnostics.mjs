// Isolated Host + native Chrome extension + local synthetic diagnostic events.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, cp, readdir } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { within } from '../benchmark/lib/extension-connection.mjs'

const repo = resolve(import.meta.dirname, '..'), require = createRequire(join(repo, 'package.json'))
const bridgeRequire = createRequire(join(repo, 'packages/browser/bridge-browser/package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'stride-diagnostics-')), home = join(root, 'home')
const realModel = process.env.STRIDE_REAL_MODEL === '1'
const statusRace = process.env.STRIDE_DIAGNOSTIC_STATUS_RACE === '1' || process.argv.includes('--status-race')
const unresponsiveStartRead = process.argv.includes('--start-expiry-read')
const startExpiry = unresponsiveStartRead || process.argv.includes('--start-expiry')
if (statusRace && startExpiry) throw Error('Run status ordering and native start expiry separately')
const traceNative = process.argv.includes('--trace-native') || startExpiry
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
const base = join(repo, '.stride-private/validation/diagnostics', version), label = realModel ? 'real-model' : 'scripted'
await mkdir(base, { recursive: true }); const artifacts = await mkdtemp(join(base, label + '-'))
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
let host, browser, sessionId, cancelTimer, phase = 'setup', events = [], gets = 0, writes = 0
async function extensionDigest(directory) {
  const files = []
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Extension inputs must not contain symlinks')
    if (entry.isFile()) files.push(relative(directory, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
  }
  const hash = createHash('sha256')
  for (const file of files.sort()) hash.update(file + '\0' + createHash('sha256').update(await readFile(join(directory, file))).digest('hex') + '\n')
  return hash.digest('hex')
}
const sourceExtensionDigest = await extensionDigest(join(repo, 'extensions/dsh-browser/dist'))
const sourceHostDigest = createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex')
const site = createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { writes++; res.writeHead(405).end(); return }
  if (req.url.startsWith('/api/customer/')) { gets++; res.writeHead(500, { 'Content-Type': 'application/json', 'Set-Cookie': 'synthetic-cookie=PRIVATE-COOKIE' }).end('{"private":"PRIVATE-BODY"}'); return }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>Diagnostic fixture</title><h1>Local diagnostics</h1><button id="reproduce">Reproduce diagnostic error</button><output id="state">READY</output><script>document.querySelector('button').onclick=async()=>{console.error(new TypeError('PRIVATE-CONSOLE'));await fetch('/api/customer/PRIVATE-PATH?token=PRIVATE-QUERY',{headers:{'X-Synthetic':'PRIVATE-HEADER'}});document.querySelector('output').value='DONE'}</script>`)
})
async function rpc(method, payload) {
  return browser.panel.evaluate(({ method, payload }) => new Promise((done, fail) => {
    const port = window.__diagnosticsPort ??= chrome.runtime.connect({ name: 'dsh-panel' }), id = crypto.randomUUID()
    const timer = setTimeout(() => { port.onMessage.removeListener(receive); fail(Error('Fixture RPC timeout')) }, 10000)
    function receive(message) { if (message.type !== 'rpc.result' || message.id !== id) return; clearTimeout(timer); port.onMessage.removeListener(receive); if (!message.ok || !message.result?.result?.ok) fail(Error('Fixture RPC rejected')); else done(message.result.result.value) }
    port.onMessage.addListener(receive); port.postMessage({ type: 'rpc', id, method, payload })
  }), { method, payload })
}
async function waitWorker(predicate, label) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await browser.worker.evaluate(predicate)) return
    await delay(50)
  }
  throw Error(label)
}
async function toolTurn(prompt) {
  events = []; await host.client.followSession(sessionId)
  let started = false, finish; const done = new Promise(resolve => { finish = resolve })
  const off = host.client.onFrame(frame => {
    if (frame.type !== 'session/event' || frame.sessionId !== sessionId) return
    const event = frame.event?.event ?? frame.event; if (event.type === 'turn/start') started = true; if (!started) return
    events.push(event); if (event.type === 'turn/end') finish(event.data.reason.kind)
  })
  cancelTimer = setTimeout(() => { void host.client.rpc('session.cancel', { sessionId }).catch(() => {}); finish('test-timeout') }, realModel ? 180000 : 45000)
  try {
    if (prompt === undefined) {
      await browser.panel.locator('.page-diagnostics').getByRole('button', { name: /让 DSH 查看|Ask DSH to inspect/ }).click()
    } else {
      const input = browser.panel.locator('.composer textarea'); await input.fill(prompt); await input.press('Enter')
    }
    assert.equal(await within(done, realModel ? 185000 : 50000, 'diagnostic model turn'), 'completed')
  }
  finally { clearTimeout(cancelTimer); off() }
  await writeFile(join(artifacts, phase + '-events.json'), JSON.stringify(events, null, 2), { mode: 0o600 })
}
try {
  await mkdir(home); await new Promise(done => site.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${site.address().port}`
  const install = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', '@eilyeee/dsh-browser-stride@link:' + join(repo, 'packages/browser/bridge-browser')], { cwd: repo, env, stdio: 'ignore' })
  const installTimer = setTimeout(() => install.kill('SIGKILL'), 120000); try { assert.equal((await once(install, 'exit'))[0], 0) } finally { clearTimeout(installTimer) }
  if (realModel) { if (!process.env.STRIDE_MODEL_CREDENTIALS || !process.env.STRIDE_MODEL_PATCH) throw Error('Private model credential/config paths required'); await copyFile(process.env.STRIDE_MODEL_CREDENTIALS, join(home, '.credentials.yaml')); await chmod(join(home, '.credentials.yaml'), 0o600) }
  const fixture = join(root, 'adapter.mjs')
  await writeFile(fixture, `import {LlmAdapter} from ${JSON.stringify(pathToFileURL(bridgeRequire.resolve('@deepseek-ai/dsh-llm')).href)};
class Scripted extends LlmAdapter {async listModels(provider){return [{provider,id:'diagnostics',name:'Synthetic diagnostics',contextWindow:128000}]} async *stream(options){const recent=options.messages.slice(options.messages.findLastIndex(m=>m.role==='user')+1); const done=recent.some(m=>m.role==='tool'); const block=done?{type:'text',text:'DIAGNOSTIC_DONE'}:{type:'tool-call',id:'diag',name:'run_code',arguments:JSON.stringify({code:"const value=await tools.browser_get_diagnostics({limit:30});console.log(value);console.log('DIAGNOSTIC_PROGRAM_OK');",description:'Read explicitly enabled synthetic diagnostic metadata'})};yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:done?'stop':'tool-calls'}}}}
export const inject=['llm','tools','agents'];export function apply(ctx){${realModel ? '' : "ctx.effect(()=>ctx.llm.registerAdapter(['stride-diagnostics'],new Scripted()));"}
let requests=0;ctx.on('agent/request',(_p,next)=>{if(++requests>12)throw Error('Synthetic request budget');return next()});ctx.effect(()=>ctx.tools.guard(exec=>!['run_code','browser_get_diagnostics'].includes(exec.name)?'Only diagnostic reads are allowed in this fixture':undefined));}`, { mode: 0o600 })
  process.env.DSH_HOME = home; for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete process.env[key]
  const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done)); const port = reservation.address().port; await new Promise(done => reservation.close(done))
  const patch = realModel ? await readFile(process.env.STRIDE_MODEL_PATCH, 'utf8') : ''
  host = await startDshBackend({ backend: 'extension', port, repoRoot: repo, benchmarkRoot: join(repo, 'benchmark'), runtimeRoot: join(root, 'runtime'), startUrl: origin + '/health', toolExecutor: realModel ? undefined : 'ptc', deferSessionCreate: true, extraPatch: patch + '\n- insert:\n    - id: diagnostic-fixture\n      name: ' + JSON.stringify(pathToFileURL(fixture).href) + '\n' })
  let extensionDir
  if (statusRace || traceNative) {
    extensionDir = join(root, 'status-race-extension')
    await cp(join(repo, 'extensions/dsh-browser/dist'), extensionDir, { recursive: true })
    if (statusRace) {
      await copyFile(join(repo, 'scripts/fixtures/diagnostic-status-race.js'), join(extensionDir, 'status-race-fixture.js'))
      const panelPath = join(extensionDir, 'panel/index.html'), panel = await readFile(panelPath, 'utf8')
      assert.ok(panel.includes('<head>'))
      await writeFile(panelPath, panel.replace('<head>', '<head><script src="../status-race-fixture.js"></script>'))
    }
    if (traceNative) {
      const background = join(extensionDir, 'background.js')
      const delayStart = startExpiry
        ? 'globalThis.__strideDiagnosticHoldFrameRead = ' + String(unresponsiveStartRead) + ';\n' + await readFile(join(repo, 'scripts/fixtures/diagnostic-start-delay.js'), 'utf8')
        : ''
      await writeFile(background, (await readFile(join(repo, 'scripts/fixtures/diagnostic-native-trace.js'), 'utf8')) + ';\n' + delayStart + ';\n' + await readFile(background, 'utf8'))
    }
  }
  browser = await startExtensionBrowser({ repoRoot: repo, benchmarkRoot: join(repo, 'benchmark'), bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`, issuePairingCode: () => host.issuePairingCode(), trustedOrigin: origin, extensionDir })
  for (let i = 0; i < 100 && !sessionId; i++) { sessionId = await browser.worker.evaluate(async () => (await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity?.focusedSessionId); if (!sessionId) await delay(100) }
  assert.equal(typeof sessionId, 'string')
  await rpc('bridge.taskBrief.save', { sessionId, version: 0, input: { goal: 'Synthetic page diagnostics', projectPath: '', materials: [], criteria: [] } })
  await browser.prepare(origin + '/diagnostics'); await browser.bindSession(sessionId); await browser.panel.bringToFront()
  if (!realModel) await rpc('session.selectModel', { sessionId, provider: 'stride-diagnostics', model: 'diagnostics' })
  if (statusRace) {
    phase = 'hold-status'
    await browser.panel.evaluate(() => window.__strideDiagnosticRace.arm())
    await browser.panel.waitForFunction(() => window.__strideDiagnosticRace.status().held, null, { timeout: 10000 })
  }
  phase = 'native-enable'
  const useShortcut = !realModel && !statusRace && !startExpiry
  const enable = browser.panel.locator('.page-diagnostics .troubleshooting-actions button').first()
  if (useShortcut) {
    await toolTurn('Inspect diagnostics before capture')
    const shortcut = browser.panel.getByRole('button', { name: /排查这个页面|Troubleshoot this page/ })
    await shortcut.click()
  } else {
    await browser.panel.locator('.page-diagnostics > summary').click()
    await enable.click()
  }
  if (startExpiry) {
    phase = 'native-start-expiry'
    await waitWorker(() => globalThis.__strideDiagnosticStartDelay.status().held, 'The native start reply was not held')
    // This must settle before the panel's own 15-second RPC timeout.
    await browser.panel.locator('.page-diagnostics [role="status"]').waitFor({ timeout: 12500 })
    assert.match(await browser.panel.locator('.page-diagnostics [role="status"]').innerText(), /诊断请求未确认|Check the connection/)
    assert.match(await enable.innerText(), /开启|Enable/)
    phase = 'late-native-start-cleanup'
    if (!unresponsiveStartRead) await browser.worker.evaluate(() => globalThis.__strideDiagnosticStartDelay.release())
    await waitWorker(() => globalThis.__strideDiagnosticNativeTrace.some(item => item.command === 'detach' && item.state === 'resolved'), 'Late native cleanup did not settle')
    assert.match(await enable.innerText(), /开启|Enable/, 'The expired native start must not enable capture after its late reply')
    const trace = await browser.worker.evaluate(() => globalThis.__strideDiagnosticNativeTrace)
    const delayedCommand = unresponsiveStartRead ? 'Page.getFrameTree' : 'Network.enable'
    assert.equal(trace.filter(item => item.command === delayedCommand && item.state === 'started').length, 1, 'Expired native work must not replay itself')
    if (unresponsiveStartRead) assert.deepEqual(await browser.worker.evaluate(() => globalThis.__strideDiagnosticStartDelay.status()), { held: true, released: false })
    // Only a new native click may start a later capture after confirmed cleanup.
    phase = 'explicit-native-restart'
    await enable.click()
  }
  await browser.panel.locator('.page-diagnostics [role="status"]').waitFor({ timeout: 15000 })
  await browser.panel.locator('.page-diagnostics [role="status"]').filter({ hasText: /已记录|entries/ }).waitFor({ timeout: 15000 })
  if (unresponsiveStartRead) {
    await browser.worker.evaluate(() => globalThis.__strideDiagnosticStartDelay.release())
    assert.match(await enable.innerText(), /停止并清空|Stop and clear/)
  }
  if (statusRace) {
    phase = 'late-status'
    assert.equal(await browser.panel.evaluate(() => window.__strideDiagnosticRace.status().delayedDeliveries), 1)
    await browser.panel.evaluate(() => window.__strideDiagnosticRace.release())
    await browser.panel.waitForTimeout(100)
    assert.match(await enable.innerText(), /停止并清空|Stop and clear/, 'An earlier disabled status reply must not overwrite the native start result')
  }
  phase = 'capture'
  await browser.target.locator('#reproduce').click(); await browser.target.locator('#state').filter({ hasText: 'DONE' }).waitFor()
  assert.equal(gets, 1); assert.equal(writes, 0)
  phase = 'model-read'
  await toolTurn(useShortcut ? undefined : realModel ? '只调用一次 browser_get_diagnostics({limit:30})，读取已由面板开启的本地测试页诊断。不要开启诊断、点击、导航、读文件或修改网页。报告实际看到的 Console 错误类型和 HTTP 状态，明确这不能证明业务成功，然后停止。' : 'Read diagnostic metadata')
  const dispatches = events.filter(e => e.type === 'tool/ptc-dispatch' || e.type === 'tool/call' && e.data.name === 'browser_get_diagnostics').map(e => e.data)
  const observed = JSON.stringify(events.filter(e => e.type === 'tool/ptc-dispatch' || e.type === 'tool/result'))
  assert.ok(dispatches.some(value => value.name === 'browser_get_diagnostics')); assert.match(observed, /TypeError/); assert.match(observed, /500/); assert.match(observed, /complete/); assert.ok(!observed.includes('PRIVATE-'))
  phase = 'native-stop'
  await enable.click(); await browser.panel.locator('.page-diagnostics button').filter({ hasText: /开启|Enable/ }).waitFor()
  await browser.target.goto(origin + '/another'); assert.equal(writes, 0)
  await browser.panel.setViewportSize({ width: 360, height: 800 }); assert.ok(await browser.panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await browser.panel.screenshot({ path: join(artifacts, 'panel.png') })
  assert.equal(await extensionDigest(join(repo, 'extensions/dsh-browser/dist')), sourceExtensionDigest, 'The candidate changed during acceptance')
  assert.equal(createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex'), sourceHostDigest, 'The Host candidate changed during acceptance')
  const result = { passed: true, version, realHost: true, isolatedChrome: true, realModel, scriptedModel: !realModel, browserVersion: browser.browserVersion, nativeEnable: true, nativeStop: true, diagnosticReadCalls: dispatches.filter(v => v.name === 'browser_get_diagnostics').length, observedConsole: 'TypeError', observedHttp: 500, sensitiveSyntheticValuesAbsent: true, serverWrites: writes, originalHostUntouched: true,
    ...(useShortcut ? { startedFromError: true, readFromSidebarButton: true } : {}),
    ...(statusRace ? { statusRaceInjected: true, staleStatusDidNotOverwriteStart: true, extensionObserverCopy: true } : {}),
    ...(startExpiry ? { startReplyDelayed: true, expiredStartRejected: true, lateStartNeverReenabled: true, nativeSlotCleanupConfirmed: true, newNativeEnableRequired: true, extensionObserverCopy: true } : {}),
    ...(unresponsiveStartRead ? { exclusiveDetachBeforeOldReply: true, freshStartBeforeOldReply: true } : {}),
    ...(traceNative ? { nativeCommandObserver: true, nativeCommandTrace: await browser.worker.evaluate(() => globalThis.__strideDiagnosticNativeTrace) } : {}),
    sourceExtensionDigest, candidateUnchangedDuringRun: true,
    hostBundleSha256: createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex'), extensionBundleSha256: createHash('sha256').update(await readFile(join(repo, 'extensions/dsh-browser/dist/background.js'))).digest('hex'), evidenceDirectory: artifacts.slice(base.length + 1) }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); await writeFile(join(base, label + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result))
} catch (error) {
  const panelState = browser === undefined ? undefined : await browser.panel.evaluate(expectedSession => ({
    conversationMatches: document.querySelector('.app')?.getAttribute('data-session-id') === expectedSession,
    connected: document.querySelector('.connection .dot.connected') !== null,
    diagnostics: document.querySelector('.page-diagnostics')?.textContent?.slice(0, 1500),
    target: document.querySelector('.control-group')?.textContent?.slice(0, 1000),
  }), sessionId).catch(() => undefined)
  const statusRaceState = !statusRace || !browser ? undefined : await browser.panel.evaluate(() => window.__strideDiagnosticRace.status()).catch(() => undefined)
  const nativeTrace = !traceNative || !browser ? undefined : await browser.worker.evaluate(() => globalThis.__strideDiagnosticNativeTrace).catch(() => undefined)
  const startDelayState = !startExpiry || !browser ? undefined : await browser.worker.evaluate(() => globalThis.__strideDiagnosticStartDelay.status()).catch(() => undefined)
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ passed: false, phase, errorName: error.name, panelState, statusRaceState, startDelayState, nativeTrace, events }, null, 2), { mode: 0o600 }); throw error
} finally {
  clearTimeout(cancelTimer); if (sessionId) await host?.client.rpc('session.cancel', { sessionId }).catch(() => {})
  await browser?.close().catch(() => {}); await host?.close().catch(() => {}); await new Promise(done => site.close(done)); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
