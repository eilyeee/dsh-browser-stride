// Disposable Host/browser harness for synthetic acceptance, never the active Host.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { startDshBackend } from '../../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../../benchmark/lib/extension-browser.mjs'
import { within } from '../../benchmark/lib/extension-connection.mjs'

export async function startIsolatedModelRun({ repo, origin, startUrl, artifacts, goal, programs, guardSource, imports = '', patch = '', workspacePath, materials = [], criteria = [], extensionDir, promptViaRpc = false, startupTimeoutMs }) {
  const require = createRequire(join(repo, 'package.json')), bridgeRequire = createRequire(join(repo, 'packages/browser/bridge-browser/package.json'))
  const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
  const root = await mkdtemp(join(tmpdir(), 'stride-model-fixture-')), home = join(root, 'home')
  const realModel = process.env.STRIDE_REAL_MODEL === '1'
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
  let host, browser, sessionId, timer
  const close = async () => {
    clearTimeout(timer)
    if (sessionId) await host?.client.rpc('session.cancel', { sessionId }).catch(() => {})
    await browser?.close().catch(() => {}); await host?.close().catch(() => {})
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
  try {
    await mkdir(home)
    console.log(JSON.stringify({ phase: 'isolated-install', realModel }))
    const install = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', '@eilyeee/dsh-browser-stride@link:' + join(repo, 'packages/browser/bridge-browser')], { cwd: repo, env, stdio: 'ignore' })
    const installTimer = setTimeout(() => install.kill('SIGKILL'), 120000)
    try { assert.equal((await once(install, 'exit'))[0], 0) } finally { clearTimeout(installTimer) }
    console.log(JSON.stringify({ phase: 'isolated-host', realModel }))
    let modelPatch = ''
    if (realModel) {
      if (!process.env.STRIDE_MODEL_CREDENTIALS || !process.env.STRIDE_MODEL_PATCH) throw Error('Private model credential/config paths required')
      await copyFile(process.env.STRIDE_MODEL_CREDENTIALS, join(home, '.credentials.yaml')); await chmod(join(home, '.credentials.yaml'), 0o600)
      modelPatch = await readFile(process.env.STRIDE_MODEL_PATCH, 'utf8')
    }
    const fixture = join(root, 'adapter.mjs')
    await writeFile(fixture, `${imports}\nimport {LlmAdapter} from ${JSON.stringify(pathToFileURL(bridgeRequire.resolve('@deepseek-ai/dsh-llm')).href)};
const programs=${JSON.stringify(programs)};
class Scripted extends LlmAdapter {async listModels(provider){return [{provider,id:'fixture',name:'Synthetic acceptance',contextWindow:128000}]}
async *stream(options){const messages=options.messages,texts=messages.map(m=>m.content?.filter(b=>b.type==='text').map(b=>b.text).join(' ')||'');const index=texts.findLastIndex((t,i)=>messages[i].role==='user'&&t.startsWith('FIXTURE_CASE=')),key=texts[index]?.slice(13);if(!programs[key])throw Error('Unknown fixture case');const done=messages.slice(index+1).some(m=>m.role==='tool');const block=done?{type:'text',text:'FIXTURE_DONE'}:{type:'tool-call',id:'fixture-'+key,name:'run_code',arguments:JSON.stringify({code:programs[key],description:'Synthetic local acceptance'})};yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:done?'stop':'tool-calls'}}}}
export const inject=['llm','tools','agents','browserRuns'];export async function apply(ctx){${realModel ? '' : "ctx.on('agent/created',({agent})=>agent.ctx.effect(()=>agent.ctx.tools.presentAs('ptc')));ctx.effect(()=>ctx.llm.registerAdapter(['stride-fixture'],new Scripted()));"}
let requests=0;ctx.on('agent/request',(_p,next)=>{if(++requests>80)throw Error('Synthetic request budget');return next()});${guardSource}}
`, { mode: 0o600 })
    process.env.DSH_HOME = home
    for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete process.env[key]
    const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done))
    const port = reservation.address().port; await new Promise(done => reservation.close(done))
    const workspacePatch = workspacePath === undefined ? '' : `- id: benchmark-extension-bridge
  config:
    token: !!js process.env.DSH_EXT_TOKEN
    sessionWorkspacePath: ${JSON.stringify(workspacePath)}
    deferSessionCreate: true
    toolTimeoutMs: 90000
    snapshotMaxChars: 32000
    maxInteractiveItems: 60
`
    host = await startDshBackend({ backend: 'extension', port, repoRoot: repo, benchmarkRoot: join(repo, 'benchmark'), runtimeRoot: join(root, 'runtime'),
      startUrl, deferSessionCreate: true, startupTimeoutMs, extraPatch: modelPatch + '\n' + workspacePatch + '\n' + patch + '\n- insert:\n    - id: synthetic-acceptance\n      name: ' + JSON.stringify(pathToFileURL(fixture).href) + '\n' })
    console.log(JSON.stringify({ phase: 'isolated-browser', realModel }))
    browser = await startExtensionBrowser({ repoRoot: repo, benchmarkRoot: join(repo, 'benchmark'), bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`, issuePairingCode: () => host.issuePairingCode(), trustedOrigin: origin, extensionDir })
    async function rpc(method, payload) {
      return browser.panel.evaluate(({ method, payload }) => new Promise((done, fail) => {
        const port = window.__acceptancePort ??= chrome.runtime.connect({ name: 'dsh-panel' }), id = crypto.randomUUID()
        const timer = setTimeout(() => { port.onMessage.removeListener(receive); fail(Error('Fixture RPC timeout')) }, 15000)
        function receive(message) { if (message.type !== 'rpc.result' || message.id !== id) return; clearTimeout(timer); port.onMessage.removeListener(receive); if (!message.ok || message.result?.result?.ok === false) fail(Error('Fixture RPC rejected')); else done(message.result?.result?.value ?? message.result) }
        port.onMessage.addListener(receive); port.postMessage({ type: 'rpc', id, method, payload })
      }), { method, payload })
    }
    for (let i = 0; i < 100 && !sessionId; i++) { sessionId = await browser.worker.evaluate(async () => (await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity?.focusedSessionId); if (!sessionId) await delay(100) }
    assert.equal(typeof sessionId, 'string')
    await rpc('bridge.taskBrief.save', { sessionId, version: 0, input: { goal, projectPath: workspacePath ?? '', materials, criteria } })
    if (!realModel) await rpc('session.selectModel', { sessionId, provider: 'stride-fixture', model: 'fixture' })
    async function turn(key, prompt, timeoutMs = realModel ? 240000 : 60000, allowInterrupted = false) {
      console.log(JSON.stringify({ phase: 'model-turn', case: key, realModel }))
      const events = []; await host.client.followSession(sessionId)
      let started = false, finish; const done = new Promise(resolve => { finish = resolve })
      const off = host.client.onFrame(frame => {
        if (frame.type !== 'session/event' || frame.sessionId !== sessionId) return
        const event = frame.event?.event ?? frame.event; if (event.type === 'turn/start') started = true; if (!started) return
        events.push(event); if (event.type === 'turn/end') finish(event.data.reason.kind)
      })
      timer = setTimeout(() => { void host.client.rpc('session.cancel', { sessionId }).catch(() => {}); finish('test-timeout') }, timeoutMs)
      try {
        const text = realModel ? prompt : 'FIXTURE_CASE=' + key
        if (promptViaRpc) await host.client.rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' })
        else { const input = browser.panel.locator('.composer textarea'); await input.fill(text); await input.press('Enter') }
        const reason = await within(done, timeoutMs + 5000, 'isolated model turn')
        assert.ok(reason === 'completed' || allowInterrupted && reason === 'aborted', 'Unexpected model turn end: ' + reason)
      } finally { clearTimeout(timer); off(); await writeFile(join(artifacts, key + '-events.json'), JSON.stringify(events, null, 2), { mode: 0o600 }) }
      return events
    }
    return { root, home, host, browser, sessionId, rpc, turn, close, realModel }
  } catch (error) {
    // The backend log is already credential-redacted. Preserve startup
    // diagnostics in private artifacts before deleting the temporary home.
    await copyFile(join(root, 'runtime/logs/dsh-extension.log'), join(artifacts, 'host-startup-failure.log')).catch(() => {})
    await close(); throw error
  }
}
