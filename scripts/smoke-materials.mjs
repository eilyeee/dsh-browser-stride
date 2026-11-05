// Existing default model, real Host and isolated Chrome; synthetic material roles only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { startVisualSite } from './fixtures/visual-site.mjs'

if (process.env.STRIDE_REAL_MODEL !== '1') throw new Error('Material-role acceptance requires STRIDE_REAL_MODEL=1')
const caseIds = ['requirements', 'embedded-design', 'page-target']
const selected = process.env.STRIDE_MATERIAL_CASE ?? 'all'
if (selected !== 'all' && !caseIds.includes(selected)) throw new Error('Unknown STRIDE_MATERIAL_CASE')
const repoRoot = resolve(import.meta.dirname, '..'), require = createRequire(join(repoRoot, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const artifacts = join(repoRoot, '.stride-private/validation/materials')
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined } }
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(`Material-role acceptance timed out: ${label}`)
}
function caseInput(site, caseId) {
  const role = 'sourceRole（requirements=业务依据，mixed=同时包含业务和视觉依据，implementation=当前网页本身是实现目标）和 documentKey（文档编号）'
  const business = 'customerTypes（按文档顺序的客户类型数组）、companyTaxIdRequired（企业是否必填纳税识别号）、endpoint（接口路径）、successFields（成功展示字段，先编号后消息）、readOnlyCanSubmit（只读模式可否提交）'
  const visual = 'visualRequirements（产品视觉要求数组；未说明则为空；每项只包含 source（embedded_design、document_text 或 page_style）、referenceKey（设计参考编号）、width、height、fill（小写十六进制）、radius、fontSize，尺寸为数字 px）'
  if (caseId === 'page-target') return { url: site.wikiUrl, expected: site.wikiTargetExpected,
    prompt: `当前要改造的目标是这张 Wiki 页面本身。先只读核对 #wiki-article 的实际宽度和顶部内边距，为后续实现提供依据。最终只返回 JSON：${role}、target（只包含 selector、width 数字 px、paddingTop 原样 CSS 值）。本轮不修改页面或项目。` }
  return { url: caseId === 'embedded-design' ? site.mixedWikiUrl : site.wikiUrl,
    expected: caseId === 'embedded-design' ? site.mixedWikiExpected : site.wikiExpected,
    prompt: (caseId === 'embedded-design'
      ? '请理解这篇客户信息文档，整理业务规则和其中客户卡片的设计要求，为后续项目开发提供依据。'
      : '请理解这篇客户信息需求说明，为后续项目联调整理业务依据。')
      + `本轮只读，不修改页面或项目。最终只返回 JSON：${role}、${business}、${visual}。基于实际读取的材料回答，缺少依据时说明，不猜测数值。` }
}
async function runCase(caseId) {
  const root = await mkdtemp(join(tmpdir(), 'stride-materials-')), home = join(root, 'home')
  const trigger = join(root, 'command.json'), result = join(root, 'result.json')
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
  const resultName = caseId === 'requirements' ? 'wiki.json' : `${caseId}.json`
  let browser, host, site, sessionId, phase = 'setup'
  try {
    await mkdir(home); await mkdir(artifacts, { recursive: true })
    const install = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', `@eilyeee/dsh-browser-stride@link:${join(repoRoot, 'packages/browser/bridge-browser')}`], { cwd: repoRoot, env, stdio: 'ignore' })
    const timer = setTimeout(() => install.kill('SIGKILL'), 120000)
    try { assert.equal((await once(install, 'exit'))[0], 0, 'Temporary plugin installation failed') } finally { clearTimeout(timer) }
    if (process.env.STRIDE_MODEL_CREDENTIALS !== undefined) {
      await copyFile(process.env.STRIDE_MODEL_CREDENTIALS, join(home, '.credentials.yaml')); await chmod(join(home, '.credentials.yaml'), 0o600)
    }
    const extraPatch = process.env.STRIDE_MODEL_PATCH === undefined ? undefined : await readFile(process.env.STRIDE_MODEL_PATCH, 'utf8')
    process.env.DSH_HOME = home
    site = await startVisualSite()
    const input = caseInput(site, caseId)
    const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done))
    const port = listener.address().port; await new Promise(done => listener.close(done))
    host = await startDshBackend({ backend: 'extension', port, repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), runtimeRoot: join(root, 'runtime'), startUrl: input.url,
      toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/visual-probe.mjs'), trigger, result }, extraPatch })
    browser = await startExtensionBrowser({ repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`, pairingCode: await host.issuePairingCode(), trustedOrigin: site.origin,
      chromiumArgs: ['--no-proxy-server', '--host-resolver-rules=MAP stride-visual.test 127.0.0.1'] })
    await browser.prepare(input.url)
    const before = await browser.target.locator('#wiki-article').evaluate(element => element.outerHTML)
    sessionId = (await host.client.rpc('session.create', { cwd: root })).sessionId
    await browser.bindSession(sessionId)
    await writeFile(trigger, JSON.stringify({ sequence: 1, mode: 'model', reportKind: 'wiki', sessionId, expected: input.expected }), { mode: 0o600 })
    await wait(async () => (await json(result))?.modelReady === true, 'model guard')
    phase = 'model'
    await host.client.rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: input.prompt }], clientTimeZone: 'Asia/Shanghai' })
    await wait(async () => (await json(`${result}.model`))?.terminal === true, 'default-model material turn', 240000)
    const modelEvidence = await json(`${result}.model`)
    assert.equal(modelEvidence.reason, 'completed'); assert.deepEqual(modelEvidence.blocked, [])
    assert.equal(modelEvidence.finalWikiReportCorrect, true, 'Role, facts, source and exact report schema must match this task')
    assert.ok(modelEvidence.results.some(row => ['browser_snapshot', 'browser_get_text'].includes(row.name) && row.ok))
    // All cases expose the same tools. Restrictions below evaluate observed
    // behaviour for this task, not a product rule attached to a Wiki URL.
    if (caseId === 'requirements') for (const name of ['browser_read_design_styles', 'browser_measure_layout', 'browser_set_design_zoom', 'browser_click_at']) {
      assert.equal(modelEvidence.browserCalls.includes(name), false, `Pure prose requirements must not trigger ${name}`)
    }
    if (caseId === 'embedded-design') assert.ok(modelEvidence.results.some(row => row.name === 'browser_screenshot' && row.ok && row.imageBlocks === 1), 'Image-only reference facts require a real screenshot')
    if (caseId === 'page-target') {
      assert.ok(modelEvidence.results.some(row => row.name === 'browser_measure_layout' && row.ok))
      const actual = await browser.target.locator('#wiki-article').evaluate(element => ({ selector: '#wiki-article', width: element.getBoundingClientRect().width, paddingTop: getComputedStyle(element).paddingTop }))
      assert.deepEqual(actual, input.expected.target)
    }
    assert.equal(await browser.target.evaluate(() => window.syntheticWrites), 0)
    assert.equal(await browser.target.locator('#wiki-article').evaluate(element => element.outerHTML), before)
    assert.ok(await host.client.rpc('session.history', { sessionId }))
    const summary = { passed: true, caseId, sourceRole: input.expected.sourceRole, syntheticOnly: true, realHost: true, isolatedChrome: true,
      nodeVersion: process.version, defaultModel: true, sameToolsAvailable: true, factsAndSchemaExact: true, pageContentUnchanged: true,
      imageReferenceVerified: caseId === 'embedded-design', targetLayoutIndependentlyVerified: caseId === 'page-target',
      historyReadable: true, projectEditingValidated: false, modelEvidence }
    await writeFile(join(artifacts, resultName), JSON.stringify(summary, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(summary)); return { caseId, passed: true }
  } catch (error) {
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, resultName), JSON.stringify({ passed: false, caseId, phase, error: error.message, modelEvidence: await json(`${result}.model`), finalReport: await readFile(`${result}.final`, 'utf8').catch(() => undefined) }, null, 2), { mode: 0o600 })
    console.error(JSON.stringify({ caseId, phase, failed: true, errorName: error.name })); return { caseId, passed: false }
  } finally {
    if (sessionId !== undefined) await host?.client.rpc('session.cancel', { sessionId }).catch(() => {})
    await browser?.close().catch(() => {}); await host?.close().catch(() => {}); await site?.close().catch(() => {})
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
const results = []
for (const caseId of selected === 'all' ? caseIds : [selected]) results.push(await runCase(caseId))
await writeFile(join(artifacts, selected === 'all' ? 'result.json' : `${selected}-result.json`), JSON.stringify({ passed: results.every(row => row.passed), results }, null, 2), { mode: 0o600 })
if (results.some(row => !row.passed)) throw new Error('Material-role acceptance failed; inspect private case evidence')
