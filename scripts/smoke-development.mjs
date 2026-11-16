// One synthetic requirement/design/project/API workflow; never uses business accounts.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'
import { parseMarkedModelReport } from '../benchmark/lib/model-report.mjs'

const repo = resolve(import.meta.dirname, '..'), realModel = process.env.STRIDE_REAL_MODEL === '1'
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
const base = join(repo, '.stride-private/validation/development-workflow', version), label = realModel ? 'real-model' : 'scripted'
await mkdir(base, { recursive: true }); const artifacts = await mkdtemp(join(base, label + '-'))
const root = await mkdtemp(join(tmpdir(), 'stride-development-')), project = join(root, 'project'), file = join(project, 'client.html'), stateFile = join(root, 'state.json')
const customerName = '合成客户-' + randomUUID().slice(0, 8)
let h, attempts = 0, saves = 0, reads = 0, phase = 'setup', latest = null
const initial = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>客户录入项目</title><style>body{margin:0;padding:24px;font-family:sans-serif}#project-header{height:40px;margin:0}#customer-panel{width:480px;margin-top:0;padding:16px;border:1px solid #999;box-sizing:border-box}</style><header id="project-header">线索提交</header><section id="customer-panel"><h2>客户信息</h2><form id="customer-form"><label>客户姓名<input id="customer-name" name="customerName" required></label><label>来源渠道<input id="channel" name="channel" value="web" readonly></label><button type="submit">提交客户</button></form><output id="result">尚未实现接口</output></section></html>`
const implemented = initial.replace('margin-top:0', 'margin-top:24px').replace('solid #999', 'solid #2563eb').replace('</html>', `<script>
async function latest(){const response=await fetch('/api/leads/latest');const value=await response.json();document.querySelector('#result').textContent=value?JSON.stringify(value):'暂无记录'}
document.querySelector('form').onsubmit=async event=>{event.preventDefault();const customerName=document.querySelector('#customer-name').value.trim();if(!customerName)return;const response=await fetch('/api/leads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerName,channel:'web'})});if(!response.ok)throw Error('Save failed');const value=await response.json();document.querySelector('#result').textContent=JSON.stringify(value)};void latest();</script></html>`)
const site = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://fixture.invalid').pathname
  if (path === '/api/leads' && req.method === 'POST') {
    attempts++; let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413).end(); return } }
    let input; try { input = JSON.parse(body) } catch { res.writeHead(400).end(); return }
    if (input.customerName !== customerName || input.channel !== 'web' || Object.keys(input).sort().join(',') !== 'channel,customerName') { res.writeHead(400).end(); return }
    if (latest !== null) { res.writeHead(409).end(); return }
    latest = { id: 'lead_' + randomUUID(), customerName: input.customerName, channel: 'web', saved: true }
    saves++; await writeFile(stateFile, JSON.stringify(latest), { mode: 0o600 }); res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(latest)); return
  }
  if (path === '/api/leads/latest' && req.method === 'GET') { reads++; res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(latest)); return }
  if (req.method !== 'GET') { res.writeHead(405).end(); return }
  if (path === '/app') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(await readFile(file)); return }
  const body = path === '/wiki' ? `<h1>客户录入需求说明</h1><article id="requirements"><p>客户姓名必填。来源渠道固定为 web，不可编辑。</p><p>实现提交客户按钮，调用资料中的接口，显示服务端返回的真实记录编号。刷新页面时读取服务端最新记录。</p><p>客户信息外框、内边距和上方间距按设计资料实现，不能省略。保留项目现有的 project-header、customer-panel、customer-name、channel、result 元素 ID。</p><p>空姓名不得发送请求。仅使用本地资源，不引入第三方资源。</p></article>`
    : path === '/design' ? `<h1>客户信息设计标注</h1><section id="properties"><p>Layer: customer-panel</p><p>外框宽度（含 padding 与 border）: 480px</p><p>与 project-header 的实际垂直距离: 24px</p><p>padding: 16px</p><p>border: 1px solid #2563eb</p></section>`
    : path === '/api-doc' ? `<h1>接口说明</h1><article id="api-contract"><p>POST /api/leads</p><p>Content-Type: application/json</p><p>请求只包含 customerName（必填字符串）和 channel（固定为 web）。成功响应为 JSON：id（服务端生成）、customerName、channel、saved（true）。</p><p>GET /api/leads/latest 返回最新记录 JSON，未提交时为 null；刷新后用此接口显示最新记录。400 表示参数无效，409 表示重复提交。验收仅提交一次。</p></article>` : '<h1>Local development fixture ready</h1>'
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8">' + body)
})
try {
  await mkdir(project); await writeFile(file, initial, { mode: 0o600 })
  await new Promise(done => site.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${site.address().port}`
  const urls = { wiki: origin + '/wiki', design: origin + '/design', api: origin + '/api-doc', app: origin + '/app' }
  const program = String.raw`function ref(value,label){const line=value.text.split('\n').find(line=>line.includes(label));const match=line?.match(/ref=(obs_[a-f0-9-]+:\d+)/);if(!match)throw Error('Missing observed control '+label);return match[1]}
const listed=(await tools.browser_list_tabs({})).text;const tabs=JSON.parse(listed.slice(listed.indexOf('{'),listed.lastIndexOf('}')+1)).tabs;
for(const url of URLS){const tab=tabs.find(value=>value.url===url);if(!tab)throw Error('Existing material tab missing');await tools.browser_follow_tab({tabId:tab.tabId});console.log((await tools.browser_snapshot({})).text)}
console.log(await tools.read({file_path:FILE}));await tools.write({file_path:FILE,content:IMPLEMENTED});
const app=tabs.find(value=>value.url===APP);await tools.browser_follow_tab({tabId:app.tabId});await tools.browser_reload({});let view=await tools.browser_snapshot({});console.log(view.text);await tools.browser_type({elementRef:ref(view,'input "客户姓名"'),text:NAME});view=await tools.browser_snapshot({});await tools.browser_click({elementRef:ref(view,'button "提交客户"')});console.log(await tools.browser_wait({}));console.log(await tools.browser_snapshot({}));console.log('DEVELOPMENT_PROGRAM_OK');`
    .replaceAll('\\\\', '\\').replace('URLS', JSON.stringify([urls.wiki, urls.design, urls.api])).replaceAll('FILE', JSON.stringify(file)).replace('IMPLEMENTED', JSON.stringify(implemented)).replace('APP', JSON.stringify(urls.app)).replace('NAME', JSON.stringify(customerName))
  const guardModule = pathToFileURL(join(repo, 'scripts/fixtures/material-project-scope.mjs')).href
  const statsFile = join(artifacts, 'tool-counts.json')
  const allowedBrowser = ['browser_list_tabs', 'browser_follow_tab', 'browser_open_tab', 'browser_snapshot', 'browser_get_text', 'browser_read_design_styles', 'browser_measure_layout', 'browser_navigate', 'browser_reload', 'browser_type', 'browser_click', 'browser_wait', 'browser_screenshot', 'browser_get_diagnostics']
  h = await startIsolatedModelRun({ repo, origin, startUrl: urls.app, artifacts, goal: '按资料完成客户录入页面与本地接口联调', workspacePath: project,
    materials: Object.entries(urls).map(([key, url]) => ({ url, label: key, role: 'unknown' })),
    criteria: [{ id: 'layout', text: '布局符合设计，客户信息上方保留实际间距' }, { id: 'save', text: '只提交一次并读取真实服务端记录，刷新读取最新状态' }],
    programs: { develop: program }, imports: `import {writeFile} from 'node:fs/promises';import {materialProjectScope,guardMaterialProjectFile,PROJECT_FILE_TOOLS} from ${JSON.stringify(guardModule)};`,
    guardSource: `const scope=await materialProjectScope(${JSON.stringify(file)});const counts={read:0,write:0,edit:0,browser:0,open:0,denied:0};ctx.effect(()=>ctx.tools.guard(exec=>{let reason;if(PROJECT_FILE_TOOLS.includes(exec.name))reason=guardMaterialProjectFile(scope,exec.arguments);else if(!['run_code',...${JSON.stringify(allowedBrowser)}].includes(exec.name))reason='Only this local project and its browser tools are allowed';else if(['browser_open_tab','browser_navigate'].includes(exec.name)&&!${JSON.stringify([...Object.values(urls), origin + '/api/leads/latest'])}.includes(exec.arguments?.url))reason='Only existing local fixture URLs are allowed';else if(counts.browser>=80)reason='Synthetic browser budget exhausted';if(reason){counts.denied++;void writeFile(${JSON.stringify(statsFile)},JSON.stringify(counts),{mode:0o600}).catch(()=>{})}return reason}));ctx.on('tools/execute',async(exec,next)=>{if(PROJECT_FILE_TOOLS.includes(exec.name))counts[exec.name]++;if(exec.name.startsWith('browser_'))counts.browser++;if(exec.name==='browser_open_tab')counts.open++;await writeFile(${JSON.stringify(statsFile)},JSON.stringify(counts),{mode:0o600});return next()});`,
  })
  const extensionOrigin = new URL(h.browser.worker.url()).origin, hostOrigin = new URL(h.host.getAuthenticatedUrl()).origin
  await h.browser.context.route('**/*', route => { const url = new URL(route.request().url()); return [origin, hostOrigin, extensionOrigin].includes(url.origin) ? route.continue() : route.abort() })
  // All pages really exist and are separately authorized through native actions.
  const materialPages = []
  for (const url of [urls.wiki, urls.design, urls.api]) { const page = await h.browser.context.newPage(); await page.goto(url); await h.browser.authorizePage(page); materialPages.push(page) }
  await h.browser.prepare(urls.app); await h.browser.bindSession(h.sessionId); await h.browser.panel.bringToFront()
  assert.equal(await materialPages[0].locator('#requirements').count(), 1); assert.match(await materialPages[1].locator('#properties').textContent(), /24px/)
  const beforePages = h.browser.context.pages().length
  phase = 'model-development'
  const events = await h.turn('develop', `给定项目只有一个可修改文件 ${file}，页面预览为 ${urls.app}。其余三个现成受控页面是 ${urls.wiki}、${urls.design}、${urls.api}。请通过插件自己查资料，判断每份资料用途，结合现有代码完成需求、刷新预览并自己联调。复用已授权页面，不重复打开，不读取需求文档 CSS；不要修改项目外文件或运行 shell。测试客户姓名为 ${customerName}。只提交一次，不重复提交；若回执不确定，只读核对。联调后验证客户信息上方实际间距与外框，保留只读渠道。空姓名禁止请求，刷新要读取服务端最新记录。做完立即停止。最终只返回 JSON：marker=DEVELOPMENT_MODEL_DONE，goalReached 为布尔值，sourceRoles 为 wiki/design/api 对应的 requirement/design/api，savedId 为真实服务端编号，reason 为实际依据。`, h.realModel ? 360000 : 90000)
  assert.equal(saves, 1); assert.equal(attempts, 1); assert.equal(latest.customerName, customerName)
  const originalSaved = { ...latest }; assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), originalSaved)
  assert.notEqual(await readFile(file, 'utf8'), initial); assert.equal(h.browser.context.pages().length, beforePages)
  const counts = JSON.parse(await readFile(statsFile, 'utf8')); assert.ok(counts.read > 0 && counts.write + counts.edit > 0); assert.equal(counts.open, 0)
  phase = 'independent-verification'
  const page = h.browser.target; await page.goto(urls.app); await page.locator('#result').filter({ hasText: originalSaved.id }).waitFor({ timeout: 10000 })
  const layout = await page.evaluate(() => {
    const header = document.querySelector('#project-header').getBoundingClientRect(), panel = document.querySelector('#customer-panel'), rect = panel.getBoundingClientRect(), css = getComputedStyle(panel)
    return { gap: rect.top - header.bottom, width: rect.width, padding: css.paddingTop, border: css.borderTopColor,
      readOnly: document.querySelector('#channel').readOnly, channel: document.querySelector('#channel').value, required: document.querySelector('#customer-name').required }
  })
  assert.equal(layout.gap, 24); assert.equal(layout.width, 480); assert.equal(layout.padding, '16px'); assert.equal(layout.border, 'rgb(37, 99, 235)')
  assert.equal(layout.readOnly, true); assert.equal(layout.channel, 'web'); assert.equal(layout.required, true)
  // Change server state after the model stops: a hard-coded success display cannot pass.
  latest = { ...latest, id: 'lead_' + randomUUID(), customerName: '刷新验收客户', saved: true }; await writeFile(stateFile, JSON.stringify(latest), { mode: 0o600 })
  await page.reload(); await page.locator('#result').filter({ hasText: latest.id }).waitFor({ timeout: 10000 })
  await page.locator('#customer-name').fill(''); await page.locator('button[type="submit"]').click(); assert.equal(attempts, 1)
  assert.ok(reads >= 2)
  let report
  if (h.realModel) {
    const final = events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message?.content?.filter(b => b.type === 'text').map(b => b.text) ?? []).at(-1)
    report = parseMarkedModelReport(final, 'DEVELOPMENT_MODEL_DONE'); assert.equal(report.goalReached, true); assert.equal(report.savedId, originalSaved.id)
    assert.deepEqual(report.sourceRoles, { wiki: 'requirement', design: 'design', api: 'api' })
    await writeFile(join(artifacts, 'model-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  } else assert.ok(events.some(e => e.type === 'tool/result' && JSON.stringify(e).includes('DEVELOPMENT_PROGRAM_OK')))
  await page.screenshot({ path: join(artifacts, 'result-page.png') })
  const result = { passed: true, version, realModel, scriptedModel: !realModel, realHost: true, isolatedChrome: true, browserVersion: h.browser.browserVersion,
    scope: 'synthetic-requirement-design-project-api-workflow', projectModifiedByModelTools: true, existingMaterialPagesReused: true, modelToolCalls: counts,
    independentLayout: layout, actualLocalSaveAttempts: attempts, actualLocalSaves: saves, refreshUsesUpdatedServerRecord: true, emptyNameBlocksRequest: true,
    suppliedBusinessProjectUntouched: true, originalHostUntouched: true, hostBundleSha256: createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex'), contentBundleSha256: createHash('sha256').update(await readFile(join(repo, 'extensions/dsh-browser/dist/content.js'))).digest('hex'), evidenceDirectory: artifacts.slice(base.length + 1) }
  await writeFile(join(artifacts, 'generated-client.html'), await readFile(file), { mode: 0o600 }); await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); await writeFile(join(base, label + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result))
} catch (error) {
  if (h?.browser) await h.browser.target.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ passed: false, phase, errorName: error.name, attempts, saves }, null, 2), { mode: 0o600 }); throw error
} finally { await h?.close(); await new Promise(done => site.close(done)); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
