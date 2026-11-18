// Drive the native task controls against a disposable Host and synthetic pages.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'

assert.notEqual(process.env.STRIDE_REAL_MODEL, '1', 'This smoke holds model requests before provider dispatch')
const repo = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const base = join(repo, '.stride-private/validation/task-page-ownership', version)
await mkdir(base, { recursive: true })
const artifacts = await mkdtemp(join(base, 'native-'))
let writes = 0
const site = createServer((request, response) => {
  if (request.method !== 'GET') {
    writes++
    response.writeHead(405).end()
    return
  }
  const title = request.url === '/other' ? 'Independent synthetic tab' : 'Shared synthetic tab'
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end('<!doctype html><title>' + title + '</title><h1>' + title + '</h1>')
})

let harness
let phase = 'setup'
try {
  await new Promise(done => site.listen(0, '127.0.0.1', done))
  const origin = 'http://127.0.0.1:' + site.address().port
  harness = await startIsolatedModelRun({
    repo, origin, startUrl: origin + '/', artifacts, goal: 'Native task page ownership',
    programs: {}, startupTimeoutMs: 120_000,
    guardSource: `
ctx.effect(() => ctx.tools.guard(() => 'No tools are permitted in the task ownership fixture'));
ctx.on('agent/request', async (payload, next) => {
  const run = ctx.browserRuns.list().find(row => row.sessionId === String(payload.agent.id) && row.task && row.state === 'running');
  if (!run) return next();
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    const unsubscribe = ctx.browserRuns.onChange(row => {
      if (row.runId === run.runId && row.state !== 'running') finish();
    });
    const timer = setTimeout(finish, 60000);
  });
  throw new Error('Synthetic model request released');
});`,
  })
  const { browser, host } = harness
  await browser.prepare(origin + '/shared')
  const other = await browser.context.newPage()
  await other.goto(origin + '/other')
  await browser.authorizePage(other)

  async function createTask(name, goal) {
    const cwd = join(harness.root, name)
    await mkdir(cwd)
    const { sessionId } = await host.client.rpc('session.create', { cwd })
    await harness.rpc('session.selectModel', { sessionId, provider: 'stride-fixture', model: 'fixture' })
    const rpcId = crypto.randomUUID()
    const response = await fetch(host.baseUrl + '/api/commands/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: host.client.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'commands/execute',
        payload: { args: { agentId: sessionId, line: '/browser ' + goal, submittedAttachments: [] } } }),
      signal: AbortSignal.timeout(15_000),
    })
    assert.equal(response.ok, true)
    assert.equal((await response.json()).result?.value?.result?.kind, 'success')
    return sessionId
  }

  const first = await createTask('first-task', 'First controlled fixture task')
  const second = await createTask('second-task', 'Second controlled fixture task')
  const panel = browser.panel
  const switched = sessionId => panel.waitForFunction(id => document.querySelector('.app')?.getAttribute('data-session-id') === id, sessionId)
  async function showSession(sessionId) {
    await panel.getByRole('button', { name: '历史会话', exact: true }).click()
    await panel.locator('.session-list button[data-session-id="' + sessionId + '"]').click()
    await switched(sessionId)
  }

  async function choose(title) {
    const button = panel.locator('.control-group-pages button').filter({ hasText: title })
    await button.click()
    await panel.locator('.control-group-pages button[aria-pressed="true"]').filter({ hasText: title }).waitFor()
  }
  const run = async sessionId => (await harness.rpc('bridge.browserRuns.list', { sessionId })).items[0]
  const state = panel.locator('.browser-runs .browser-run-status strong')
  const start = panel.getByRole('button', { name: '绑定并开始', exact: true })
  async function waitForModelAdmission(sessionId) {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const current = await run(sessionId)
      assert.equal(current.state, 'running')
      if (current.task.modelRequests > 0) return
      await delay(100)
    }
    throw Error('The controlled model request never reached admission')
  }
  async function stopTask(sessionId) {
    // Model admission increments the run version immediately after startup.
    // Refresh after that transition before sending a versioned native stop.
    await waitForModelAdmission(sessionId)
    await panel.getByRole('button', { name: '刷新任务', exact: true }).click()
    await panel.getByRole('button', { name: '停止任务', exact: true }).click()
    await state.filter({ hasText: '已停止' }).waitFor({ timeout: 15_000 })
    assert.equal((await run(sessionId)).state, 'stopped')
  }
  await showSession(first)
  await choose('Shared synthetic tab')
  await start.click()
  await state.filter({ hasText: '运行中' }).waitFor()
  assert.equal((await run(first)).state, 'running')

  phase = 'same-tab-refusal'
  await showSession(second)
  await choose('Shared synthetic tab')
  await start.click()
  await panel.getByText('这个标签页已有任务', { exact: false }).waitFor({ timeout: 16_000 })
  assert.equal((await run(first)).state, 'running')
  const queued = await run(second)
  assert.equal(queued.state, 'queued')
  assert.equal(queued.task.modelRequests, 0)
  assert.equal(queued.task.toolCalls, 0)

  phase = 'independent-tab'
  await choose('Independent synthetic tab')
  await start.click()
  await state.filter({ hasText: '运行中' }).waitFor()
  assert.equal((await run(first)).state, 'running')
  assert.equal((await run(second)).state, 'running')
  assert.equal(writes, 0)

  phase = 'native-stop'
  await stopTask(second)
  await showSession(first)
  await stopTask(first)
  const result = { passed: true, version, isolatedChrome: true, nativeStartAndStop: true,
    sameTabRefused: true, secondTaskStayedQueued: true, differentTabsBothRunning: true, syntheticServerWrites: writes }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(result))
} catch (error) {
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ phase, error: error.name }) + '\n', { mode: 0o600 })
  throw error
} finally {
  await harness?.close()
  await new Promise(done => site.close(done))
}
