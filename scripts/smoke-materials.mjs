// Existing default model, real Host and isolated Chrome; synthetic requirements only.
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
const repoRoot = resolve(import.meta.dirname, '..'), require = createRequire(join(repoRoot, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'stride-materials-')), home = join(root, 'home')
const trigger = join(root, 'command.json'), result = join(root, 'result.json')
const artifacts = join(repoRoot, '.stride-private/validation/materials')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const key of ['DSH_EXT_TOKEN', 'DSH_BRIDGE_ADMIN_TOKEN', 'DSH_BROWSER_SESSION_WORKSPACE']) delete env[key]
let browser, host, site, sessionId, modelEvidence, phase = 'setup'
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined } }
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(`Material-role acceptance timed out: ${label}`)
}
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
  const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port; await new Promise(done => listener.close(done))
  host = await startDshBackend({ backend: 'extension', port, repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), runtimeRoot: join(root, 'runtime'), startUrl: site.wikiUrl,
    toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/visual-probe.mjs'), trigger, result }, extraPatch })
  browser = await startExtensionBrowser({ repoRoot, benchmarkRoot: join(repoRoot, 'benchmark'), bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`, pairingCode: await host.issuePairingCode(), trustedOrigin: site.origin,
    chromiumArgs: ['--no-proxy-server', '--host-resolver-rules=MAP stride-visual.test 127.0.0.1'] })
  await browser.prepare(site.wikiUrl)
  sessionId = (await host.client.rpc('session.create', { cwd: root })).sessionId
  await browser.bindSession(sessionId)
  await writeFile(trigger, JSON.stringify({ sequence: 1, mode: 'model', reportKind: 'wiki', sessionId, expected: site.wikiExpected }), { mode: 0o600 })
  await wait(async () => (await json(result))?.modelReady === true, 'model guard')
  phase = 'wiki-model'
  await host.client.rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '当前已绑定客户信息需求 Wiki。请理解本轮联调的业务要求，只整理需求，不修改项目。最终只返回 JSON：sourceRole（requirements、design 或 implementation）、documentKey（文档编号）、customerTypes（客户类型数组，按文档顺序）、companyTaxIdRequired（企业是否必填纳税识别号）、endpoint（接口路径）、successFields（成功展示字段，先编号后消息）、readOnlyCanSubmit（只读模式可否提交）、visualRequirements（文档明确给出的产品视觉要求数组，未说明则为空）。请基于实际读取的文档回答。' }], clientTimeZone: 'Asia/Shanghai' })
  await wait(async () => (await json(`${result}.model`))?.terminal === true, 'default-model requirements turn', 240000)
  modelEvidence = await json(`${result}.model`)
  assert.equal(modelEvidence.reason, 'completed'); assert.deepEqual(modelEvidence.blocked, [])
  assert.equal(modelEvidence.finalWikiReportCorrect, true)
  assert.ok(modelEvidence.results.some(row => ['browser_snapshot', 'browser_get_text'].includes(row.name) && row.ok))
  // These tools were available to the model. Their absence is a behaviour check,
  // rather than a test guard hiding the inappropriate tools.
  for (const name of ['browser_read_design_styles', 'browser_measure_layout', 'browser_set_design_zoom', 'browser_click_at']) {
    assert.equal(modelEvidence.browserCalls.includes(name), false, `Wiki requirements must not trigger ${name}`)
  }
  assert.equal(await browser.target.evaluate(() => window.syntheticWrites), 0)
  assert.ok(await host.client.rpc('session.history', { sessionId }))
  const summary = { passed: true, syntheticOnly: true, realHost: true, isolatedChrome: true, defaultModel: true,
    wikiRequirementsExact: true, wikiThemeExcluded: true, designToolsAvailableButUnused: true, pageUntouched: true, historyReadable: true,
    projectEditingValidated: false, modelEvidence }
  await writeFile(join(artifacts, 'wiki.json'), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary))
} catch (error) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'wiki.json'), JSON.stringify({ passed: false, phase, error: error.message, modelEvidence: await json(`${result}.model`) }, null, 2), { mode: 0o600 })
  throw error
} finally {
  if (sessionId !== undefined) await host?.client.rpc('session.cancel', { sessionId }).catch(() => {})
  await browser?.close().catch(() => {}); await host?.close().catch(() => {}); await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
