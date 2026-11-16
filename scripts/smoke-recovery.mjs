// Real local save with a deliberately delayed wire reply, native review, then a late reply.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'

const repo = resolve(import.meta.dirname, '..'), realModel = process.env.STRIDE_REAL_MODEL === '1'
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
const base = join(repo, '.stride-private/validation/native-recovery', version), label = realModel ? 'real-model' : 'scripted'
await mkdir(base, { recursive: true }); const artifacts = await mkdtemp(join(base, label + '-')), statusFile = join(artifacts, 'host-status.json')
let writes = 0, saved = false, h, phase = 'setup'
const site = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/save') { writes++; saved = true; res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"saved":true}'); return }
  if (req.method !== 'GET') { res.writeHead(405).end(); return }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>Local recovery fixture</title><h1>Recovery acceptance</h1><button id="save">Save once</button><output>Saved: ${saved}</output><script>document.querySelector('button').onclick=async()=>{await fetch('/api/save',{method:'POST'});document.querySelector('output').value='Saved: true'}</script>`)
})
async function wait(check, label, timeoutMs = 15000) { const until = Date.now() + timeoutMs; while (Date.now() < until) { if (await check()) return; await delay(100) } throw Error('Recovery fixture timed out: ' + label) }
async function status() { try { return JSON.parse(await readFile(statusFile, 'utf8')) } catch { return {} } }
async function nativeReview() {
  await wait(async () => (await status()).idle === true, 'idle Agent before native review')
  await h.browser.panel.locator('.page-recovery').evaluate(element => { element.open = true })
  await h.browser.panel.locator('.page-recovery button').filter({ hasText: /刷新核对|Refresh review/ }).click()
  const choice = h.browser.panel.locator('.page-recovery input[value="applied"]')
  await choice.waitFor({ state: 'visible' }); assert.equal(await choice.count(), 1)
  const confirm = h.browser.panel.locator('.page-recovery button').filter({ hasText: /记录人工|Record review/ })
  await choice.dispatchEvent('click'); assert.equal(await confirm.isDisabled(), true)
  await choice.check(); assert.equal(await choice.isChecked(), true)
  await h.browser.panel.locator('.page-recovery button').filter({ hasText: /记录人工|Record review/ }).click()
  await h.browser.panel.locator('.page-recovery [role="status"]').filter({ hasText: /核对已记录|Review recorded/ }).waitFor({ timeout: 15000 })
}
try {
  await new Promise(done => site.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${site.address().port}`
  const programs = {
    save: String.raw`const view=await tools.browser_snapshot({});const ref=view.text.split('\n').find(line=>line.includes('button "Save once"'))?.match(/ref=(obs_[a-f0-9-]+:\d+)/)?.[1];if(!ref)throw Error('Missing Save reference');let unknown=false;try{await tools.browser_click({elementRef:ref})}catch{unknown=true}if(!unknown)throw Error('Expected delayed reply timeout');console.log(await tools.browser_snapshot({}));console.log('RECOVERY_PROGRAM_OK');`,
    audit: `console.log(await tools.browser_snapshot({}));console.log('RECOVERY_READ_OK');`,
    recheck: `console.log(await tools.browser_snapshot({}));console.log('RECOVERY_READ_OK');`,
  }
  h = await startIsolatedModelRun({ repo, origin, startUrl: origin + '/health', artifacts, goal: 'Synthetic uncertain-save review', programs,
    imports: "import {writeFile} from 'node:fs/promises';",
    guardSource: `let clickCalls=0;ctx.effect(()=>ctx.tools.guard(exec=>!['run_code','browser_snapshot','browser_click'].includes(exec.name)?'Only synthetic recovery browser tools are allowed':exec.name==='browser_click'&&++clickCalls>1?'Do not repeat the synthetic save':undefined));ctx.effect(()=>{const timer=setInterval(()=>{const rows=ctx.browserRuns.dispatches.list();const sid=rows.find(row=>row.sessionId)?.sessionId;void writeFile(${JSON.stringify(statusFile)},JSON.stringify({idle:sid?ctx.agents.get(sid)?.status==='idle':true,clickCalls,rows:rows.map(({requestId,name,state,receipt,nativeReview,nativeReviewInvalidated,previousNativeReview})=>({requestId,name,state,receipt,nativeReview,nativeReviewInvalidated,previousNativeReview}))}),{mode:0o600}).catch(()=>{})},100);return()=>clearInterval(timer)});`,
  })
  await h.browser.prepare(origin + '/form'); await h.browser.bindSession(h.sessionId); await h.browser.panel.bringToFront()
  // Test-only wire fault injection in this isolated worker. The real DOM action
  // and local server save run normally; only its first click reply is held.
  await h.browser.worker.evaluate(() => {
    const prototype = WebSocket.prototype, send = prototype.send, sockets = new WeakSet(), names = new Map()
    prototype.send = function (data) {
      if (!sockets.has(this)) {
        sockets.add(this)
        this.addEventListener('message', event => { try { const frame = JSON.parse(String(event.data)); if (frame.t === 'tool.call') names.set(frame.id, frame.name) } catch {} })
      }
      try {
        const frame = JSON.parse(String(data))
        if (frame.t === 'tool.result' && names.get(frame.id) === 'browser_click' && globalThis.__recoveryHeld === undefined) {
          globalThis.__recoveryHeld = { socket: this, data }; return
        }
      } catch {}
      return send.call(this, data)
    }
    globalThis.__releaseRecoveryReply = () => { const value = globalThis.__recoveryHeld; if (!value) throw Error('No delayed reply'); send.call(value.socket, value.data); globalThis.__recoveryReleased = true }
  })
  await h.rpc('bridge.browserRuns.list', { sessionId: h.sessionId }) // Prime the isolated socket observer.
  phase = 'uncertain-save'
  const saveTurn = h.turn('save', '当前已授权本地合成表单。先快照，再点击 Save once 一次且仅一次。等待回执，不得重复点击或改用其他写入办法。本轮会在保存后测试手动中断；不需要用户回答问题，也不处理其他页面。', h.realModel ? 240000 : 60000, true).catch(error => error)
  await wait(async () => writes === 1 && await h.browser.worker.evaluate(() => globalThis.__recoveryHeld !== undefined), 'actual local save and held reply', h.realModel ? 180000 : 30000)
  await h.host.client.rpc('session.cancel', { sessionId: h.sessionId })
  const savedTurn = await saveTurn; if (savedTurn instanceof Error) throw savedTurn
  await h.turn('audit', '仅只读当前页面快照，报告 Saved 状态。刚才已中断的保存不得重做；不导航、不点击、不输入，读完立即结束。')
  assert.equal(writes, 1); assert.equal(saved, true)
  await wait(async () => (await status()).rows?.some(row => row.name === 'browser_click' && row.state === 'unresolved'), 'durable unknown write')
  assert.equal(await h.browser.worker.evaluate(() => globalThis.__recoveryHeld !== undefined), true)
  phase = 'native-review'
  await nativeReview(); assert.equal(writes, 1)
  await wait(async () => (await status()).rows?.some(row => row.name === 'browser_click' && row.nativeReview?.source === 'native-user'), 'native review record')
  phase = 'late-receipt'
  await h.browser.worker.evaluate(() => globalThis.__releaseRecoveryReply())
  await wait(async () => (await status()).rows?.some(row => row.name === 'browser_click' && row.receipt?.ok === true && row.nativeReviewInvalidated === true), 'late reply invalidates review')
  await h.turn('recheck', '只读当前页面快照，报告当前 Saved 状态。禁止再次点击、导航或保存；读完立即结束。')
  phase = 'native-recheck'
  await nativeReview(); assert.equal(writes, 1)
  await wait(async () => (await status()).rows?.some(row => row.name === 'browser_click' && row.nativeReview?.source === 'native-user' && row.previousNativeReview && row.nativeReviewInvalidated === false), 'second review preserves old acknowledgement')
  assert.equal((await status()).clickCalls, 1)
  await h.browser.panel.setViewportSize({ width: 360, height: 800 }); assert.ok(await h.browser.panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await h.browser.panel.screenshot({ path: join(artifacts, 'panel.png') })
  const result = { passed: true, version, realModel, scriptedModel: !realModel, realHost: true, isolatedChrome: true, browserVersion: h.browser.browserVersion,
    actualLocalSaves: writes, modelClickCalls: (await status()).clickCalls, originalWritePreserved: true, lateReceiptInvalidatedReview: true,
    nativeReviewRequiredAgain: true, automaticReplay: false, businessSuccessFromReview: false, originalHostUntouched: true,
    hostBundleSha256: createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex'), backgroundBundleSha256: createHash('sha256').update(await readFile(join(repo, 'extensions/dsh-browser/dist/background.js'))).digest('hex'), evidenceDirectory: artifacts.slice(base.length + 1) }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); await writeFile(join(base, label + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result))
} catch (error) {
  if (h?.browser) {
    await h.browser.panel.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
    await writeFile(join(artifacts, 'failure-panel.json'), JSON.stringify({ recovery: await h.browser.panel.locator('.page-recovery').textContent().catch(() => ''),
      affinity: await h.browser.worker.evaluate(async () => (await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity).catch(() => null) }, null, 2), { mode: 0o600 })
  }
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ passed: false, phase, errorName: error.name, writes }, null, 2), { mode: 0o600 }); throw error
}
finally { await h?.close(); await new Promise(done => site.close(done)) }
