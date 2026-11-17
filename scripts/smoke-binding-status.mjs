// Own-conversation diagnostics in an isolated Host and two native panels.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'
import { parseMarkedModelReport } from '../benchmark/lib/model-report.mjs'
const repo = resolve(process.env.STRIDE_ACCEPTANCE_REPO ?? resolve(import.meta.dirname, '..'))
const realModel = process.env.STRIDE_REAL_MODEL === '1'
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
const base = join(repo, '.stride-private/validation/binding-status', version)
await mkdir(base, { recursive: true })
const label = realModel ? 'real-model' : 'scripted', artifacts = await mkdtemp(join(base, label + '-'))
let h, phase = 'setup', writes = 0
const site = createServer((req, res) => {
  if (req.method !== 'GET') { writes++; res.writeHead(405).end(); return }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Synthetic binding page</title><h1>Read-only routing fixture</h1>')
})
try {
  await new Promise(done => site.listen(0, '127.0.0.1', done))
  const origin = 'http://127.0.0.1:' + site.address().port
  h = await startIsolatedModelRun({ repo, origin, startUrl: origin + '/first', artifacts, promptViaRpc: true, startupTimeoutMs: 120000,
    goal: 'Observe own conversation binding without changing it', programs: { inspect: 'console.log(await tools.browser_list_tabs({}));' },
    guardSource: "ctx.effect(()=>ctx.tools.guard(exec=>['run_code','browser_list_tabs'].includes(exec.name)?undefined:'Only the read-only authorized tab list is permitted'));" })
  await h.browser.prepare(origin + '/first'); await h.browser.bindSession(h.sessionId)
  const other = await h.browser.context.newPage(); await other.goto(origin + '/other'); await h.browser.authorizePage(other)
  const otherTabId = await h.browser.worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, origin + '/other')
  assert.equal(typeof otherTabId, 'number')
  const second = await h.browser.context.newPage(); await second.goto(h.browser.panel.url())
  await second.locator('header.topbar').waitFor(); await second.locator('.new-session-trigger').click()
  await second.waitForFunction(sid => { const id = document.querySelector('.app')?.getAttribute('data-session-id'); return !!id && id !== sid }, h.sessionId)
  await second.locator('.control-group-pages button[data-tab-id="' + otherTabId + '"]').click()
  await second.locator('.control-group-pages button[data-tab-id="' + otherTabId + '"][aria-pressed="true"]').waitFor()
  const cases = []
  async function inspect(name, expected) {
    phase = name
    const events = await h.turn('inspect', '仅调用一次 browser_list_tabs，禁止选择、follow、导航、页面动作、文件、shell、API或资料写入。只根据本轮工具实际返回的 binding 四个布尔字段报告，不能从历史猜测；字段缺失写 unknown。最终只返回 JSON：marker=OWN_BINDING_MODEL_DONE，binding 为本次 binding 对象，businessSaved=false。', realModel ? 240000 : 60000)
    const calls = events.filter(e => e.type === 'tool/ptc-dispatch')
    assert.ok(calls.every(e => ['run_code', 'browser_list_tabs'].includes(e.data.name) && !e.data.isError))
    const lists = calls.filter(e => e.data.name === 'browser_list_tabs'); assert.equal(lists.length, 1)
    const text = lists[0].data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    const body = text.match(/<UNTRUSTED_PAGE_CONTENT[^>]*>([\s\S]*?)<\/UNTRUSTED_PAGE_CONTENT[^>]*>/)?.[1]
    assert.ok(body); const data = JSON.parse(body); assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, data.binding?.[key]])), expected)
    assert.equal(data.tabs.filter(t => t.controlled).length, expected.targetAuthorized ? 1 : 0)
    if (realModel) {
      const last = events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message?.content?.filter(b => b.type === 'text').map(b => b.text) ?? []).at(-1)
      const report = parseMarkedModelReport(last, 'OWN_BINDING_MODEL_DONE')
      assert.deepEqual(report.binding, expected); assert.equal(report.businessSaved, false)
    }
    await writeFile(join(artifacts, name + '-events.json'), JSON.stringify(events), { mode: 0o600 })
    cases.push({ name, passed: true, binding: expected })
  }
  await inspect('visible', { sessionScoped: true, panelSessionRegistered: true, targetSelected: true, targetAuthorized: true })
  await h.browser.panel.close()
  await inspect('panel-closed', { sessionScoped: true, panelSessionRegistered: false, targetSelected: true, targetAuthorized: true })
  await h.browser.target.close()
  await inspect('target-closed', { sessionScoped: true, panelSessionRegistered: false, targetSelected: false, targetAuthorized: false })
  assert.equal(writes, 0)
  const result = { passed: true, version, realModel, scriptedModel: !realModel, cases, businessWrites: writes, originalHostUntouched: true,
    hostBundleSha256: createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex'),
    backgroundBundleSha256: createHash('sha256').update(await readFile(join(repo, 'extensions/dsh-browser/dist/background.js'))).digest('hex'),
    contentBundleSha256: createHash('sha256').update(await readFile(join(repo, 'extensions/dsh-browser/dist/content.js'))).digest('hex'),
    evidenceDirectory: artifacts.slice(base.length + 1) }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  await writeFile(join(base, label + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result))
} catch (error) { await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ passed: false, phase, errorName: error.name }), { mode: 0o600 }); throw error }
finally { await h?.close(); await new Promise(done => site.close(done)) }
