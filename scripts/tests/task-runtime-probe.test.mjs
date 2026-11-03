import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startTaskSite } from '../fixtures/task-site.mjs'
import { apply } from '../fixtures/task-runtime-probe.mjs'

test('the task fixture verifies persisted state over loopback while pinning the browser test domain', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stride-task-probe-test-'))
  const site = await startTaskSite({ hostname: 'stride-task.test' })
  const trigger = join(root, 'trigger.json'), result = join(root, 'result.json')
  const verificationUrl = new URL('/state', site.url)
  verificationUrl.hostname = '127.0.0.1'
  const expected = { sessionId: 'synthetic-session', url: site.url, verificationUrl: verificationUrl.href }
  const cleanup = []
  let observe, verifier
  const ctx = {
    on() {}, effect(fn) { cleanup.push(fn()) },
    browserRuns: { onChange(fn) { observe = fn; return () => {} }, dispatches: { list: () => [] } },
    browserTasks: { registerVerifier(_runId, value) { verifier = value } },
  }
  t.after(async () => {
    for (const stop of cleanup.reverse()) await stop()
    await site.close()
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(trigger, JSON.stringify(expected))
  apply(ctx, { trigger, result })
  const deadline = Date.now() + 3000
  while (true) {
    try { await readFile(`${result}.ready`); break } catch {}
    assert.ok(Date.now() < deadline, 'fixture registration timeout')
    await delay(5)
  }
  observe({ sessionId: expected.sessionId, runId: 'run_synthetic', state: 'queued', task: {}, facts: [] })
  assert.equal(verifier.acceptsTarget(site.url), true)
  assert.equal(verifier.acceptsTarget(verificationUrl.href), false)
  const signal = new AbortController().signal
  assert.equal(await verifier.verify({ signal }), undefined, 'no model or page success claim can substitute for saved state')
  const response = await fetch(new URL('/save', verificationUrl), { method: 'POST', headers: { origin: site.origin, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
  assert.equal(response.status, 200)
  assert.deepEqual(await verifier.verify({ signal }), { fieldValues: { testSetting: 'enabled', persisted: 'true' } })
})

test('the disconnect fixture holds just one completed snapshot until its original tool signal aborts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stride-task-disconnect-test-'))
  const trigger = join(root, 'trigger.json'), result = join(root, 'result.json')
  const events = new Map(), cleanup = []
  const controller = new AbortController()
  const agent = { id: 'synthetic-session' }
  const ctx = { on(name, fn) { events.set(name, fn) }, effect(fn) { cleanup.push(fn()) },
    browserRuns: { onChange() { return () => {} } } }
  t.after(async () => {
    controller.abort()
    for (const stop of cleanup.reverse()) await stop()
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(trigger, JSON.stringify({ sessionId: agent.id, disconnectOnce: true }))
  apply(ctx, { trigger, result })
  const waitFile = async path => {
    const deadline = Date.now() + 3000
    while (true) {
      try { await readFile(path); return } catch {}
      assert.ok(Date.now() < deadline, 'fixture timeout')
      await delay(5)
    }
  }
  await waitFile(`${result}.ready`)
  let settled = false, invocations = 0
  const answer = { isError: false, content: [] }
  const call = () => events.get('tools/execute')({ agent, name: 'browser_snapshot', signal: controller.signal }, async () => { invocations++; return answer })
  const pending = call().then(value => { settled = true; return value })
  await waitFile(`${result}.disconnect-ready`)
  assert.equal(settled, false)
  controller.abort()
  assert.equal(await pending, answer)
  assert.equal(await call(), answer)
  assert.equal(invocations, 2, 'the fixture never replays the completed read')
})
