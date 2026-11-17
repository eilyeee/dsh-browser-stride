// Passive snapshot inspection with synthetic controls; never touches a user Host.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomInt, randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'
import { parseMarkedModelReport } from '../benchmark/lib/model-report.mjs'

const repo = resolve(import.meta.dirname, '..'), realModel = process.env.STRIDE_REAL_MODEL === '1'
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
const base = join(repo, '.stride-private/validation/control-state', version)
await mkdir(base, { recursive: true })
const label = realModel ? 'real-model' : 'scripted', artifacts = await mkdtemp(join(base, label + '-'))
const min = -randomInt(12, 48) - 0.5, max = randomInt(22, 86) + 0.5
const ariaMin = randomInt(3, 17), ariaMax = randomInt(70, 99)
const password = 'SYNTHETIC_PASSWORD_' + randomUUID(), sensitiveBound = '913752468105237', unusable = 'SYNTHETIC_UNUSABLE_' + randomUUID()
const expected = { enabled: { disabled: false, readOnly: false, nativeRequired: false, min, max, step: 'any' },
  locked: { disabled: true, readOnly: true, nativeRequired: true },
  nested: { disabled: true, readOnly: true, nativeRequired: false, ariaMin, ariaMax },
  sensitive: 'masked', malformed: { min: 'unusable', max: 'unusable', step: 'unusable' }, businessValidationVerified: false }
let h, writes = 0, phase = 'setup'
const site = createServer((req, res) => {
  if (req.method !== 'GET') { writes++; res.writeHead(405).end(); return }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Passive form state</title>
<main><h1>Synthetic control-state inspection</h1><p>Read the exposed controls only.</p>
<label>Enabled<input id="enabled" role="spinbutton" type="text" min="${min}" max="${max}" step="any"></label>
<label>Locked<input id="locked" type="number" value="5" min="1" max="12" disabled readonly required></label>
<div id="host" aria-disabled="true" aria-readonly="true"></div>
<label>Password<input id="password" type="password" value="${password}" min="${sensitiveBound}" max="${sensitiveBound}"></label>
<label>Malformed<input id="malformed" min="${unusable}" max="1e309" step="0"></label></main>
<script>const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML='<label>Nested<input id="nested" type="number" aria-valuemin="${ariaMin}" aria-valuemax="${ariaMax}"></label>';
window.fixtureEvents={invalid:0,input:0,change:0,focus:0,click:0};for(const field of [...document.querySelectorAll('input'),...root.querySelectorAll('input')])for(const type of Object.keys(window.fixtureEvents))field.addEventListener(type,()=>window.fixtureEvents[type]++);</script>`)
})
try {
  await new Promise(done => site.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${site.address().port}`, url = origin + '/form'
  h = await startIsolatedModelRun({ repo, origin, startUrl: url, artifacts,
    goal: 'Read current DOM flags and numeric declarations without editing or validating', programs: { inspect: "console.log(await tools.browser_snapshot({}));" }, promptViaRpc: true,
    guardSource: "ctx.effect(()=>ctx.tools.guard(exec=>['run_code','browser_snapshot'].includes(exec.name)?undefined:'Only passive snapshot inspection is allowed'));" })
  const hostOrigin = new URL(h.host.baseUrl).origin, extensionOrigin = new URL(h.browser.worker.url()).origin
  await h.browser.context.route('**/*', route => [origin, hostOrigin, extensionOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
  await h.browser.prepare(url); await h.browser.bindSession(h.sessionId)
  const page = h.browser.target
  const mounted = await page.evaluate(secret => ({
    min: document.querySelector('#enabled').getAttribute('min'), max: document.querySelector('#enabled').getAttribute('max'),
    locked: document.querySelector('#locked').disabled,
    nested: document.querySelector('#host').shadowRoot.querySelector('#nested').getAttribute('aria-valuemin'),
    secretPresent: document.querySelector('#password').value === secret,
  }), password)
  assert.equal(mounted.min, String(min)); assert.equal(mounted.max, String(max)); assert.equal(mounted.locked, true)
  assert.equal(mounted.nested, String(ariaMin)); assert.equal(mounted.secretPresent, true)
  phase = 'model-read'
  const events = await h.turn('inspect', '仅用browser_snapshot读取当前合成页面，禁止其他工具、动作、校验调用、文件或网络访问。根据实际返回，最终只返回JSON：marker=CONTROL_STATE_MODEL_DONE；enabled={disabled,readOnly,nativeRequired,min,max,step}；locked={disabled,readOnly,nativeRequired}；nested={disabled,readOnly,nativeRequired,ariaMin,ariaMax}；sensitive为数值属性遮罩状态的字符串；malformed={min,max,step}，各值为对应数值属性的声明状态字符串；businessValidationVerified为是否已证实框架/服务端业务校验。依据DOM状态和声明回答，工具未给出的字段写unknown，不能从控件名称或惯例猜范围，不能把原生有效性或声明当业务校验。不要回显敏感值或不可用属性原文，读完停止。', realModel ? 240000 : 60000)
  const calls = events.filter(event => event.type === 'tool/ptc-dispatch')
  assert.ok(calls.some(event => event.data.name === 'browser_snapshot' && !event.data.isError))
  assert.ok(calls.every(event => ['run_code', 'browser_snapshot'].includes(event.data.name)))
  const text = calls.filter(event => event.data.name === 'browser_snapshot').flatMap(event => event.data.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
  assert.ok(text.includes('dom-state(disabled=false,readonly=false,native-required=false)'))
  assert.ok(text.includes(`numeric-attributes(min=${min},max=${max},step=any`))
  assert.ok(text.includes(`aria-min=${ariaMin},aria-max=${ariaMax}`))
  for (const secret of [password, sensitiveBound, unusable]) assert.ok(!text.includes(secret))
  assert.ok(text.includes('numeric-attributes=masked')); assert.ok(text.includes('min=unusable,max=unusable,step=unusable'))
  let report
  if (realModel) {
    const last = events.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message?.content?.filter(block => block.type === 'text').map(block => block.text) ?? []).at(-1)
    report = parseMarkedModelReport(last, 'CONTROL_STATE_MODEL_DONE')
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(report[key], value)
  }
  assert.deepEqual(await page.evaluate(() => window.fixtureEvents), { invalid: 0, input: 0, change: 0, focus: 0, click: 0 })
  assert.equal(writes, 0)
  const result = { passed: true, version, realModel, scriptedModel: !realModel, isolatedHost: true, isolatedChrome: true,
    numericDeclarationsObserved: true, explicitFlagsObserved: true, sensitiveAttributesWithheld: true,
    controlEvents: 0, serverWrites: writes, businessValidationVerified: false, originalHostUntouched: true,
    modelReport: report, hostBundleSha256: createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex'),
    contentBundleSha256: createHash('sha256').update(await readFile(join(repo, 'extensions/dsh-browser/dist/content.js'))).digest('hex'),
    evidenceDirectory: artifacts.slice(base.length + 1) }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  await writeFile(join(base, label + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(result))
} catch (error) {
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ passed: false, phase, errorName: error.name }), { mode: 0o600 })
  throw error
} finally { await h?.close(); await new Promise(done => site.close(done)) }
