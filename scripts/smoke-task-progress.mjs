// Synthetic task-note validation and correction; never uses the active Host.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'

const repo = resolve(import.meta.dirname, '..')
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
const realModel = process.env.STRIDE_REAL_MODEL === '1'
const base = join(repo, '.stride-private/validation/task-progress', version)
await mkdir(base, { recursive: true })
const label = realModel ? 'real-model' : 'scripted'
const artifacts = await mkdtemp(join(base, label + '-'))
const markers = Array.from({ length: 5 }, (_, i) => `SYNTHETIC_OBSERVATION_${i + 1}`)
const report = { criterionId: 'contract', implementation: 'implemented', observation: 'observed', evidence: markers, nextStep: '' }
const corrected = { ...report, evidence: [markers.slice(0, 2).join('; '), ...markers.slice(2)] }
const code = `const before=JSON.parse((await tools.browser_task_notes({action:'read'})).text);
try { await tools.browser_task_notes({action:'report',version:before.version,json:${JSON.stringify(JSON.stringify(report))}}); throw Error('Oversized report accepted'); }
catch(error) { if(!String(error).includes('at most 4 evidence items')) throw error; }
const unchanged=JSON.parse((await tools.browser_task_notes({action:'read'})).text);
if(JSON.stringify(unchanged)!==JSON.stringify(before))throw Error('Rejected report changed notes');
await tools.browser_task_notes({action:'report',version:before.version,json:${JSON.stringify(JSON.stringify(corrected))}});
console.log(await tools.browser_task_notes({action:'read'}));`
let h
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Synthetic task notes</title><main>Task-note acceptance only</main>'))
function notes(call) {
  return JSON.parse(call.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
}
try {
  await new Promise(done => site.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${site.address().port}`
  h = await startIsolatedModelRun({ repo, origin, startUrl: origin + '/', artifacts,
    goal: 'Check synthetic task-note validation without changing business data',
    criteria: [{ id: 'contract', text: 'Preserve five synthetic observations within the report format' }],
    programs: { correction: code }, promptViaRpc: true, extensionDir: process.env.STRIDE_COMPAT_EXTENSION_DIR,
    guardSource: "ctx.effect(()=>ctx.tools.guard(exec=>!['run_code','browser_task_notes'].includes(exec.name)?'Only synthetic task notes allowed':undefined));" })
  const extensionVersion = await h.browser.worker.evaluate(() => chrome.runtime.getManifest().version)
  if (process.env.STRIDE_COMPAT_EXTENSION_DIR) assert.equal(extensionVersion, '0.1.20')
  const events = await h.turn('correction', `这是隔离的任务资料格式验收，不操作浏览器或业务数据。先读取browser_task_notes。测试明确要求首次report故意把这5个标记各放一条evidence：${markers.join('、')}；criterionId=contract，implementation=implemented，observation=observed，nextStep为空。每次report必须携带最近read返回的数字version。首次报告预期因证据条数拒绝；不要预先改成有效格式。拒绝后再次read，确认所有已存资料和版本与首次read完全一致。然后根据实际工具说明或错误信息修正，只提交一次有效报告，合并证据但保留全部5个标记，不改变goal/materials/criteria，不设置用户确认。最后再次read核对保存。不得调用其他工具或改文件。`, realModel ? 180000 : 60000)
  const calls = events.filter(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'browser_task_notes')
  const reports = calls.filter(call => call.data.arguments.action === 'report')
  assert.equal(reports.length, 2)
  assert.equal(reports[0].data.isError, true)
  const error = JSON.stringify(reports[0].data.content)
  assert.ok(error.includes('at most 4 evidence items'))
  assert.ok(markers.every(marker => !error.includes(marker)))
  assert.equal(reports[1].data.isError, false)
  const before = notes(calls[0])
  const invalidIndex = calls.indexOf(reports[0]), correctedIndex = calls.indexOf(reports[1])
  const unchanged = calls.slice(invalidIndex + 1, correctedIndex).find(call => call.data.arguments.action === 'read' && !call.data.isError)
  assert.ok(unchanged)
  assert.deepEqual(notes(unchanged), before)
  const final = notes(calls.findLast(call => call.data.arguments.action === 'read' && !call.data.isError))
  assert.equal(final.version, before.version + 1)
  assert.equal(final.progress.length, 1)
  const progress = final.progress[0]
  assert.equal(progress.userConfirmed, false)
  assert.ok(progress.evidence.length <= 4 && markers.every(marker => progress.evidence.join('\n').includes(marker)))
  for (const field of ['goal', 'projectPath', 'materials', 'criteria', 'userEdited']) assert.deepEqual(final[field], before[field])
  assert.equal(events.some(event => event.type === 'tool/ptc-dispatch' && !['run_code', 'browser_task_notes'].includes(event.data.name)), false)
  const result = { passed: true, version, extensionVersion, realModel, scriptedModel: !realModel, isolatedHost: true,
    rejectedReportUnchanged: true, correctionPreservesAllObservations: true, userConfirmationFalse: true,
    originalHostUntouched: true, businessToolsDispatched: 0,
    hostBundleSha256: createHash('sha256').update(await readFile(join(repo, 'packages/browser/bridge-browser/lib/index.js'))).digest('hex'),
    evidenceDirectory: artifacts.slice(base.length + 1) }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  await writeFile(join(base, label + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(result))
} catch (error) {
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ passed: false, errorName: error.name }), { mode: 0o600 })
  throw error
} finally { await h?.close(); await new Promise(done => site.close(done)) }
