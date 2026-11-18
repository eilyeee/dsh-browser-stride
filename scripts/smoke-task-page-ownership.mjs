// Drive the native task controls against a disposable Host and synthetic pages.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'

assert.notEqual(process.env.STRIDE_REAL_MODEL, '1', 'This smoke uses scripted synthetic tasks')
const repo = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const base = join(repo, '.stride-private/validation/task-page-ownership', version)
await mkdir(base, { recursive: true })
const artifacts = await mkdtemp(join(base, 'native-'))
const interruptedGoal = 'FIXTURE_CASE=save-once'
let writes = 0
const site = createServer((request, response) => {
  if (request.method !== 'GET') {
    writes++
    response.writeHead(request.method === 'POST' && request.url === '/save-once' ? 204 : 405).end()
    return
  }
  const title = request.url === '/other' ? 'Independent synthetic tab' : 'Shared synthetic tab'
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end('<!doctype html><title>' + title + '</title><h1>' + title + '</h1>'
      + '<button id="save">Save once</button><script>document.getElementById("save").onclick = () => fetch("/save-once", {method: "POST"})</script>')
})

let harness
let phase = 'setup'
try {
  await new Promise(done => site.listen(0, '127.0.0.1', done))
  const origin = 'http://127.0.0.1:' + site.address().port
  harness = await startIsolatedModelRun({
    repo, origin, startUrl: origin + '/', artifacts, goal: 'Native task page ownership',
    programs: { 'save-once': String.raw`
const view = await tools.browser_snapshot({});
const save = view.text.split('\n').find(line => line.includes('button "Save once"'));
const ref = save?.match(/ref=(obs_[a-f0-9-]+:\d+)/)?.[1];
if (!ref) throw Error('Missing synthetic Save reference');
console.log((await tools.browser_click({elementRef: ref})).text);
` }, startupTimeoutMs: 120_000,
    guardSource: `
let saves = 0;
ctx.effect(() => ctx.tools.guard(exec => {
  if (!['run_code', 'browser_snapshot', 'browser_click'].includes(exec.name)) return 'Only synthetic browser tools are permitted';
  if (exec.name === 'browser_click' && ++saves > 1) return 'Never repeat the synthetic save';
}));
ctx.on('agent/request', async (payload, next) => {
  const run = ctx.browserRuns.list().find(row => row.sessionId === String(payload.agent.id) && row.task && row.state === 'running');
  if (!run || run.task.goal === ${JSON.stringify(interruptedGoal)}) return next();
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

  phase = 'unanswered-write'
  const owner = await createTask('interrupted-task', interruptedGoal)
  const successor = await createTask('after-reconnect', 'Task waiting for the same tab')
  await showSession(owner)
  await choose('Shared synthetic tab')
  const readScope = () => browser.worker.evaluate(async () => (await chrome.storage.session.get('dshBrowserTabScope')).dshBrowserTabScope)
  const scope = await readScope()
  assert.match(scope, /^[a-f0-9]{32}$/)
  // This fixture runs the actual local save and drops only the return frame.
  await browser.worker.evaluate(() => {
    const prototype = WebSocket.prototype, send = prototype.send
    const sockets = new WeakSet(), names = new Map()
    prototype.send = function (data) {
      if (!sockets.has(this)) {
        sockets.add(this)
        this.addEventListener('message', event => {
          const frame = JSON.parse(String(event.data))
          if (frame.t === 'tool.call') names.set(frame.id, frame.name)
        })
      }
      const frame = JSON.parse(String(data))
      if (frame.t === 'tool.result' && names.get(frame.id) === 'browser_click') {
        globalThis.__strideHeldSaveReply = true
        return
      }
      return send.call(this, data)
    }
  })
  await run(owner) // Attach the observer to the authenticated connection.
  await start.click()
  const deadline = Date.now() + 25_000
  while (writes !== 1 || !await browser.worker.evaluate(() => globalThis.__strideHeldSaveReply === true)) {
    assert.ok(Date.now() < deadline, 'The managed save reply was not observed')
    await delay(100)
  }
  const dispatchFile = join(harness.root, 'runtime', 'extension', 'storages', 'browser_dispatches_776562.json')
  async function savedDispatch() {
    const { tables } = JSON.parse(await readFile(dispatchFile, 'utf8'))
    const rows = Object.values(tables.dispatches).filter(row => row.name === 'browser_click')
    assert.equal(rows.length, 1)
    return rows[0]
  }
  const sent = await savedDispatch()
  assert.equal(sent.state, 'sent_unconfirmed')
  assert.match(sent.taskPageKey, /^[a-f0-9]{64}$/)
  assert.equal(writes, 1)

  phase = 'same-tab-after-worker-restart'
  await browser.restartWorker({ preservePanel: true })
  await panel.locator('.connection .dot.connected').waitFor({ timeout: 30_000 })
  await panel.evaluate(() => { delete window.__acceptancePort })
  assert.equal(await readScope(), scope)
  const unresolved = await savedDispatch()
  assert.equal(unresolved.state, 'unresolved')
  assert.equal(unresolved.taskPageKey, sent.taskPageKey)
  assert.equal((await run(owner)).state, 'paused')
  await showSession(successor)
  await choose('Shared synthetic tab')
  await start.click()
  await panel.getByText('这个标签页已有任务', { exact: false }).waitFor({ timeout: 16_000 })
  assert.equal((await run(successor)).state, 'queued')
  assert.equal((await run(successor)).task.toolCalls, 0)
  await choose('Independent synthetic tab')
  await start.click()
  await state.filter({ hasText: '运行中' }).waitFor()
  await stopTask(successor)
  assert.deepEqual(await savedDispatch(), unresolved)
  assert.equal(writes, 1)
  const result = { passed: true, version, isolatedChrome: true, nativeStartAndStop: true,
    sameTabRefused: true, secondTaskStayedQueued: true, differentTabsBothRunning: true,
    workerRestartPreservedBrowserScope: true, sameTabAfterReconnectRefused: true,
    differentTabAfterReconnectAdmitted: true, unresolvedWritePreserved: true, syntheticServerWrites: writes }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(result))
} catch (error) {
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ phase, error: error.name }) + '\n', { mode: 0o600 })
  throw error
} finally {
  await harness?.close()
  await new Promise(done => site.close(done))
}
